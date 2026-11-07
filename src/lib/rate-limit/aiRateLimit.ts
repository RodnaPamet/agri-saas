/**
 * AI completion rate limit (feat/ai-guardrails).
 *
 * Mirrors `apiReadRateLimit.ts` (Upstash sliding-window + in-memory
 * fallback, same fail-open posture) but is invoked from the application
 * layer with a `RequestContext` — no NextRequest. It throttles routed AI
 * completions per (tenant, user) so a runaway client / compromised
 * credential can't burn budget or hammer the provider.
 *
 * Keyed `ai:{tenantId}:{userId}` — a per-user bucket within a tenant so
 * one user's burst doesn't starve their colleagues. Bypassed in test
 * mode + when `RATE_LIMIT_ENABLED=0` via the shared `isRateLimitBypassed()`.
 *
 * Default 30/min (tunable via `AI_RATE_LIMIT_PER_MIN`). On exceed it
 * throws the typed 429 `rateLimited(...)` error so `withApiErrorHandling`
 * surfaces a clean 429 with no new plumbing.
 *
 * Degradation: no Upstash configured → in-memory `checkRateLimit`
 * (per-replica, still correct for single-node dev/prod). Upstash throw →
 * fail open (a rate-limiter outage must not take AI down).
 */
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from '@/env';
import type { RequestContext } from '@/app-layer/types';
import { rateLimited } from '@/lib/errors/types';
import { checkRateLimit } from '@/lib/security/rate-limit';
// From `rate-limit-bypass`, NOT `rate-limit-middleware`: this module is
// reachable from `scripts/worker.ts` (via ai/routing <- usecases/rag <-
// jobs/classify-photo), and the middleware imports `next/server`, which the
// worker bundle cannot resolve. That edge crash-looped the worker tier for
// ~12-17 hours — see rate-limit-bypass.ts for the chain.
import { isRateLimitBypassed } from '@/lib/security/rate-limit-bypass';
import { logger } from '@/lib/observability/logger';

/** Default per-(tenant,user) AI completions per minute. */
const DEFAULT_AI_RATE_PER_MIN = 30;
const WINDOW_MS = 60 * 1000;

/** Resolved limit (env override or default). */
function maxPerMinute(): number {
    return env.AI_RATE_LIMIT_PER_MIN ?? DEFAULT_AI_RATE_PER_MIN;
}

// ─── Upstash + memory-fallback infrastructure ──────────────────────

let _limiter: Ratelimit | null = null;
let _initialized = false;

function init() {
    if (_initialized) return;
    _initialized = true;
    if (env.RATE_LIMIT_MODE !== 'upstash') return;
    try {
        const redis = Redis.fromEnv();
        _limiter = new Ratelimit({
            redis,
            limiter: Ratelimit.slidingWindow(maxPerMinute(), `${WINDOW_MS} ms`),
            prefix: 'rl:ai',
        });
    } catch (err) {
        logger.error('Failed to initialize Upstash for AI rate limit', {
            component: 'rate-limit',
            error: String(err),
        });
    }
}

/** Bucket key — per (tenant, user). */
export function buildAiRateLimitKey(ctx: RequestContext): string {
    return `ai:${ctx.tenantId}:${ctx.userId}`;
}

/**
 * Throws `rateLimited(...)` (HTTP 429) when the tenant+user has exceeded
 * the per-minute AI completion budget. No-op when bypassed. Fails open on
 * an Upstash error. Call at the START of `completeWithRouting`.
 */
export async function assertAiRateLimit(ctx: RequestContext): Promise<void> {
    if (isRateLimitBypassed()) return;

    init();
    const key = buildAiRateLimitKey(ctx);

    // ── Upstash path ──
    if (env.RATE_LIMIT_MODE === 'upstash' && _limiter) {
        try {
            const r = await _limiter.limit(key);
            if (!r.success) {
                throwLimited(ctx, Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)));
            }
            return;
        } catch (err) {
            // Fail open — a rate-limiter outage must not take AI down.
            logger.error('AI rate limit exception, failing open', {
                component: 'rate-limit',
                error: String(err),
            });
            return;
        }
    }

    // ── In-memory fallback ──
    const result = checkRateLimit(key, { maxAttempts: maxPerMinute(), windowMs: WINDOW_MS });
    if (!result.allowed) {
        throwLimited(ctx, Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
    }
}

function throwLimited(ctx: RequestContext, retryAfterSeconds: number): never {
    logger.warn('AI rate limit exceeded', {
        component: 'rate-limit',
        scope: 'ai',
        tenantId: ctx.tenantId,
    });
    throw rateLimited(
        `ai_rate_limited: too many AI requests. Retry after ${retryAfterSeconds} seconds.`,
    );
}

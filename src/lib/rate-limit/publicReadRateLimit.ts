/**
 * Edge-runtime read-rate-limit for PUBLIC, unauthenticated GET API routes.
 *
 * P1.6. The preset (`PUBLIC_READ_LIMIT`) lives in
 * `src/lib/security/rate-limit.ts` so every budget shares one source of truth;
 * this module is the Edge enforcement surface, invoked from `src/middleware.ts`
 * INSIDE the public-path branch.
 *
 * ── why inside that branch, and not beside the other read tier ──
 *
 * Stage 1 of the middleware RETURNS for a public path. A limiter placed after
 * it never sees a public request at all, so the check has to happen before that
 * return — which is exactly where `isScimRateLimited` already sits, for the
 * same reason.
 *
 * ── why its own module ──
 *
 * The house pattern, and a practical constraint. `scimRateLimit.ts` duplicates
 * this same Upstash + in-memory scaffolding rather than sharing
 * `apiReadRateLimit.ts`'s, because the policy differs: different bucket key,
 * different exclusions, different limits. Folding the public tier into
 * `apiReadRateLimit.ts` would also have broken eight suites that mock that
 * module with a BARE object literal — such a mock yields `undefined` for every
 * export it omits, and four of them drive public paths through the real
 * middleware, so stage 1 would have called `undefined(...)`. A module nothing
 * mocks yet costs some duplication and no silent breakage.
 *
 * ── the posture ──
 *
 * Fail-OPEN on an Upstash exception, like every other tier here: a Redis
 * outage must not brown out invite acceptance. Fail-open is the right default
 * for a budget whose job is to blunt abuse, not to authenticate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from '@/env';
import { PUBLIC_READ_LIMIT } from '@/lib/security/rate-limit';
import { edgeLogger } from '@/lib/observability/edge-logger';

/**
 * The public prefixes this tier covers, and NOTHING else.
 *
 * Two of the sixteen entries in `PUBLIC_PATH_PREFIXES` — a figure worth
 * stating, because "public read tier" sounds like it covers every public GET
 * and it does not. These two are the public, unauthenticated,
 * token-parameterised DATA reads: four GET routes between them
 * (`/api/invites/[token]`, `/api/invites/[token]/start-signin`, and the
 * `/api/org/invite/` pair of the same shape). An anonymous caller can probe
 * invite tokens there, and each probe costs a database read.
 *
 * Why every other public prefix is EXCLUDED:
 *
 *   /api/auth            NextAuth, already tiered (LOGIN_LIMIT and friends).
 *                        It also carries session polling, which a 60/min/IP
 *                        cap would break across browser tabs.
 *   /api/health
 *   /api/livez
 *   /api/readyz
 *   /api/metrics         Probes. An operator needs these to answer WHILE an
 *                        attacker hammers the API; throttling them makes the
 *                        monitoring fail together with the thing it monitors.
 *   /api/scim/           Has its own, far higher tier (300/min per bearer,
 *                        600/min per IP). A 60/min cap would break real
 *                        provisioning runs.
 *   /api/staging/seed    POST, and 403s in production.
 *   /api/admin/*         Platform-key gated and LOGIN_LIMIT'd at the handler.
 *   page routes          `/login`, `/register`, `/invite/`, `/privacy`, … are
 *                        HTML. One reload fetches a page plus its assets, so a
 *                        60/min page budget would lock a real person out of
 *                        signing in.
 */
const PUBLIC_READ_PREFIXES: readonly string[] = ['/api/invites/', '/api/org/invite/'];

/**
 * Match logic for the public tier. Exposed for tests and for the middleware,
 * which calls it to decide whether to invoke the async check at all.
 *
 * GET only: a POST to an invite route is an acceptance — a mutation, already
 * budgeted by `withApiErrorHandling`.
 */
export function isPublicReadRateLimited(method: string, pathname: string): boolean {
    if (method !== 'GET') return false;
    return PUBLIC_READ_PREFIXES.some((p) => pathname.startsWith(p));
}

// ─── Upstash + memory-fallback infrastructure ──────────────────────
// Mirrors scimRateLimit.ts / apiReadRateLimit.ts: Upstash for multi-replica
// correctness, an in-memory Map for local dev and test, same fail-open posture.

const _memoryCache = new Map<string, { count: number; resetAt: number }>();
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
            limiter: Ratelimit.slidingWindow(
                PUBLIC_READ_LIMIT.maxAttempts,
                `${PUBLIC_READ_LIMIT.windowMs} ms`,
            ),
            prefix: 'rl:public-read',
        });
    } catch (err) {
        edgeLogger.error('Failed to initialize Upstash for public read rate limit', {
            component: 'rate-limit',
            err: String(err),
        });
    }
}

function getClientIp(req: NextRequest): string {
    const fwd = req.headers.get('x-forwarded-for');
    if (fwd) {
        const first = fwd.split(',')[0]?.trim();
        if (first) return first;
    }
    return req.headers.get('x-real-ip')?.trim() || '127.0.0.1';
}

interface Bucket {
    ok: boolean;
    limit: number;
    remaining: number;
    reset: number;
    retryAfter: number;
}

function checkMemory(key: string): Bucket {
    const now = Date.now();
    let record = _memoryCache.get(key);
    if (!record || now > record.resetAt) {
        record = { count: 0, resetAt: now + PUBLIC_READ_LIMIT.windowMs };
    }
    record.count++;
    _memoryCache.set(key, record);
    const ok = record.count <= PUBLIC_READ_LIMIT.maxAttempts;
    return {
        ok,
        limit: PUBLIC_READ_LIMIT.maxAttempts,
        remaining: Math.max(0, PUBLIC_READ_LIMIT.maxAttempts - record.count),
        reset: record.resetAt,
        retryAfter: ok ? 0 : Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
    };
}

/** Test-only — clears the memory store. */
export function _clearPublicReadRateLimitMemory(): void {
    _memoryCache.clear();
    _initialized = false;
    _limiter = null;
}

/** Same operator + test escape hatches as every other tier here. */
function isBypassed(): boolean {
    if (env.RATE_LIMIT_ENABLED === '0') return true;
    if (env.AUTH_TEST_MODE === '1') return true;
    if (process.env.NEXT_TEST_MODE === '1') return true;
    return false;
}

export interface PublicReadRateLimitResult {
    ok: boolean;
    /** Pre-built 429 response when blocked; absent when allowed. */
    response?: NextResponse;
}

/**
 * Enforce the public read tier.
 *
 * Keyed by IP ALONE — there is no authenticated user on these paths, which is
 * the whole reason they need a tier of their own. That makes the budget coarser
 * than it looks: carrier-grade NAT puts many subscribers behind one public
 * IPv4, so 60/min is shared by everyone behind a village's cell tower. The
 * figure is a deliberate compromise between that and what it defends against.
 */
export async function checkPublicReadRateLimit(
    req: NextRequest,
): Promise<PublicReadRateLimitResult> {
    if (isBypassed()) return { ok: true };

    init();
    const key = `rl:public-read:ip:${getClientIp(req)}`;

    let check: Bucket;
    try {
        if (env.RATE_LIMIT_MODE !== 'upstash' || !_limiter) {
            check = checkMemory(key);
        } else {
            const r = await _limiter.limit(key);
            check = {
                ok: r.success,
                limit: r.limit,
                remaining: r.remaining,
                reset: r.reset,
                retryAfter: r.success ? 0 : Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)),
            };
        }
    } catch (err) {
        edgeLogger.error('Public read rate limit exception, failing open', {
            component: 'rate-limit',
            err: String(err),
        });
        return { ok: true };
    }

    if (!check.ok) {
        edgeLogger.warn('Public read rate limit exceeded', {
            component: 'rate-limit',
            scope: 'public-read',
            // No IP at warn level — it is PII, and here it is the entire key.
            // The request-id on the response ties this back in the logs.
        });
        return {
            ok: false,
            response: NextResponse.json(
                {
                    error: {
                        code: 'RATE_LIMITED',
                        scope: 'public-read',
                        message: `Too many requests. Retry after ${check.retryAfter} seconds.`,
                        retryAfterSeconds: check.retryAfter,
                    },
                },
                {
                    status: 429,
                    headers: {
                        'Retry-After': String(check.retryAfter),
                        'X-RateLimit-Limit': String(check.limit),
                        'X-RateLimit-Remaining': '0',
                        'X-RateLimit-Reset': String(check.reset),
                    },
                },
            ),
        };
    }

    return { ok: true };
}

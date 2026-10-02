/**
 * Edge rate limit for PUBLIC, unauthenticated GET API routes. P1.6.
 *
 * ## Why this tier exists
 *
 * Stage 1 of `src/middleware.ts` returns `NextResponse.next()` for a public
 * path, so neither existing read budget can reach one: the read tier requires
 * an `/api/t/` prefix, and the mutation tier lives in `withApiErrorHandling`,
 * which runs after the middleware and only claims mutation methods. That
 * leaves the public, unauthenticated, token-parameterised GET reads with no
 * budget at all — and on those an anonymous caller can probe invite tokens,
 * where every guess costs a database read.
 *
 * Same shape of hole, and the same defence, as the SCIM and API-key tiers; see
 * `scimRateLimit.ts` and `apiKeyRateLimit.ts`.
 *
 * ## Why it is not one of those tiers
 *
 * It claims by PATH prefix like SCIM, but a 60/min budget shared with
 * provisioning (300/min per bearer) would make a customer's Entra sync and an
 * anonymous invite lookup compete for one bucket. And there is no credential to
 * key on, which is what separates it from the API-key tier: an unauthenticated
 * caller has only an IP.
 *
 * ## Which requests it claims
 *
 * Two of the sixteen entries in `PUBLIC_PATH_PREFIXES` — worth stating,
 * because "public read tier" sounds like it covers every public GET and it does
 * not. See `PUBLIC_READ_PREFIXES` for why each of the other fourteen is out.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from '@/env';
import { PUBLIC_READ_LIMIT } from '@/lib/security/rate-limit';
import { edgeLogger } from '@/lib/observability/edge-logger';
import {
    type Bucket,
    isRateLimitBypassed,
    getClientIp,
    checkMemoryBucket,
    toBucket,
    rateLimitedResponse,
} from './edge-bucket';

/**
 * The public prefixes this tier covers, and NOTHING else.
 *
 * These two are the public, unauthenticated, token-parameterised DATA reads —
 * four GET routes between them (`/api/invites/[token]`,
 * `/api/invites/[token]/start-signin`, and the `/api/org/invite/` pair of the
 * same shape).
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
 *   /api/scim/           Its own, far higher tier (300/min per bearer, 600/min
 *                        per IP). A 60/min cap would break provisioning runs.
 *   /api/staging/seed    POST, and 403s in production.
 *   /api/admin/*         Platform-key gated and LOGIN_LIMIT'd at the handler.
 *   page routes          `/login`, `/register`, `/invite/`, `/privacy`, … are
 *                        HTML. One reload fetches a page plus its assets, so a
 *                        60/min page budget would lock a real person out of
 *                        signing in.
 *
 * Trailing slashes are load-bearing, exactly as for `SCIM_PATH_PREFIX` and
 * `TENANT_API_PREFIX`: `/api/invites` without one would also claim
 * `/api/invitesomething`, and a limiter must never be wider than the hole it
 * defends — nor narrower.
 */
const PUBLIC_READ_PREFIXES: readonly string[] = ['/api/invites/', '/api/org/invite/'];

/**
 * Which requests this tier claims. The ONE definition — the middleware calls
 * it rather than re-testing the prefix, so the two cannot drift.
 *
 * GET only: a POST to an invite route is an acceptance — a mutation, already
 * budgeted by `withApiErrorHandling`. Double-charging it here would make
 * accepting an invite fail for a reason nobody could find.
 */
export function isPublicReadRateLimited(method: string, pathname: string): boolean {
    if (method !== 'GET') return false;
    return PUBLIC_READ_PREFIXES.some((p) => pathname.startsWith(p));
}

const _memoryCache = new Map<string, { count: number; resetAt: number }>();
let _limiter: Ratelimit | null = null;
let _initialized = false;

function init(): void {
    if (_initialized) return;
    _initialized = true;
    if (env.RATE_LIMIT_MODE !== 'upstash') return;
    try {
        _limiter = new Ratelimit({
            redis: Redis.fromEnv(),
            limiter: Ratelimit.slidingWindow(
                PUBLIC_READ_LIMIT.maxAttempts,
                `${PUBLIC_READ_LIMIT.windowMs} ms`,
            ),
            prefix: 'rl:public-read',
        });
    } catch (err) {
        edgeLogger.error('Failed to initialize Upstash for the public read tier', {
            component: 'rate-limit',
            err: String(err),
        });
    }
}

/** Test-only — clears the memory store. */
export function _clearPublicReadRateLimitMemory(): void {
    _memoryCache.clear();
    _initialized = false;
    _limiter = null;
}

export interface PublicReadRateLimitResult {
    ok: boolean;
    /** Pre-built 429 when blocked; absent when allowed. */
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
 *
 * Fail OPEN on a backend outage, like every other tier here: a Redis outage
 * must not stop someone accepting an invite.
 */
export async function checkPublicReadRateLimit(
    req: NextRequest,
): Promise<PublicReadRateLimitResult> {
    if (isRateLimitBypassed()) return { ok: true };
    init();

    const key = `rl:public-read:ip:${getClientIp(req)}`;

    let bucket: Bucket;
    try {
        bucket = _limiter
            ? toBucket(await _limiter.limit(key))
            : checkMemoryBucket(_memoryCache, key, PUBLIC_READ_LIMIT);
    } catch (err) {
        edgeLogger.error('Public read rate limit check failed; allowing request', {
            component: 'rate-limit',
            err: String(err),
        });
        return { ok: true };
    }

    if (bucket.ok) return { ok: true };

    // No IP in the log at warn level — it is PII, and here it is the entire
    // key. The request-id on the response ties this back in the logs.
    edgeLogger.warn('Public read rate limit exceeded', {
        component: 'rate-limit',
        scope: 'public-read',
    });
    return { ok: false, response: rateLimitedResponse(bucket) };
}

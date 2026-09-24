/**
 * Edge rate limit for tenant API-key (`iflk_`) requests.
 *
 * ## Why this tier exists
 *
 * The Edge carve-out in `src/middleware.ts` lets a request carrying an
 * `iflk_` bearer past `getToken()` WITHOUT authenticating it, because the key
 * is an opaque token compared against a hash in the database and the Edge has
 * no database. The handler authenticates instead, via `getTenantCtx` ->
 * `tryApiKeyAuth` -> `verifyApiKey`.
 *
 * That makes `/api/t/` a surface where an ANONYMOUS caller reaches a key
 * comparison — a bearer brute-force oracle if unbudgeted, and unbounded
 * database load besides, since every guess costs a `TenantApiKey` lookup.
 * SCIM has the same property and the same defence; see `scimRateLimit.ts`.
 *
 * ## Why it is not the SCIM tier
 *
 * SCIM claims requests by PATH prefix. An API key is not path-scoped — it may
 * address any route under `/api/t/` — so this tier claims by CREDENTIAL
 * SHAPE instead: does the request present an `iflk_` bearer. Sharing SCIM's
 * budget would also mean a customer's integration and a tenant's Entra sync
 * competing for one bucket, which is a coupling neither would expect.
 *
 * ## Which requests it claims
 *
 * Only those the carve-out actually lets through. This predicate and the
 * carve-out's condition must not drift, so `isApiKeyRateLimited` is the ONE
 * definition and the middleware calls it rather than re-testing the header.
 *
 * Fail-open on infrastructure error, mirroring every other tier: an Upstash
 * outage must not take a customer's integration down. The per-IP ceiling is
 * the anti-guessing floor; see `API_KEY_LIMIT` for why both buckets exist.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from '@/env';
import { API_KEY_LIMIT, API_KEY_IP_LIMIT } from '@/lib/security/rate-limit';
import { API_KEY_PREFIX } from '@/lib/auth/api-key-token';
import { edgeLogger } from '@/lib/observability/edge-logger';
import {
    type Bucket,
    checkMemoryBucket,
    fingerprintBearer,
    getClientIp,
    isRateLimitBypassed,
    rateLimitedResponse,
    toBucket,
} from './edge-bucket';

/**
 * The tenant API prefix the carve-out is bounded to.
 *
 * Trailing slash is load-bearing, exactly as for `SCIM_PATH_PREFIX`: `/api/t`
 * without it would also claim `/api/tokens` or `/api/tenants`, and a limiter
 * must never be WIDER than the hole it defends — nor narrower.
 */
export const TENANT_API_PREFIX = '/api/t/';

/**
 * Does this request present an API-key bearer on the tenant API?
 *
 * Deliberately a pure header+path test with no database access: it runs on the
 * Edge, and it must give the same answer as the carve-out that admits the
 * request. It says nothing about whether the key is VALID — that is the
 * handler's job, and a rate limiter that only counted valid keys would not
 * budget the guessing it exists to stop.
 */
export function isApiKeyRateLimited(pathname: string, authHeader: string | null): boolean {
    if (!pathname.startsWith(TENANT_API_PREFIX)) return false;
    if (!authHeader) return false;
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    return token.startsWith(API_KEY_PREFIX);
}

const _memoryCache = new Map<string, { count: number; resetAt: number }>();

let _limiter: Ratelimit | null = null;
let _ipLimiter: Ratelimit | null = null;
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
                API_KEY_LIMIT.maxAttempts,
                `${API_KEY_LIMIT.windowMs} ms`,
            ),
            prefix: 'rl:apikey',
        });
        _ipLimiter = new Ratelimit({
            redis,
            limiter: Ratelimit.slidingWindow(
                API_KEY_IP_LIMIT.maxAttempts,
                `${API_KEY_IP_LIMIT.windowMs} ms`,
            ),
            prefix: 'rl:apikey-ip',
        });
    } catch (err) {
        edgeLogger.error('Failed to initialize Upstash for API-key rate limit', {
            component: 'rate-limit',
            err: String(err),
        });
    }
}

/** Test-only — clears the memory store and forces re-init. */
export function _clearApiKeyRateLimitMemory(): void {
    _memoryCache.clear();
    _initialized = false;
    _limiter = null;
    _ipLimiter = null;
}

export interface ApiKeyRateLimitResult {
    ok: boolean;
    response?: NextResponse;
}

/** Enforce both buckets. Returns a 429 with `Retry-After` when either binds. */
export async function checkApiKeyRateLimit(req: NextRequest): Promise<ApiKeyRateLimitResult> {
    if (isRateLimitBypassed()) return { ok: true };
    init();

    const ip = getClientIp(req);
    const bearer = fingerprintBearer(req.headers.get('authorization'));

    const tokenKey = `rl:apikey:b:${bearer}`;
    const ipKey = `rl:apikey-ip:ip:${ip}`;

    let tokenBucket: Bucket;
    let ipBucket: Bucket;
    try {
        if (_limiter && _ipLimiter) {
            const [t, i] = await Promise.all([
                _limiter.limit(tokenKey),
                _ipLimiter.limit(ipKey),
            ]);
            tokenBucket = toBucket(t);
            ipBucket = toBucket(i);
        } else {
            tokenBucket = checkMemoryBucket(_memoryCache, tokenKey, API_KEY_LIMIT);
            ipBucket = checkMemoryBucket(_memoryCache, ipKey, API_KEY_IP_LIMIT);
        }
    } catch (err) {
        // Fail OPEN: a customer's integration must survive a rate-limit
        // backend outage, exactly as provisioning does.
        edgeLogger.error('API-key rate limit check failed; allowing request', {
            component: 'rate-limit',
            err: String(err),
        });
        return { ok: true };
    }

    if (tokenBucket.ok && ipBucket.ok) return { ok: true };

    const blocking = !tokenBucket.ok ? tokenBucket : ipBucket;
    return { ok: false, response: rateLimitedResponse(blocking) };
}

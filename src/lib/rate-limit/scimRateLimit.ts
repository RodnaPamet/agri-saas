/**
 * Edge-runtime rate limit for SCIM 2.0 provisioning.
 *
 * ## Why SCIM needs its own tier
 *
 * `/api/scim/` sits in `PUBLIC_PATH_PREFIXES`, so the middleware does not
 * authenticate it — it cannot, because a SCIM bearer is an opaque token
 * compared against a hash in the database, and the Edge has no database. The
 * handler authenticates instead (enforced fail-closed by
 * `tests/guards/scim-routes-self-authenticate.test.ts`).
 *
 * That makes this the one API surface where an ANONYMOUS caller reaches a
 * token comparison. Unlimited, that is a bearer brute-force oracle. The read
 * tier does not cover it — `isApiReadRateLimited` requires an `/api/t/` prefix
 * and only throttles GETs, while SCIM is neither.
 *
 * ## Two buckets, because one is not enough
 *
 * Per-BEARER alone fails against the attacker: rotating a fresh guess each
 * request yields a fresh bucket every time, so the limit never binds. Per-IP
 * alone fails against the operator: several tenants' Entra syncs egress from
 * one shared Microsoft IP pool, so a single ceiling would throttle innocent
 * tenants. Enforce both — the tighter per-bearer budget for normal traffic,
 * the looser per-IP ceiling as the anti-guessing floor.
 *
 * The bearer is HASHED into the key. A rate-limit key is a cache key that can
 * end up in logs and in Redis; a live provisioning credential must not.
 *
 * Fail-open on infrastructure error, mirroring `apiReadRateLimit.ts`: an
 * Upstash outage must not take provisioning down.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from '@/env';
import { SCIM_LIMIT, SCIM_IP_LIMIT } from '@/lib/security/rate-limit';
import { edgeLogger } from '@/lib/observability/edge-logger';

/** The public prefixes this limiter defends. Kept in ONE place. */
export const SCIM_PATH_PREFIX = '/api/scim/';

/**
 * Signed-webhook prefixes, added 2026-08-20.
 *
 * Same situation as SCIM and the same reason for the same budget: these are
 * public at the Edge (their senders — Stripe, the AV scanner, third-party
 * integrations — cannot carry a session cookie), so an anonymous caller
 * reaches a signature comparison. Unbudgeted that is unbounded database and
 * log load from the internet: every handler logs a warn on a bad signature.
 *
 * They share this tier rather than getting a fourth: the traffic class is
 * identical (machine-to-machine, signed, bursty on retry) and a separate
 * budget would be a number nobody could justify differently.
 */
const WEBHOOK_PATH_PREFIXES = [
    // Platform-admin API — same situation: public at the Edge because its
    // credential is a header key the Edge cannot verify, so an anonymous
    // caller reaches a constant-time key comparison. Budgeted for the same
    // reason, and it is the highest-value key in the system. Listed to match
    // the carve-out exactly; /api/admin/diagnostics stays session-gated and
    // out of this tier.
    '/api/admin/agri-events',
    '/api/admin/news-derived-events',
    '/api/admin/support-schemes',
    '/api/admin/tenants',
    '/api/stripe/webhook',
    '/api/storage/av-webhook',
    '/api/integrations/webhooks/',
] as const;

/**
 * Does this request belong to the SCIM tier?
 *
 * The trailing slash is load-bearing and matches `PUBLIC_PATH_PREFIXES`
 * exactly: `/api/scim` without it would also claim `/api/scimulator`, and the
 * limiter's scope must not be wider than the carve-out's.
 */
export function isScimRateLimited(pathname: string): boolean {
    return (
        pathname.startsWith(SCIM_PATH_PREFIX) ||
        WEBHOOK_PATH_PREFIXES.some((p) => pathname.startsWith(p))
    );
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
            limiter: Ratelimit.slidingWindow(SCIM_LIMIT.maxAttempts, `${SCIM_LIMIT.windowMs} ms`),
            prefix: 'rl:scim',
        });
        _ipLimiter = new Ratelimit({
            redis,
            limiter: Ratelimit.slidingWindow(
                SCIM_IP_LIMIT.maxAttempts,
                `${SCIM_IP_LIMIT.windowMs} ms`,
            ),
            prefix: 'rl:scim-ip',
        });
    } catch (err) {
        edgeLogger.error('Failed to initialize Upstash for SCIM rate limit', {
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

/**
 * A short, stable fingerprint of the presented bearer.
 *
 * NOT the token. Web Crypto's digest is async and this runs on the Edge, so
 * use a cheap synchronous non-cryptographic hash: the requirement here is
 * "distinct tokens get distinct buckets and the raw secret never lands in a
 * key", not collision resistance. A collision merely makes two callers share
 * a budget, which the per-IP ceiling already tolerates.
 */
function fingerprintBearer(header: string | null): string {
    if (!header) return 'none';
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (!token) return 'none';
    let h = 5381;
    for (let i = 0; i < token.length; i++) {
        h = ((h << 5) + h + token.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

interface Bucket {
    ok: boolean;
    limit: number;
    remaining: number;
    reset: number;
    retryAfter: number;
}

function checkMemory(key: string, cfg: { maxAttempts: number; windowMs: number }): Bucket {
    const now = Date.now();
    let record = _memoryCache.get(key);
    if (!record || now > record.resetAt) {
        record = { count: 0, resetAt: now + cfg.windowMs };
    }
    record.count++;
    _memoryCache.set(key, record);
    const ok = record.count <= cfg.maxAttempts;
    return {
        ok,
        limit: cfg.maxAttempts,
        remaining: Math.max(0, cfg.maxAttempts - record.count),
        reset: record.resetAt,
        retryAfter: ok ? 0 : Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
    };
}

/** Test-only — clears the memory store and forces re-init. */
export function _clearScimRateLimitMemory(): void {
    _memoryCache.clear();
    _initialized = false;
    _limiter = null;
    _ipLimiter = null;
}

/** Same operator + test escape hatches as every other tier. */
function isBypassed(): boolean {
    if (env.RATE_LIMIT_ENABLED === '0') return true;
    if (env.AUTH_TEST_MODE === '1') return true;
    if (process.env.NEXT_TEST_MODE === '1') return true;
    return false;
}

export interface ScimRateLimitResult {
    ok: boolean;
    response?: NextResponse;
}

/**
 * Enforce both SCIM buckets. Returns a 429 carrying `Retry-After` and the
 * standard `X-RateLimit-*` headers.
 *
 * The body names neither the IP nor the token, per the repo's rate-limit
 * convention — a 429 is served to whoever asked, including an attacker, and
 * must not confirm anything about what they sent.
 */
export async function checkScimRateLimit(req: NextRequest): Promise<ScimRateLimitResult> {
    if (isBypassed()) return { ok: true };
    init();

    const ip = getClientIp(req);
    const bearer = fingerprintBearer(req.headers.get('authorization'));

    const tokenKey = `rl:scim:b:${bearer}`;
    const ipKey = `rl:scim-ip:ip:${ip}`;

    let tokenBucket: Bucket;
    let ipBucket: Bucket;
    try {
        if (_limiter && _ipLimiter) {
            const [t, i] = await Promise.all([
                _limiter.limit(tokenKey),
                _ipLimiter.limit(ipKey),
            ]);
            const toBucket = (
                r: { success: boolean; limit: number; remaining: number; reset: number },
            ): Bucket => ({
                ok: r.success,
                limit: r.limit,
                remaining: r.remaining,
                reset: r.reset,
                retryAfter: r.success ? 0 : Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)),
            });
            tokenBucket = toBucket(t);
            ipBucket = toBucket(i);
        } else {
            tokenBucket = checkMemory(tokenKey, SCIM_LIMIT);
            ipBucket = checkMemory(ipKey, SCIM_IP_LIMIT);
        }
    } catch (err) {
        // Fail OPEN: provisioning must survive a rate-limit backend outage.
        edgeLogger.error('SCIM rate limit check failed; allowing request', {
            component: 'rate-limit',
            err: String(err),
        });
        return { ok: true };
    }

    if (tokenBucket.ok && ipBucket.ok) return { ok: true };

    // Report whichever bucket actually blocked, so Retry-After is honest.
    const blocking = !tokenBucket.ok ? tokenBucket : ipBucket;
    const response = NextResponse.json(
        { error: 'Too many requests' },
        {
            status: 429,
            headers: {
                'Retry-After': String(blocking.retryAfter),
                'X-RateLimit-Limit': String(blocking.limit),
                'X-RateLimit-Remaining': String(blocking.remaining),
                'X-RateLimit-Reset': String(Math.ceil(blocking.reset / 1000)),
            },
        },
    );
    return { ok: false, response };
}

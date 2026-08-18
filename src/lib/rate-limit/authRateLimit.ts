import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from '@/env';
import { edgeLogger } from '@/lib/observability/edge-logger';

// Define logical tiers for endpoints
type EndpointTier = 'high' | 'medium' | 'low';

export interface RateLimitResult {
    ok: boolean;
    limit: number;
    remaining: number;
    reset: number;
    retryAfter: number;
}

// Memory fallback store for local development/testing
const _memoryCache = new Map<string, { count: number; resetAt: number }>();

// Lazy initialized Upstash
let _redis: Redis | null = null;
let _limiters: { high: Ratelimit; medium: Ratelimit; low: Ratelimit } | null = null;
let _initialized = false;

function initUpstash() {
    if (_initialized) return;
    _initialized = true;

    const mode = env.RATE_LIMIT_MODE;
    if (mode !== 'upstash') return;

    try {
        _redis = Redis.fromEnv();
        _limiters = {
            high: new Ratelimit({ redis: _redis, limiter: Ratelimit.slidingWindow(10, '60 s') }),
            medium: new Ratelimit({ redis: _redis, limiter: Ratelimit.slidingWindow(30, '60 s') }),
            low: new Ratelimit({ redis: _redis, limiter: Ratelimit.slidingWindow(60, '60 s') })
        };
    } catch (error) {
        edgeLogger.error('Failed to initialize Upstash Redis', { component: 'rate-limit', err: String(error) });
    }
}

/**
 * Endpoint classification logic.
 * The strictness depends on the risk of the endpoint to abuse.
 */
function classifyEndpoint(pathname: string): EndpointTier {
    // Native token issue + refresh. Classified explicitly because the DEFAULT
    // below is 'low' (60/min) — the tier meant for /csrf and /providers, i.e.
    // for getters that leak nothing. A refresh endpoint is neither: it is an
    // unauthenticated credential exchange, which is the same abuse position as
    // /signin and belongs in the same tier.
    //
    // 'high' = 10/min per (IP, ua-hash). A native client refreshes roughly four
    // times an hour (ACCESS_TOKEN_TTL_SECONDS = 15 min), so this leaves well
    // over an order of magnitude of headroom for legitimate traffic while
    // capping guessing at 10 attempts a minute against a 256-bit token.
    if (pathname.startsWith('/api/auth/token')) {
        return 'high';
    }

    if (
        pathname.startsWith('/api/auth/signin') ||
        pathname.startsWith('/api/auth/callback') ||
        pathname.startsWith('/api/auth/signout')
    ) {
        return 'high';
    }

    if (pathname.startsWith('/api/auth/session')) {
        return 'medium';
    }

    // Default to low for getters like /csrf, /providers, etc.
    return 'low';
}

/**
 * Extracts the stable client identifier from the request using IP.
 * Also appends a hash of the User-Agent to mitigate NAT/shared-IP blocking (if Web Crypto is enabled).
 */
async function getClientKey(req: NextRequest): Promise<string> {
    // GAP-05 — Next 15 removed `req.ip`. Read x-forwarded-for as the
    // canonical edge-runtime client-IP source. Local-dev fallback is
    // 127.0.0.1 — the request comes through the dev server which
    // doesn't set the header.
    let ip = req.headers.get('x-forwarded-for') || '127.0.0.1';

    if (ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }

    const ua = req.headers.get('user-agent') || 'unknown';

    let uaHash = 'unknown';
    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(ua);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        uaHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 8);
    } catch {
        // Fallback if crypto.subtle is unsupported
    }

    return `rl:auth:${ip}:${uaHash}`;
}

/**
 * Processes rate limits against an in-memory Map. 
 * ONLY FOR LOCAL DEV / DETERMINISTIC TESTING.
 */
function checkMemoryLimit(key: string, tier: EndpointTier): RateLimitResult {
    let limitObject = { limit: 60, windowMs: 60000 };
    switch (tier) {
        case 'high': limitObject = { limit: 10, windowMs: 60000 }; break;
        case 'medium': limitObject = { limit: 30, windowMs: 60000 }; break;
        case 'low': limitObject = { limit: 60, windowMs: 60000 }; break;
    }

    const now = Date.now();
    let record = _memoryCache.get(key);

    if (!record || now > record.resetAt) {
        // Initialize or reset standard window
        record = { count: 0, resetAt: now + limitObject.windowMs };
    }

    record.count++;
    _memoryCache.set(key, record);

    const remaining = Math.max(0, limitObject.limit - record.count);
    const ok = record.count <= limitObject.limit;

    return {
        ok,
        limit: limitObject.limit,
        remaining,
        reset: record.resetAt,
        retryAfter: ok ? 0 : Math.ceil((record.resetAt - now) / 1000),
    };
}

/**
 * Main module function.
 * Evaluates rate limit against Upstash Redis (or memory).
 * Can fail-open if Redis throws an exception.
 */
export async function checkAuthRateLimit(req: NextRequest): Promise<{
    ok: boolean;
    response?: NextResponse; // Pre-built 429 response 
    headers?: Headers;       // Headers to append if authorized
}> {
    const enabled = env.RATE_LIMIT_ENABLED !== '0';
    const testMode = env.AUTH_TEST_MODE === '1';
    if (!enabled || testMode) {
        return { ok: true };
    }

    initUpstash();

    try {
        const { pathname } = req.nextUrl;
        const tier = classifyEndpoint(pathname);
        const key = await getClientKey(req);

        // Append tier to key to isolate limits
        const fullKey = `${key}:${tier}`;

        let rlResult: RateLimitResult;

        const mode = env.RATE_LIMIT_MODE;

        if (mode === 'memory' || !_limiters) {
            // Memory fallback mode
            rlResult = checkMemoryLimit(fullKey, tier);
        } else {
            // Upstash Mode
            const limiter = _limiters[tier];
            const result = await limiter.limit(fullKey);

            rlResult = {
                ok: result.success,
                limit: result.limit,
                remaining: result.remaining,
                reset: result.reset, // Unix timestamp in ms
                retryAfter: result.success ? 0 : Math.ceil((result.reset - Date.now()) / 1000)
            };
        }

        const rlHeaders = new Headers({
            'X-RateLimit-Limit': rlResult.limit.toString(),
            'X-RateLimit-Remaining': rlResult.remaining.toString(),
            'X-RateLimit-Reset': rlResult.reset.toString(),
        });

        if (!rlResult.ok) {
            edgeLogger.warn('Rate limit exceeded', { component: 'rate-limit', tier, pathname });
            rlHeaders.set('Retry-After', rlResult.retryAfter.toString());

            // Return appropriate 429 response structure
            return {
                ok: false,
                response: NextResponse.json(
                    { error: 'RATE_LIMITED', retryAfterSeconds: rlResult.retryAfter },
                    { status: 429, headers: rlHeaders }
                )
            };
        }

        return { ok: true, headers: rlHeaders };

    } catch (error) {
        // GLOBAL CIRCUIT BREAKER
        // If everything crashes (e.g. Upstash offline), we fail-open so people can still login to the SaaS.
        edgeLogger.error('Rate limit exception, failing open', { component: 'rate-limit', err: String(error) });
        return { ok: true };
    }
}

/**
 * Edge-runtime read-rate-limit for tenant-scoped GET API routes.
 *
 * GAP-17. The preset (`API_READ_LIMIT`) lives in
 * `src/lib/security/rate-limit.ts` so all rate-limit budgets share
 * one source of truth. This module is the Edge-runtime *enforcement*
 * surface: it mirrors `authRateLimit.ts` (same Upstash + in-memory
 * fallback shape, same fail-open posture) and is invoked from
 * `src/middleware.ts` before tenant-scoped GETs reach a route
 * handler.
 *
 * Why a separate module from authRateLimit:
 *   - Different bucket key (tenant-scoped vs auth-flow-scoped).
 *   - Different exclusion logic (health/docs paths).
 *   - Different limits (120/min vs 10/30/60 by auth tier).
 *   Sharing one file would force a switch on `pathname` that smears
 *   two unrelated policies together.
 *
 * Why no preset re-export here: the limit values are a runtime
 * construction concern and live in `src/lib/security/rate-limit.ts`
 * with the rest of the presets (`API_MUTATION_LIMIT`,
 * `LOGIN_LIMIT`, …). Importing the constant here keeps the numbers
 * in one place; if a future PR tunes the limit, it lands in the
 * presets file and this module picks it up automatically.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from '@/env';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';
import { isPersonPath } from '@/lib/auth/guard';
import { edgeLogger } from '@/lib/observability/edge-logger';

// ─── Exclusions ─────────────────────────────────────────────────────
//
// Paths that the read-tier MUST NOT throttle even when matched by
// the GET-on-/api shape. Keep this list narrow and exact-match-prefix
// — overbroad exclusions would create gaps in the rate-limit shield.

const EXCLUDED_PATHS: readonly string[] = [
    // Health/probe endpoints — operators need these to work even
    // when an attacker is hammering the API.
    '/api/health',
    '/api/livez',
    '/api/readyz',
    // Future API documentation surface (per GAP-17 spec). Not a
    // current route, but listing here means adding it later doesn't
    // require touching this module.
    '/api/docs',
    // P5.6a gave this route its own inline `enforceRateLimit` with a tighter
    // budget, because a GET cannot reach the mutation tier
    // (`resolveRateLimitScope` returns null outside MUTATION_METHODS). Letting
    // the read tier apply as well would mean two budgets on one route, the
    // looser one invisible — and an Art 15 export is the wrong place to
    // economise on requests.
    '/api/account/export',
];

/**
 * Match logic for the read tier. Exposed for tests + reuse — the
 * middleware calls this to decide whether to invoke the rate-limit
 * check at all.
 *
 * Subject to throttle:
 *   - GET requests on /api/t/<slug>/...
 *
 * Not subject:
 *   - Non-GET methods (mutations have their own tier via withApiErrorHandling)
 *   - Anything not under /api/t/
 *   - Anything in EXCLUDED_PATHS (health probes, /api/docs)
 *   - Vector-tile requests (`.pbf`) — see below
 *
 * The exclusion check uses prefix-match against `path` or `path + '/'`
 * so `/api/health` matches but `/api/healthcheck` does not.
 */
/**
 * A person-scoped API read — `/api/me/`, `/api/social/`, `/api/account/`.
 *
 * Derived from `isPersonPath` rather than restated, so the two cannot drift:
 * that predicate also drives the Edge MFA and terms gates, and a read tier
 * covering a different set from the gate beside it is the asymmetry P1.6
 * exists to remove. Pages (`/account/`, `/onboarding/`) are excluded here —
 * `isApiRoute` keeps this to API traffic, because a page load is not an API
 * read and throttling navigation at 120/min would be a different decision.
 */
function isPersonApiPath(pathname: string): boolean {
    return pathname.startsWith('/api/') && isPersonPath(pathname);
}

export function isApiReadRateLimited(method: string, pathname: string): boolean {
    if (method !== 'GET') return false;
    // P1.6 (#1192) — PERSON-scoped API reads are covered too. They were not,
    // and the omission had the same shape as the MFA one P1.6 already fixed:
    // this predicate required an `/api/t/` prefix, so `/api/me/`,
    // `/api/social/` and (since the widening) `/api/account/` had NO read tier
    // at all. The mutation tier lives in `withApiErrorHandling` and covers
    // their writes; nothing covered their reads.
    //
    // Same preset as the tenant tier, which is what "parity" means here — one
    // budget, two populations, rather than a second number to keep aligned.
    if (!pathname.startsWith('/api/t/') && !isPersonApiPath(pathname)) return false;
    // Map vector tiles (`/locations/:id/tiles/:z/:x/:y.pbf`) are still
    // auth'd + tenant-scoped (the middleware's JWT + tenant-access gate runs
    // first) and are browser/edge-cacheable, but they fire in bursts during
    // pan/zoom. Throttling them at 120/min would tear holes in the map.
    // `.pbf` is the only tile surface, so a suffix match is exact + narrow.
    if (pathname.endsWith('.pbf')) return false;
    for (const excluded of EXCLUDED_PATHS) {
        if (pathname === excluded || pathname.startsWith(excluded + '/')) {
            return false;
        }
    }
    return true;
}

/**
 * Extract the tenant slug from a `/api/t/<slug>/...` path.
 * Returns null when the shape doesn't match (caller should never
 * call this for non-tenant paths; we return null defensively rather
 * than throwing so the middleware path stays simple).
 */
export function extractTenantSlug(pathname: string): string | null {
    const m = pathname.match(/^\/api\/t\/([^/]+)/);
    return m ? m[1] : null;
}

// ─── Upstash + memory-fallback infrastructure ──────────────────────
//
// Mirrors authRateLimit.ts: Upstash for production multi-replica
// correctness, in-memory Map for local dev / test. Same fail-open
// posture — Upstash outage doesn't take down the API.

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
                API_READ_LIMIT.maxAttempts,
                `${API_READ_LIMIT.windowMs} ms`,
            ),
            prefix: 'rl:api-read',
        });
    } catch (err) {
        edgeLogger.error('Failed to initialize Upstash for API read rate limit', {
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
 * Build the read-tier key.
 *
 *   rl:api-read:t:<tenantSlug>:ip:<ip>:u:<userId|anon>
 *
 * Tenant-slug is part of the key namespace so a user with the same
 * IP across two tenants gets two independent budgets. Per-tenant
 * scoping is the spec; per-user-per-tenant is more precise without
 * making one user starve coworkers.
 */
function buildKey(tenantSlug: string | null, ip: string, userId: string | null): string {
    // `person` rather than `unknown` for a person-scoped read (#1192). The
    // namespace is honest about what it is: `unknown` would conflate "this
    // request has no tenant BY DESIGN" with "a tenant path whose slug would
    // not parse", and those want different answers if either ever has to be
    // read off a dashboard.
    return `rl:api-read:t:${tenantSlug ?? 'person'}:ip:${ip}:u:${userId ?? 'anon'}`;
}

interface ReadCheck {
    ok: boolean;
    limit: number;
    remaining: number;
    /** Unix-ms timestamp at which the window resets. */
    reset: number;
    /** Seconds until the window resets (1+ when blocked). */
    retryAfter: number;
}

function checkMemory(key: string): ReadCheck {
    const now = Date.now();
    let record = _memoryCache.get(key);
    if (!record || now > record.resetAt) {
        record = { count: 0, resetAt: now + API_READ_LIMIT.windowMs };
    }
    record.count++;
    _memoryCache.set(key, record);
    const remaining = Math.max(0, API_READ_LIMIT.maxAttempts - record.count);
    const ok = record.count <= API_READ_LIMIT.maxAttempts;
    return {
        ok,
        limit: API_READ_LIMIT.maxAttempts,
        remaining,
        reset: record.resetAt,
        retryAfter: ok ? 0 : Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
    };
}

// Test-only — clears the memory store. Exported via a defined name
// rather than re-exposing _memoryCache so the production callsites
// can't reach it accidentally.
export function _clearApiReadRateLimitMemory(): void {
    _memoryCache.clear();
    _initialized = false;
    _limiter = null;
}

/**
 * Bypass predicate. Mirror of `authRateLimit.ts`'s gates so the
 * read tier honours the same operator + test escape hatches and
 * doesn't surprise contributors who already know the convention.
 */
function isBypassed(): boolean {
    if (env.RATE_LIMIT_ENABLED === '0') return true;
    if (env.AUTH_TEST_MODE === '1') return true;
    if (process.env.NEXT_TEST_MODE === '1') return true;
    return false;
}

export interface ApiReadRateLimitResult {
    ok: boolean;
    /** Pre-built 429 response when blocked; absent when allowed. */
    response?: NextResponse;
}

/**
 * Enforce the read-tier rate limit. Called from middleware after
 * the JWT is verified and the tenant-access gate has passed.
 *
 * Fail-open: if Upstash throws, we let the request through and log
 * it. Same posture as authRateLimit — a Redis outage shouldn't
 * brown out the API.
 */
export async function checkApiReadRateLimit(
    req: NextRequest,
    userId: string | null,
    tenantSlug: string | null,
): Promise<ApiReadRateLimitResult> {
    if (isBypassed()) return { ok: true };

    init();
    const ip = getClientIp(req);
    const key = buildKey(tenantSlug, ip, userId);

    let check: ReadCheck;
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
                retryAfter: r.success
                    ? 0
                    : Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)),
            };
        }
    } catch (err) {
        edgeLogger.error('API read rate limit exception, failing open', {
            component: 'rate-limit',
            err: String(err),
        });
        return { ok: true };
    }

    if (!check.ok) {
        edgeLogger.warn('API read rate limit exceeded', {
            component: 'rate-limit',
            scope: 'api-read',
            tenantSlug: tenantSlug ?? '(unknown)',
            // Don't log the IP at warn level — it's PII. The
            // request-id stamped by middleware on every response
            // ties this back to the offending caller in logs.
        });
        return {
            ok: false,
            response: NextResponse.json(
                {
                    error: {
                        code: 'RATE_LIMITED',
                        scope: 'api-read',
                        message: `Too many read requests. Retry after ${check.retryAfter} seconds.`,
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

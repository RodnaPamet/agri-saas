/**
 * Epic A.2 — Global API rate-limiting middleware.
 *
 * Thin layer on top of `src/lib/security/rate-limit.ts`. Provides:
 *
 *   1. A canonical IP extractor that walks the standard fallback
 *      chain (`x-forwarded-for` → `x-real-ip` → Next's own
 *      `request.ip` → `'unknown'`).
 *   2. A keying strategy: `<scope>:ip:<ip>:<actor>` where `actor`
 *      is `u:<userId>` when authenticated, `anon` otherwise. This
 *      ensures authenticated users get their own budget per (IP,
 *      user) pair while anonymous traffic shares a per-IP bucket.
 *   3. `enforceRateLimit(req, ctx)` — returns a canonical 429
 *      response (RFC-compliant `Retry-After` header + safe JSON body)
 *      when the budget is exhausted, `null` otherwise.
 *   4. `withRateLimit(handler, opts)` — route-handler higher-order
 *      wrapper for declarative use in Next.js route files.
 *
 * The middleware is intentionally NOT edge-compatible. Next.js
 * middleware running on the Edge runtime uses `authRateLimit.ts`
 * (Upstash-backed); this module runs inside Node route handlers
 * where the in-memory sliding-window limiter from
 * `rate-limit.ts` is appropriate and already in use for MFA.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
    type RateLimitConfig,
    type RateLimitResult,
} from './rate-limit';
import { checkRateLimitDistributed } from '@/lib/rate-limit/mutationRateLimit';
import { logger } from '@/lib/observability/logger';

// ─── Types ───────────────────────────────────────────────────────────

export interface RateLimitScope {
    /**
     * Logical namespace for the key. Pick a stable, low-cardinality
     * string per protected surface (e.g. `'login'`, `'api-mutation'`,
     * `'api-key-create'`). Namespacing ensures budgets from one flow
     * don't bleed into another.
     */
    scope: string;

    /** The preset policy — e.g. `LOGIN_LIMIT`, `API_MUTATION_LIMIT`. */
    config: RateLimitConfig;

    /**
     * Authenticated user id when available. When omitted, the key
     * degrades to IP-only (`anon` bucket), which is the correct
     * pre-authentication behaviour.
     */
    userId?: string | null;

    /**
     * Optional override for the client IP. Useful in tests and for
     * trusted upstreams that provide a verified client IP. When
     * omitted, extracted from the request.
     */
    ip?: string;
}

export interface RateLimitEnforcement {
    /** The key actually used (for debugging + metrics). */
    key: string;
    /** Raw sliding-window result. */
    result: RateLimitResult;
    /** Present if the request was blocked — ready to return from the handler. */
    response?: NextResponse;
}

// ─── IP extraction ───────────────────────────────────────────────────

/**
 * Canonical client-IP extractor. Walks the standard fallback chain:
 *
 *   1. `x-forwarded-for` first value (trust upstream proxy; matches
 *      what the rest of the codebase already does in context.ts /
 *      csp-report route).
 *   2. `x-real-ip` (nginx-style single-value header).
 *   3. `request.ip` (Next.js-provided; present in edge + some deploys).
 *   4. `'unknown'` sentinel — the middleware will still track the
 *      bucket, just with all unknown-IP traffic pooled together.
 *
 * Returning `'unknown'` rather than throwing keeps the middleware
 * usable in weird environments (tests, CLI tools, local dev without
 * a proxy) at the cost of a shared bucket. Production deployments
 * behind a proxy always have `x-forwarded-for`.
 */
export function getClientIp(req: NextRequest | Request): string {
    const headers = req.headers;
    const forwarded = headers.get('x-forwarded-for');
    if (forwarded) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) return first;
    }
    const realIp = headers.get('x-real-ip');
    if (realIp) return realIp.trim();

    // Next.js provides `ip` on NextRequest; guard for plain Request.
    const maybeReq = req as NextRequest & { ip?: string };
    if (typeof maybeReq.ip === 'string' && maybeReq.ip) return maybeReq.ip;

    return 'unknown';
}

// ─── Key builder ─────────────────────────────────────────────────────

/**
 * Build the canonical rate-limit key.
 *
 *   <scope>:ip:<ip>:u:<userId>   → authenticated
 *   <scope>:ip:<ip>:anon         → unauthenticated
 *
 * Keeping the scope first makes grep/log-filtering easy; keeping the
 * IP before userId means a run of auth failures from a single IP
 * (spraying usernames) clusters under one IP prefix.
 *
 * CGNAT rationale — DO NOT "simplify" the authenticated key to IP-only.
 * This is a mobile-first product: most users arrive over carrier
 * networks, where carrier-grade NAT puts *thousands* of unrelated
 * subscribers behind ONE public IPv4. The `u:<userId>` component is
 * what gives each authenticated mobile user their OWN bucket — drop it
 * and a single busy user (or one abuser) behind a carrier NAT would
 * throttle every other subscriber sharing that egress IP. The `anon`
 * (pre-authentication) bucket is necessarily IP-only, which is correct
 * there because there is no identity yet; every authenticated preset
 * MUST keep the userId.
 */
export function buildRateLimitKey(
    scope: string,
    ip: string,
    userId?: string | null,
): string {
    const actor = userId ? `u:${userId}` : 'anon';
    return `${scope}:ip:${ip}:${actor}`;
}

// ─── Response shape ──────────────────────────────────────────────────

/**
 * Build a 429 response following RFC 7231 / 6585:
 *   - status 429
 *   - `Retry-After` header (integer seconds)
 *   - `X-RateLimit-*` informational headers
 *   - application/json body with a stable `error.code` for clients
 *
 * Never includes the key itself or the caller's IP in the body — log
 * them instead. The caller gets enough info to back off intelligently
 * and nothing extra.
 */
function buildTooManyRequestsResponse(
    scope: string,
    config: RateLimitConfig,
    result: RateLimitResult,
): NextResponse {
    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    const resetAt = Math.floor((Date.now() + result.retryAfterMs) / 1000);

    const headers = new Headers({
        'Retry-After': String(retryAfterSeconds),
        'X-RateLimit-Limit': String(config.maxAttempts),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(resetAt),
    });

    return NextResponse.json(
        {
            error: {
                code: 'RATE_LIMITED',
                message: `Too many requests. Retry after ${retryAfterSeconds} seconds.`,
                retryAfterSeconds,
                scope,
            },
        },
        { status: 429, headers },
    );
}

// ─── Enforcement ─────────────────────────────────────────────────────

/**
 * Check and record a rate-limit attempt.
 *
 *   - Returns `{ response: NextResponse, ... }` when the budget is
 *     exhausted. Hand it back from your route handler directly.
 *   - Returns `{ response: undefined, ... }` when the request should
 *     proceed. The `result` field still contains the remaining budget
 *     (for optional informational headers on the success path).
 *
 * Every invocation (allowed or blocked) emits a `debug` log line on
 * success and a `warn` on block, so abuse patterns show up in the
 * standard log stream without per-route wiring.
 */
export async function enforceRateLimit(
    req: NextRequest | Request,
    scope: RateLimitScope,
): Promise<RateLimitEnforcement> {
    const ip = scope.ip ?? getClientIp(req);
    const key = buildRateLimitKey(scope.scope, ip, scope.userId ?? null);
    // Distributed by default (Upstash sliding window, ONE round-trip); falls
    // back to the in-process Map when no Upstash env is configured.
    const result = await checkRateLimitDistributed(key, scope.config);

    if (!result.allowed) {
        logger.warn('rate-limit.blocked', {
            component: 'rate-limit-middleware',
            scope: scope.scope,
            ip,
            hasUserId: !!scope.userId,
            retryAfterMs: result.retryAfterMs,
        });
        return {
            key,
            result,
            response: buildTooManyRequestsResponse(scope.scope, scope.config, result),
        };
    }

    logger.debug('rate-limit.allowed', {
        component: 'rate-limit-middleware',
        scope: scope.scope,
        ip,
        hasUserId: !!scope.userId,
        remaining: result.remaining,
    });

    return { key, result };
}

// ─── Route-handler wrapper ───────────────────────────────────────────

export interface WithRateLimitOptions {
    /** Logical namespace for the key. */
    scope: string;
    /** The preset policy. */
    config: RateLimitConfig;
    /**
     * Resolver for the authenticated user id. Called before the
     * handler; if it throws or returns null/undefined, the request is
     * rate-limited by IP alone. Call order: userId resolver → IP
     * extraction → limit check → handler.
     */
    getUserId?: (req: NextRequest) => string | null | undefined | Promise<string | null | undefined>;
}

/**
 * Wrap a Next.js route handler with rate-limit enforcement. The
 * wrapped handler short-circuits to a 429 response when the budget is
 * exhausted; otherwise it runs as normal and the rate-limiter has
 * already recorded the attempt.
 *
 * @example
 *   export const POST = withRateLimit(async (req) => {
 *     const session = await auth();
 *     // ... handler body
 *     return NextResponse.json({ ok: true });
 *   }, {
 *     scope: 'api-mutation',
 *     config: API_MUTATION_LIMIT,
 *     getUserId: async (req) => (await auth())?.user?.id,
 *   });
 */
export function withRateLimit<Args extends unknown[]>(
    handler: (req: NextRequest, ...args: Args) => Promise<Response> | Response,
    options: WithRateLimitOptions,
): (req: NextRequest, ...args: Args) => Promise<Response> {
    return async (req: NextRequest, ...args: Args) => {
        let userId: string | null | undefined;
        if (options.getUserId) {
            try {
                userId = await options.getUserId(req);
            } catch {
                // Failure to resolve a user id falls back to anon.
                // The handler itself will re-authenticate and can
                // reject the request properly if needed.
                userId = null;
            }
        }

        const { response } = await enforceRateLimit(req, {
            scope: options.scope,
            config: options.config,
            userId,
        });
        if (response) return response;

        return handler(req, ...args);
    };
}

// ─── Bypass predicate ────────────────────────────────────────────────

/**
 * True when the current process should skip rate limiting.
 *
 *   - `RATE_LIMIT_ENABLED=0` — explicit operator override for the
 *     whole process.
 *   - `AUTH_TEST_MODE=1` — Playwright / e2e webserver runs with this
 *     set. Next.js dev mode reasserts `NODE_ENV=development` at
 *     startup even when we launched it with `NODE_ENV=test`, so we
 *     can't rely on NODE_ENV alone for the e2e-server bypass.
 *   - `NEXT_TEST_MODE=1` — same shape, belt-and-braces.
 *   - `NODE_ENV=test` AND not explicitly opted-in (`RATE_LIMIT_ENABLED=1`)
 *     — Jest suites hit mutation endpoints in tight loops; a specific
 *     test can opt back in per-process to exercise the limiter itself
 *     (Epic A.2/A.3 suites do this).
 *
 * Read via `process.env` directly (not through `src/env.ts`) so tests
 * can flip the toggle mid-process via env mutation. The validated `env`
 * snapshot is captured at first import and wouldn't pick up per-test
 * flips.
 */
export function isRateLimitBypassed(): boolean {
    if (process.env.RATE_LIMIT_ENABLED === '0') return true;
    if (process.env.AUTH_TEST_MODE === '1') return true;
    if (process.env.NEXT_TEST_MODE === '1') return true;
    if (
        process.env.NODE_ENV === 'test' &&
        process.env.RATE_LIMIT_ENABLED !== '1'
    ) {
        return true;
    }
    return false;
}

// ─── Re-exports ──────────────────────────────────────────────────────
//
// Convenience re-exports so callers can import everything they need
// from this one module.

export {
    checkRateLimitDistributed,
    resetRateLimitDistributed,
} from '@/lib/rate-limit/mutationRateLimit';
export {
    checkRateLimit,
    resetRateLimit,
    clearAllRateLimits,
    LOGIN_LIMIT,
    API_MUTATION_LIMIT,
    API_READ_LIMIT,
    API_KEY_CREATE_LIMIT,
    EMAIL_DISPATCH_LIMIT,
    MFA_VERIFY_LIMIT,
    MFA_ENROLL_VERIFY_LIMIT,
    TENANT_INVITE_CREATE_LIMIT,
    INVITE_REDEEM_LIMIT,
    EXCHANGE_LISTING_CREATE_LIMIT,
    EXCHANGE_INQUIRY_LIMIT,
    KNOWLEDGE_ASK_LIMIT,
} from './rate-limit';
export type { RateLimitConfig, RateLimitResult } from './rate-limit';

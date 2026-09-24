/**
 * Shared primitives for the Edge rate-limit tiers that defend an
 * ANONYMOUS-at-the-Edge credential comparison.
 *
 * ## Why this exists
 *
 * Two surfaces are public at the Edge because their credential is something
 * `getToken()` cannot verify — an opaque hashed bearer compared against the
 * database. SCIM was the first (`scimRateLimit.ts`); tenant API keys are the
 * second (`apiKeyRateLimit.ts`). Both need the identical mechanism: two
 * sliding-window buckets, one keyed on a fingerprint of the presented bearer
 * and one on the client IP, with an in-memory fallback when Upstash is not
 * configured and a fail-open on backend error.
 *
 * The mechanism was written once for SCIM and is extracted here rather than
 * copied, because the parts that are easy to get subtly wrong — hashing the
 * bearer out of the key, reporting the bucket that actually blocked so
 * `Retry-After` is honest, failing open rather than closed — should have one
 * implementation and one set of tests, not two that drift.
 *
 * What is NOT shared is the decision of which requests a tier claims, or its
 * budget. Those differ per surface and stay in the tier's own module.
 *
 * `scimRateLimit.ts` still carries its own copy of these primitives. It is not
 * migrated here in the same change that opens a new authentication path: that
 * PR is security-sensitive enough without also rewriting the limiter already
 * defending provisioning. The migration is mechanical and its existing tests
 * (`tests/unit/scim-rate-limit*.test.ts`) are the oracle for doing it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/env';
import type { RateLimitConfig } from '@/lib/security/rate-limit';

export interface Bucket {
    ok: boolean;
    limit: number;
    remaining: number;
    reset: number;
    retryAfter: number;
}

/**
 * The operator and test escape hatches every tier honours.
 *
 * Kept identical across tiers on purpose: a deployment that disables rate
 * limiting to debug an incident must not be left with one tier still firing.
 */
export function isRateLimitBypassed(): boolean {
    if (env.RATE_LIMIT_ENABLED === '0') return true;
    if (env.AUTH_TEST_MODE === '1') return true;
    if (process.env.NEXT_TEST_MODE === '1') return true;
    return false;
}

export function getClientIp(req: NextRequest): string {
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
 * use a cheap synchronous non-cryptographic hash: the requirement is "distinct
 * tokens get distinct buckets and the raw secret never lands in a key", not
 * collision resistance. A rate-limit key is a cache key that can end up in
 * logs and in Redis; a live credential must not. A collision merely makes two
 * callers share a budget, which the per-IP ceiling already tolerates.
 */
export function fingerprintBearer(header: string | null): string {
    if (!header) return 'none';
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (!token) return 'none';
    let h = 5381;
    for (let i = 0; i < token.length; i++) {
        h = ((h << 5) + h + token.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

/** In-memory sliding window, used when Upstash is not configured. */
export function checkMemoryBucket(
    store: Map<string, { count: number; resetAt: number }>,
    key: string,
    cfg: RateLimitConfig,
): Bucket {
    const now = Date.now();
    let record = store.get(key);
    if (!record || now > record.resetAt) {
        record = { count: 0, resetAt: now + cfg.windowMs };
    }
    record.count++;
    store.set(key, record);
    const ok = record.count <= cfg.maxAttempts;
    return {
        ok,
        limit: cfg.maxAttempts,
        remaining: Math.max(0, cfg.maxAttempts - record.count),
        reset: record.resetAt,
        retryAfter: ok ? 0 : Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
    };
}

/** Normalise an Upstash result into the shape both tiers report on. */
export function toBucket(r: {
    success: boolean;
    limit: number;
    remaining: number;
    reset: number;
}): Bucket {
    return {
        ok: r.success,
        limit: r.limit,
        remaining: r.remaining,
        reset: r.reset,
        retryAfter: r.success ? 0 : Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)),
    };
}

/**
 * The 429 both tiers serve.
 *
 * The body names neither the IP nor the token, per the repo's rate-limit
 * convention — a 429 is served to whoever asked, including an attacker, and
 * must not confirm anything about what they sent. `blocking` is whichever
 * bucket actually refused, so `Retry-After` is honest rather than the shorter
 * of the two.
 */
export function rateLimitedResponse(blocking: Bucket): NextResponse {
    return NextResponse.json(
        { error: 'Too many requests' },
        {
            status: 429,
            headers: {
                'Retry-After': String(blocking.retryAfter),
                'X-RateLimit-Limit': String(blocking.limit),
                'X-RateLimit-Remaining': String(blocking.remaining),
                // SECONDS, matching `scimRateLimit.ts` and the rest of the
                // repo's 429s. `Bucket.reset` is an epoch in MILLIseconds, so
                // the division is not incidental — emitting the raw value
                // would tell a client to wait ~1000x too long.
                'X-RateLimit-Reset': String(Math.ceil(blocking.reset / 1000)),
            },
        },
    );
}

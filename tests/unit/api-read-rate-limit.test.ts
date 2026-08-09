/**
 * GAP-17: read-tier rate limit for tenant-scoped GET API routes.
 *
 * Two surfaces under test:
 *   1. `isApiReadRateLimited(method, pathname)` — match logic, the
 *      cheap predicate the middleware calls before doing any work.
 *   2. `checkApiReadRateLimit(req, userId, tenantSlug)` — the actual
 *      enforcement, exercised against the in-memory fallback (the
 *      Upstash path is the same logic from a calling-API perspective).
 */
import type { NextRequest } from 'next/server';

// ─── Stable env BEFORE the module loads. ───
//
// `apiReadRateLimit.ts` reads `env.RATE_LIMIT_MODE` and the bypass
// gates at first invocation. Forcing memory mode here pins the
// limiter to the in-process Map so tests don't try to reach
// Upstash and so we can drive it deterministically.
process.env.RATE_LIMIT_MODE = 'memory';
delete process.env.RATE_LIMIT_ENABLED;
delete process.env.AUTH_TEST_MODE;
delete process.env.NEXT_TEST_MODE;

import {
    isApiReadRateLimited,
    extractTenantSlug,
    checkApiReadRateLimit,
    _clearApiReadRateLimitMemory,
} from '@/lib/rate-limit/apiReadRateLimit';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';

function fakeReq(headers: Record<string, string> = {}): NextRequest {
    // We only need the .headers.get() shape — NextRequest in tests
    // is awkward to construct. A minimal mock that matches the
    // signature is fine for our purposes.
    return {
        headers: {
            get: (name: string) => headers[name.toLowerCase()] ?? null,
        },
    } as unknown as NextRequest;
}

describe('isApiReadRateLimited (match logic)', () => {
    it('matches GET on /api/t/<slug>/<resource>', () => {
        expect(isApiReadRateLimited('GET', '/api/t/acme-corp/practices')).toBe(true);
        expect(isApiReadRateLimited('GET', '/api/t/acme-corp/risks?limit=50')).toBe(true);
        expect(isApiReadRateLimited('GET', '/api/t/acme-corp/evidence/abc123')).toBe(true);
    });

    it('does NOT match non-GET methods (mutations have their own tier)', () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
            expect(isApiReadRateLimited(method, '/api/t/acme-corp/practices')).toBe(false);
        }
    });

    it('does NOT match GETs outside /api/t/', () => {
        expect(isApiReadRateLimited('GET', '/api/auth/csrf')).toBe(false);
        expect(isApiReadRateLimited('GET', '/api/admin/tenants')).toBe(false);
        expect(isApiReadRateLimited('GET', '/api/org/acme/portfolio')).toBe(false);
        expect(isApiReadRateLimited('GET', '/dashboard')).toBe(false);
        expect(isApiReadRateLimited('GET', '/')).toBe(false);
    });

    it('excludes /api/health (and the modern livez/readyz aliases)', () => {
        expect(isApiReadRateLimited('GET', '/api/health')).toBe(false);
        expect(isApiReadRateLimited('GET', '/api/livez')).toBe(false);
        expect(isApiReadRateLimited('GET', '/api/readyz')).toBe(false);
        // Defensive: no false-positive on /api/healthcheck (similar prefix).
        // healthcheck doesn't start with /api/t/, so it's already excluded
        // by the primary gate, but if a future PR widens the matcher this
        // assertion catches an accidental over-exclusion of /api/health*.
        expect(isApiReadRateLimited('GET', '/api/healthcheck')).toBe(false);
    });

    it('excludes /api/docs', () => {
        expect(isApiReadRateLimited('GET', '/api/docs')).toBe(false);
        expect(isApiReadRateLimited('GET', '/api/docs/openapi.json')).toBe(false);
    });
});

describe('extractTenantSlug', () => {
    it('returns the slug for tenant-scoped paths', () => {
        expect(extractTenantSlug('/api/t/acme-corp/practices')).toBe('acme-corp');
        expect(extractTenantSlug('/api/t/with-dashes/risks?q=foo')).toBe('with-dashes');
    });

    it('returns null when the path does not match the shape', () => {
        expect(extractTenantSlug('/api/health')).toBe(null);
        expect(extractTenantSlug('/api/admin/tenants')).toBe(null);
        expect(extractTenantSlug('/dashboard')).toBe(null);
    });
});

describe('checkApiReadRateLimit (memory mode)', () => {
    beforeEach(() => {
        _clearApiReadRateLimitMemory();
        // Re-pin the env state — earlier tests may have leaked changes.
        process.env.RATE_LIMIT_MODE = 'memory';
        delete process.env.RATE_LIMIT_ENABLED;
        delete process.env.AUTH_TEST_MODE;
        delete process.env.NEXT_TEST_MODE;
    });

    it('allows requests up to the configured threshold', async () => {
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.1' });
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            const result = await checkApiReadRateLimit(req, 'user-1', 'acme-corp');
            expect(result.ok).toBe(true);
            expect(result.response).toBeUndefined();
        }
    });

    it('returns 429 with Retry-After once the threshold is exceeded', async () => {
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.1' });
        // Burn the budget.
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            await checkApiReadRateLimit(req, 'user-1', 'acme-corp');
        }

        const result = await checkApiReadRateLimit(req, 'user-1', 'acme-corp');

        expect(result.ok).toBe(false);
        expect(result.response).toBeDefined();
        expect(result.response!.status).toBe(429);

        const body = await result.response!.json();
        expect(body.error.code).toBe('RATE_LIMITED');
        expect(body.error.scope).toBe('api-read');
        expect(body.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);

        // RFC-compliant Retry-After + informational X-RateLimit-* headers.
        expect(result.response!.headers.get('Retry-After')).toMatch(/^\d+$/);
        expect(result.response!.headers.get('X-RateLimit-Limit')).toBe(
            String(API_READ_LIMIT.maxAttempts),
        );
        expect(result.response!.headers.get('X-RateLimit-Remaining')).toBe('0');
        expect(result.response!.headers.get('X-RateLimit-Reset')).toMatch(/^\d+$/);

        // Sensitive data MUST NOT appear in the response.
        const bodyStr = JSON.stringify(body);
        expect(bodyStr).not.toContain('203.0.113.1');
        expect(bodyStr).not.toContain('user-1');
    });

    it('isolates buckets per (tenant, user) — one user does not starve another', async () => {
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.1' });
        // Burn user-1's budget.
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            await checkApiReadRateLimit(req, 'user-1', 'acme-corp');
        }

        // user-1 is now blocked.
        const blocked = await checkApiReadRateLimit(req, 'user-1', 'acme-corp');
        expect(blocked.ok).toBe(false);

        // user-2 on the SAME IP and SAME tenant still has full budget.
        const otherUser = await checkApiReadRateLimit(req, 'user-2', 'acme-corp');
        expect(otherUser.ok).toBe(true);
    });

    it('isolates buckets per tenant — same user across tenants is independent', async () => {
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.1' });
        // Burn user-1's budget in tenant A.
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            await checkApiReadRateLimit(req, 'user-1', 'tenant-a');
        }

        const blockedInA = await checkApiReadRateLimit(req, 'user-1', 'tenant-a');
        expect(blockedInA.ok).toBe(false);

        const okInB = await checkApiReadRateLimit(req, 'user-1', 'tenant-b');
        expect(okInB.ok).toBe(true);
    });

    it('falls back to anon bucket when userId is null', async () => {
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.99' });
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            const r = await checkApiReadRateLimit(req, null, 'acme-corp');
            expect(r.ok).toBe(true);
        }
        const blocked = await checkApiReadRateLimit(req, null, 'acme-corp');
        expect(blocked.ok).toBe(false);
    });

    it('respects RATE_LIMIT_ENABLED=0 bypass', async () => {
        process.env.RATE_LIMIT_ENABLED = '0';
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.1' });
        // Pile on far past the threshold — bypass must let everything through.
        for (let i = 0; i < API_READ_LIMIT.maxAttempts * 2; i++) {
            const r = await checkApiReadRateLimit(req, 'user-1', 'acme-corp');
            expect(r.ok).toBe(true);
        }
    });

    it('respects AUTH_TEST_MODE=1 bypass', async () => {
        process.env.AUTH_TEST_MODE = '1';
        const req = fakeReq({ 'x-forwarded-for': '203.0.113.1' });
        for (let i = 0; i < API_READ_LIMIT.maxAttempts * 2; i++) {
            const r = await checkApiReadRateLimit(req, 'user-1', 'acme-corp');
            expect(r.ok).toBe(true);
        }
    });
});

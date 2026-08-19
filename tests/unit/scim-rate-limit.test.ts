/**
 * The SCIM rate limiter — executing tests.
 *
 * `/api/scim/` is public at the Edge (its credential is opaque to `getToken`
 * and the Edge has no database), so it is the one API surface where an
 * anonymous caller reaches a token comparison. Unbudgeted, that is a bearer
 * brute-force oracle.
 *
 * The interesting assertion is the ROTATION one. A per-bearer bucket is the
 * obvious design and it is useless against the attack it looks like it stops:
 * a caller who sends a different guess every request gets a fresh bucket every
 * request and is never limited. Only the per-IP ceiling binds. Both buckets
 * exist for that reason, and this file proves the second one does its job —
 * because a limiter that passes every "one caller, many requests" test and
 * fails the rotation case reads as correct right up until it matters.
 */
import { NextRequest } from 'next/server';

// ─── Stable env BEFORE the module loads ───
//
// Same preamble as tests/unit/api-read-rate-limit.test.ts, for the same two
// reasons. `RATE_LIMIT_MODE` defaults to `upstash` (src/env.ts), so without
// pinning it to memory the limiter builds a real Upstash client and the suite
// spends minutes failing on network calls. And every tier bypasses under
// AUTH_TEST_MODE / NEXT_TEST_MODE, which jest sets — leave those in place and
// this file asserts nothing at all, very quietly.
process.env.RATE_LIMIT_MODE = 'memory';
delete process.env.RATE_LIMIT_ENABLED;
delete process.env.AUTH_TEST_MODE;
delete process.env.NEXT_TEST_MODE;

import {
    checkScimRateLimit,
    isScimRateLimited,
    _clearScimRateLimitMemory,
} from '@/lib/rate-limit/scimRateLimit';
import { SCIM_LIMIT, SCIM_IP_LIMIT } from '@/lib/security/rate-limit';

beforeEach(() => {
    _clearScimRateLimitMemory();
    // Re-pin — an earlier case may have leaked a change.
    process.env.RATE_LIMIT_MODE = 'memory';
    delete process.env.RATE_LIMIT_ENABLED;
});

function req(bearer: string, ip = '203.0.113.7') {
    return new NextRequest('http://localhost:3000/api/scim/v2/Users', {
        method: 'GET',
        headers: { authorization: `Bearer ${bearer}`, 'x-forwarded-for': ip },
    });
}

describe('scope', () => {
    it.each([
        ['/api/scim/v2/Users', true],
        ['/api/scim/v2/Groups/abc', true],
        ['/api/scimulator', false],
        ['/api/t/acme/journal', false],
        ['/api/auth/session', false],
    ] as const)('isScimRateLimited(%s) === %s', (pathname, expected) => {
        // The trailing slash keeps the limiter's scope identical to the
        // carve-out's. Widen one without the other and either an unlimited
        // public path exists, or a limiter throttles a path that is still
        // behind the JWT gate.
        expect(isScimRateLimited(pathname)).toBe(expected);
    });
});

describe('the per-bearer budget', () => {
    it('allows a normal sync and refuses the request past the limit', async () => {
        const bearer = 'scim_tenant_a';
        for (let i = 0; i < SCIM_LIMIT.maxAttempts; i++) {
            const r = await checkScimRateLimit(req(bearer));
            expect(r.ok).toBe(true);
        }
        const blocked = await checkScimRateLimit(req(bearer));
        expect(blocked.ok).toBe(false);
        expect(blocked.response?.status).toBe(429);
    });

    it('does not let one tenant exhaust another tenant', async () => {
        const noisy = 'scim_tenant_a';
        for (let i = 0; i <= SCIM_LIMIT.maxAttempts; i++) await checkScimRateLimit(req(noisy));
        expect((await checkScimRateLimit(req(noisy))).ok).toBe(false);

        // A different bearer from a DIFFERENT IP is untouched. (Same IP would
        // share the ceiling, which is the deliberate trade — see below.)
        const quiet = await checkScimRateLimit(req('scim_tenant_b', '198.51.100.9'));
        expect(quiet.ok).toBe(true);
    });
});

describe('the per-IP ceiling is what stops a brute force', () => {
    it('refuses a caller who rotates a FRESH bearer on every request', async () => {
        // The whole reason two buckets exist. Every request here lands in a
        // brand-new per-bearer bucket, so that limit never binds; only the
        // ceiling does. A single-bucket design passes every other test in this
        // file and fails this one.
        let blockedAt = -1;
        for (let i = 0; i < SCIM_IP_LIMIT.maxAttempts + 5; i++) {
            const r = await checkScimRateLimit(req(`scim_guess_${i}`));
            if (!r.ok) {
                blockedAt = i;
                break;
            }
        }
        expect(blockedAt).toBeGreaterThan(0);
        expect(blockedAt).toBeLessThanOrEqual(SCIM_IP_LIMIT.maxAttempts);
    });

    it('leaves room for more than one legitimate sync from a shared IdP egress IP', async () => {
        // Entra egresses several tenants' syncs from one Microsoft IP pool, so
        // the ceiling must exceed a single tenant's full budget or two innocent
        // tenants would throttle each other.
        expect(SCIM_IP_LIMIT.maxAttempts).toBeGreaterThan(SCIM_LIMIT.maxAttempts);
    });
});

describe('the 429 tells the caller how to behave and nothing else', () => {
    it('carries Retry-After and the standard rate-limit headers', async () => {
        const bearer = 'scim_headers';
        for (let i = 0; i <= SCIM_LIMIT.maxAttempts; i++) await checkScimRateLimit(req(bearer));
        const blocked = await checkScimRateLimit(req(bearer));
        const res = blocked.response!;
        expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(res.headers.get('X-RateLimit-Limit')).toBeTruthy();
        expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
    });

    it('never echoes the IP or the presented bearer', async () => {
        // A 429 is served to whoever asked, attacker included. It must not
        // confirm anything about what they sent — and the bearer is a live
        // provisioning credential.
        const bearer = 'scim_super_secret_value';
        for (let i = 0; i <= SCIM_LIMIT.maxAttempts; i++) await checkScimRateLimit(req(bearer));
        const blocked = await checkScimRateLimit(req(bearer));
        const body = await blocked.response!.text();
        expect(body).not.toContain(bearer);
        expect(body).not.toContain('203.0.113.7');
    });
});

describe('bypass', () => {
    it('honours RATE_LIMIT_ENABLED=0 like every other tier', async () => {
        process.env.RATE_LIMIT_ENABLED = '0';
        _clearScimRateLimitMemory();
        try {
            for (let i = 0; i < SCIM_IP_LIMIT.maxAttempts + 10; i++) {
                expect((await checkScimRateLimit(req('scim_x'))).ok).toBe(true);
            }
        } finally {
            delete process.env.RATE_LIMIT_ENABLED;
        }
    });
});

/**
 * Tests for the tenant-access gate logic (Epic 1, PR 4).
 *
 * Tests the pure `checkTenantAccess` function extracted from middleware so
 * tests are not coupled to Next.js Edge Runtime machinery. The middleware
 * itself wires the result to NextResponse redirects/JSON — those branches
 * are NOT exercised anywhere in this file.
 *
 * This docblock said "those branches are exercised by the E2E suite" until
 * 2026-08-21. They never were: a grep for `no_tenant_access` across
 * `tests/e2e/` returns nothing. What covers them today are executing unit
 * tests that import the real middleware export —
 * `tests/unit/operator-lockdown-enforced.test.ts` and
 * `tests/unit/admin-cross-site-gate-enforced.test.ts`, both from #640.
 *
 * The false claim mattered. The 2026-08-19 enforcement-seam audit found that
 * docblocks asserting non-existent coverage were a principal reason fifteen
 * unenforced seams went unnoticed — one of them even named a test file that
 * has never existed in this repo's history. If you extract another pure helper
 * out of the middleware, name the test that drives the wiring, or say plainly
 * that nothing does.
 *
 * Also tests `extractTenantSlugFromPath` and the updated `isPublicPath`
 * carve-outs for /no-tenant, /invite/, and /api/invites/.
 */

import {
    checkTenantAccess,
    extractTenantSlugFromPath,
    isPublicPath,
} from '@/lib/auth/guard';

describe('extractTenantSlugFromPath', () => {
    it('extracts slug from /t/:slug/dashboard', () => {
        expect(extractTenantSlugFromPath('/t/acme/dashboard')).toBe('acme');
    });

    it('extracts slug from /api/t/:slug/risks', () => {
        expect(extractTenantSlugFromPath('/api/t/acme/risks')).toBe('acme');
    });

    it('extracts slug from bare /t/:slug', () => {
        expect(extractTenantSlugFromPath('/t/acme')).toBe('acme');
    });

    it('returns null for /login', () => {
        expect(extractTenantSlugFromPath('/login')).toBeNull();
    });

    it('returns null for /no-tenant', () => {
        expect(extractTenantSlugFromPath('/no-tenant')).toBeNull();
    });

    it('returns null for /invite/sometoken', () => {
        expect(extractTenantSlugFromPath('/invite/sometoken')).toBeNull();
    });

    it('returns null for /api/invites/sometoken/start-signin', () => {
        expect(extractTenantSlugFromPath('/api/invites/sometoken/start-signin')).toBeNull();
    });
});

describe('isPublicPath — new carve-outs', () => {
    it('/no-tenant is public', () => {
        expect(isPublicPath('/no-tenant')).toBe(true);
    });

    it('/invite/abc123 is public', () => {
        expect(isPublicPath('/invite/abc123')).toBe(true);
    });

    it('/api/invites/abc123 is public', () => {
        expect(isPublicPath('/api/invites/abc123')).toBe(true);
    });

    it('/api/invites/abc123/start-signin is public', () => {
        expect(isPublicPath('/api/invites/abc123/start-signin')).toBe(true);
    });

    it('/t/acme/dashboard is NOT public', () => {
        expect(isPublicPath('/t/acme/dashboard')).toBe(false);
    });

    it('/api/t/acme/risks is NOT public', () => {
        expect(isPublicPath('/api/t/acme/risks')).toBe(false);
    });
});

/**
 * R-1: checkTenantAccess now takes memberships: ReadonlyArray<{slug}> instead
 * of a single string slug. The following tests have been updated to pass the
 * new array shape. All prior behaviours are preserved — the semantic is the
 * same, just the input is an array of one (previously a scalar).
 */
describe('checkTenantAccess', () => {
    it('allows when memberships array contains the URL slug', () => {
        expect(checkTenantAccess('/t/acme/dashboard', [{ slug: 'acme' }])).toBe('allow');
    });

    it('allows API path when memberships array contains the URL slug', () => {
        expect(checkTenantAccess('/api/t/acme/risks', [{ slug: 'acme' }])).toBe('allow');
    });

    it('returns no_tenant_access when memberships is null', () => {
        expect(checkTenantAccess('/t/acme/dashboard', null)).toBe('no_tenant_access');
    });

    it('returns no_tenant_access when memberships is undefined', () => {
        expect(checkTenantAccess('/t/acme/dashboard', undefined)).toBe('no_tenant_access');
    });

    it('returns no_tenant_access when memberships is an empty array', () => {
        expect(checkTenantAccess('/t/acme/dashboard', [])).toBe('no_tenant_access');
    });

    it('returns no_tenant_access for API path when memberships is empty', () => {
        expect(checkTenantAccess('/api/t/acme/risks', [])).toBe('no_tenant_access');
    });

    it('returns cross_tenant when URL slug is not in memberships', () => {
        expect(checkTenantAccess('/t/beta/dashboard', [{ slug: 'acme' }])).toBe('cross_tenant');
    });

    it('returns cross_tenant for API path with slug not in memberships', () => {
        expect(checkTenantAccess('/api/t/beta/risks', [{ slug: 'acme' }])).toBe('cross_tenant');
    });

    it('returns allow for /no-tenant (non-tenant path)', () => {
        expect(checkTenantAccess('/no-tenant', null)).toBe('allow');
    });

    it('returns allow for /login (non-tenant path)', () => {
        expect(checkTenantAccess('/login', null)).toBe('allow');
    });

    it('returns allow for /invite/:token (public, non-tenant path)', () => {
        expect(checkTenantAccess('/invite/sometoken', null)).toBe('allow');
    });

    it('returns allow for /api/invites/:token/start-signin (public path)', () => {
        expect(checkTenantAccess('/api/invites/tok/start-signin', null)).toBe('allow');
    });
});

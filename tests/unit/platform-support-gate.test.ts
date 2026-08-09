/**
 * The platform-support gate (#12).
 *
 * This is the practice standing between one tenant's admins and every other
 * tenant's promotions feed, so the cases that matter are the negative ones —
 * especially the misconfiguration path. `PLATFORM_TENANT_SLUG` unset must make
 * the console unreachable for EVERYONE; a blank value that matched any slug
 * would silently grant every farm owner global write access.
 */
export {};

const mockEnv: { PLATFORM_TENANT_SLUG?: string } = {};

jest.mock('@/env', () => ({
    get env() {
        return mockEnv;
    },
}));

import { isPlatformTenant, assertPlatformSupport } from '@/lib/auth/platform-support';
import { makeRequestContext } from '../helpers/make-context';

const ctxFor = (role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'READER', tenantSlug?: string) =>
    makeRequestContext(role, { userId: 'u-1', tenantId: 't-1', tenantSlug });

beforeEach(() => {
    delete mockEnv.PLATFORM_TENANT_SLUG;
});

describe('fail closed when unconfigured', () => {
    it('denies every tenant when PLATFORM_TENANT_SLUG is unset', () => {
        expect(isPlatformTenant('anything')).toBe(false);
        expect(isPlatformTenant('agrent-platform')).toBe(false);
    });

    it('denies every tenant when the value is blank or whitespace', () => {
        mockEnv.PLATFORM_TENANT_SLUG = '   ';
        expect(isPlatformTenant('agrent-platform')).toBe(false);
        expect(isPlatformTenant('   ')).toBe(false);
        expect(isPlatformTenant('')).toBe(false);
    });

    it('throws for an admin of any tenant when unconfigured', () => {
        expect(() => assertPlatformSupport(ctxFor('OWNER', 'agrent-platform'))).toThrow();
    });
});

describe('when configured', () => {
    beforeEach(() => {
        mockEnv.PLATFORM_TENANT_SLUG = 'agrent-platform';
    });

    it('recognises the designated tenant', () => {
        expect(isPlatformTenant('agrent-platform')).toBe(true);
    });

    it('rejects any other tenant, including near-misses', () => {
        for (const slug of ['acme', 'agrent-platform-2', 'agrent', 'AGRENT-PLATFORM']) {
            expect(isPlatformTenant(slug)).toBe(false);
        }
    });

    it('rejects a missing slug rather than treating it as a match', () => {
        expect(isPlatformTenant(undefined)).toBe(false);
        expect(isPlatformTenant(null)).toBe(false);
    });

    it('admits an admin of the platform tenant', () => {
        expect(() => assertPlatformSupport(ctxFor('OWNER', 'agrent-platform'))).not.toThrow();
        expect(() => assertPlatformSupport(ctxFor('ADMIN', 'agrent-platform'))).not.toThrow();
    });

    it('denies a NON-admin of the platform tenant', () => {
        expect(() => assertPlatformSupport(ctxFor('EDITOR', 'agrent-platform'))).toThrow();
        expect(() => assertPlatformSupport(ctxFor('READER', 'agrent-platform'))).toThrow();
    });

    it('denies the OWNER of another tenant — the escalation this gate exists for', () => {
        expect(() => assertPlatformSupport(ctxFor('OWNER', 'acme'))).toThrow();
    });

    it('reports a foreign tenant as not-found, not forbidden', () => {
        // A 403 would confirm to an unrelated tenant's owner that a
        // global-catalogue console exists to go looking for.
        let thrown: unknown;
        try {
            assertPlatformSupport(ctxFor('OWNER', 'acme'));
        } catch (err) {
            thrown = err;
        }
        expect((thrown as { status?: number }).status).toBe(404);
    });
});

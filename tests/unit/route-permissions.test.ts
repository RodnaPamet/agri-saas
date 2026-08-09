/**
 * Branch coverage for the route → permission resolver (Epic C.1).
 *
 * `resolveRoutePermission` is the runtime arm of the API permission
 * map — it decides which `PermissionKey` a request path + method
 * requires. The branches that matter:
 *
 *   - path regex match vs miss
 *   - method-scoped rules (the MFA-policy PUT-only carve-out)
 *   - rules with no `methods` array (all-method)
 *   - the `mode` default ('all' when a rule omits it)
 *   - the dynamic-tenant-segment regex (`/api/t/<slug>/...`)
 *
 * A wrong branch here either leaves an admin route ungated or
 * denies a legitimate caller — both are security-relevant.
 */
import {
    resolveRoutePermission,
    isRouteCovered,
    ROUTE_PERMISSIONS,
} from '@/lib/security/route-permissions';

describe('resolveRoutePermission', () => {
    it('resolves an admin members route to admin.members', () => {
        const r = resolveRoutePermission(
            '/api/t/acme/admin/members',
            'GET',
        );
        expect(r?.permission).toBe('admin.members');
        expect(r?.mode).toBe('all'); // default applied
    });

    it('matches a nested sub-path under a covered prefix', () => {
        const r = resolveRoutePermission(
            '/api/t/acme/admin/members/user-123',
            'DELETE',
        );
        expect(r?.permission).toBe('admin.members');
    });

    it('returns null for an uncovered tenant route', () => {
        expect(
            resolveRoutePermission('/api/t/acme/practices', 'GET'),
        ).toBeNull();
    });

    it('returns null for a route outside the tenant prefix entirely', () => {
        expect(
            resolveRoutePermission('/api/health', 'GET'),
        ).toBeNull();
    });

    it('works for any tenant slug via the dynamic segment', () => {
        const a = resolveRoutePermission('/api/t/acme/admin/scim', 'POST');
        const b = resolveRoutePermission(
            '/api/t/other-corp/admin/scim',
            'POST',
        );
        expect(a?.permission).toBe('admin.scim');
        expect(b?.permission).toBe('admin.scim');
    });

    it('gates DEK rotation under admin.tenant_lifecycle (OWNER-only key)', () => {
        const r = resolveRoutePermission(
            '/api/t/acme/admin/tenant-dek-rotation',
            'POST',
        );
        expect(r?.permission).toBe('admin.tenant_lifecycle');
    });

    it('gates the GAP-22 short rotate-dek alias identically', () => {
        const r = resolveRoutePermission(
            '/api/t/acme/admin/rotate-dek',
            'POST',
        );
        expect(r?.permission).toBe('admin.tenant_lifecycle');
    });

    // ── Method-scoped rule: the MFA policy carve-out ────────────────

    it('matches the MFA-policy rule for PUT (the gated method)', () => {
        const r = resolveRoutePermission(
            '/api/t/acme/security/mfa/policy',
            'PUT',
        );
        expect(r?.permission).toBe('admin.manage');
    });

    it('does NOT match the MFA-policy rule for GET (intentionally open)', () => {
        const r = resolveRoutePermission(
            '/api/t/acme/security/mfa/policy',
            'GET',
        );
        expect(r).toBeNull();
    });

    it('uppercases a lowercase method before matching', () => {
        const r = resolveRoutePermission(
            '/api/t/acme/security/mfa/policy',
            'put',
        );
        expect(r?.permission).toBe('admin.manage');
    });

    it('matches billing checkout but not an unrelated billing path', () => {
        expect(
            resolveRoutePermission('/api/t/acme/billing/checkout', 'POST')
                ?.permission,
        ).toBe('admin.manage');
        expect(
            resolveRoutePermission('/api/t/acme/billing/unknown', 'POST'),
        ).toBeNull();
    });

    it('returns the matched rule object alongside the permission', () => {
        const r = resolveRoutePermission('/api/t/acme/sso', 'POST');
        expect(r?.rule).toBeDefined();
        expect(r?.rule.note).toContain('SSO');
    });
});

describe('isRouteCovered', () => {
    it('is true for any method when the path matches a rule', () => {
        // MFA policy rule is PUT-scoped, but isRouteCovered ignores method.
        expect(isRouteCovered('/api/t/acme/security/mfa/policy')).toBe(true);
    });

    it('is true for an admin route', () => {
        expect(isRouteCovered('/api/t/acme/admin/roles')).toBe(true);
    });

    it('is false for an uncovered route', () => {
        expect(isRouteCovered('/api/t/acme/risks')).toBe(false);
    });
});

describe('ROUTE_PERMISSIONS invariants', () => {
    it('every rule carries a non-empty note for reviewer context', () => {
        for (const rule of ROUTE_PERMISSIONS) {
            expect(typeof rule.note).toBe('string');
            expect(rule.note.length).toBeGreaterThan(0);
        }
    });

    it('every method-scoped rule uses only canonical uppercase verbs', () => {
        const allowed = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
        for (const rule of ROUTE_PERMISSIONS) {
            if (!rule.methods) continue;
            for (const m of rule.methods) {
                expect(allowed.has(m)).toBe(true);
            }
        }
    });
});

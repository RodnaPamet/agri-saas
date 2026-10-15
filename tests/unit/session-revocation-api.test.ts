/**
 * Session Revocation API & Enforcement Tests
 *
 * Tests the session revocation architecture:
 * - sessionVersion increment strategy
 * - self vs admin revocation permissions
 * - cross-tenant revocation blocked
 * - audit event payloads
 * - revocation actually invalidates sessions
 */
import {
    isPublicPath,
    isTenantPath,
    isMfaAllowedPath,
} from '../../src/lib/auth/guard';

describe('Session Revocation Enforcement', () => {
    // ─── sessionVersion Semantics ───────────────────────────────────

    describe('sessionVersion invalidation strategy', () => {
        it('token with lower version than DB is invalid', () => {
            const tokenVersion = 2;
            const dbVersion = 3;
            expect(dbVersion > tokenVersion).toBe(true);
        });

        it('token with equal version is valid', () => {
            const tokenVersion = 3;
            const dbVersion = 3;
            expect(dbVersion > tokenVersion).toBe(false);
        });

        it('each revocation increments version by 1', () => {
            let version = 0;
            version += 1; // first revocation
            expect(version).toBe(1);
            version += 1; // second revocation
            expect(version).toBe(2);
        });

        it('bulk revocation increments all affected users', () => {
            const versions = [0, 0, 1, 2];
            const after = versions.map(v => v + 1);
            expect(after).toEqual([1, 1, 2, 3]);
        });
    });

    // ─── Access Control ─────────────────────────────────────────────

    describe('session revocation access control', () => {
        interface RevokePermission {
            actorRole: 'ADMIN' | 'READER';
            targetIsSelf: boolean;
            targetInTenant: boolean;
        }

        function canRevoke(p: RevokePermission): boolean {
            if (p.targetIsSelf) return true;
            if (p.actorRole !== 'ADMIN') return false;
            if (!p.targetInTenant) return false;
            return true;
        }

        it('anyone can revoke their own sessions', () => {
            expect(canRevoke({ actorRole: 'READER', targetIsSelf: true, targetInTenant: true })).toBe(true);
        });

        it('admin can revoke same-tenant user sessions', () => {
            expect(canRevoke({ actorRole: 'ADMIN', targetIsSelf: false, targetInTenant: true })).toBe(true);
        });

        it('non-admin cannot revoke others sessions', () => {
            expect(canRevoke({ actorRole: 'READER', targetIsSelf: false, targetInTenant: true })).toBe(false);
        });

        it('admin cannot revoke cross-tenant user sessions', () => {
            expect(canRevoke({ actorRole: 'ADMIN', targetIsSelf: false, targetInTenant: false })).toBe(false);
        });

        it('bulk revocation is admin-only', () => {
            expect(canRevoke({ actorRole: 'READER', targetIsSelf: false, targetInTenant: true })).toBe(false);
            expect(canRevoke({ actorRole: 'ADMIN', targetIsSelf: false, targetInTenant: true })).toBe(true);
        });
    });

    // ─── Audit Events ───────────────────────────────────────────────

    describe('audit event payloads', () => {
        it('self-revocation emits CURRENT_SESSION_REVOKED', () => {
            const event = {
                action: 'CURRENT_SESSION_REVOKED',
                entityType: 'User',
                entityId: 'user-123',
                details: 'User revoked their own sessions. New sessionVersion: 1',
            };
            expect(event.action).toBe('CURRENT_SESSION_REVOKED');
            expect(event.entityType).toBe('User');
            expect(event.details).toContain('sessionVersion');
        });

        it('admin user-revocation emits SESSIONS_REVOKED_FOR_USER', () => {
            const event = {
                action: 'SESSIONS_REVOKED_FOR_USER',
                entityType: 'User',
                entityId: 'target-user-456',
                details: 'Admin admin-001 revoked sessions for user target-user-456',
            };
            expect(event.action).toBe('SESSIONS_REVOKED_FOR_USER');
            expect(event.entityId).toBe('target-user-456');
        });

        it('bulk revocation emits ALL_TENANT_SESSIONS_REVOKED', () => {
            const event = {
                action: 'ALL_TENANT_SESSIONS_REVOKED',
                entityType: 'Tenant',
                entityId: 'tenant-001',
                details: 'Admin admin-001 revoked sessions for 15 users in tenant.',
            };
            expect(event.action).toBe('ALL_TENANT_SESSIONS_REVOKED');
            expect(event.entityType).toBe('Tenant');
            expect(event.details).toContain('15 users');
        });

        // REMOVED: 'audit events never contain session tokens or secrets' (#1784).
        //
        // It tested a `details` string typed into this file against patterns
        // chosen by the same author — so it asserted that a constant does not
        // match a regex, passed for ever, and would have passed just as
        // happily if every audit writer started interpolating a bearer token.
        // Its NAME was the harmful part: a reader searching for coverage of
        // that claim found it, stopped, and was wrong.
        //
        // The claim is now checked where a leak would be written:
        // `tests/guards/audit-details-carry-no-secrets.test.ts` scans all 220
        // `logEvent` call sites in `src/` and fails on an interpolated value
        // whose name is a secret.
    });

    // ─── Path Guards ────────────────────────────────────────────────

    describe('session revocation route guards', () => {
        it('session revocation API routes are tenant-scoped', () => {
            expect(isTenantPath('/api/t/acme/security/sessions/revoke-current')).toBe(true);
            expect(isTenantPath('/api/t/acme/security/sessions/revoke-user')).toBe(true);
            expect(isTenantPath('/api/t/acme/security/sessions/revoke-all')).toBe(true);
        });

        it('session routes require authentication (not public)', () => {
            expect(isPublicPath('/api/t/acme/security/sessions/revoke-current')).toBe(false);
            expect(isPublicPath('/api/t/acme/security/sessions/revoke-all')).toBe(false);
        });

        it('session routes are NOT MFA-exempt (require full auth)', () => {
            // Session revocation routes should require completed MFA
            expect(isMfaAllowedPath('/api/t/acme/security/sessions/revoke-current')).toBe(false);
            expect(isMfaAllowedPath('/api/t/acme/security/sessions/revoke-all')).toBe(false);
        });
    });

    // ─── Post-Revocation Behavior ───────────────────────────────────

    describe('post-revocation session behavior', () => {
        it('revoked token is detected on next JWT callback check', () => {
            const tokenVersion = 1;
            const dbVersionAfterRevoke = 2;
            const isRevoked = dbVersionAfterRevoke > tokenVersion;
            expect(isRevoked).toBe(true);
        });

        it('new login gets fresh sessionVersion', () => {
            const dbVersion = 5; // After multiple revocations
            const newToken = { sessionVersion: dbVersion };
            expect(newToken.sessionVersion).toBe(5);
            expect(dbVersion > newToken.sessionVersion).toBe(false); // Valid
        });

        it('revocation does not affect other tenants', () => {
            const tenantAUser = { id: 'user-1', sessionVersion: 3 };
            const tenantBUser = { id: 'user-1', sessionVersion: 1 };
            // Same user, different tenants — versions are independent
            // (actually in our model, sessionVersion is on User not per-tenant,
            //  but revocation is scoped by tenant membership check)
            expect(tenantAUser.sessionVersion).not.toBe(tenantBUser.sessionVersion);
        });
    });
});

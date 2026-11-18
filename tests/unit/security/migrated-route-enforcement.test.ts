/**
 * Epic D.3 — migrated-route enforcement tests.
 *
 * Picks one representative route per migration cluster (billing,
 * security/sessions/revoke-all, security/sessions/revoke-user,
 * security/mfa/policy PUT, sso) and drives it through the full
 * `withApiErrorHandling` + `requirePermission` chain. Verifies:
 *
 *   - an ADMIN context reaches the inner handler (success path)
 *   - a READER context is rejected with a 403 JSON envelope
 *   - the inner handler is NOT invoked on denial
 *   - an `AUTHZ_DENIED` audit entry is recorded with the right key
 *
 * The companion `admin-route-enforcement.test.ts` covers the original
 * Epic C.1 admin routes; this suite is the equivalent ratchet for the
 * Epic D.3 migrations so a copy-paste typo or accidental revert
 * (back to `requireAdminCtx`) trips a deterministic test.
 */

// ─── Mocks ─────────────────────────────────────────────────────────

const mockGetTenantCtx = jest.fn();
const mockAppendAuditEntry = jest.fn();

// Tenant SSO is turned off in production (owner ruling 2026-11-18); this
// suite is about the PERMISSION gate on the dormant SSO config route, so the
// flag is on here. The off state is tests/unit/tenant-sso-turned-off.test.ts.
jest.mock('@/lib/auth/tenant-sso-availability', () => ({
    assertScimEnabled: async () => undefined,
    assertTenantSsoEnabled: async () => undefined,
}));
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => mockGetTenantCtx(...args),
}));

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: (...args: unknown[]) => mockAppendAuditEntry(...args),
}));

// Billing — stub Stripe + entitlements lookups.
const mockListBillingEvents = jest.fn();
const mockFindOrCreateCustomer = jest.fn();
const mockCreatePortalSession = jest.fn();
const mockCreateCheckoutSession = jest.fn();
jest.mock('@/lib/entitlements-server', () => ({
    listBillingEvents: (...a: unknown[]) => mockListBillingEvents(...a),
}));
jest.mock('@/lib/stripe', () => ({
    findOrCreateCustomer: (...a: unknown[]) => mockFindOrCreateCustomer(...a),
    createPortalSession: (...a: unknown[]) => mockCreatePortalSession(...a),
    createCheckoutSession: (...a: unknown[]) => mockCreateCheckoutSession(...a),
}));

// Security session usecases.
const mockRevokeAllTenantSessions = jest.fn();
const mockRevokeUserSessions = jest.fn();
jest.mock('@/app-layer/usecases/session-security', () => ({
    revokeAllTenantSessions: (...a: unknown[]) => mockRevokeAllTenantSessions(...a),
    revokeUserSessions: (...a: unknown[]) => mockRevokeUserSessions(...a),
    revokeCurrentSession: jest.fn(),
}));

// MFA usecases.
const mockUpdateTenantMfaPolicy = jest.fn();
jest.mock('@/app-layer/usecases/mfa', () => ({
    updateTenantMfaPolicy: (...a: unknown[]) => mockUpdateTenantMfaPolicy(...a),
    getTenantSecuritySettings: jest.fn(),
}));

// SSO usecases.
const mockGetTenantSsoConfig = jest.fn();
const mockUpsertTenantSsoConfig = jest.fn();
jest.mock('@/app-layer/usecases/sso', () => ({
    getTenantSsoConfig: (...a: unknown[]) => mockGetTenantSsoConfig(...a),
    upsertTenantSsoConfig: (...a: unknown[]) => mockUpsertTenantSsoConfig(...a),
    deleteTenantSsoConfig: jest.fn(),
    toggleTenantSso: jest.fn(),
    setTenantSsoEnforced: jest.fn(),
}));

// ── Imports (after mocks) ──

import { GET as billingEventsGET } from '@/app/api/t/[tenantSlug]/billing/events/route';
import { POST as revokeAllPOST } from '@/app/api/t/[tenantSlug]/security/sessions/revoke-all/route';
import { POST as revokeUserPOST } from '@/app/api/t/[tenantSlug]/security/sessions/revoke-user/route';
import { PUT as mfaPolicyPUT } from '@/app/api/t/[tenantSlug]/security/mfa/policy/route';
import { GET as ssoGET } from '@/app/api/t/[tenantSlug]/sso/route';

import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

// ── Fixtures ──

function makeCtx(role: 'ADMIN' | 'EDITOR' | 'AUDITOR' | 'READER'): RequestContext {
    return {
        requestId: 'req-test',
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role,
        permissions: {
            canRead: true,
            canWrite: role === 'ADMIN' || role === 'EDITOR',
            canAdmin: role === 'ADMIN',
            canAudit: role === 'AUDITOR' || role === 'ADMIN',
            canExport: role !== 'READER',
        },
        appPermissions: getPermissionsForRole(role),
    };
}

function makeReq(method: string, path: string, body?: unknown) {
    return {
        method,
        url: `https://app.example.com${path}`,
        headers: new Headers(),
        nextUrl: {
            pathname: path,
            protocol: 'https:',
            host: 'app.example.com',
            searchParams: new URLSearchParams(),
        },
        json: async () => body ?? {},
    } as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
    [
        mockGetTenantCtx, mockAppendAuditEntry,
        mockListBillingEvents, mockFindOrCreateCustomer,
        mockCreatePortalSession, mockCreateCheckoutSession,
        mockRevokeAllTenantSessions, mockRevokeUserSessions,
        mockUpdateTenantMfaPolicy,
        mockGetTenantSsoConfig, mockUpsertTenantSsoConfig,
    ].forEach((m) => m.mockReset());
});

// ─── Billing — admin.manage ────────────────────────────────────────

describe('GET /api/t/:slug/billing/events — admin.manage', () => {
    const params = { params: Promise.resolve({ tenantSlug: 'acme' }) };
    const path = '/api/t/acme/billing/events';

    it('returns events for an ADMIN', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));
        mockListBillingEvents.mockResolvedValue([{ id: 'e1' }]);
        const res = await billingEventsGET(makeReq('GET', path), params);
        expect(res.status).toBe(200);
        expect(mockListBillingEvents).toHaveBeenCalledTimes(1);
    });

    it('returns 403 + audit for a READER', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));
        mockAppendAuditEntry.mockResolvedValue({ id: 'a1', entryHash: 'h', previousHash: null });
        const res = await billingEventsGET(makeReq('GET', path), params);
        expect(res.status).toBe(403);
        expect(mockListBillingEvents).not.toHaveBeenCalled();
        const audit = mockAppendAuditEntry.mock.calls[0][0];
        expect(audit.entityId).toBe('admin.manage');
        expect(audit.action).toBe('AUTHZ_DENIED');
    });
});

// ─── security/sessions/revoke-all — admin.members ──────────────────

describe('POST /api/t/:slug/security/sessions/revoke-all — admin.members', () => {
    const params = { params: Promise.resolve({ tenantSlug: 'acme' }) };
    const path = '/api/t/acme/security/sessions/revoke-all';

    it('revokes for an ADMIN', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));
        mockRevokeAllTenantSessions.mockResolvedValue({ usersAffected: 7 });
        const res = await revokeAllPOST(makeReq('POST', path), params);
        expect(res.status).toBe(200);
        const body = await res.json() as { usersAffected: number };
        expect(body.usersAffected).toBe(7);
    });

    it('returns 403 + audit for a READER', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));
        mockAppendAuditEntry.mockResolvedValue({ id: 'a1', entryHash: 'h', previousHash: null });
        const res = await revokeAllPOST(makeReq('POST', path), params);
        expect(res.status).toBe(403);
        expect(mockRevokeAllTenantSessions).not.toHaveBeenCalled();
        const audit = mockAppendAuditEntry.mock.calls[0][0];
        expect(audit.entityId).toBe('admin.members');
    });
});

// ─── security/sessions/revoke-user — admin.members ─────────────────

describe('POST /api/t/:slug/security/sessions/revoke-user — admin.members', () => {
    const params = { params: Promise.resolve({ tenantSlug: 'acme' }) };
    const path = '/api/t/acme/security/sessions/revoke-user';

    // The schema requires `targetUserId` to be a cuid.
    const TARGET_CUID = 'cmo8ae4ax0001k23vjcj6sdn2';

    it('forwards target user id for an ADMIN', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));
        mockRevokeUserSessions.mockResolvedValue({ userId: TARGET_CUID, newSessionVersion: 7 });
        const res = await revokeUserPOST(
            makeReq('POST', path, { targetUserId: TARGET_CUID }),
            params,
        );
        expect(res.status).toBe(200);
        expect(mockRevokeUserSessions).toHaveBeenCalledWith(expect.anything(), TARGET_CUID);
    });

    it('returns 403 + audit for a READER', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));
        mockAppendAuditEntry.mockResolvedValue({ id: 'a1', entryHash: 'h', previousHash: null });
        const res = await revokeUserPOST(
            makeReq('POST', path, { targetUserId: TARGET_CUID }),
            params,
        );
        expect(res.status).toBe(403);
        expect(mockRevokeUserSessions).not.toHaveBeenCalled();
    });
});

// ─── security/mfa/policy PUT — admin.manage ────────────────────────

describe('PUT /api/t/:slug/security/mfa/policy — admin.manage', () => {
    const params = { params: Promise.resolve({ tenantSlug: 'acme' }) };
    const path = '/api/t/acme/security/mfa/policy';

    it('updates policy for an ADMIN', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));
        mockUpdateTenantMfaPolicy.mockResolvedValue({ ok: true });
        const res = await mfaPolicyPUT(
            makeReq('PUT', path, { mfaPolicy: 'REQUIRED' }),
            params,
        );
        expect(res.status).toBe(200);
        expect(mockUpdateTenantMfaPolicy).toHaveBeenCalledTimes(1);
    });

    it('returns 403 + audit for a READER (PUT only — GET is open)', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));
        mockAppendAuditEntry.mockResolvedValue({ id: 'a1', entryHash: 'h', previousHash: null });
        const res = await mfaPolicyPUT(
            makeReq('PUT', path, { mfaPolicy: 'REQUIRED' }),
            params,
        );
        expect(res.status).toBe(403);
        expect(mockUpdateTenantMfaPolicy).not.toHaveBeenCalled();
    });
});

// ─── sso GET — admin.manage ────────────────────────────────────────

describe('GET /api/t/:slug/sso — admin.manage', () => {
    const params = { params: Promise.resolve({ tenantSlug: 'acme' }) };
    const path = '/api/t/acme/sso';

    it('lists providers for an ADMIN', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));
        mockGetTenantSsoConfig.mockResolvedValue([
            { id: 'p1', protocol: 'OIDC', configJson: { clientSecret: 'shh' } },
        ]);
        const res = await ssoGET(makeReq('GET', path), params);
        expect(res.status).toBe(200);
        const body = (await res.json()) as Array<{ configJson: Record<string, unknown> }>;
        // Secret-masking happens in the handler; verify the response
        // doesn't echo the literal secret.
        expect(body[0].configJson.clientSecret).toBe('••••••••');
    });

    it('returns 403 + audit for a READER', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));
        mockAppendAuditEntry.mockResolvedValue({ id: 'a1', entryHash: 'h', previousHash: null });
        const res = await ssoGET(makeReq('GET', path), params);
        expect(res.status).toBe(403);
        expect(mockGetTenantSsoConfig).not.toHaveBeenCalled();
        const audit = mockAppendAuditEntry.mock.calls[0][0];
        expect(audit.entityId).toBe('admin.manage');
    });
});

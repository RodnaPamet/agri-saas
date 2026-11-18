/**
 * Epic C.1 — admin route enforcement smoke tests.
 *
 * These tests pick one representative route per permission key from
 * `ROUTE_PERMISSIONS` and exercise it end-to-end through the
 * `withApiErrorHandling` + `requirePermission` chain. They verify:
 *
 *   - an ADMIN context reaches the inner handler
 *   - a READER context is rejected with a 403 JSON envelope
 *   - the inner handler is NOT invoked on denial
 *   - an audit entry is recorded for the denial
 *
 * The unit test for `permission-middleware.ts` already covers the
 * middleware in isolation; this suite proves the wiring is intact at
 * the route boundary so a copy-paste typo (`requirePermsision('…')`,
 * `requirePermission('admni.scim'…)`) shows up in CI.
 */

// ─── Mocks (declared before route imports so Jest hoists them) ───

const mockGetTenantCtx = jest.fn();
const mockAppendAuditEntry = jest.fn();

// SCIM is turned off in production (owner ruling 2026-11-18); this suite is
// about the PERMISSION gate on the dormant token route, so the flag is on.
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

// SCIM route reaches into prisma — stub to avoid hitting the DB.
const mockScimFindMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantScimToken: {
            findMany: (...args: unknown[]) => mockScimFindMany(...args),
        },
    },
    prisma: {
        tenantScimToken: {
            findMany: (...args: unknown[]) => mockScimFindMany(...args),
        },
    },
}));

// Members route reaches into the tenant-admin usecase — stub the
// listing call we exercise below.
const mockListTenantMembers = jest.fn();
jest.mock('@/app-layer/usecases/tenant-admin', () => ({
    listTenantMembers: (...args: unknown[]) => mockListTenantMembers(...args),
    inviteTenantMember: jest.fn(),
    listPendingInvites: jest.fn(),
    getTenantAdminSettings: jest.fn(),
    updateTenantMemberRole: jest.fn(),
    deactivateTenantMember: jest.fn(),
}));

// ── Imports (after mocks) ──

import { GET as scimGET } from '@/app/api/t/[tenantSlug]/admin/scim/route';
import { GET as membersGET } from '@/app/api/t/[tenantSlug]/admin/members/route';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

// ── Fixtures ──

function makeCtx(
    role: 'ADMIN' | 'EDITOR' | 'AUDITOR' | 'READER',
): RequestContext {
    return {
        requestId: 'req-test-1',
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

function makeReq(method: string, path: string) {
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
    } as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
    mockGetTenantCtx.mockReset();
    mockAppendAuditEntry.mockReset();
    mockScimFindMany.mockReset();
    mockListTenantMembers.mockReset();
});

// ─── /admin/scim — admin.scim ───

describe('GET /api/t/:slug/admin/scim — admin.scim', () => {
    it('returns 200 + payload for an ADMIN', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));
        mockScimFindMany.mockResolvedValue([]);

        const res = await scimGET(
            makeReq('GET', '/api/t/acme/admin/scim'),
            { params: Promise.resolve({ tenantSlug: 'acme' }) },
        );

        expect(res.status).toBe(200);
        expect(mockScimFindMany).toHaveBeenCalledTimes(1);
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
    });

    it('returns 403 for a READER and records an audit entry', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));
        mockAppendAuditEntry.mockResolvedValue({
            id: 'a1',
            entryHash: 'h',
            previousHash: null,
        });

        const res = await scimGET(
            makeReq('GET', '/api/t/acme/admin/scim'),
            { params: Promise.resolve({ tenantSlug: 'acme' }) },
        );

        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('FORBIDDEN');
        // Generic message — must not echo the permission key.
        expect(body.error.message).toBe('Permission denied');

        // Inner handler never reached.
        expect(mockScimFindMany).not.toHaveBeenCalled();

        // Audit entry recorded with the right shape.
        expect(mockAppendAuditEntry).toHaveBeenCalledTimes(1);
        const entry = mockAppendAuditEntry.mock.calls[0][0];
        expect(entry).toMatchObject({
            tenantId: 'tenant-1',
            userId: 'user-1',
            entity: 'Permission',
            entityId: 'admin.scim',
            action: 'AUTHZ_DENIED',
        });
    });

    it('rejects an EDITOR (admin.scim is admin-only)', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('EDITOR'));
        mockAppendAuditEntry.mockResolvedValue({
            id: 'a1',
            entryHash: 'h',
            previousHash: null,
        });

        const res = await scimGET(
            makeReq('GET', '/api/t/acme/admin/scim'),
            { params: Promise.resolve({ tenantSlug: 'acme' }) },
        );

        expect(res.status).toBe(403);
        expect(mockScimFindMany).not.toHaveBeenCalled();
    });
});

// ─── /admin/members — admin.members ───

describe('GET /api/t/:slug/admin/members — admin.members', () => {
    it('returns 200 + payload for an ADMIN', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));
        mockListTenantMembers.mockResolvedValue([{ id: 'm1' }]);

        const res = await membersGET(
            makeReq('GET', '/api/t/acme/admin/members'),
            { params: Promise.resolve({ tenantSlug: 'acme' }) },
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as Array<{ id: string }>;
        expect(body).toEqual([{ id: 'm1' }]);
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
    });

    it('returns 403 for a READER and records an audit entry', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));
        mockAppendAuditEntry.mockResolvedValue({
            id: 'a1',
            entryHash: 'h',
            previousHash: null,
        });

        const res = await membersGET(
            makeReq('GET', '/api/t/acme/admin/members'),
            { params: Promise.resolve({ tenantSlug: 'acme' }) },
        );

        expect(res.status).toBe(403);
        expect(mockListTenantMembers).not.toHaveBeenCalled();
        const entry = mockAppendAuditEntry.mock.calls[0][0];
        expect(entry).toMatchObject({
            entity: 'Permission',
            entityId: 'admin.members',
            action: 'AUTHZ_DENIED',
        });
    });
});

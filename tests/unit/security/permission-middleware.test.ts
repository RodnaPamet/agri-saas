/**
 * Unit tests for src/lib/security/permission-middleware.ts
 *
 * Covers Epic C (Defense-in-Depth) layer-1 enforcement:
 *   - allowed: handler runs and receives the resolved RequestContext
 *   - denied: 403 thrown via forbidden(), handler never invoked
 *   - audit: AUTHZ_DENIED entry written on denial with the right shape
 *   - tenant-safe: handler can only see the ctx the middleware resolved
 *   - any/all modes
 *   - misconfiguration (empty key list) fails loud
 */

// ─── Mocks (declared before imports — Jest hoists `jest.mock` calls) ───

const mockGetTenantCtx = jest.fn();
const mockAppendAuditEntry = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => mockGetTenantCtx(...args),
}));

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: (...args: unknown[]) => mockAppendAuditEntry(...args),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: (...args: unknown[]) => mockLoggerWarn(...args),
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

import {
    hasPermission,
    requirePermission,
    requireAnyPermission,
    requireAllPermissions,
    type PermissionKey,
} from '@/lib/security/permission-middleware';
import { AppError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

// ─── Fixtures ───

function makeCtx(
    role: 'ADMIN' | 'EDITOR' | 'AUDITOR' | 'READER',
    overrides: Partial<RequestContext> = {},
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
        ...overrides,
    };
}

function makeReq(method = 'POST', path = '/api/t/acme/risks') {
    // Minimal NextRequest stand-in — middleware only reads `method` and
    // `nextUrl.pathname`. Avoids pulling next/server's runtime in tests.
    return {
        method,
        nextUrl: { pathname: path },
    } as unknown as import('next/server').NextRequest;
}

const routeArgs = { params: Promise.resolve({ tenantSlug: 'acme' }) };

// ─── hasPermission ───

describe('hasPermission', () => {
    it('returns true when the granular flag is granted', () => {
        const perms = getPermissionsForRole('ADMIN');
        expect(hasPermission(perms, 'controls.create')).toBe(true);
        expect(hasPermission(perms, 'admin.scim')).toBe(true);
    });

    it('returns false when the granular flag is denied', () => {
        const perms = getPermissionsForRole('READER');
        expect(hasPermission(perms, 'controls.create')).toBe(false);
        expect(hasPermission(perms, 'admin.scim')).toBe(false);
    });

    it('returns false for unknown keys (fail-closed)', () => {
        const perms = getPermissionsForRole('ADMIN');
        expect(
            hasPermission(perms, 'fictional.flag' as PermissionKey),
        ).toBe(false);
    });
});

// ─── requirePermission — happy path ───

describe('requirePermission — allowed', () => {
    beforeEach(() => {
        mockGetTenantCtx.mockReset();
        mockAppendAuditEntry.mockReset();
    });

    it('invokes the wrapped handler and forwards the resolved ctx', async () => {
        const ctx = makeCtx('ADMIN');
        mockGetTenantCtx.mockResolvedValue(ctx);

        const handler = jest.fn().mockResolvedValue(new Response('ok'));
        const wrapped = requirePermission('controls.create', handler);

        const req = makeReq();
        const res = await wrapped(req, routeArgs);

        expect(handler).toHaveBeenCalledTimes(1);
        // GAP-05: the wrapper now resolves the params Promise once and
        // forwards them RESOLVED, so the inner handler reads params.foo
        // synchronously (not the original Promise-bearing routeArgs).
        expect(handler).toHaveBeenCalledWith(req, { params: { tenantSlug: 'acme' } }, ctx);
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
        expect(res).toBeInstanceOf(Response);
    });

    it('passes ctx through without mutation — handler cannot escape tenant', async () => {
        const ctx = makeCtx('EDITOR');
        mockGetTenantCtx.mockResolvedValue(ctx);

        const handler = jest.fn(async (_req, _args, c: RequestContext) => {
            // Handler must not be able to spoof a different tenant — the
            // middleware hands back exactly what getTenantCtx resolved.
            expect(c.tenantId).toBe('tenant-1');
            expect(c.tenantSlug).toBe('acme');
            expect(c.role).toBe('EDITOR');
            return new Response('ok');
        });

        await requirePermission('controls.create', handler)(makeReq(), routeArgs);
        expect(handler).toHaveBeenCalled();
    });
});

// ─── requirePermission — denial ───

describe('requirePermission — denied', () => {
    beforeEach(() => {
        mockGetTenantCtx.mockReset();
        mockAppendAuditEntry.mockReset();
        mockLoggerWarn.mockReset();
    });

    it('throws 403 with a generic message when the permission is missing', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));

        const handler = jest.fn();
        const wrapped = requirePermission('controls.create', handler);

        await expect(wrapped(makeReq(), routeArgs)).rejects.toMatchObject({
            status: 403,
            code: 'FORBIDDEN',
            message: 'Permission denied',
        });
        await expect(wrapped(makeReq(), routeArgs)).rejects.toBeInstanceOf(
            AppError,
        );

        expect(handler).not.toHaveBeenCalled();
    });

    it('emits an AUTHZ_DENIED audit entry on denial', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));
        mockAppendAuditEntry.mockResolvedValue({
            id: 'a1',
            entryHash: 'h',
            previousHash: null,
        });

        const wrapped = requirePermission('controls.create', jest.fn());
        await expect(
            wrapped(makeReq('POST', '/api/t/acme/risks'), routeArgs),
        ).rejects.toThrow();

        expect(mockAppendAuditEntry).toHaveBeenCalledTimes(1);
        const entry = mockAppendAuditEntry.mock.calls[0][0];
        expect(entry).toMatchObject({
            tenantId: 'tenant-1',
            userId: 'user-1',
            actorType: 'USER',
            entity: 'Permission',
            entityId: 'controls.create',
            action: 'AUTHZ_DENIED',
            requestId: 'req-test-1',
        });
        expect(entry.detailsJson).toMatchObject({
            category: 'access',
            event: 'authz_denied',
            permissionKeys: ['controls.create'],
            role: 'READER',
            method: 'POST',
            path: '/api/t/acme/risks',
        });
    });

    it('marks the actor as API_KEY when the request was bearer-auth\'d', async () => {
        mockGetTenantCtx.mockResolvedValue(
            makeCtx('READER', { apiKeyId: 'key-123' }),
        );
        mockAppendAuditEntry.mockResolvedValue({
            id: 'a1',
            entryHash: 'h',
            previousHash: null,
        });

        await expect(
            requirePermission('controls.create', jest.fn())(makeReq(), routeArgs),
        ).rejects.toThrow();

        expect(mockAppendAuditEntry).toHaveBeenCalledTimes(1);
        expect(mockAppendAuditEntry.mock.calls[0][0]).toMatchObject({
            actorType: 'API_KEY',
        });
    });

    it('still returns 403 if the audit write fails — fail-open on telemetry, fail-closed on access', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));
        mockAppendAuditEntry.mockRejectedValue(new Error('audit DB down'));

        await expect(
            requirePermission('controls.create', jest.fn())(makeReq(), routeArgs),
        ).rejects.toMatchObject({ status: 403 });

        // The telemetry failure surfaces through the logger so ops can
        // see audit storage degradation, but the request is still denied.
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            expect.stringContaining('AUTHZ_DENIED'),
            expect.objectContaining({
                tenantId: 'tenant-1',
                requestId: 'req-test-1',
            }),
        );
    });

    it('does NOT include the permission key in the response message', async () => {
        // Hardening: the 403 message must not let an unauthenticated
        // probe enumerate which key gates which route.
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));

        try {
            await requirePermission('admin.scim', jest.fn())(
                makeReq(),
                routeArgs,
            );
        } catch (err) {
            const e = err as AppError;
            expect(e.message).toBe('Permission denied');
            expect(e.message).not.toContain('admin');
            expect(e.message).not.toContain('scim');
        }
    });
});

// ─── any / all modes ───

describe('requirePermission — modes', () => {
    beforeEach(() => {
        mockGetTenantCtx.mockReset();
        mockAppendAuditEntry.mockReset();
    });

    it('any-of grants when at least one key is held', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('AUDITOR'));

        const handler = jest.fn().mockResolvedValue(new Response('ok'));
        await requireAnyPermission(
            ['admin.manage', 'reports.export'],
            handler,
        )(makeReq(), routeArgs);

        expect(handler).toHaveBeenCalled();
    });

    it('any-of denies when no key is held', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));
        mockAppendAuditEntry.mockResolvedValue({
            id: 'a1',
            entryHash: 'h',
            previousHash: null,
        });

        await expect(
            requireAnyPermission(
                ['admin.manage', 'admin.scim'],
                jest.fn(),
            )(makeReq(), routeArgs),
        ).rejects.toMatchObject({ status: 403 });
    });

    it('all-of grants only when every key is held', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));

        const handler = jest.fn().mockResolvedValue(new Response('ok'));
        await requireAllPermissions(
            ['controls.create', 'evidence.upload'],
            handler,
        )(makeReq(), routeArgs);

        expect(handler).toHaveBeenCalled();
    });

    it('all-of denies when any key is missing', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('EDITOR'));
        mockAppendAuditEntry.mockResolvedValue({
            id: 'a1',
            entryHash: 'h',
            previousHash: null,
        });

        await expect(
            requireAllPermissions(
                ['controls.create', 'admin.scim'],
                jest.fn(),
            )(makeReq(), routeArgs),
        ).rejects.toMatchObject({ status: 403 });

        const entry = mockAppendAuditEntry.mock.calls[0][0];
        expect(entry.entityId).toBe('controls.create,admin.scim');
        expect(entry.detailsJson.permissionKeys).toEqual([
            'controls.create',
            'admin.scim',
        ]);
    });
});

// ─── Misconfiguration ───

describe('requirePermission — misconfiguration', () => {
    it('throws at construction when given an empty key list', () => {
        expect(() =>
            requirePermission(
                [] as unknown as readonly PermissionKey[],
                jest.fn(),
            ),
        ).toThrow(/at least one permission key/i);
    });

    it('throws at construction when given an empty keys object', () => {
        expect(() =>
            requirePermission({ keys: [], mode: 'all' }, jest.fn()),
        ).toThrow(/at least one permission key/i);
    });
});

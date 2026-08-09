/**
 * API Key Management + Scope Enforcement Tests
 *
 * Verifies:
 * 1. Admin can create/list/revoke API keys
 * 2. Non-admin cannot manage API keys
 * 3. Revoked key fails auth
 * 4. Scope validation rejects invalid scopes
 * 5. scopesToPermissions maps correctly
 * 6. enforceApiKeyScope allows/blocks correctly
 * 7. Full-access scope grants everything
 * 8. Resource wildcard scopes work
 */
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import type { Role } from '@prisma/client';

// ─── Mock db-context ───
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTx: Record<string, any> = {};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => {
        return fn(mockTx);
    }),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => undefined),
}));

import {
    validateScopes,
    scopesToPermissions,
    enforceApiKeyScope,
    VALID_SCOPES,
} from '@/lib/auth/api-key-auth';

import {
    listApiKeys,
    createApiKey,
    revokeApiKey,
} from '@/app-layer/usecases/api-keys';

// ─── Helpers ───

function makeCtx(role: Role = 'ADMIN', overrides: Partial<RequestContext> = {}): RequestContext {
    return {
        requestId: 'req-test',
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme-co',
        role,
        permissions: {
            canRead: true,
            canWrite: role !== 'READER',
            canAdmin: role === 'ADMIN',
            canAudit: role === 'ADMIN' || role === 'AUDITOR',
            canExport: role !== 'READER',
        },
        appPermissions: getPermissionsForRole(role),
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockTx).forEach(k => delete mockTx[k]);
});

// ─── Scope Validation ───

describe('API Key Scopes — Validation', () => {
    it('accepts valid scopes', () => {
        expect(validateScopes(['practices:read'])).toEqual([]);
        expect(validateScopes(['*'])).toEqual([]);
        expect(validateScopes(['practices:read', 'evidence:write'])).toEqual([]);
        expect(validateScopes(['practices:*'])).toEqual([]);
    });

    it('rejects non-array', () => {
        expect(validateScopes('practices:read')).toContainEqual(expect.stringMatching(/array/i));
    });

    it('rejects empty array', () => {
        expect(validateScopes([])).toContainEqual(expect.stringMatching(/at least one/i));
    });

    it('rejects invalid scope strings', () => {
        const errors = validateScopes(['invalid:scope']);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]).toContain('Invalid scope');
    });

    it('VALID_SCOPES contains expected scopes', () => {
        expect(VALID_SCOPES).toContain('*');
        expect(VALID_SCOPES).toContain('practices:read');
        expect(VALID_SCOPES).toContain('practices:write');
        expect(VALID_SCOPES).toContain('practices:*');
        expect(VALID_SCOPES).toContain('evidence:read');
        expect(VALID_SCOPES).toContain('admin:write');
    });
});

// ─── Scope to Permission Mapping ───

describe('API Key Scopes — scopesToPermissions', () => {
    it('full access (*) returns ADMIN permissions', () => {
        const perms = scopesToPermissions(['*']);
        const adminPerms = getPermissionsForRole('ADMIN');
        expect(perms).toEqual(adminPerms);
    });

    it('practices:read grants only practices.view', () => {
        const perms = scopesToPermissions(['practices:read']);
        expect(perms.practices.view).toBe(true);
        expect(perms.practices.create).toBe(false);
        expect(perms.practices.edit).toBe(false);
    });

    it('practices:write grants practices.create and practices.edit', () => {
        const perms = scopesToPermissions(['practices:write']);
        expect(perms.practices.create).toBe(true);
        expect(perms.practices.edit).toBe(true);
        expect(perms.practices.view).toBe(false); // read not included in write
    });

    it('practices:* grants all practices actions', () => {
        const perms = scopesToPermissions(['practices:*']);
        expect(perms.practices.view).toBe(true);
        expect(perms.practices.create).toBe(true);
        expect(perms.practices.edit).toBe(true);
    });

    it('evidence:read grants view and download', () => {
        const perms = scopesToPermissions(['evidence:read']);
        expect(perms.evidence.view).toBe(true);
        expect(perms.evidence.download).toBe(true);
        expect(perms.evidence.upload).toBe(false);
    });

    it('multiple scopes combine correctly', () => {
        const perms = scopesToPermissions(['practices:read', 'evidence:write']);
        expect(perms.practices.view).toBe(true);
        expect(perms.practices.create).toBe(false);
        expect(perms.evidence.upload).toBe(true);
        expect(perms.evidence.edit).toBe(true);
        expect(perms.evidence.view).toBe(false); // read not granted
    });

    it('grants nothing for empty scopes', () => {
        const perms = scopesToPermissions([]);
        // All should be false
        expect(perms.practices.view).toBe(false);
        expect(perms.evidence.upload).toBe(false);
        expect(perms.admin.manage).toBe(false);
    });
});

// ─── Scope Enforcement ───

describe('API Key Scopes — enforceApiKeyScope', () => {
    it('no-op for session-authenticated requests (no apiKeyId)', () => {
        const ctx = makeCtx();
        // Should not throw
        expect(() => enforceApiKeyScope(ctx, 'practices', 'read')).not.toThrow();
    });

    it('allows access when scope matches', () => {
        const ctx = makeCtx('ADMIN', {
            apiKeyId: 'ak-1',
            apiKeyScopes: ['practices:read', 'evidence:write'],
        });
        expect(() => enforceApiKeyScope(ctx, 'practices', 'read')).not.toThrow();
        expect(() => enforceApiKeyScope(ctx, 'evidence', 'write')).not.toThrow();
    });

    it('blocks access when scope is missing', () => {
        const ctx = makeCtx('ADMIN', {
            apiKeyId: 'ak-1',
            apiKeyScopes: ['practices:read'],
        });
        expect(() => enforceApiKeyScope(ctx, 'evidence', 'write')).toThrow(/does not have scope/);
        expect(() => enforceApiKeyScope(ctx, 'practices', 'write')).toThrow(/does not have scope/);
    });

    it('full access (*) allows everything', () => {
        const ctx = makeCtx('ADMIN', {
            apiKeyId: 'ak-1',
            apiKeyScopes: ['*'],
        });
        expect(() => enforceApiKeyScope(ctx, 'practices', 'read')).not.toThrow();
        expect(() => enforceApiKeyScope(ctx, 'admin', 'write')).not.toThrow();
    });

    it('resource wildcard (practices:*) allows all actions on resource', () => {
        const ctx = makeCtx('ADMIN', {
            apiKeyId: 'ak-1',
            apiKeyScopes: ['practices:*'],
        });
        expect(() => enforceApiKeyScope(ctx, 'practices', 'read')).not.toThrow();
        expect(() => enforceApiKeyScope(ctx, 'practices', 'write')).not.toThrow();
        expect(() => enforceApiKeyScope(ctx, 'evidence', 'read')).toThrow(/does not have scope/);
    });
});

// ─── API Key CRUD ───

describe('API Key Management — Authorization', () => {
    const NON_ADMIN_ROLES: Role[] = ['EDITOR', 'READER', 'AUDITOR'];

    NON_ADMIN_ROLES.forEach((role) => {
        it(`${role} cannot list API keys`, async () => {
            await expect(listApiKeys(makeCtx(role))).rejects.toThrow(/permission|admin/i);
        });

        it(`${role} cannot create API keys`, async () => {
            await expect(
                createApiKey(makeCtx(role), { name: 'Test', scopes: ['*'] })
            ).rejects.toThrow(/permission|admin/i);
        });

        it(`${role} cannot revoke API keys`, async () => {
            await expect(revokeApiKey(makeCtx(role), 'ak-1')).rejects.toThrow(/permission|admin/i);
        });
    });
});

describe('API Key Management — Create', () => {
    it('creates a key and returns plaintext', async () => {
        mockTx.tenantApiKey = {
            create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
                id: 'ak-1',
                name: data.name,
                keyPrefix: data.keyPrefix,
                scopes: data.scopes,
                expiresAt: null,
                createdAt: new Date(),
            })),
        };

        const result = await createApiKey(makeCtx(), {
            name: 'CI Key',
            scopes: ['practices:read'],
        });

        expect(result.name).toBe('CI Key');
        expect(result.plaintext).toBeDefined();
        expect(result.plaintext.startsWith('iflk_')).toBe(true);
        // The hash stored in DB should NOT be the plaintext
        const createCall = mockTx.tenantApiKey.create.mock.calls[0][0];
        expect(createCall.data.keyHash).not.toBe(result.plaintext);
    });

    it('rejects invalid scopes', async () => {
        await expect(
            createApiKey(makeCtx(), { name: 'Bad', scopes: ['invalid:scope'] })
        ).rejects.toThrow(/Invalid scopes/);
    });

    it('rejects empty name', async () => {
        await expect(
            createApiKey(makeCtx(), { name: '  ', scopes: ['*'] })
        ).rejects.toThrow(/name/i);
    });

    it('rejects past expiry', async () => {
        await expect(
            createApiKey(makeCtx(), {
                name: 'Expired',
                scopes: ['*'],
                expiresAt: new Date(Date.now() - 86400000).toISOString(),
            })
        ).rejects.toThrow(/future/i);
    });
});

describe('API Key Management — Revoke', () => {
    it('revokes an active key', async () => {
        mockTx.tenantApiKey = {
            findFirst: jest.fn(async () => ({
                id: 'ak-1', tenantId: 'tenant-1', name: 'Active Key', revokedAt: null,
            })),
            update: jest.fn(async () => ({
                id: 'ak-1', name: 'Active Key', keyPrefix: 'iflk_test', revokedAt: new Date(),
            })),
        };

        const result = await revokeApiKey(makeCtx(), 'ak-1');
        expect(result.revokedAt).toBeDefined();
    });

    it('rejects revoking already-revoked key', async () => {
        mockTx.tenantApiKey = {
            findFirst: jest.fn(async () => ({
                id: 'ak-1', tenantId: 'tenant-1', name: 'R Key', revokedAt: new Date(),
            })),
        };

        await expect(revokeApiKey(makeCtx(), 'ak-1')).rejects.toThrow(/already revoked/i);
    });

    it('rejects revoking non-existent key', async () => {
        mockTx.tenantApiKey = {
            findFirst: jest.fn(async () => null),
        };

        await expect(revokeApiKey(makeCtx(), 'missing')).rejects.toThrow(/not found/i);
    });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Data Portability Roundtrip & RBAC Tests
 *
 * Tests:
 *   1. RBAC: export requires canExport or canAdmin
 *   2. RBAC: import requires canAdmin
 *   3. RBAC: import target must match context tenant
 *   4. Roundtrip: export → import dry-run validates cleanly
 *   5. Roundtrip: export → import persists correctly
 *   6. Audit: export and import operations are logged
 *   7. Structural: usecase exposes all 3 entrypoints
 */

import type { RequestContext } from '../../src/app-layer/types';
import { getPermissionsForRole } from '../../src/lib/permissions';
import {
    assertCanExport,
    assertCanImport,
    assertImportTargetMatchesContext,
} from '../../src/app-layer/policies/data-portability.policies';
import {
    EXPORT_FORMAT_VERSION,
    APP_IDENTIFIER,
    type ExportEnvelope,
} from '../../src/app-layer/services/export-schemas';

// ─── Fixtures ───────────────────────────────────────────────────────

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
    return {
        requestId: 'req-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        role: 'ADMIN' as any,
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole((overrides.role ?? 'ADMIN') as any),
        ...overrides,
    };
}

function makeMinimalCtx(perms: Partial<RequestContext['permissions']> = {}): RequestContext {
    return makeCtx({
        permissions: {
            canRead: false,
            canWrite: false,
            canAdmin: false,
            canAudit: false,
            canExport: false,
            ...perms,
        },
    });
}

function makeEnvelope(): ExportEnvelope {
    return {
        formatVersion: EXPORT_FORMAT_VERSION,
        metadata: {
            tenantId: 'tenant-1',
            exportedAt: new Date().toISOString(),
            domains: ['CONTROLS'],
            app: APP_IDENTIFIER,
            appVersion: '1.0.0',
        },
        entities: {
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'Firewall', tenantId: 'tenant-1', status: 'ACTIVE' },
            }],
            practiceTestPlan: [{
                entityType: 'practiceTestPlan',
                id: 'tp-1',
                schemaVersion: '1.0',
                data: { name: 'Test Plan', tenantId: 'tenant-1', practiceId: 'ctrl-1' },
            }],
        },
        relationships: [{
            fromType: 'practiceTestPlan',
            fromId: 'tp-1',
            toType: 'practice',
            toId: 'ctrl-1',
            relationship: 'BELONGS_TO',
        }],
    };
}

// ═════════════════════════════════════════════════════════════════════
// 1. RBAC: Export Permissions
// ═════════════════════════════════════════════════════════════════════

describe('Data portability RBAC: export', () => {
    test('admin can export', () => {
        expect(() => assertCanExport(makeMinimalCtx({ canAdmin: true }))).not.toThrow();
    });

    test('user with canExport can export', () => {
        expect(() => assertCanExport(makeMinimalCtx({ canExport: true }))).not.toThrow();
    });

    test('user without canExport or canAdmin cannot export', () => {
        expect(() => assertCanExport(makeMinimalCtx())).toThrow(/permission to export/);
    });

    test('read-only user cannot export', () => {
        expect(() => assertCanExport(makeMinimalCtx({ canRead: true }))).toThrow();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. RBAC: Import Permissions
// ═════════════════════════════════════════════════════════════════════

describe('Data portability RBAC: import', () => {
    test('admin can import', () => {
        expect(() => assertCanImport(makeMinimalCtx({ canAdmin: true }))).not.toThrow();
    });

    test('user with only canExport cannot import', () => {
        expect(() => assertCanImport(makeMinimalCtx({ canExport: true }))).toThrow();
    });

    test('user with canWrite cannot import', () => {
        expect(() => assertCanImport(makeMinimalCtx({ canWrite: true }))).toThrow();
    });

    test('unprivileged user cannot import', () => {
        expect(() => assertCanImport(makeMinimalCtx())).toThrow(/administrative actions/);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. RBAC: Tenant Context Matching
// ═════════════════════════════════════════════════════════════════════

describe('Data portability RBAC: tenant context', () => {
    test('matching tenant passes', () => {
        const ctx = makeCtx({ tenantId: 'tenant-abc' });
        expect(() => assertImportTargetMatchesContext(ctx, 'tenant-abc')).not.toThrow();
    });

    test('mismatched tenant throws', () => {
        const ctx = makeCtx({ tenantId: 'tenant-abc' });
        expect(() => assertImportTargetMatchesContext(ctx, 'tenant-xyz')).toThrow(
            /does not match/,
        );
    });

    test('error message includes both tenant IDs', () => {
        const ctx = makeCtx({ tenantId: 'my-tenant' });
        try {
            assertImportTargetMatchesContext(ctx, 'other-tenant');
            fail('Should have thrown');
        } catch (e: any) {
            expect(e.message).toContain('my-tenant');
            expect(e.message).toContain('other-tenant');
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Roundtrip: Export → Import Mocked Integration
// ═════════════════════════════════════════════════════════════════════

const createSpy = jest.fn();
const auditCreateSpy = jest.fn();

jest.mock('@/lib/prisma', () => {
    const models = [
        'practice', 'practiceTestPlan', 'practiceTestRun', 'practiceRequirementLink',
        'policy', 'policyVersion', 'risk', 'evidence',
        'task', 'taskLink',
        'vendor', 'vendorAssessment', 'vendorRelationship',
        'framework', 'frameworkRequirement',
    ];
    const mockPrisma: Record<string, unknown> = {};
    for (const model of models) {
        (mockPrisma as any)[model] = {
            create: (...args: unknown[]) => createSpy(model, ...args),
            update: jest.fn().mockResolvedValue({ id: 'upd' }),
            findUnique: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockResolvedValue([]),
        };
    }
    (mockPrisma as any).auditLog = {
        create: (...args: unknown[]) => auditCreateSpy(...args),
    };
    // Interactive transaction: call the callback with mockPrisma as tx
    (mockPrisma as any).$transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        return cb(mockPrisma);
    });
    return { prisma: mockPrisma };
});

// Mock runInTenantContext and withTenantDb to pass callback the mock prisma
jest.mock('@/lib/db-context', () => {

    const { prisma } = require('@/lib/prisma');
    return {
        runInTenantContext: jest.fn(async (_ctx: unknown, cb: (db: unknown) => Promise<unknown>) => {
            return cb(prisma);
        }),
        withTenantDb: jest.fn(async (_tenantId: string, cb: (db: unknown) => Promise<unknown>) => {
            return cb(prisma);
        }),
    };
});

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        child: jest.fn().mockReturnValue({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        }),
    },
}));

import {
    exportBundle,
    validateBundle,
    importBundle,
} from '../../src/app-layer/usecases/data-portability';

beforeEach(() => {
    jest.clearAllMocks();
    createSpy.mockResolvedValue({ id: 'created' });
    auditCreateSpy.mockResolvedValue({ id: 'audit-1' });
});

describe('Data portability: usecase entrypoints', () => {
    test('exportBundle calls export service and creates audit log', async () => {
        const ctx = makeCtx();
        const result = await exportBundle(ctx, {
            domains: ['CONTROLS'],
            description: 'Test export',
        });

        expect(result.envelope.formatVersion).toBe(EXPORT_FORMAT_VERSION);
        expect(result.stats.domains).toEqual(['CONTROLS']);
        // Serialized bundle should be present and compressed by default
        expect(result.serialized).toBeDefined();
        expect(result.serialized.compressed).toBe(true);
        expect(result.serialized.outputSize).toBeGreaterThan(0);
        expect(auditCreateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    action: 'DATA_EXPORT',
                    tenantId: 'tenant-1',
                }),
            }),
        );
    });

    test('exportBundle rejects non-admin/non-export user', async () => {
        const ctx = makeMinimalCtx();
        await expect(exportBundle(ctx, {})).rejects.toThrow(/permission to export/);
    });

    test('validateBundle runs dry-run import', async () => {
        const ctx = makeCtx();
        const envelope = makeEnvelope();
        const result = await validateBundle(ctx, envelope);

        expect(result.dryRun).toBe(true);
        expect(result.success).toBe(true);
        expect(createSpy).not.toHaveBeenCalled(); // No persistence
    });

    test('importBundle persists entities and creates audit log', async () => {
        const ctx = makeCtx();
        const envelope = makeEnvelope();

        const result = await importBundle(ctx, {
            envelope,
            conflictStrategy: 'SKIP',
            dryRun: false,
        });

        expect(result.success).toBe(true);
        expect(result.imported.practice).toBe(1);
        expect(result.imported.practiceTestPlan).toBe(1);

        // Audit log created
        expect(auditCreateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    action: 'DATA_IMPORT',
                    tenantId: 'tenant-1',
                }),
            }),
        );
    });

    test('importBundle dry-run creates audit log with DRYRUN action', async () => {
        const ctx = makeCtx();
        const envelope = makeEnvelope();

        const result = await importBundle(ctx, {
            envelope,
            conflictStrategy: 'SKIP',
            dryRun: true,
        });

        expect(result.dryRun).toBe(true);
        expect(auditCreateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    action: 'DATA_IMPORT_DRYRUN',
                }),
            }),
        );
    });

    test('importBundle rejects non-admin user', async () => {
        const ctx = makeMinimalCtx({ canExport: true });
        await expect(
            importBundle(ctx, {
                envelope: makeEnvelope(),
                conflictStrategy: 'SKIP',
            }),
        ).rejects.toThrow(/administrative actions/);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Roundtrip: Export → Validate → Import
// ═════════════════════════════════════════════════════════════════════

describe('Data portability: export → import roundtrip', () => {
    test('exported envelope validates cleanly for import', async () => {
        const ctx = makeCtx();

        // Export
        const exportResult = await exportBundle(ctx, { domains: ['CONTROLS'] });

        // Validate (dry-run import)
        const validateResult = await validateBundle(ctx, exportResult.envelope);
        expect(validateResult.success).toBe(true);
        expect(validateResult.dryRun).toBe(true);
    });

    test('roundtrip preserves entity count', async () => {
        const ctx = makeCtx();

        // Export
        const exportResult = await exportBundle(ctx, { domains: ['CONTROLS'] });
        const entityCount = exportResult.stats.entityCount;

        // Import
        const importResult = await importBundle(ctx, {
            envelope: exportResult.envelope,
            conflictStrategy: 'SKIP',
            dryRun: true,
        });

        // Total imported count should match export entity count
        const totalImported = Object.values(importResult.imported)
            .reduce((sum, n) => sum + (n ?? 0), 0);
        expect(totalImported).toBe(entityCount);
    });

    test('FK relationships preserved through roundtrip', async () => {
        const ctx = makeCtx();
        const capturedData: Array<{ model: string; data: Record<string, unknown> }> = [];
        createSpy.mockImplementation((model: string, args: any) => {
            capturedData.push({ model, data: args.data });
            return { id: args.data.id ?? 'created' };
        });

        const envelope = makeEnvelope();

        await importBundle(ctx, {
            envelope,
            conflictStrategy: 'SKIP',
            dryRun: false,
        });

        // practiceTestPlan.practiceId should reference the practice
        const tp = capturedData.find(c => c.model === 'practiceTestPlan');
        expect(tp?.data.practiceId).toBe('ctrl-1');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Structural: Module Exports
// ═════════════════════════════════════════════════════════════════════

describe('Data portability: structural', () => {
    test('usecase exports all 3 entrypoints', () => {
        expect(typeof exportBundle).toBe('function');
        expect(typeof validateBundle).toBe('function');
        expect(typeof importBundle).toBe('function');
    });

    test('policies export all 3 assertions', () => {
        expect(typeof assertCanExport).toBe('function');
        expect(typeof assertCanImport).toBe('function');
        expect(typeof assertImportTargetMatchesContext).toBe('function');
    });
});

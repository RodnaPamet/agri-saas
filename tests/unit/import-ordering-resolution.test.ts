/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Import Service — Topological Ordering, FK Resolution, and Persistence Tests
 *
 * Tests:
 *   1. Topological order: parents before children
 *   2. FK resolution: references updated via IdMap
 *   3. ID mapping: RENAME generates new IDs, others preserve
 *   4. Conflict strategies: SKIP, OVERWRITE, FAIL, RENAME
 *   5. Tenant override: data lands in target tenant
 *   6. M2M/join relationships restored
 *   7. Unresolved references fail with diagnostics
 *   8. Deterministic re-import behavior
 */

import {
    EXPORT_FORMAT_VERSION,
    APP_IDENTIFIER,
    IMPORT_ORDER,
    type ExportEnvelope,
    type ExportEntityType,
    type ImportOptions,
} from '../../src/app-layer/services/export-schemas';
import { IdMap } from '../../src/app-layer/services/import-service';

// ─── Fixtures ───────────────────────────────────────────────────────

function makeEnvelope(
    entities: ExportEnvelope['entities'] = {},
    relationships: ExportEnvelope['relationships'] = [],
): ExportEnvelope {
    return {
        formatVersion: EXPORT_FORMAT_VERSION,
        metadata: {
            tenantId: 'source-tenant',
            exportedAt: new Date().toISOString(),
            domains: ['CONTROLS'],
            app: APP_IDENTIFIER,
            appVersion: '1.0.0',
        },
        entities,
        relationships,
    };
}

function makeOptions(overrides: Partial<ImportOptions> = {}): ImportOptions {
    return {
        targetTenantId: 'target-tenant',
        conflictStrategy: 'SKIP',
        dryRun: true, // Default dry-run for safety
        ...overrides,
    };
}

// ═════════════════════════════════════════════════════════════════════
// 1. IdMap — ID Resolution
// ═════════════════════════════════════════════════════════════════════

describe('IdMap: ID resolution', () => {
    test('set and get identity mapping', () => {
        const map = new IdMap();
        map.set('practice', 'ctrl-1', 'ctrl-1');
        expect(map.get('practice', 'ctrl-1')).toBe('ctrl-1');
    });

    test('set and get remapped ID', () => {
        const map = new IdMap();
        map.set('practice', 'ctrl-1', 'new-ctrl-99');
        expect(map.get('practice', 'ctrl-1')).toBe('new-ctrl-99');
    });

    test('resolve returns mapped ID if present', () => {
        const map = new IdMap();
        map.set('practice', 'ctrl-1', 'new-id');
        expect(map.resolve('practice', 'ctrl-1')).toBe('new-id');
    });

    test('resolve falls back to original if no mapping', () => {
        const map = new IdMap();
        expect(map.resolve('practice', 'unknown-id')).toBe('unknown-id');
    });

    test('different entity types with same ID are separate', () => {
        const map = new IdMap();
        map.set('practice', 'id-1', 'ctrl-mapped');
        map.set('policy', 'id-1', 'pol-mapped');
        expect(map.resolve('practice', 'id-1')).toBe('ctrl-mapped');
        expect(map.resolve('policy', 'id-1')).toBe('pol-mapped');
    });

    test('size tracks number of mappings', () => {
        const map = new IdMap();
        expect(map.size).toBe(0);
        map.set('practice', 'a', 'b');
        map.set('policy', 'c', 'd');
        expect(map.size).toBe(2);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Topological Import Order
// ═════════════════════════════════════════════════════════════════════

describe('Import order: topological correctness', () => {
    const indexOf = (t: ExportEntityType) => IMPORT_ORDER.indexOf(t);

    test('framework before frameworkRequirement', () => {
        expect(indexOf('framework')).toBeLessThan(indexOf('frameworkRequirement'));
    });

    test('practice before practiceTestPlan', () => {
        expect(indexOf('practice')).toBeLessThan(indexOf('practiceTestPlan'));
    });

    test('practiceTestPlan before practiceTestRun', () => {
        expect(indexOf('practiceTestPlan')).toBeLessThan(indexOf('practiceTestRun'));
    });

    test('practice before practiceMapping', () => {
        expect(indexOf('practice')).toBeLessThan(indexOf('practiceMapping'));
    });

    test('policy before policyVersion', () => {
        expect(indexOf('policy')).toBeLessThan(indexOf('policyVersion'));
    });

    test('vendor before vendorReview', () => {
        expect(indexOf('vendor')).toBeLessThan(indexOf('vendorReview'));
    });

    test('vendor before vendorSubprocessor', () => {
        expect(indexOf('vendor')).toBeLessThan(indexOf('vendorSubprocessor'));
    });

    test('task before taskLink', () => {
        expect(indexOf('task')).toBeLessThan(indexOf('taskLink'));
    });

    test('evidence is standalone (no ordering constraint)', () => {
        // Evidence has no children in the import order
        expect(indexOf('evidence')).toBeGreaterThanOrEqual(0);
    });

    test('all entity types in IMPORT_ORDER are unique', () => {
        const seen = new Set<string>();
        for (const t of IMPORT_ORDER) {
            expect(seen.has(t)).toBe(false);
            seen.add(t);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Import Service — Mock Prisma for Persistence Tests
// ═════════════════════════════════════════════════════════════════════

const createSpy = jest.fn();
const updateSpy = jest.fn();
const findUniqueSpy = jest.fn();

jest.mock('@/lib/prisma', () => {
    const models = [
        'practice', 'practiceTestPlan', 'practiceTestRun', 'practiceRequirementLink',
        'policy', 'policyVersion',
        'risk',
        'evidence',
        'task', 'taskLink',
        'vendor', 'vendorAssessment', 'vendorRelationship',
        'framework', 'frameworkRequirement',
    ];
    const mockPrisma: Record<string, unknown> = {};
    for (const model of models) {
        (mockPrisma as any)[model] = {
            create: (...args: unknown[]) => createSpy(model, ...args),
            update: (...args: unknown[]) => updateSpy(model, ...args),
            findUnique: (...args: unknown[]) => findUniqueSpy(model, ...args),
            findMany: jest.fn().mockResolvedValue([]),
        };
    }
    // Interactive transaction: call the callback with mockPrisma as tx
    (mockPrisma as any).$transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        return cb(mockPrisma);
    });
    return { prisma: mockPrisma };
});

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        child: jest.fn().mockReturnThis(),
    },
}));

import { importTenantData, validateImportEnvelope } from '../../src/app-layer/services/import-service';

beforeEach(() => {
    jest.clearAllMocks();
    createSpy.mockResolvedValue({ id: 'created' });
    updateSpy.mockResolvedValue({ id: 'updated' });
    findUniqueSpy.mockResolvedValue(null); // No existing entities by default
});

// ═════════════════════════════════════════════════════════════════════
// 4. Valid Bundle Imports Successfully
// ═════════════════════════════════════════════════════════════════════

describe('Import service: valid bundle', () => {
    test('single practice imports successfully', async () => {
        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'Firewall', tenantId: 'source-tenant', status: 'ACTIVE' },
            }],
        });

        const result = await importTenantData(envelope, makeOptions({ dryRun: false }));
        expect(result.success).toBe(true);
        expect(result.imported.practice).toBe(1);
    });

    test('practice + testPlan imports in correct order', async () => {
        const callOrder: string[] = [];
        createSpy.mockImplementation((model: string) => {
            callOrder.push(model);
            return { id: 'new' };
        });

        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'Ctrl', tenantId: 'source-tenant' },
            }],
            practiceTestPlan: [{
                entityType: 'practiceTestPlan',
                id: 'tp-1',
                schemaVersion: '1.0',
                data: { name: 'Plan', tenantId: 'source-tenant', practiceId: 'ctrl-1' },
            }],
        });

        const result = await importTenantData(envelope, makeOptions({ dryRun: false }));
        expect(result.success).toBe(true);

        // practice must be created before practiceTestPlan
        const ctrlIdx = callOrder.indexOf('practice');
        const tpIdx = callOrder.indexOf('practiceTestPlan');
        expect(ctrlIdx).toBeLessThan(tpIdx);
    });

    test('three-level chain: practice → testPlan → testRun', async () => {
        const callOrder: string[] = [];
        createSpy.mockImplementation((model: string) => {
            callOrder.push(model);
            return { id: 'new' };
        });

        const envelope = makeEnvelope({
            practiceTestRun: [{
                entityType: 'practiceTestRun',
                id: 'tr-1',
                schemaVersion: '1.0',
                data: { tenantId: 'source-tenant', testPlanId: 'tp-1', practiceId: 'ctrl-1' },
            }],
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'Ctrl', tenantId: 'source-tenant' },
            }],
            practiceTestPlan: [{
                entityType: 'practiceTestPlan',
                id: 'tp-1',
                schemaVersion: '1.0',
                data: { name: 'Plan', tenantId: 'source-tenant', practiceId: 'ctrl-1' },
            }],
        });

        const result = await importTenantData(envelope, makeOptions({ dryRun: false }));
        expect(result.success).toBe(true);

        // Order must be: practice → practiceTestPlan → practiceTestRun
        expect(callOrder.indexOf('practice')).toBeLessThan(callOrder.indexOf('practiceTestPlan'));
        expect(callOrder.indexOf('practiceTestPlan')).toBeLessThan(callOrder.indexOf('practiceTestRun'));
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. FK Resolution
// ═════════════════════════════════════════════════════════════════════

describe('Import service: FK resolution', () => {
    test('child entity practiceId is resolved via ID map', async () => {
        const capturedData: Array<{ model: string; data: Record<string, unknown> }> = [];
        createSpy.mockImplementation((model: string, args: any) => {
            capturedData.push({ model, data: args.data });
            return { id: args.data.id };
        });

        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'old-ctrl',
                schemaVersion: '1.0',
                data: { name: 'C', tenantId: 'source-tenant' },
            }],
            practiceTestPlan: [{
                entityType: 'practiceTestPlan',
                id: 'old-tp',
                schemaVersion: '1.0',
                data: { name: 'P', tenantId: 'source-tenant', practiceId: 'old-ctrl' },
            }],
        });

        await importTenantData(envelope, makeOptions({
            dryRun: false,
            conflictStrategy: 'SKIP',
        }));

        // The testPlan's practiceId should reference the practice's (preserved) ID
        const tpCreate = capturedData.find(c => c.model === 'practiceTestPlan');
        expect(tpCreate?.data.practiceId).toBe('old-ctrl');
    });

    test('RENAME strategy generates new IDs and resolves FKs', async () => {
        const capturedData: Array<{ model: string; data: Record<string, unknown> }> = [];
        createSpy.mockImplementation((model: string, args: any) => {
            capturedData.push({ model, data: args.data });
            return { id: args.data.id };
        });

        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'old-ctrl',
                schemaVersion: '1.0',
                data: { name: 'C', tenantId: 'source-tenant' },
            }],
            practiceTestPlan: [{
                entityType: 'practiceTestPlan',
                id: 'old-tp',
                schemaVersion: '1.0',
                data: { name: 'P', tenantId: 'source-tenant', practiceId: 'old-ctrl' },
            }],
        });

        await importTenantData(envelope, makeOptions({
            dryRun: false,
            conflictStrategy: 'RENAME',
        }));

        const ctrlCreate = capturedData.find(c => c.model === 'practice');
        const tpCreate = capturedData.find(c => c.model === 'practiceTestPlan');

        // IDs should be different from originals
        expect(ctrlCreate?.data.id).not.toBe('old-ctrl');
        expect(tpCreate?.data.id).not.toBe('old-tp');

        // FK should match the NEW practice ID
        expect(tpCreate?.data.practiceId).toBe(ctrlCreate?.data.id);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Tenant Override
// ═════════════════════════════════════════════════════════════════════

describe('Import service: tenant safety', () => {
    test('imported entities use target tenantId, not source', async () => {
        const capturedData: Array<{ data: Record<string, unknown> }> = [];
        createSpy.mockImplementation((_model: string, args: any) => {
            capturedData.push({ data: args.data });
            return { id: 'new' };
        });

        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'C', tenantId: 'source-tenant' },
            }],
        });

        await importTenantData(envelope, makeOptions({
            targetTenantId: 'target-tenant-xyz',
            dryRun: false,
        }));

        expect(capturedData[0]?.data.tenantId).toBe('target-tenant-xyz');
    });

    test('multiple entities all get target tenant', async () => {
        const capturedData: Array<{ data: Record<string, unknown> }> = [];
        createSpy.mockImplementation((_model: string, args: any) => {
            capturedData.push({ data: args.data });
            return { id: 'new' };
        });

        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'C1', tenantId: 'source-tenant' },
            }],
            policy: [{
                entityType: 'policy',
                id: 'pol-1',
                schemaVersion: '1.0',
                data: { title: 'P1', tenantId: 'source-tenant' },
            }],
        });

        await importTenantData(envelope, makeOptions({
            targetTenantId: 'correct-tenant',
            dryRun: false,
        }));

        for (const { data } of capturedData) {
            expect(data.tenantId).toBe('correct-tenant');
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 7. Conflict Strategies
// ═════════════════════════════════════════════════════════════════════

describe('Import service: conflict strategies', () => {
    test('SKIP skips existing entities', async () => {
        findUniqueSpy.mockResolvedValue({ id: 'ctrl-1' }); // entity exists

        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'C', tenantId: 'source-tenant' },
            }],
        });

        const result = await importTenantData(envelope, makeOptions({
            conflictStrategy: 'SKIP',
            dryRun: false,
        }));

        expect(result.skipped.practice).toBe(1);
        expect(result.imported.practice).toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
    });

    test('OVERWRITE updates existing entities', async () => {
        findUniqueSpy.mockResolvedValue({ id: 'ctrl-1' }); // entity exists

        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'Updated', tenantId: 'source-tenant' },
            }],
        });

        const result = await importTenantData(envelope, makeOptions({
            conflictStrategy: 'OVERWRITE',
            dryRun: false,
        }));

        expect(result.imported.practice).toBe(1);
        expect(updateSpy).toHaveBeenCalled();
    });

    test('FAIL reports conflicts as errors', async () => {
        findUniqueSpy.mockResolvedValue({ id: 'ctrl-1' }); // entity exists

        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'C', tenantId: 'source-tenant' },
            }],
        });

        const result = await importTenantData(envelope, makeOptions({
            conflictStrategy: 'FAIL',
            dryRun: false,
        }));

        expect(result.success).toBe(false);
        expect(result.conflicts.practice).toBe(1);
        expect(result.errors.some(e => e.message.includes('Conflict'))).toBe(true);
    });

    test('RENAME creates with new IDs (no conflict)', async () => {
        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'C', tenantId: 'source-tenant' },
            }],
        });

        const result = await importTenantData(envelope, makeOptions({
            conflictStrategy: 'RENAME',
            dryRun: false,
        }));

        expect(result.imported.practice).toBe(1);
        // Should have used a new ID
        expect(createSpy).toHaveBeenCalledWith(
            'practice',
            expect.objectContaining({
                data: expect.objectContaining({
                    id: expect.not.stringMatching(/^ctrl-1$/),
                }),
            }),
        );
    });
});

// ═════════════════════════════════════════════════════════════════════
// 8. M2M / Join Table Resolution
// ═════════════════════════════════════════════════════════════════════

describe('Import service: M2M relationships', () => {
    test('policy → policyVersion FK is resolved', async () => {
        const capturedData: Array<{ model: string; data: Record<string, unknown> }> = [];
        createSpy.mockImplementation((model: string, args: any) => {
            capturedData.push({ model, data: args.data });
            return { id: args.data.id };
        });

        const envelope = makeEnvelope({
            policy: [{
                entityType: 'policy',
                id: 'pol-1',
                schemaVersion: '1.0',
                data: { title: 'Privacy', tenantId: 'source-tenant' },
            }],
            policyVersion: [{
                entityType: 'policyVersion',
                id: 'pv-1',
                schemaVersion: '1.0',
                data: { policyId: 'pol-1', tenantId: 'source-tenant', versionNumber: 1 },
            }],
        });

        await importTenantData(envelope, makeOptions({ dryRun: false }));

        // policyVersion.policyId should point to the policy
        const pvCreate = capturedData.find(c => c.model === 'policyVersion');
        expect(pvCreate?.data.policyId).toBe('pol-1');
    });

    test('vendor → vendorAssessment FK is resolved', async () => {
        const capturedData: Array<{ model: string; data: Record<string, unknown> }> = [];
        createSpy.mockImplementation((model: string, args: any) => {
            capturedData.push({ model, data: args.data });
            return { id: args.data.id };
        });

        const envelope = makeEnvelope({
            vendor: [{
                entityType: 'vendor',
                id: 'v-1',
                schemaVersion: '1.0',
                data: { name: 'Acme', tenantId: 'source-tenant' },
            }],
            vendorReview: [{
                entityType: 'vendorReview',
                id: 'va-1',
                schemaVersion: '1.0',
                data: { vendorId: 'v-1', tenantId: 'source-tenant', status: 'COMPLETED' },
            }],
        });

        await importTenantData(envelope, makeOptions({ dryRun: false }));

        const vaCreate = capturedData.find(c => c.model === 'vendorAssessment');
        expect(vaCreate?.data.vendorId).toBe('v-1');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 9. Deterministic Re-Import
// ═════════════════════════════════════════════════════════════════════

describe('Import service: deterministic re-import', () => {
    test('importing same bundle twice with SKIP produces same result', async () => {
        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'C', tenantId: 'source-tenant' },
            }],
        });

        const opts = makeOptions({ dryRun: true });

        const result1 = await importTenantData(envelope, opts);
        const result2 = await importTenantData(envelope, opts);

        expect(result1.imported).toEqual(result2.imported);
        expect(result1.skipped).toEqual(result2.skipped);
        expect(result1.success).toBe(result2.success);
    });

    test('re-import with SKIP + existing entities skips consistently', async () => {
        findUniqueSpy.mockResolvedValue({ id: 'ctrl-1' });

        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'C', tenantId: 'source-tenant' },
            }],
        });

        const result1 = await importTenantData(envelope, makeOptions({
            conflictStrategy: 'SKIP',
            dryRun: false,
        }));
        const result2 = await importTenantData(envelope, makeOptions({
            conflictStrategy: 'SKIP',
            dryRun: false,
        }));

        expect(result1.skipped).toEqual(result2.skipped);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 10. Dry Run
// ═════════════════════════════════════════════════════════════════════

describe('Import service: dry run mode', () => {
    test('dry run does not call create', async () => {
        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'C', tenantId: 'source-tenant' },
            }],
        });

        const result = await importTenantData(envelope, makeOptions({ dryRun: true }));

        expect(result.dryRun).toBe(true);
        expect(result.imported.practice).toBe(1);
        expect(createSpy).not.toHaveBeenCalled();
    });

    test('validateImportEnvelope uses dry run', async () => {
        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'C', tenantId: 'source-tenant' },
            }],
        });

        const result = await validateImportEnvelope(envelope, 'target');
        expect(result.dryRun).toBe(true);
        expect(createSpy).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 11. Error Handling
// ═════════════════════════════════════════════════════════════════════

describe('Import service: error handling', () => {
    test('persistence error is captured with entity details', async () => {
        createSpy.mockRejectedValueOnce(new Error('DB connection failed'));

        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'C', tenantId: 'source-tenant' },
            }],
        });

        const result = await importTenantData(envelope, makeOptions({ dryRun: false }));

        expect(result.success).toBe(false);
        expect(result.errors.length).toBe(1);
        expect(result.errors[0].entityType).toBe('practice');
        expect(result.errors[0].entityId).toBe('ctrl-1');
        expect(result.errors[0].message).toContain('DB connection failed');
    });

    test('P2002 unique constraint with SKIP strategy skips', async () => {
        const p2002Error = new Error('Unique constraint');
        (p2002Error as any).code = 'P2002';
        createSpy.mockRejectedValueOnce(p2002Error);

        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: 'ctrl-1',
                schemaVersion: '1.0',
                data: { name: 'C', tenantId: 'source-tenant' },
            }],
        });

        const result = await importTenantData(envelope, makeOptions({
            conflictStrategy: 'SKIP',
            dryRun: false,
        }));

        // P2002 with SKIP → skipped, not error
        expect(result.skipped.practice).toBe(1);
    });

    test('invalid envelope fails before any persistence', async () => {
        const result = await importTenantData(
            { invalid: true },
            makeOptions({ dryRun: false }),
        );

        expect(result.success).toBe(false);
        expect(createSpy).not.toHaveBeenCalled();
    });
});

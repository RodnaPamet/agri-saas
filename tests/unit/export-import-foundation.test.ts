/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Export/Import Service Foundation Tests
 *
 * Tests:
 *   1. Export envelope schema validation — valid + invalid
 *   2. Import options validation — valid + invalid
 *   3. Format version checking
 *   4. Domain → entity type mapping completeness
 *   5. Import ordering covers all entity types
 *   6. Import service validates and rejects bad input
 *   7. Import dry-run mode
 *   8. Entity filtering (include/exclude)
 */

import {
    EXPORT_FORMAT_VERSION,
    APP_IDENTIFIER,
    DOMAIN_ENTITY_MAP,
    IMPORT_ORDER,
    FULL_TENANT_DOMAINS,
    validateExportEnvelope,
    validateImportOptions,
    isFormatVersionSupported,
    parseFormatVersion,
    checkVersionCompatibility,
    type ExportEnvelope,
    type ExportEntityType,
    type ImportOptions,
} from '../../src/app-layer/services/export-schemas';

// ─── Fixture Builders ───────────────────────────────────────────────

function makeValidEnvelope(overrides: Partial<ExportEnvelope> = {}): ExportEnvelope {
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
            practice: [
                {
                    entityType: 'practice',
                    id: 'ctrl-1',
                    schemaVersion: '1.0',
                    data: { name: 'Firewall Policy', status: 'ACTIVE' },
                },
            ],
        },
        relationships: [
            {
                fromType: 'practiceTestPlan',
                fromId: 'tp-1',
                toType: 'practice',
                toId: 'ctrl-1',
                relationship: 'BELONGS_TO',
            },
        ],
        ...overrides,
    };
}

function makeValidOptions(overrides: Partial<ImportOptions> = {}): ImportOptions {
    return {
        targetTenantId: 'tenant-target',
        conflictStrategy: 'SKIP',
        ...overrides,
    };
}

// ═════════════════════════════════════════════════════════════════════
// 1. Export Envelope Validation
// ═════════════════════════════════════════════════════════════════════

describe('Export envelope validation', () => {
    test('valid envelope passes validation', () => {
        const result = validateExportEnvelope(makeValidEnvelope());
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    test('null input rejected', () => {
        const result = validateExportEnvelope(null);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Input is not an object');
    });

    test('missing formatVersion rejected', () => {
        const envelope = makeValidEnvelope();
        delete (envelope as any).formatVersion;
        const result = validateExportEnvelope(envelope);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('formatVersion'))).toBe(true);
    });

    test('missing metadata rejected', () => {
        const envelope = makeValidEnvelope();
        delete (envelope as any).metadata;
        const result = validateExportEnvelope(envelope);
        expect(result.valid).toBe(false);
    });

    test('missing metadata.tenantId rejected', () => {
        const envelope = makeValidEnvelope();
        delete (envelope.metadata as any).tenantId;
        const result = validateExportEnvelope(envelope);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('tenantId'))).toBe(true);
    });

    test('missing metadata.exportedAt rejected', () => {
        const envelope = makeValidEnvelope();
        delete (envelope.metadata as any).exportedAt;
        const result = validateExportEnvelope(envelope);
        expect(result.valid).toBe(false);
    });

    test('invalid domain rejected', () => {
        const envelope = makeValidEnvelope();
        (envelope.metadata as any).domains = ['INVALID_DOMAIN'];
        const result = validateExportEnvelope(envelope);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('INVALID_DOMAIN'))).toBe(true);
    });

    test('empty domains rejected', () => {
        const envelope = makeValidEnvelope();
        (envelope.metadata as any).domains = [];
        const result = validateExportEnvelope(envelope);
        expect(result.valid).toBe(false);
    });

    test('unknown entity type rejected', () => {
        const envelope = makeValidEnvelope();
        (envelope.entities as any).unknownType = [{ id: 'x', entityType: 'unknownType', schemaVersion: '1.0', data: {} }];
        const result = validateExportEnvelope(envelope);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('unknownType'))).toBe(true);
    });

    test('entity record missing id rejected', () => {
        const envelope = makeValidEnvelope();
        envelope.entities.practice = [
            { entityType: 'practice', id: '', schemaVersion: '1.0', data: { name: 'x' } },
        ];
        const result = validateExportEnvelope(envelope);
        expect(result.valid).toBe(false);
    });

    test('entity record with wrong entityType rejected', () => {
        const envelope = makeValidEnvelope();
        envelope.entities.practice = [
            { entityType: 'policy' as any, id: 'ctrl-1', schemaVersion: '1.0', data: {} },
        ];
        const result = validateExportEnvelope(envelope);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes("must be 'practice'"))).toBe(true);
    });

    test('invalid relationship type rejected', () => {
        const envelope = makeValidEnvelope();
        envelope.relationships = [
            { fromType: 'practice', fromId: 'a', toType: 'policy', toId: 'b', relationship: 'INVALID' as any },
        ];
        const result = validateExportEnvelope(envelope);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('INVALID'))).toBe(true);
    });

    test('valid envelope with multiple entity types passes', () => {
        const envelope = makeValidEnvelope();
        envelope.entities.policy = [
            { entityType: 'policy', id: 'pol-1', schemaVersion: '1.0', data: { title: 'Privacy' } },
        ];
        envelope.metadata.domains = ['CONTROLS', 'POLICIES'];
        const result = validateExportEnvelope(envelope);
        expect(result.valid).toBe(true);
    });

    test('valid envelope with all domains passes', () => {
        const envelope = makeValidEnvelope();
        envelope.metadata.domains = ['FULL_TENANT'];
        const result = validateExportEnvelope(envelope);
        expect(result.valid).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Import Options Validation
// ═════════════════════════════════════════════════════════════════════

describe('Import options validation', () => {
    test('valid options pass', () => {
        const result = validateImportOptions(makeValidOptions());
        expect(result.valid).toBe(true);
    });

    test('missing targetTenantId rejected', () => {
        const result = validateImportOptions({ conflictStrategy: 'SKIP' });
        expect(result.valid).toBe(false);
    });

    test('missing conflictStrategy rejected', () => {
        const result = validateImportOptions({ targetTenantId: 'x' });
        expect(result.valid).toBe(false);
    });

    test('invalid conflictStrategy rejected', () => {
        const result = validateImportOptions({
            targetTenantId: 'x',
            conflictStrategy: 'INVALID',
        });
        expect(result.valid).toBe(false);
    });

    test('all valid conflict strategies accepted', () => {
        for (const strategy of ['SKIP', 'OVERWRITE', 'RENAME', 'FAIL']) {
            const result = validateImportOptions({
                targetTenantId: 'x',
                conflictStrategy: strategy,
            });
            expect(result.valid).toBe(true);
        }
    });

    test('invalid includeEntityType rejected', () => {
        const result = validateImportOptions({
            targetTenantId: 'x',
            conflictStrategy: 'SKIP',
            includeEntityTypes: ['unknownType'],
        });
        expect(result.valid).toBe(false);
    });

    test('valid includeEntityTypes accepted', () => {
        const result = validateImportOptions({
            targetTenantId: 'x',
            conflictStrategy: 'SKIP',
            includeEntityTypes: ['practice', 'policy'],
        });
        expect(result.valid).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Format Version Checking
// ═════════════════════════════════════════════════════════════════════

describe('Format version checking', () => {
    // --- parseFormatVersion ---
    test('parses valid major.minor format', () => {
        expect(parseFormatVersion('1.0')).toEqual({ major: 1, minor: 0 });
        expect(parseFormatVersion('2.3')).toEqual({ major: 2, minor: 3 });
        expect(parseFormatVersion('10.25')).toEqual({ major: 10, minor: 25 });
    });

    test('rejects invalid format strings', () => {
        expect(parseFormatVersion('')).toBeNull();
        expect(parseFormatVersion('1')).toBeNull();
        expect(parseFormatVersion('v1.0')).toBeNull();
        expect(parseFormatVersion('1.0.0')).toBeNull();
        expect(parseFormatVersion('abc')).toBeNull();
        expect(parseFormatVersion(undefined as any)).toBeNull();
    });

    // --- isFormatVersionSupported (semver-aware) ---
    test('current version (exact match) is supported', () => {
        expect(isFormatVersionSupported('1.0')).toBe(true);
    });

    test('same major, different minor is supported (compatible)', () => {
        expect(isFormatVersionSupported('1.1')).toBe(true);
        expect(isFormatVersionSupported('1.5')).toBe(true);
        expect(isFormatVersionSupported('1.99')).toBe(true);
    });

    test('different major is NOT supported (breaking)', () => {
        expect(isFormatVersionSupported('2.0')).toBe(false);
        expect(isFormatVersionSupported('0.1')).toBe(false);
        expect(isFormatVersionSupported('3.0')).toBe(false);
    });

    test('invalid versions are NOT supported', () => {
        expect(isFormatVersionSupported('')).toBe(false);
        expect(isFormatVersionSupported('abc')).toBe(false);
        expect(isFormatVersionSupported('1.0.0')).toBe(false);
    });

    test('EXPORT_FORMAT_VERSION constant is supported', () => {
        expect(isFormatVersionSupported(EXPORT_FORMAT_VERSION)).toBe(true);
    });

    // --- checkVersionCompatibility ---
    test('exact match returns EXACT', () => {
        const result = checkVersionCompatibility('1.0');
        expect(result.level).toBe('EXACT');
        expect(result.message).toContain('Exact match');
    });

    test('same major returns COMPATIBLE', () => {
        const result = checkVersionCompatibility('1.3');
        expect(result.level).toBe('COMPATIBLE');
        expect(result.message).toContain('Compatible');
        expect(result.bundleVersion).toBe('1.3');
        expect(result.appVersion).toBe(EXPORT_FORMAT_VERSION);
    });

    test('different major returns INCOMPATIBLE', () => {
        const result = checkVersionCompatibility('2.0');
        expect(result.level).toBe('INCOMPATIBLE');
        expect(result.message).toContain('Incompatible');
    });

    test('invalid string returns INVALID', () => {
        const result = checkVersionCompatibility('garbage');
        expect(result.level).toBe('INVALID');
        expect(result.message).toContain('Invalid format version');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Domain → Entity Type Mapping Completeness
// ═════════════════════════════════════════════════════════════════════

describe('Domain entity mapping', () => {
    test('FULL_TENANT covers all domain-specific entity types', () => {
        const allDomainTypes = new Set<string>();
        for (const domain of FULL_TENANT_DOMAINS) {
            for (const t of DOMAIN_ENTITY_MAP[domain]) {
                allDomainTypes.add(t);
            }
        }

        const fullTenantTypes = new Set(DOMAIN_ENTITY_MAP.FULL_TENANT);

        // Every type in individual domains must be in FULL_TENANT
        for (const t of allDomainTypes) {
            expect(fullTenantTypes.has(t as ExportEntityType)).toBe(true);
        }
    });

    test('every entity type appears in at least one domain', () => {
        const allMappedTypes = new Set<string>();
        for (const types of Object.values(DOMAIN_ENTITY_MAP)) {
            for (const t of types) {
                allMappedTypes.add(t);
            }
        }

        // Verify we're not missing entity types
        expect(allMappedTypes.size).toBeGreaterThanOrEqual(10);
    });

    test('no domain has an empty entity list', () => {
        for (const [_domain, types] of Object.entries(DOMAIN_ENTITY_MAP)) {
            expect(types.length).toBeGreaterThan(0);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Import Ordering
// ═════════════════════════════════════════════════════════════════════

describe('Import ordering', () => {
    test('IMPORT_ORDER covers all FULL_TENANT entity types', () => {
        const orderSet = new Set(IMPORT_ORDER);
        for (const t of DOMAIN_ENTITY_MAP.FULL_TENANT) {
            expect(orderSet.has(t)).toBe(true);
        }
    });

    test('parent types come before child types', () => {
        const indexOf = (t: ExportEntityType) => IMPORT_ORDER.indexOf(t);

        // Practices before test plans/runs
        expect(indexOf('practice')).toBeLessThan(indexOf('practiceTestPlan'));
        expect(indexOf('practice')).toBeLessThan(indexOf('practiceTestRun'));

        // Policies before versions
        expect(indexOf('policy')).toBeLessThan(indexOf('policyVersion'));

        // Vendors before reviews/subprocessors
        expect(indexOf('vendor')).toBeLessThan(indexOf('vendorReview'));
        expect(indexOf('vendor')).toBeLessThan(indexOf('vendorSubprocessor'));

        // Tasks before task links
        expect(indexOf('task')).toBeLessThan(indexOf('taskLink'));
    });

    test('no duplicates in IMPORT_ORDER', () => {
        const seen = new Set<string>();
        for (const t of IMPORT_ORDER) {
            expect(seen.has(t)).toBe(false);
            seen.add(t);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Import Service — Validation and Rejection
// ═════════════════════════════════════════════════════════════════════

// Mock dependencies for import service
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
            create: jest.fn().mockResolvedValue({ id: 'new' }),
            update: jest.fn().mockResolvedValue({ id: 'updated' }),
            findUnique: jest.fn().mockResolvedValue(null),
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

describe('Import service: validation and rejection', () => {
    test('rejects invalid envelope', async () => {
        const result = await importTenantData(
            { invalid: true },
            makeValidOptions(),
        );
        expect(result.success).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    test('rejects invalid options', async () => {
        const result = await importTenantData(
            makeValidEnvelope(),
            { invalid: true },
        );
        expect(result.success).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    test('rejects unsupported format version', async () => {
        const envelope = makeValidEnvelope();
        (envelope as any).formatVersion = '99.0';
        const result = await importTenantData(envelope, makeValidOptions());
        expect(result.success).toBe(false);
        expect(result.errors.some(e => e.message.includes('Unsupported format'))).toBe(true);
    });

    test('accepts valid envelope and options', async () => {
        const result = await importTenantData(
            makeValidEnvelope(),
            makeValidOptions(),
        );
        expect(result.success).toBe(true);
        expect(result.imported.practice).toBe(1);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 7. Import Dry-Run Mode
// ═════════════════════════════════════════════════════════════════════

describe('Import service: dry-run mode', () => {
    test('dry run counts entities without persisting', async () => {
        const result = await importTenantData(
            makeValidEnvelope(),
            makeValidOptions({ dryRun: true }),
        );
        expect(result.success).toBe(true);
        expect(result.dryRun).toBe(true);
        expect(result.imported.practice).toBe(1);
    });

    test('validateImportEnvelope uses dry run', async () => {
        const result = await validateImportEnvelope(
            makeValidEnvelope(),
            'tenant-target',
        );
        expect(result.dryRun).toBe(true);
        expect(result.success).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 8. Entity Filtering
// ═════════════════════════════════════════════════════════════════════

describe('Import service: entity filtering', () => {
    test('includeEntityTypes limits what is imported', async () => {
        const envelope = makeValidEnvelope();
        envelope.entities.policy = [
            { entityType: 'policy', id: 'pol-1', schemaVersion: '1.0', data: {} },
        ];

        const result = await importTenantData(envelope, makeValidOptions({
            includeEntityTypes: ['policy'],
        }));

        expect(result.imported.policy).toBe(1);
        expect(result.imported.practice).toBeUndefined();
    });

    test('excludeEntityTypes removes types from import', async () => {
        const envelope = makeValidEnvelope();
        envelope.entities.policy = [
            { entityType: 'policy', id: 'pol-1', schemaVersion: '1.0', data: {} },
        ];

        const result = await importTenantData(envelope, makeValidOptions({
            excludeEntityTypes: ['practice'],
        }));

        expect(result.imported.policy).toBe(1);
        expect(result.imported.practice).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 9. Constants Sanity
// ═════════════════════════════════════════════════════════════════════

describe('Export constants', () => {
    test('EXPORT_FORMAT_VERSION is a valid semver-like string', () => {
        expect(EXPORT_FORMAT_VERSION).toMatch(/^\d+\.\d+$/);
    });

    test('APP_IDENTIFIER is correct', () => {
        expect(APP_IDENTIFIER).toBe('inflect-compliance');
    });
});

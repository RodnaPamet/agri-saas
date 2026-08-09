/**
 * Tenant Safety & Self-Reference Handling Tests
 *
 * Tests:
 *   1. Self-reference cycle detection
 *   2. Topological sort for hierarchical data
 *   3. Cross-tenant FK rejection
 *   4. Duplicate ID detection
 *   5. Bundle integrity validation
 *   6. Relationship target validation
 *   7. Import service rejects unsafe bundles
 *   8. Schema guardrail: no self-referencing models in current schema
 */

import {
    detectSelfReferenceCycles,
    topologicalSortSelfRefs,
    validateTenantSafety,
    SELF_REFERENCING_FIELDS,
} from '../../src/app-layer/services/tenant-safety';
import {
    EXPORT_FORMAT_VERSION,
    APP_IDENTIFIER,
    type ExportEnvelope,
    type ExportEntityRecord,
    type ExportEntityType,
    type ImportOptions,
} from '../../src/app-layer/services/export-schemas';

// ─── Fixtures ───────────────────────────────────────────────────────

function makeEnvelope(
    entities: ExportEnvelope['entities'] = {},
    relationships: ExportEnvelope['relationships'] = [],
    sourceTenantId = 'source-tenant',
): ExportEnvelope {
    return {
        formatVersion: EXPORT_FORMAT_VERSION,
        metadata: {
            tenantId: sourceTenantId,
            exportedAt: new Date().toISOString(),
            domains: ['CONTROLS'],
            app: APP_IDENTIFIER,
            appVersion: '1.0.0',
        },
        entities,
        relationships,
    };
}

function makeOptions(targetTenantId = 'target-tenant'): ImportOptions {
    return {
        targetTenantId,
        conflictStrategy: 'SKIP',
    };
}

function makeRecord(
    entityType: ExportEntityType,
    id: string,
    data: Record<string, unknown> = {},
): ExportEntityRecord {
    return {
        entityType,
        id,
        schemaVersion: '1.0',
        data: { tenantId: 'source-tenant', ...data },
    };
}

// ═════════════════════════════════════════════════════════════════════
// 1. Self-Reference Cycle Detection
// ═════════════════════════════════════════════════════════════════════

describe('Self-reference cycle detection', () => {
    test('no cycles in flat entity set', () => {
        const records = [
            makeRecord('practice', 'c1'),
            makeRecord('practice', 'c2'),
            makeRecord('practice', 'c3'),
        ];
        const cycles = detectSelfReferenceCycles('practice', records);
        expect(cycles).toEqual([]);
    });

    test('no cycles when no self-ref fields registered', () => {
        const records = [
            makeRecord('practice', 'c1', { parentId: 'c2' }),
            makeRecord('practice', 'c2', { parentId: 'c1' }),
        ];
        // practice has no registered self-ref fields, so no detection
        const cycles = detectSelfReferenceCycles('practice', records);
        expect(cycles).toEqual([]);
    });

    test('detects cycle when self-ref field is registered', () => {
        // Temporarily add a self-ref field for testing
        const original = SELF_REFERENCING_FIELDS.practice;
        SELF_REFERENCING_FIELDS.practice = ['parentId'];

        try {
            const records = [
                makeRecord('practice', 'c1', { parentId: 'c2' }),
                makeRecord('practice', 'c2', { parentId: 'c1' }),
            ];
            const cycles = detectSelfReferenceCycles('practice', records);
            expect(cycles.length).toBeGreaterThanOrEqual(1);
        } finally {
            SELF_REFERENCING_FIELDS.practice = original;
        }
    });

    test('no false positive for valid parent chain', () => {
        const original = SELF_REFERENCING_FIELDS.practice;
        SELF_REFERENCING_FIELDS.practice = ['parentId'];

        try {
            const records = [
                makeRecord('practice', 'root', {}),           // root (no parent)
                makeRecord('practice', 'child', { parentId: 'root' }),
                makeRecord('practice', 'grandchild', { parentId: 'child' }),
            ];
            const cycles = detectSelfReferenceCycles('practice', records);
            expect(cycles).toEqual([]);
        } finally {
            SELF_REFERENCING_FIELDS.practice = original;
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Topological Sort for Self-References
// ═════════════════════════════════════════════════════════════════════

describe('Topological sort for self-references', () => {
    test('returns records unchanged when no self-ref fields', () => {
        const records = [
            makeRecord('practice', 'c1'),
            makeRecord('practice', 'c2'),
        ];
        const sorted = topologicalSortSelfRefs('practice', records);
        expect(sorted).toEqual(records);
    });

    test('orders parents before children', () => {
        const original = SELF_REFERENCING_FIELDS.practice;
        SELF_REFERENCING_FIELDS.practice = ['parentId'];

        try {
            const records = [
                makeRecord('practice', 'child', { parentId: 'root' }),
                makeRecord('practice', 'root', {}),
                makeRecord('practice', 'grandchild', { parentId: 'child' }),
            ];
            const sorted = topologicalSortSelfRefs('practice', records);
            const ids = sorted.map(r => r.id);

            expect(ids.indexOf('root')).toBeLessThan(ids.indexOf('child'));
            expect(ids.indexOf('child')).toBeLessThan(ids.indexOf('grandchild'));
        } finally {
            SELF_REFERENCING_FIELDS.practice = original;
        }
    });

    test('throws on cycle', () => {
        const original = SELF_REFERENCING_FIELDS.practice;
        SELF_REFERENCING_FIELDS.practice = ['parentId'];

        try {
            const records = [
                makeRecord('practice', 'c1', { parentId: 'c2' }),
                makeRecord('practice', 'c2', { parentId: 'c1' }),
            ];
            expect(() => topologicalSortSelfRefs('practice', records)).toThrow(/Cycle detected/);
        } finally {
            SELF_REFERENCING_FIELDS.practice = original;
        }
    });

    test('handles multiple independent trees', () => {
        const original = SELF_REFERENCING_FIELDS.practice;
        SELF_REFERENCING_FIELDS.practice = ['parentId'];

        try {
            const records = [
                makeRecord('practice', 'a-child', { parentId: 'a-root' }),
                makeRecord('practice', 'b-child', { parentId: 'b-root' }),
                makeRecord('practice', 'a-root', {}),
                makeRecord('practice', 'b-root', {}),
            ];
            const sorted = topologicalSortSelfRefs('practice', records);
            const ids = sorted.map(r => r.id);

            expect(ids.indexOf('a-root')).toBeLessThan(ids.indexOf('a-child'));
            expect(ids.indexOf('b-root')).toBeLessThan(ids.indexOf('b-child'));
        } finally {
            SELF_REFERENCING_FIELDS.practice = original;
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Cross-Tenant FK Rejection
// ═════════════════════════════════════════════════════════════════════

describe('Tenant safety: cross-tenant FK rejection', () => {
    test('clean bundle passes', () => {
        const envelope = makeEnvelope({
            practice: [makeRecord('practice', 'c1')],
        });
        const result = validateTenantSafety(envelope, makeOptions());
        expect(result.safe).toBe(true);
        expect(result.violations).toEqual([]);
    });

    test('entity with source tenantId is safe', () => {
        const envelope = makeEnvelope({
            practice: [makeRecord('practice', 'c1', { tenantId: 'source-tenant' })],
        });
        const result = validateTenantSafety(envelope, makeOptions());
        expect(result.safe).toBe(true);
    });

    test('entity with target tenantId is safe', () => {
        const envelope = makeEnvelope({
            practice: [makeRecord('practice', 'c1', { tenantId: 'target-tenant' })],
        });
        const result = validateTenantSafety(envelope, makeOptions());
        expect(result.safe).toBe(true);
    });

    test('entity with foreign tenantId is rejected', () => {
        const envelope = makeEnvelope({
            practice: [makeRecord('practice', 'c1', { tenantId: 'evil-tenant' })],
        });
        const result = validateTenantSafety(envelope, makeOptions());
        expect(result.safe).toBe(false);
        expect(result.violations.some(v => v.rule === 'NO_CROSS_TENANT_FK')).toBe(true);
        expect(result.violations[0].message).toContain('evil-tenant');
    });

    test('mixed tenantIds — one foreign — is rejected', () => {
        const envelope = makeEnvelope({
            practice: [
                makeRecord('practice', 'c1', { tenantId: 'source-tenant' }),
                makeRecord('practice', 'c2', { tenantId: 'other-tenant' }),
            ],
        });
        const result = validateTenantSafety(envelope, makeOptions());
        expect(result.safe).toBe(false);
        const crossTenantV = result.violations.find(v => v.rule === 'NO_CROSS_TENANT_FK');
        expect(crossTenantV?.entityId).toBe('c2');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Duplicate ID Detection
// ═════════════════════════════════════════════════════════════════════

describe('Tenant safety: duplicate ID detection', () => {
    test('unique IDs pass', () => {
        const envelope = makeEnvelope({
            practice: [
                makeRecord('practice', 'c1'),
                makeRecord('practice', 'c2'),
            ],
        });
        const result = validateTenantSafety(envelope, makeOptions());
        expect(result.violations.filter(v => v.rule === 'DUPLICATE_ID')).toEqual([]);
    });

    test('duplicate IDs within same type detected', () => {
        const envelope = makeEnvelope({
            practice: [
                makeRecord('practice', 'c1'),
                makeRecord('practice', 'c1'), // duplicate
            ],
        });
        const result = validateTenantSafety(envelope, makeOptions());
        expect(result.safe).toBe(false);
        expect(result.violations.some(v => v.rule === 'DUPLICATE_ID')).toBe(true);
    });

    test('same ID in different entity types is allowed', () => {
        const envelope = makeEnvelope({
            practice: [makeRecord('practice', 'shared-id')],
            policy: [makeRecord('policy', 'shared-id')],
        });
        const result = validateTenantSafety(envelope, makeOptions());
        expect(result.violations.filter(v => v.rule === 'DUPLICATE_ID')).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Bundle Integrity
// ═════════════════════════════════════════════════════════════════════

describe('Tenant safety: bundle integrity', () => {
    test('valid entities pass integrity check', () => {
        const envelope = makeEnvelope({
            practice: [makeRecord('practice', 'c1', { name: 'Valid' })],
        });
        const result = validateTenantSafety(envelope, makeOptions());
        expect(result.violations.filter(v => v.rule === 'BUNDLE_INTEGRITY')).toEqual([]);
    });

    test('entity with empty id is rejected', () => {
        const envelope = makeEnvelope({
            practice: [{
                entityType: 'practice',
                id: '',
                schemaVersion: '1.0',
                data: { name: 'Bad' },
            }],
        });
        const result = validateTenantSafety(envelope, makeOptions());
        expect(result.safe).toBe(false);
        expect(result.violations.some(v => v.rule === 'BUNDLE_INTEGRITY')).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Relationship Target Validation
// ═════════════════════════════════════════════════════════════════════

describe('Tenant safety: relationship targets', () => {
    test('valid relationship passes', () => {
        const envelope = makeEnvelope(
            {
                practice: [makeRecord('practice', 'c1')],
                practiceTestPlan: [makeRecord('practiceTestPlan', 'tp1')],
            },
            [{
                fromType: 'practiceTestPlan',
                fromId: 'tp1',
                toType: 'practice',
                toId: 'c1',
                relationship: 'BELONGS_TO',
            }],
        );
        const result = validateTenantSafety(envelope, makeOptions());
        expect(result.violations.filter(v => v.rule === 'MISSING_RELATIONSHIP_TARGET')).toEqual([]);
    });

    test('relationship referencing missing entity generates warning', () => {
        const envelope = makeEnvelope(
            {
                practice: [makeRecord('practice', 'c1')],
            },
            [{
                fromType: 'practice',
                fromId: 'c1',
                toType: 'practice',
                toId: 'c-missing',
                relationship: 'LINKED_TO',
            }],
        );
        const result = validateTenantSafety(envelope, makeOptions());
        const warnings = result.violations.filter(v => v.rule === 'MISSING_RELATIONSHIP_TARGET');
        expect(warnings.length).toBeGreaterThanOrEqual(1);
        // Warnings don't block import (they're severity WARNING)
        expect(result.safe).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 7. Import Service Integration — Unsafe Bundles Rejected
// ═════════════════════════════════════════════════════════════════════

jest.mock('@/lib/prisma', () => {
    const models = [
        'practice', 'practiceTestPlan', 'practiceTestRun', 'practiceRequirementLink',
        'policy', 'policyVersion', 'risk', 'evidence',
        'task', 'taskLink',
        'vendor', 'vendorAssessment', 'vendorRelationship',
        'framework', 'frameworkRequirement',
    ];
    const mockPrisma: Record<string, Record<string, unknown>> = {};
    for (const model of models) {
        mockPrisma[model] = {
            create: jest.fn().mockResolvedValue({ id: 'new' }),
            update: jest.fn().mockResolvedValue({ id: 'upd' }),
            findUnique: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockResolvedValue([]),
        };
    }
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

import { importTenantData } from '../../src/app-layer/services/import-service';
import { readPrismaSchema } from '../helpers/prisma-schema';

describe('Import service: rejects unsafe bundles', () => {
    test('rejects bundle with cross-tenant references', async () => {
        const envelope = makeEnvelope({
            practice: [makeRecord('practice', 'c1', { tenantId: 'evil-tenant' })],
        });
        const result = await importTenantData(envelope, makeOptions());
        expect(result.success).toBe(false);
        expect(result.errors.some(e => e.message.includes('NO_CROSS_TENANT_FK'))).toBe(true);
    });

    test('rejects bundle with duplicate IDs', async () => {
        const envelope = makeEnvelope({
            practice: [
                makeRecord('practice', 'dup1'),
                makeRecord('practice', 'dup1'),
            ],
        });
        const result = await importTenantData(envelope, makeOptions());
        expect(result.success).toBe(false);
        expect(result.errors.some(e => e.message.includes('DUPLICATE_ID'))).toBe(true);
    });

    test('accepts clean bundle', async () => {
        const envelope = makeEnvelope({
            practice: [makeRecord('practice', 'c1')],
        });
        const result = await importTenantData(envelope, {
            ...makeOptions(),
            dryRun: true,
        });
        expect(result.success).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 8. Schema Guardrail: No Self-Referencing Models
// ═════════════════════════════════════════════════════════════════════

describe('GUARDRAIL: Prisma schema has no unregistered self-referencing models', () => {
    test('no model has a FK pointing to itself', () => {
        const schemaContent = readPrismaSchema();

        // Models with a deliberate self-referencing FK that are NOT part of
        // the export/import system — so the import-ordering concern this
        // guard protects (parent-before-child topo sort) does not apply.
        // Tenant-safety is still enforced by RLS + the app-layer same-tenant
        // checks on the owning usecase.
        const EXEMPT_SELF_REF = new Set<string>([
            // RQ-5 — org hierarchy tree; not exportable, RLS-isolated.
            'RiskHierarchyNode',
        ]);

        // Parse model blocks
        const modelRegex = /model\s+(\w+)\s*\{([^}]+)\}/g;
        let match;
        const selfRefModels: string[] = [];

        while ((match = modelRegex.exec(schemaContent)) !== null) {
            const modelName = match[1];
            const body = match[2];

            // Find FK relations: fieldName ModelName @relation(...)
            // A self-ref is when a field references the same model
            const fieldRegex = /^\s+(\w+)\s+(\w+)\??\s+@relation.*fields:\s*\[(\w+)\]/gm;
            let fieldMatch;

            while ((fieldMatch = fieldRegex.exec(body)) !== null) {
                const referencedModel = fieldMatch[2];
                if (referencedModel === modelName && !EXEMPT_SELF_REF.has(modelName)) {
                    selfRefModels.push(`${modelName}.${fieldMatch[3]} → ${modelName}`);
                }
            }
        }

        if (selfRefModels.length > 0) {
            fail(
                `Self-referencing FK(s) detected in Prisma schema:\n` +
                selfRefModels.map(s => `  - ${s}`).join('\n') + '\n' +
                `Register these in SELF_REFERENCING_FIELDS (tenant-safety.ts) ` +
                `and add topological sort handling in the import service.`,
            );
        }
    });

    test('SELF_REFERENCING_FIELDS covers all exportable entity types', () => {
        const entityTypes: ExportEntityType[] = [
            'practice', 'practiceTestPlan', 'practiceTestRun', 'practiceMapping',
            'policy', 'policyVersion', 'risk', 'evidence',
            'task', 'taskLink',
            'vendor', 'vendorReview', 'vendorSubprocessor',
            'framework', 'frameworkRequirement',
        ];

        for (const type of entityTypes) {
            expect(SELF_REFERENCING_FIELDS).toHaveProperty(type);
            expect(Array.isArray(SELF_REFERENCING_FIELDS[type])).toBe(true);
        }
    });

    test('all registered self-ref fields are currently empty (no self-refs in schema)', () => {
        for (const [_type, fields] of Object.entries(SELF_REFERENCING_FIELDS)) {
            expect(fields).toEqual([]);
        }
    });
});

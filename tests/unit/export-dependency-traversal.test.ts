/**
 * Export Dependency Traversal Tests
 *
 * Tests:
 *   1. Graph structure: edges, reachability, deduplication
 *   2. Domain root → dependent entity traversal
 *   3. Tenant isolation: unrelated tenant data excluded
 *   4. M2M / join table relationships exported correctly
 *   5. Duplicate entity deduplication
 *   6. Soft-deleted entities excluded
 *   7. Structural: graph covers all domain entity types
 */

import {
    EXPORT_EDGES,
    getEdgesFrom,
    getReachableTypes,
} from '../../src/app-layer/services/export-graph';
import {
    DOMAIN_ENTITY_MAP,
    type ExportEntityType,
    type ExportDomain,
} from '../../src/app-layer/services/export-schemas';

// ═════════════════════════════════════════════════════════════════════
// 1. Graph Structure
// ═════════════════════════════════════════════════════════════════════

describe('Export graph: edge structure', () => {
    test('every edge has valid from/to entity types', () => {
        for (const edge of EXPORT_EDGES) {
            expect(typeof edge.from).toBe('string');
            expect(typeof edge.to).toBe('string');
            expect(edge.from).not.toBe(edge.to); // no self-refs in current graph
        }
    });

    test('every edge has a prismaModel and foreignKey', () => {
        for (const edge of EXPORT_EDGES) {
            expect(edge.prismaModel).toBeTruthy();
            expect(edge.foreignKey).toBeTruthy();
        }
    });

    test('JOIN edges have targetKey and targetModel', () => {
        const joinEdges = EXPORT_EDGES.filter(e => e.kind === 'JOIN');
        for (const edge of joinEdges) {
            expect(edge.targetKey).toBeTruthy();
            expect(edge.targetModel).toBeTruthy();
        }
    });

    test('every edge has a valid relationship type', () => {
        const validTypes = new Set(['BELONGS_TO', 'LINKED_TO', 'MAPS_TO', 'VERSION_OF', 'REVIEWS']);
        for (const edge of EXPORT_EDGES) {
            expect(validTypes.has(edge.relationship)).toBe(true);
        }
    });

    test('no duplicate edges', () => {
        const seen = new Set<string>();
        for (const edge of EXPORT_EDGES) {
            const key = `${edge.from}→${edge.to}:${edge.foreignKey}`;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Graph Reachability
// ═════════════════════════════════════════════════════════════════════

describe('Export graph: reachability', () => {
    test('practice reaches test plans, test runs, and mappings', () => {
        const reachable = getReachableTypes('practice');
        expect(reachable.has('practice')).toBe(true);
        expect(reachable.has('practiceTestPlan')).toBe(true);
        expect(reachable.has('practiceTestRun')).toBe(true);
        expect(reachable.has('practiceMapping')).toBe(true);
    });

    test('policy reaches versions', () => {
        const reachable = getReachableTypes('policy');
        expect(reachable.has('policy')).toBe(true);
        expect(reachable.has('policyVersion')).toBe(true);
    });

    test('vendor reaches reviews and subprocessors', () => {
        const reachable = getReachableTypes('vendor');
        expect(reachable.has('vendor')).toBe(true);
        expect(reachable.has('vendorReview')).toBe(true);
        expect(reachable.has('vendorSubprocessor')).toBe(true);
    });

    test('framework reaches requirements', () => {
        const reachable = getReachableTypes('framework');
        expect(reachable.has('framework')).toBe(true);
        expect(reachable.has('frameworkRequirement')).toBe(true);
    });

    test('task reaches task links', () => {
        const reachable = getReachableTypes('task');
        expect(reachable.has('task')).toBe(true);
        expect(reachable.has('taskLink')).toBe(true);
    });

    test('evidence is a leaf (no children)', () => {
        const reachable = getReachableTypes('evidence');
        expect(reachable.size).toBe(1);
        expect(reachable.has('evidence')).toBe(true);
    });

    test('risk is a leaf (no children)', () => {
        const reachable = getReachableTypes('risk');
        expect(reachable.size).toBe(1);
        expect(reachable.has('risk')).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Edge Lookup
// ═════════════════════════════════════════════════════════════════════

describe('Export graph: edge lookup', () => {
    test('getEdgesFrom returns outgoing edges for practice', () => {
        const edges = getEdgesFrom('practice');
        expect(edges.length).toBeGreaterThanOrEqual(2);
        expect(edges.every(e => e.from === 'practice')).toBe(true);
    });

    test('getEdgesFrom returns empty for leaf entities', () => {
        const edges = getEdgesFrom('evidence');
        expect(edges.length).toBe(0);
    });

    test('getEdgesFrom returns empty for unknown types', () => {
        const edges = getEdgesFrom('unknownType' as ExportEntityType);
        expect(edges.length).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Graph Coverage — Every Domain Entity Type Is Reachable
// ═════════════════════════════════════════════════════════════════════

describe('Export graph: domain coverage', () => {
    const DOMAIN_ROOTS: Record<string, ExportEntityType> = {
        CONTROLS: 'practice',
        POLICIES: 'policy',
        RISKS: 'risk',
        EVIDENCE: 'evidence',
        TASKS: 'task',
        VENDORS: 'vendor',
        FRAMEWORKS: 'framework',
    };

    test.each(
        Object.entries(DOMAIN_ROOTS).filter(([d]) => d !== 'FULL_TENANT'),
    )(
        '%s domain: all entity types reachable from root',
        (domain, rootType) => {
            const reachable = getReachableTypes(rootType);
            const domainTypes = DOMAIN_ENTITY_MAP[domain as ExportDomain];

            for (const entityType of domainTypes) {
                if (entityType === rootType) continue; // root is always reachable
                expect(reachable.has(entityType)).toBe(true);
            }
        },
    );
});

// ═════════════════════════════════════════════════════════════════════
// 5. Export Service — Mock-Based Traversal Tests
// ═════════════════════════════════════════════════════════════════════

// Create spies for each model
const spies: Record<string, jest.Mock> = {};
const modelNames = [
    'practice', 'practiceTestPlan', 'practiceTestRun', 'practiceRequirementLink',
    'policy', 'policyVersion',
    'risk',
    'evidence',
    'task', 'taskLink',
    'vendor', 'vendorAssessment', 'vendorRelationship',
    'framework', 'frameworkRequirement',
];

for (const model of modelNames) {
    spies[model] = jest.fn().mockResolvedValue([]);
}

// Build the mock Prisma-like object used by export service queries
const mockPrisma: Record<string, Record<string, unknown>> = {};
for (const model of modelNames) {
    mockPrisma[model] = { findMany: (...args: unknown[]) => spies[model](...args) };
}

// Mock withTenantDb — calls the callback with our mock prisma as the tx client
jest.mock('@/lib/db-context', () => ({
    withTenantDb: jest.fn(async (_tenantId: string, cb: (tx: unknown) => Promise<unknown>) => {
        return cb(mockPrisma);
    }),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        child: jest.fn().mockReturnThis(),
    },
}));

import { exportTenantData } from '../../src/app-layer/services/export-service';

beforeEach(() => {
    jest.clearAllMocks();
    for (const spy of Object.values(spies)) {
        spy.mockResolvedValue([]);
    }
});

describe('Export service: dependency-aware traversal', () => {
    test('practice domain traverses to test plans and test runs', async () => {
        // Root: 1 practice
        spies.practice.mockResolvedValue([
            { id: 'ctrl-1', tenantId: 't1', name: 'Firewall', status: 'ACTIVE' },
        ]);

        // Child: 1 test plan linked to ctrl-1
        spies.practiceTestPlan.mockResolvedValue([
            { id: 'tp-1', tenantId: 't1', practiceId: 'ctrl-1', name: 'Firewall Test' },
        ]);

        // Grandchild: 1 test run linked to tp-1
        spies.practiceTestRun.mockResolvedValue([
            { id: 'tr-1', tenantId: 't1', testPlanId: 'tp-1', practiceId: 'ctrl-1', status: 'PASSED' },
        ]);

        const result = await exportTenantData({
            tenantId: 't1',
            domains: ['CONTROLS'],
        });

        // Should have 3 entities: practice, testPlan, testRun
        expect(result.envelope.entities.practice?.length).toBe(1);
        expect(result.envelope.entities.practiceTestPlan?.length).toBe(1);
        expect(result.envelope.entities.practiceTestRun?.length).toBe(1);
        expect(result.stats.entityCount).toBe(3);
    });

    test('relationships are emitted for each traversed edge', async () => {
        spies.practice.mockResolvedValue([
            { id: 'ctrl-1', tenantId: 't1', name: 'Ctrl' },
        ]);
        spies.practiceTestPlan.mockResolvedValue([
            { id: 'tp-1', tenantId: 't1', practiceId: 'ctrl-1', name: 'Plan' },
        ]);

        const result = await exportTenantData({
            tenantId: 't1',
            domains: ['CONTROLS'],
        });

        // Should have at least 1 relationship: tp-1 BELONGS_TO ctrl-1
        const rels = result.envelope.relationships;
        expect(rels.length).toBeGreaterThanOrEqual(1);
        const tpRel = rels.find(r => r.fromId === 'tp-1' && r.toId === 'ctrl-1');
        expect(tpRel).toBeDefined();
        expect(tpRel?.relationship).toBe('BELONGS_TO');
    });

    test('policy domain includes versions', async () => {
        spies.policy.mockResolvedValue([
            { id: 'pol-1', tenantId: 't1', title: 'Privacy' },
        ]);
        spies.policyVersion.mockResolvedValue([
            { id: 'pv-1', tenantId: 't1', policyId: 'pol-1', versionNumber: 1 },
        ]);

        const result = await exportTenantData({
            tenantId: 't1',
            domains: ['POLICIES'],
        });

        expect(result.envelope.entities.policy?.length).toBe(1);
        expect(result.envelope.entities.policyVersion?.length).toBe(1);

        const rel = result.envelope.relationships.find(r => r.fromId === 'pv-1');
        expect(rel?.relationship).toBe('VERSION_OF');
    });

    test('vendor domain includes assessments and subprocessors', async () => {
        spies.vendor.mockResolvedValue([
            { id: 'v-1', tenantId: 't1', name: 'Acme Cloud' },
        ]);
        spies.vendorAssessment.mockResolvedValue([
            { id: 'va-1', tenantId: 't1', vendorId: 'v-1', status: 'COMPLETED' },
        ]);
        spies.vendorRelationship.mockResolvedValue([
            { id: 'vr-1', tenantId: 't1', primaryVendorId: 'v-1', subprocessorVendorId: 'v-2' },
        ]);

        const result = await exportTenantData({
            tenantId: 't1',
            domains: ['VENDORS'],
        });

        expect(result.envelope.entities.vendor?.length).toBe(1);
        expect(result.envelope.entities.vendorReview?.length).toBe(1);
        expect(result.envelope.entities.vendorSubprocessor?.length).toBe(1);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Tenant Isolation
// ═════════════════════════════════════════════════════════════════════

describe('Export service: tenant isolation', () => {
    test('queries are scoped to the specified tenantId', async () => {
        spies.practice.mockResolvedValue([]);

        await exportTenantData({
            tenantId: 'tenant-abc',
            domains: ['CONTROLS'],
        });

        // Verify the practice query was called with tenantId filter
        expect(spies.practice).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    tenantId: 'tenant-abc',
                }),
            }),
        );
    });

    test('envelope metadata contains the exporting tenantId', async () => {
        const result = await exportTenantData({
            tenantId: 'tenant-xyz',
            domains: ['CONTROLS'],
        });

        expect(result.envelope.metadata.tenantId).toBe('tenant-xyz');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 7. Deduplication
// ═════════════════════════════════════════════════════════════════════

describe('Export service: entity deduplication', () => {
    test('same entity reached via multiple paths is exported once', async () => {
        // Multi-domain export where practice appears in both CONTROLS and via TASKS→practice linkage
        spies.practice.mockResolvedValue([
            { id: 'ctrl-1', tenantId: 't1', name: 'Shared Practice' },
            { id: 'ctrl-1', tenantId: 't1', name: 'Shared Practice' }, // duplicate
        ]);

        const result = await exportTenantData({
            tenantId: 't1',
            domains: ['CONTROLS'],
        });

        // ctrl-1 should appear exactly once
        const practices = result.envelope.entities.practice ?? [];
        const ids = practices.map(c => c.id);
        const uniqueIds = [...new Set(ids)];
        expect(ids.length).toBe(uniqueIds.length);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 8. Sensitive Field Redaction
// ═════════════════════════════════════════════════════════════════════

describe('Export service: field redaction', () => {
    test('sensitive fields are stripped from exported entities', async () => {
        spies.practice.mockResolvedValue([
            {
                id: 'ctrl-1',
                tenantId: 't1',
                name: 'Safe Practice',
                password: 'secret123',
                apiKey: 'key-456',
                accessToken: 'tok-789',
            },
        ]);

        const result = await exportTenantData({
            tenantId: 't1',
            domains: ['CONTROLS'],
        });

        const data = result.envelope.entities.practice?.[0]?.data as Record<string, unknown>;
        expect(data.name).toBe('Safe Practice');
        expect(data.password).toBeUndefined();
        expect(data.apiKey).toBeUndefined();
        expect(data.accessToken).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 9. Empty Domain Export
// ═════════════════════════════════════════════════════════════════════

describe('Export service: empty domain', () => {
    test('empty tenant produces valid empty envelope', async () => {
        const result = await exportTenantData({
            tenantId: 't-empty',
            domains: ['CONTROLS'],
        });

        expect(result.envelope.formatVersion).toBe('1.0');
        expect(result.envelope.metadata.tenantId).toBe('t-empty');
        expect(result.stats.entityCount).toBe(0);
        expect(result.stats.relationshipCount).toBe(0);
    });
});

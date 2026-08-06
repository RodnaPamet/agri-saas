/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Gap Analysis Usecase Tests
 *
 * Validates the product-facing gap-analysis layer that bridges
 * persisted mappings → resolution engine → traceability semantics.
 *
 * Test strategy:
 * - Mock RequirementMappingRepository to return controlled persisted data
 * - Mock Prisma framework/requirement queries
 * - Verify the full pipeline: DB → edge loader → resolution → business semantics
 * - Verify conservative semantics are preserved end-to-end
 * - Verify framework-pair filtering works correctly
 */

import type { ResolvedMappingEdge, MappingStrengthValue } from '@/app-layer/domain/requirement-mapping.types';

// ─── Mock Setup ──────────────────────────────────────────────────────

// In-memory mapping store for the mock repository
let mockMappings: any[] = [];
let mockMappingSets: any[] = [];

jest.mock('@/app-layer/repositories/RequirementMappingRepository', () => ({
    RequirementMappingRepository: {
        findBySourceRequirement: jest.fn(async (_db: any, query: any) => {
            return mockMappings.filter(m =>
                m.sourceRequirement.id === query.sourceRequirementId &&
                (!query.targetFrameworkId || m.targetRequirement.framework.id === query.targetFrameworkId)
            );
        }),
        findByTargetRequirement: jest.fn(async (_db: any, query: any) => {
            return mockMappings.filter(m =>
                m.targetRequirement.id === query.targetRequirementId &&
                (!query.sourceFrameworkId || m.sourceRequirement.framework.id === query.sourceFrameworkId)
            );
        }),
        findByFrameworkPair: jest.fn(async (_db: any, query: any) => {
            return mockMappings.filter(m =>
                m.sourceRequirement.framework.id === query.sourceFrameworkId &&
                m.targetRequirement.framework.id === query.targetFrameworkId
            );
        }),
        listMappingSets: jest.fn(async () => mockMappingSets),
        resolveEdge: jest.fn((raw: any): ResolvedMappingEdge => ({
            id: raw.id,
            strength: raw.strength,
            rationale: raw.rationale ?? null,
            source: {
                requirementId: raw.sourceRequirement.id,
                requirementCode: raw.sourceRequirement.code,
                requirementTitle: raw.sourceRequirement.title,
                frameworkId: raw.sourceRequirement.frameworkId ?? raw.sourceRequirement.framework?.id,
                frameworkKey: raw.sourceRequirement.framework.key,
                frameworkName: raw.sourceRequirement.framework.name,
            },
            target: {
                requirementId: raw.targetRequirement.id,
                requirementCode: raw.targetRequirement.code,
                requirementTitle: raw.targetRequirement.title,
                frameworkId: raw.targetRequirement.frameworkId ?? raw.targetRequirement.framework?.id,
                frameworkKey: raw.targetRequirement.framework.key,
                frameworkName: raw.targetRequirement.framework.name,
            },
        })),
    },
}));

jest.mock('@/lib/db-context', () => ({
    runInGlobalContext: jest.fn(async (fn: any) => fn(mockDb)),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ─── Mock DB ─────────────────────────────────────────────────────────

const mockFrameworks = new Map<string, { id: string; key: string; name: string }>();
const mockRequirements = new Map<string, any[]>();

const mockDb = {
    framework: {
        // `findFirst`, not `findUnique`: Framework.key lost its single-column
        // unique so two revisions of a standard can coexist, and a lookup by
        // key alone now asks for the newest.
        findFirst: jest.fn(async ({ where }: any) => {
            if (where.key) return mockFrameworks.get(where.key) ?? null;
            return null;
        }),
    },
    frameworkRequirement: {
        findMany: jest.fn(async ({ where }: any) => {
            return mockRequirements.get(where.frameworkId) ?? [];
        }),
    },
} as any;

// ─── Import after mocks ─────────────────────────────────────────────

import {
    createDbEdgeLoader,
    listAvailableMappingSets,
    getRequirementTraceability,
    getFrameworkPairMappings,
    performGapAnalysis,
} from '@/app-layer/usecases/gap-analysis';

// ─── Test Data Fixtures ──────────────────────────────────────────────

const ISO_FW = { id: 'fw-iso', key: 'ISO27001-2022', name: 'ISO 27001:2022' };
const NIST_FW = { id: 'fw-nist', key: 'NIST-CSF-2.0', name: 'NIST CSF 2.0' };
const SOC2_FW = { id: 'fw-soc2', key: 'SOC2-2017', name: 'SOC 2 (2017)' };

function makePersistedMapping(
    id: string,
    source: { id: string; code: string; title: string; framework: typeof ISO_FW },
    target: { id: string; code: string; title: string; framework: typeof ISO_FW },
    strength: MappingStrengthValue,
    rationale: string = '',
) {
    return {
        id,
        strength,
        rationale,
        mappingSetId: 'ms-1',
        sourceRequirementId: source.id,
        targetRequirementId: target.id,
        sourceRequirement: {
            id: source.id,
            code: source.code,
            title: source.title,
            frameworkId: source.framework.id,
            framework: source.framework,
        },
        targetRequirement: {
            id: target.id,
            code: target.code,
            title: target.title,
            frameworkId: target.framework.id,
            framework: target.framework,
        },
    };
}

// Source requirements (ISO)
const isoA51 = { id: 'req-iso-a51', code: 'A.5.1', title: 'Info Security Policies', framework: ISO_FW };
const isoA52 = { id: 'req-iso-a52', code: 'A.5.2', title: 'Info Security Roles', framework: ISO_FW };
const isoA515 = { id: 'req-iso-a515', code: 'A.5.15', title: 'Access Control', framework: ISO_FW };
const isoA524 = { id: 'req-iso-a524', code: 'A.5.24', title: 'Incident Planning', framework: ISO_FW };

// Target requirements (NIST)
const nistGvOc01 = { id: 'req-nist-gvoc01', code: 'GV.OC-01', title: 'Org Context', framework: NIST_FW };
const nistGvRm01 = { id: 'req-nist-gvrm01', code: 'GV.RM-01', title: 'Risk Management', framework: NIST_FW };
const nistPrAa01 = { id: 'req-nist-praa01', code: 'PR.AA-01', title: 'Identity/Auth', framework: NIST_FW };
const nistRsMa01 = { id: 'req-nist-rsma01', code: 'RS.MA-01', title: 'Incident Mgmt', framework: NIST_FW };
const nistIdRa01 = { id: 'req-nist-idra01', code: 'ID.RA-01', title: 'Risk Assessment', framework: NIST_FW };

// ─── Tests ───────────────────────────────────────────────────────────

describe('Gap Analysis Usecase', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // Register frameworks
        mockFrameworks.clear();
        mockFrameworks.set('ISO27001-2022', ISO_FW);
        mockFrameworks.set('NIST-CSF-2.0', NIST_FW);
        mockFrameworks.set('SOC2-2017', SOC2_FW);

        // Register assessable requirements
        mockRequirements.clear();
        mockRequirements.set('fw-iso', [
            { id: isoA51.id, code: isoA51.code, title: isoA51.title },
            { id: isoA52.id, code: isoA52.code, title: isoA52.title },
            { id: isoA515.id, code: isoA515.code, title: isoA515.title },
            { id: isoA524.id, code: isoA524.code, title: isoA524.title },
        ]);
        mockRequirements.set('fw-nist', [
            { id: nistGvOc01.id, code: nistGvOc01.code, title: nistGvOc01.title },
            { id: nistGvRm01.id, code: nistGvRm01.code, title: nistGvRm01.title },
            { id: nistPrAa01.id, code: nistPrAa01.code, title: nistPrAa01.title },
            { id: nistRsMa01.id, code: nistRsMa01.code, title: nistRsMa01.title },
            { id: nistIdRa01.id, code: nistIdRa01.code, title: nistIdRa01.title },
        ]);

        // Persisted mappings covering all strength levels
        mockMappings = [
            makePersistedMapping('m1', isoA51, nistGvOc01, 'EQUAL', 'Equivalent governance'),
            makePersistedMapping('m2', isoA52, nistGvRm01, 'SUBSET', 'Partial risk coverage'),
            makePersistedMapping('m3', isoA515, nistPrAa01, 'INTERSECT', 'Overlapping access scope'),
            makePersistedMapping('m4', isoA524, nistRsMa01, 'RELATED', 'Conceptual link'),
        ];

        // Mapping set metadata
        mockMappingSets = [{
            id: 'ms-1',
            name: 'ISO → NIST',
            description: 'ISO 27001 to NIST CSF mapping',
            version: 1,
            sourceFramework: ISO_FW,
            targetFramework: NIST_FW,
            _count: { mappings: 4 },
        }];
    });

    // ─── createDbEdgeLoader ──────────────────────────────────────
    describe('createDbEdgeLoader', () => {
        it('creates a loader that queries persisted mappings', async () => {
            const loader = createDbEdgeLoader(mockDb);
            const edges = await loader('req-iso-a51');

            expect(edges).toHaveLength(1);
            expect(edges[0].source.requirementCode).toBe('A.5.1');
            expect(edges[0].target.requirementCode).toBe('GV.OC-01');
            expect(edges[0].strength).toBe('EQUAL');
        });

        it('returns empty array for unknown source', async () => {
            const loader = createDbEdgeLoader(mockDb);
            const edges = await loader('req-nonexistent');

            expect(edges).toHaveLength(0);
        });

        it('returns all outgoing edges from a source', async () => {
            // Add a second edge from A.5.1
            mockMappings.push(
                makePersistedMapping('m5', isoA51, nistGvRm01, 'RELATED', 'Also related'),
            );

            const loader = createDbEdgeLoader(mockDb);
            const edges = await loader('req-iso-a51');

            expect(edges).toHaveLength(2);
        });
    });

    // ─── listAvailableMappingSets ────────────────────────────────
    describe('listAvailableMappingSets', () => {
        it('returns all available mapping sets with metadata', async () => {
            const sets = await listAvailableMappingSets(mockDb);

            expect(sets).toHaveLength(1);
            expect(sets[0].name).toBe('ISO → NIST');
            expect(sets[0].sourceFramework.key).toBe('ISO27001-2022');
            expect(sets[0].targetFramework.key).toBe('NIST-CSF-2.0');
            expect(sets[0].mappingCount).toBe(4);
        });

        it('returns empty array when no mapping sets exist', async () => {
            mockMappingSets = [];
            const sets = await listAvailableMappingSets(mockDb);
            expect(sets).toHaveLength(0);
        });
    });

    // ─── getRequirementTraceability ──────────────────────────────
    describe('getRequirementTraceability', () => {
        it('returns FULL confidence for EQUAL mapping', async () => {
            const report = await getRequirementTraceability({
                sourceRequirementId: 'req-iso-a51',
                targetFrameworkKey: 'NIST-CSF-2.0',
                maxDepth: 1,
            }, mockDb);

            expect(report.findings).toHaveLength(1);
            expect(report.findings[0].mappingStrength).toBe('EQUAL');
            expect(report.findings[0].confidence).toBe('FULL');
            expect(report.findings[0].isActionable).toBe(true);
            expect(report.findings[0].isDirect).toBe(true);
            expect(report.summary.bestConfidence).toBe('FULL');
        });

        it('returns PARTIAL confidence for SUBSET mapping', async () => {
            const report = await getRequirementTraceability({
                sourceRequirementId: 'req-iso-a52',
                targetFrameworkKey: 'NIST-CSF-2.0',
                maxDepth: 1,
            }, mockDb);

            expect(report.findings).toHaveLength(1);
            expect(report.findings[0].confidence).toBe('PARTIAL');
            expect(report.findings[0].isActionable).toBe(false);
        });

        it('returns OVERLAP confidence for INTERSECT mapping', async () => {
            const report = await getRequirementTraceability({
                sourceRequirementId: 'req-iso-a515',
                targetFrameworkKey: 'NIST-CSF-2.0',
                maxDepth: 1,
            }, mockDb);

            expect(report.findings).toHaveLength(1);
            expect(report.findings[0].confidence).toBe('OVERLAP');
            expect(report.findings[0].isActionable).toBe(false);
        });

        it('returns INFORMATIONAL for RELATED mapping', async () => {
            const report = await getRequirementTraceability({
                sourceRequirementId: 'req-iso-a524',
                targetFrameworkKey: 'NIST-CSF-2.0',
                maxDepth: 1,
            }, mockDb);

            expect(report.findings).toHaveLength(1);
            expect(report.findings[0].confidence).toBe('INFORMATIONAL');
            expect(report.findings[0].isActionable).toBe(false);
        });

        it('returns empty findings for unknown source', async () => {
            const report = await getRequirementTraceability({
                sourceRequirementId: 'req-nonexistent',
                targetFrameworkKey: 'NIST-CSF-2.0',
                maxDepth: 1,
            }, mockDb);

            expect(report.findings).toHaveLength(0);
            expect(report.summary.bestConfidence).toBe('NONE');
        });

        it('includes edge chain for auditability', async () => {
            const report = await getRequirementTraceability({
                sourceRequirementId: 'req-iso-a51',
                targetFrameworkKey: 'NIST-CSF-2.0',
                maxDepth: 1,
            }, mockDb);

            const finding = report.findings[0];
            expect(finding.edgeChain).toHaveLength(1);
            expect(finding.edgeChain[0].fromCode).toBe('A.5.1');
            expect(finding.edgeChain[0].toCode).toBe('GV.OC-01');
            expect(finding.edgeChain[0].strength).toBe('EQUAL');
            expect(finding.edgeChain[0].rationale).toBe('Equivalent governance');
        });

        it('includes human-readable explanation', async () => {
            const report = await getRequirementTraceability({
                sourceRequirementId: 'req-iso-a51',
                targetFrameworkKey: 'NIST-CSF-2.0',
                maxDepth: 1,
            }, mockDb);

            const explanation = report.findings[0].explanation;
            expect(explanation.summary).toContain('equivalent');
            expect(explanation.actionRequired).toBe(false);
        });
    });

    // ─── getFrameworkPairMappings ────────────────────────────────
    describe('getFrameworkPairMappings', () => {
        it('returns all mappings for a valid framework pair', async () => {
            const result = await getFrameworkPairMappings('ISO27001-2022', 'NIST-CSF-2.0', mockDb);

            expect(result).not.toBeNull();
            expect(result!.mappings).toHaveLength(4);
            expect(result!.sourceFramework.key).toBe('ISO27001-2022');
            expect(result!.targetFramework.key).toBe('NIST-CSF-2.0');
        });

        it('returns null for unknown source framework', async () => {
            const result = await getFrameworkPairMappings('UNKNOWN', 'NIST-CSF-2.0', mockDb);
            expect(result).toBeNull();
        });

        it('returns null for unknown target framework', async () => {
            const result = await getFrameworkPairMappings('ISO27001-2022', 'UNKNOWN', mockDb);
            expect(result).toBeNull();
        });

        it('includes strength distribution in summary', async () => {
            const result = await getFrameworkPairMappings('ISO27001-2022', 'NIST-CSF-2.0', mockDb);

            expect(result!.summary.total).toBe(4);
            expect(result!.summary.byStrength.EQUAL).toBe(1);
            expect(result!.summary.byStrength.SUBSET).toBe(1);
            expect(result!.summary.byStrength.INTERSECT).toBe(1);
            expect(result!.summary.byStrength.RELATED).toBe(1);
        });

        it('computes actionable count correctly', async () => {
            const result = await getFrameworkPairMappings('ISO27001-2022', 'NIST-CSF-2.0', mockDb);

            // Only EQUAL is actionable (no SUPERSET in test data)
            expect(result!.summary.actionableCount).toBe(1);
        });

        it('each mapping includes confidence and rationale', async () => {
            const result = await getFrameworkPairMappings('ISO27001-2022', 'NIST-CSF-2.0', mockDb);

            for (const m of result!.mappings) {
                expect(m.confidence).toBeTruthy();
                expect(typeof m.isActionable).toBe('boolean');
            }

            const equalMapping = result!.mappings.find(m => m.strength === 'EQUAL');
            expect(equalMapping!.confidence).toBe('FULL');
            expect(equalMapping!.isActionable).toBe(true);
            expect(equalMapping!.rationale).toBe('Equivalent governance');
        });
    });

    // ─── performGapAnalysis ──────────────────────────────────────
    describe('performGapAnalysis', () => {
        it('produces correct gap status for each strength level', async () => {
            const result = await performGapAnalysis({
                sourceFrameworkKey: 'ISO27001-2022',
                targetFrameworkKey: 'NIST-CSF-2.0',
                maxDepth: 1,
            }, mockDb);

            expect(result).not.toBeNull();

            // EQUAL → COVERED
            const gvoc = result!.entries.find(e => e.targetRequirement.requirementCode === 'GV.OC-01');
            expect(gvoc!.status).toBe('COVERED');
            expect(gvoc!.bestConfidence).toBe('FULL');

            // SUBSET → PARTIALLY_COVERED
            const gvrm = result!.entries.find(e => e.targetRequirement.requirementCode === 'GV.RM-01');
            expect(gvrm!.status).toBe('PARTIALLY_COVERED');

            // INTERSECT → PARTIALLY_COVERED
            const praa = result!.entries.find(e => e.targetRequirement.requirementCode === 'PR.AA-01');
            expect(praa!.status).toBe('PARTIALLY_COVERED');

            // RELATED → REVIEW_NEEDED
            const rsma = result!.entries.find(e => e.targetRequirement.requirementCode === 'RS.MA-01');
            expect(rsma!.status).toBe('REVIEW_NEEDED');

            // No mapping → NOT_COVERED
            const idra = result!.entries.find(e => e.targetRequirement.requirementCode === 'ID.RA-01');
            expect(idra!.status).toBe('NOT_COVERED');
        });

        it('computes correct coverage percentages', async () => {
            const result = await performGapAnalysis({
                sourceFrameworkKey: 'ISO27001-2022',
                targetFrameworkKey: 'NIST-CSF-2.0',
                maxDepth: 1,
            }, mockDb);

            expect(result!.summary.totalTargetRequirements).toBe(5);
            expect(result!.summary.covered).toBe(1);           // GV.OC-01 (EQUAL)
            expect(result!.summary.partiallyCovered).toBe(2);   // GV.RM-01, PR.AA-01
            expect(result!.summary.reviewNeeded).toBe(1);       // RS.MA-01
            expect(result!.summary.notCovered).toBe(1);         // ID.RA-01
            expect(result!.summary.coveragePercent).toBe(20);
        });

        it('sorts entries with NOT_COVERED first (gaps at top)', async () => {
            const result = await performGapAnalysis({
                sourceFrameworkKey: 'ISO27001-2022',
                targetFrameworkKey: 'NIST-CSF-2.0',
            }, mockDb);

            const statuses = result!.entries.map(e => e.status);
            const notCoveredIdx = statuses.indexOf('NOT_COVERED');
            const coveredIdx = statuses.indexOf('COVERED');
            expect(notCoveredIdx).toBeLessThan(coveredIdx);
        });

        it('returns null for unknown source framework', async () => {
            const result = await performGapAnalysis({
                sourceFrameworkKey: 'UNKNOWN',
                targetFrameworkKey: 'NIST-CSF-2.0',
            }, mockDb);

            expect(result).toBeNull();
        });

        it('returns null for unknown target framework', async () => {
            const result = await performGapAnalysis({
                sourceFrameworkKey: 'ISO27001-2022',
                targetFrameworkKey: 'UNKNOWN',
            }, mockDb);

            expect(result).toBeNull();
        });

        it('returns null when no assessable requirements exist', async () => {
            mockRequirements.set('fw-iso', []);

            const result = await performGapAnalysis({
                sourceFrameworkKey: 'ISO27001-2022',
                targetFrameworkKey: 'NIST-CSF-2.0',
            }, mockDb);

            expect(result).toBeNull();
        });

        it('includes explanations for every entry', async () => {
            const result = await performGapAnalysis({
                sourceFrameworkKey: 'ISO27001-2022',
                targetFrameworkKey: 'NIST-CSF-2.0',
            }, mockDb);

            for (const entry of result!.entries) {
                expect(entry.explanation).toBeTruthy();
                expect(entry.explanation.length).toBeGreaterThan(10);
            }
        });

        it('never overclaims: SUBSET/INTERSECT/RELATED are never COVERED', async () => {
            const result = await performGapAnalysis({
                sourceFrameworkKey: 'ISO27001-2022',
                targetFrameworkKey: 'NIST-CSF-2.0',
            }, mockDb);

            for (const entry of result!.entries) {
                if (entry.bestSource) {
                    const strength = entry.bestSource.strength;
                    if (strength === 'SUBSET' || strength === 'INTERSECT' || strength === 'RELATED') {
                        expect(entry.status).not.toBe('COVERED');
                    }
                }
            }
        });

        it('SUPERSET is treated as COVERED (HIGH confidence)', async () => {
            // Replace one mapping with SUPERSET
            mockMappings[0] = makePersistedMapping(
                'm1-super', isoA51, nistGvOc01, 'SUPERSET', 'Source broader',
            );

            const result = await performGapAnalysis({
                sourceFrameworkKey: 'ISO27001-2022',
                targetFrameworkKey: 'NIST-CSF-2.0',
            }, mockDb);

            const gvoc = result!.entries.find(e => e.targetRequirement.requirementCode === 'GV.OC-01');
            expect(gvoc!.status).toBe('COVERED');
            expect(gvoc!.bestConfidence).toBe('HIGH');
        });
    });

    // ─── Conservative semantics ──────────────────────────────────
    describe('conservative semantics end-to-end', () => {
        const strengths: MappingStrengthValue[] = ['EQUAL', 'SUPERSET', 'SUBSET', 'INTERSECT', 'RELATED'];

        it.each(strengths)('%s produces correct gap status through persisted pipeline', async (strength) => {
            // Set up a single mapping with the given strength
            mockMappings = [
                makePersistedMapping('m-test', isoA51, nistGvOc01, strength, 'Test'),
            ];
            mockRequirements.set('fw-iso', [
                { id: isoA51.id, code: isoA51.code, title: isoA51.title },
            ]);
            mockRequirements.set('fw-nist', [
                { id: nistGvOc01.id, code: nistGvOc01.code, title: nistGvOc01.title },
            ]);

            const result = await performGapAnalysis({
                sourceFrameworkKey: 'ISO27001-2022',
                targetFrameworkKey: 'NIST-CSF-2.0',
                maxDepth: 1,
            }, mockDb);

            const entry = result!.entries[0];

            if (strength === 'EQUAL' || strength === 'SUPERSET') {
                expect(entry.status).toBe('COVERED');
            } else if (strength === 'SUBSET' || strength === 'INTERSECT') {
                expect(entry.status).toBe('PARTIALLY_COVERED');
            } else {
                expect(entry.status).toBe('REVIEW_NEEDED');
            }
        });
    });
});

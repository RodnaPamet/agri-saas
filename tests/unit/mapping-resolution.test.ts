/**
 * Mapping Resolution Engine Tests
 *
 * Tests the BFS-based cross-framework mapping resolution engine:
 * - Direct (depth=1) mapping resolution
 * - Transitive (depth>1) resolution across multiple frameworks
 * - Depth limiting (clamping, default, max)
 * - Cycle detection and prevention
 * - Strength propagation (weakest-link)
 * - Target framework filtering
 * - Minimum strength filtering
 * - Deterministic output ordering
 * - Empty/missing edge handling
 * - Batch resolution
 * - Statistics computation
 *
 * All tests use in-memory edge loaders — no database or mocking required.
 * The engine is decoupled from Prisma by design.
 */

import {
    resolveMapping,
    resolveMappingBatch,
    computeEffectiveStrength,
    DEFAULT_MAX_DEPTH,
    ABSOLUTE_MAX_DEPTH,
    type MappingEdgeLoader,
    type MappingPathEdge,
} from '@/app-layer/services/mapping-resolution';
import type { ResolvedMappingEdge, MappingStrengthValue } from '@/app-layer/domain/requirement-mapping.types';

// ─── Test Graph ──────────────────────────────────────────────────────
//
// The test graph models three frameworks with cross-framework mappings:
//
//   ISO 27001          NIST CSF          SOC 2
//   ─────────          ────────          ─────
//   A.5.1  ──EQUAL──▶  GV.OC-01
//   A.5.1  ──SUBSET──▶ GV.RM-01
//   A.5.2  ──INTERSECT▶ GV.RR-01
//                       GV.OC-01 ──RELATED──▶ CC1
//                       GV.RR-01 ──SUPERSET─▶ CC5
//                                             CC1 ──RELATED──▶ (back to GV.OC-01 — cycle!)
//
// A.5.1 should resolve:
//   Direct:     GV.OC-01 (EQUAL), GV.RM-01 (SUBSET)
//   Transitive: CC1 (via GV.OC-01, effective=RELATED since min(EQUAL,RELATED)=RELATED)
//
// A.5.2 should resolve:
//   Direct:     GV.RR-01 (INTERSECT)
//   Transitive: CC5 (via GV.RR-01, effective=INTERSECT since min(INTERSECT,SUPERSET)=INTERSECT)

function makeEdge(
    id: string,
    source: { reqId: string; code: string; title: string; fwKey: string; fwName: string },
    target: { reqId: string; code: string; title: string; fwKey: string; fwName: string },
    strength: MappingStrengthValue,
    rationale: string = '',
): ResolvedMappingEdge {
    return {
        id,
        strength,
        rationale,
        source: {
            requirementId: source.reqId,
            requirementCode: source.code,
            requirementTitle: source.title,
            frameworkId: `fw-${source.fwKey}`,
            frameworkKey: source.fwKey,
            frameworkName: source.fwName,
        },
        target: {
            requirementId: target.reqId,
            requirementCode: target.code,
            requirementTitle: target.title,
            frameworkId: `fw-${target.fwKey}`,
            frameworkKey: target.fwKey,
            frameworkName: target.fwName,
        },
    };
}

// Framework fixtures
const ISO = { fwKey: 'ISO27001', fwName: 'ISO 27001' };
const NIST = { fwKey: 'NIST-CSF', fwName: 'NIST CSF 2.0' };
const SOC2 = { fwKey: 'SOC2', fwName: 'SOC 2' };

// Requirement fixtures
const ISO_A51 = { reqId: 'req-a51', code: 'A.5.1', title: 'Info Security Policies', ...ISO };
const ISO_A52 = { reqId: 'req-a52', code: 'A.5.2', title: 'Info Security Roles', ...ISO };
const NIST_GVOC01 = { reqId: 'req-gvoc01', code: 'GV.OC-01', title: 'Organizational Context', ...NIST };
const NIST_GVRM01 = { reqId: 'req-gvrm01', code: 'GV.RM-01', title: 'Risk Management', ...NIST };
const NIST_GVRR01 = { reqId: 'req-gvrr01', code: 'GV.RR-01', title: 'Roles & Responsibilities', ...NIST };
const SOC2_CC1 = { reqId: 'req-cc1', code: 'CC1', title: 'Practice Environment', ...SOC2 };
const SOC2_CC5 = { reqId: 'req-cc5', code: 'CC5', title: 'Practice Activities', ...SOC2 };

// Edge database (adjacency list)
const EDGE_DB: Record<string, ResolvedMappingEdge[]> = {
    // ISO → NIST
    'req-a51': [
        makeEdge('e1', ISO_A51, NIST_GVOC01, 'EQUAL', 'Both address gov context'),
        makeEdge('e2', ISO_A51, NIST_GVRM01, 'SUBSET', 'Partial risk mgmt coverage'),
    ],
    'req-a52': [
        makeEdge('e3', ISO_A52, NIST_GVRR01, 'INTERSECT', 'Overlapping role definitions'),
    ],
    // NIST → SOC2
    'req-gvoc01': [
        makeEdge('e4', NIST_GVOC01, SOC2_CC1, 'RELATED', 'Governance context → practice env'),
    ],
    'req-gvrr01': [
        makeEdge('e5', NIST_GVRR01, SOC2_CC5, 'SUPERSET', 'Roles fully covers practice activities'),
    ],
    // Cycle: SOC2 CC1 → NIST GV.OC-01 (creates circular reference)
    'req-cc1': [
        makeEdge('e6', SOC2_CC1, NIST_GVOC01, 'RELATED', 'Circular back-reference'),
    ],
};

/**
 * In-memory edge loader for tests — simulates DB lookups.
 */
const testLoader: MappingEdgeLoader = async (sourceReqId: string) => {
    return EDGE_DB[sourceReqId] ?? [];
};

/**
 * Empty edge loader — returns no edges for any requirement.
 */
const emptyLoader: MappingEdgeLoader = async () => [];

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describe('Mapping Resolution Engine', () => {
    // ─── computeEffectiveStrength ─────────────────────────────────
    describe('computeEffectiveStrength', () => {
        it('returns RELATED for empty edge list', () => {
            expect(computeEffectiveStrength([])).toBe('RELATED');
        });

        it('returns the edge strength for a single-edge path', () => {
            const edge: MappingPathEdge = {
                id: 'e1', depth: 1, strength: 'EQUAL', rationale: null,
                source: { requirementId: 'a', requirementCode: 'A', requirementTitle: 'A', frameworkKey: 'F1', frameworkName: 'F1' },
                target: { requirementId: 'b', requirementCode: 'B', requirementTitle: 'B', frameworkKey: 'F2', frameworkName: 'F2' },
            };
            expect(computeEffectiveStrength([edge])).toBe('EQUAL');
        });

        it('returns the weakest strength across multiple edges', () => {
            const edges: MappingPathEdge[] = [
                { id: 'e1', depth: 1, strength: 'EQUAL', rationale: null,
                  source: { requirementId: 'a', requirementCode: 'A', requirementTitle: 'A', frameworkKey: 'F1', frameworkName: 'F1' },
                  target: { requirementId: 'b', requirementCode: 'B', requirementTitle: 'B', frameworkKey: 'F2', frameworkName: 'F2' } },
                { id: 'e2', depth: 2, strength: 'RELATED', rationale: null,
                  source: { requirementId: 'b', requirementCode: 'B', requirementTitle: 'B', frameworkKey: 'F2', frameworkName: 'F2' },
                  target: { requirementId: 'c', requirementCode: 'C', requirementTitle: 'C', frameworkKey: 'F3', frameworkName: 'F3' } },
            ];
            expect(computeEffectiveStrength(edges)).toBe('RELATED');
        });

        it('weakest link: SUPERSET + SUBSET = SUBSET', () => {
            const edges: MappingPathEdge[] = [
                { id: 'e1', depth: 1, strength: 'SUPERSET', rationale: null,
                  source: { requirementId: 'a', requirementCode: 'A', requirementTitle: 'A', frameworkKey: 'F1', frameworkName: 'F1' },
                  target: { requirementId: 'b', requirementCode: 'B', requirementTitle: 'B', frameworkKey: 'F2', frameworkName: 'F2' } },
                { id: 'e2', depth: 2, strength: 'SUBSET', rationale: null,
                  source: { requirementId: 'b', requirementCode: 'B', requirementTitle: 'B', frameworkKey: 'F2', frameworkName: 'F2' },
                  target: { requirementId: 'c', requirementCode: 'C', requirementTitle: 'C', frameworkKey: 'F3', frameworkName: 'F3' } },
            ];
            expect(computeEffectiveStrength(edges)).toBe('SUBSET');
        });
    });

    // ─── Direct Mapping Resolution ───────────────────────────────
    describe('Direct mapping resolution', () => {
        it('resolves direct (depth=1) mappings from A.5.1', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 1 },
                testLoader,
            );

            expect(result.paths).toHaveLength(2);
            expect(result.stats.directPaths).toBe(2);
            expect(result.stats.transitivePaths).toBe(0);

            // Both should be depth 1
            expect(result.paths.every(p => p.depth === 1)).toBe(true);
            expect(result.paths.every(p => p.isDirect)).toBe(true);

            // Check target codes
            const targetCodes = result.paths.map(p => p.target.requirementCode);
            expect(targetCodes).toContain('GV.OC-01');
            expect(targetCodes).toContain('GV.RM-01');
        });

        it('resolves single direct mapping from A.5.2', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a52', maxDepth: 1 },
                testLoader,
            );

            expect(result.paths).toHaveLength(1);
            expect(result.paths[0].target.requirementCode).toBe('GV.RR-01');
            expect(result.paths[0].effectiveStrength).toBe('INTERSECT');
        });

        it('returns empty paths for requirement with no mappings', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'nonexistent', maxDepth: 1 },
                testLoader,
            );

            expect(result.paths).toHaveLength(0);
            expect(result.stats.totalPaths).toBe(0);
            expect(result.source.requirementId).toBe('nonexistent');
        });

        it('populates source info from discovered edges', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 1 },
                testLoader,
            );

            expect(result.source.requirementId).toBe('req-a51');
            expect(result.source.requirementCode).toBe('A.5.1');
            expect(result.source.frameworkKey).toBe('ISO27001');
        });
    });

    // ─── Transitive Mapping Resolution ───────────────────────────
    describe('Transitive mapping resolution', () => {
        it('discovers transitive mappings: ISO → NIST → SOC2', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3 },
                testLoader,
            );

            // Direct: GV.OC-01, GV.RM-01
            // Transitive: CC1 (via GV.OC-01)
            expect(result.paths).toHaveLength(3);
            expect(result.stats.directPaths).toBe(2);
            expect(result.stats.transitivePaths).toBe(1);
        });

        it('computes effective strength for transitive paths', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3 },
                testLoader,
            );

            // Find the transitive path to CC1
            const cc1Path = result.paths.find(p => p.target.requirementCode === 'CC1');
            expect(cc1Path).toBeDefined();
            expect(cc1Path!.depth).toBe(2);
            expect(cc1Path!.isDirect).toBe(false);
            // min(EQUAL, RELATED) = RELATED
            expect(cc1Path!.effectiveStrength).toBe('RELATED');
            expect(cc1Path!.edges).toHaveLength(2);
        });

        it('transitive path from A.5.2: ISO → NIST → SOC2', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a52', maxDepth: 3 },
                testLoader,
            );

            // Direct: GV.RR-01
            // Transitive: CC5 (via GV.RR-01)
            expect(result.paths).toHaveLength(2);
            const cc5Path = result.paths.find(p => p.target.requirementCode === 'CC5');
            expect(cc5Path).toBeDefined();
            // min(INTERSECT, SUPERSET) = INTERSECT
            expect(cc5Path!.effectiveStrength).toBe('INTERSECT');
        });

        it('includes full edge chain in transitive paths', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3 },
                testLoader,
            );

            const cc1Path = result.paths.find(p => p.target.requirementCode === 'CC1');
            expect(cc1Path!.edges).toHaveLength(2);
            expect(cc1Path!.edges[0].source.requirementCode).toBe('A.5.1');
            expect(cc1Path!.edges[0].target.requirementCode).toBe('GV.OC-01');
            expect(cc1Path!.edges[1].source.requirementCode).toBe('GV.OC-01');
            expect(cc1Path!.edges[1].target.requirementCode).toBe('CC1');
        });
    });

    // ─── Depth Limiting ──────────────────────────────────────────
    describe('Depth limiting', () => {
        it('limits traversal to maxDepth=1 (direct only)', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 1 },
                testLoader,
            );

            expect(result.paths.every(p => p.depth === 1)).toBe(true);
            expect(result.config.maxDepth).toBe(1);
        });

        it('limits traversal to maxDepth=2 (one transitive hop)', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 2 },
                testLoader,
            );

            // Direct (2) + CC1 via GV.OC-01 (depth=2)
            expect(result.paths).toHaveLength(3);
            expect(result.paths.every(p => p.depth <= 2)).toBe(true);
        });

        it('uses DEFAULT_MAX_DEPTH when not specified', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51' },
                testLoader,
            );

            expect(result.config.maxDepth).toBe(DEFAULT_MAX_DEPTH);
        });

        it('clamps maxDepth to ABSOLUTE_MAX_DEPTH', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 999 },
                testLoader,
            );

            expect(result.config.maxDepth).toBe(ABSOLUTE_MAX_DEPTH);
        });

        it('clamps maxDepth to minimum of 1', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 0 },
                testLoader,
            );

            expect(result.config.maxDepth).toBe(1);
        });
    });

    // ─── Cycle Detection ─────────────────────────────────────────
    describe('Cycle detection', () => {
        it('does not loop on cyclical edges (CC1 → GV.OC-01 → CC1)', async () => {
            // CC1 maps back to GV.OC-01 which was already visited via A.5.1
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 10 },
                testLoader,
            );

            // Should NOT contain infinite paths — just the 3 reachable nodes
            // (GV.OC-01, GV.RM-01, CC1) — GV.OC-01 won't be re-expanded via CC1
            expect(result.paths.length).toBeLessThanOrEqual(3);

            // Verify no duplicate target requirement IDs
            const targetIds = result.paths.map(p => p.target.requirementId);
            const uniqueTargetIds = new Set(targetIds);
            expect(targetIds.length).toBe(uniqueTargetIds.size);
        });

        it('handles self-referential edges safely', async () => {
            const selfRefLoader: MappingEdgeLoader = async (id) => {
                if (id === 'req-self') {
                    return [makeEdge('eself', 
                        { reqId: 'req-self', code: 'SELF', title: 'Self', fwKey: 'F1', fwName: 'F1' },
                        { reqId: 'req-self', code: 'SELF', title: 'Self', fwKey: 'F1', fwName: 'F1' },
                        'EQUAL',
                    )];
                }
                return [];
            };

            const result = await resolveMapping(
                { sourceRequirementId: 'req-self', maxDepth: 5 },
                selfRefLoader,
            );

            // Self-reference should be skipped (source is in visited set)
            expect(result.paths).toHaveLength(0);
        });

        it('terminates on tight 2-node cycle', async () => {
            const cycleLoader: MappingEdgeLoader = async (id) => {
                if (id === 'req-a') {
                    return [makeEdge('ec1',
                        { reqId: 'req-a', code: 'A', title: 'Node A', fwKey: 'F1', fwName: 'F1' },
                        { reqId: 'req-b', code: 'B', title: 'Node B', fwKey: 'F2', fwName: 'F2' },
                        'EQUAL',
                    )];
                }
                if (id === 'req-b') {
                    return [makeEdge('ec2',
                        { reqId: 'req-b', code: 'B', title: 'Node B', fwKey: 'F2', fwName: 'F2' },
                        { reqId: 'req-a', code: 'A', title: 'Node A', fwKey: 'F1', fwName: 'F1' },
                        'EQUAL',
                    )];
                }
                return [];
            };

            const result = await resolveMapping(
                { sourceRequirementId: 'req-a', maxDepth: 10 },
                cycleLoader,
            );

            // Only B should be in results (A is source, B→A cycle prevented)
            expect(result.paths).toHaveLength(1);
            expect(result.paths[0].target.requirementCode).toBe('B');
        });
    });

    // ─── Target Framework Filtering ──────────────────────────────
    describe('Target framework filtering', () => {
        it('filters results to specific target framework', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3, targetFrameworkKeys: ['SOC2'] },
                testLoader,
            );

            // Should only include CC1 (SOC2), not GV.OC-01 / GV.RM-01 (NIST)
            expect(result.paths).toHaveLength(1);
            expect(result.paths[0].target.frameworkKey).toBe('SOC2');
            expect(result.paths[0].target.requirementCode).toBe('CC1');
        });

        it('filters to multiple target frameworks', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3, targetFrameworkKeys: ['NIST-CSF', 'SOC2'] },
                testLoader,
            );

            expect(result.paths).toHaveLength(3);
            const frameworks = new Set(result.paths.map(p => p.target.frameworkKey));
            expect(frameworks).toEqual(new Set(['NIST-CSF', 'SOC2']));
        });

        it('returns empty when target framework has no mappings', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3, targetFrameworkKeys: ['NONEXISTENT'] },
                testLoader,
            );

            expect(result.paths).toHaveLength(0);
        });
    });

    // ─── Minimum Strength Filtering ──────────────────────────────
    describe('Minimum strength filtering', () => {
        it('filters by minimum effective strength', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3, minStrength: 'SUBSET' },
                testLoader,
            );

            // EQUAL-ranked GV.OC-01 (rank 5) ✓
            // SUBSET-ranked GV.RM-01 (rank 3) ✓
            // RELATED-ranked CC1 (rank 1) ✗ (below SUBSET threshold of rank 3)
            expect(result.paths).toHaveLength(2);
            expect(result.paths.every(p => p.effectiveStrengthRank >= 3)).toBe(true);
        });

        it('EQUAL minimum filters to only equivalent mappings', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3, minStrength: 'EQUAL' },
                testLoader,
            );

            expect(result.paths).toHaveLength(1);
            expect(result.paths[0].effectiveStrength).toBe('EQUAL');
        });

        it('RELATED minimum includes everything', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3, minStrength: 'RELATED' },
                testLoader,
            );

            expect(result.paths).toHaveLength(3);
        });
    });

    // ─── Deterministic Output Order ──────────────────────────────
    describe('Deterministic output', () => {
        it('orders by depth ascending, then strength descending, then code alphabetically', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3 },
                testLoader,
            );

            // Depth 1: GV.OC-01 (EQUAL, rank 5), GV.RM-01 (SUBSET, rank 3)
            // Depth 2: CC1 (RELATED, rank 1)
            expect(result.paths[0].target.requirementCode).toBe('GV.OC-01');
            expect(result.paths[0].effectiveStrength).toBe('EQUAL');
            expect(result.paths[1].target.requirementCode).toBe('GV.RM-01');
            expect(result.paths[1].effectiveStrength).toBe('SUBSET');
            expect(result.paths[2].target.requirementCode).toBe('CC1');
            expect(result.paths[2].effectiveStrength).toBe('RELATED');
        });

        it('produces identical output on repeated runs', async () => {
            const r1 = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3 },
                testLoader,
            );
            const r2 = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3 },
                testLoader,
            );

            expect(r1.paths.length).toBe(r2.paths.length);
            for (let i = 0; i < r1.paths.length; i++) {
                expect(r1.paths[i].target.requirementCode).toBe(r2.paths[i].target.requirementCode);
                expect(r1.paths[i].effectiveStrength).toBe(r2.paths[i].effectiveStrength);
                expect(r1.paths[i].depth).toBe(r2.paths[i].depth);
            }
        });
    });

    // ─── Statistics ──────────────────────────────────────────────
    describe('Statistics', () => {
        it('computes correct summary statistics', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3 },
                testLoader,
            );

            expect(result.stats.totalPaths).toBe(3);
            expect(result.stats.directPaths).toBe(2);
            expect(result.stats.transitivePaths).toBe(1);
            expect(result.stats.maxDepthReached).toBe(2);
            expect(result.stats.uniqueTargetRequirements).toBe(3);
            expect(result.stats.uniqueTargetFrameworks).toBe(2); // NIST + SOC2
        });

        it('reports zero stats for no-match query', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'nonexistent' },
                testLoader,
            );

            expect(result.stats.totalPaths).toBe(0);
            expect(result.stats.directPaths).toBe(0);
            expect(result.stats.maxDepthReached).toBe(0);
        });
    });

    // ─── Batch Resolution ────────────────────────────────────────
    describe('Batch resolution', () => {
        it('resolves multiple source requirements in batch', async () => {
            const results = await resolveMappingBatch([
                { sourceRequirementId: 'req-a51', maxDepth: 1 },
                { sourceRequirementId: 'req-a52', maxDepth: 1 },
            ], testLoader);

            expect(results).toHaveLength(2);
            expect(results[0].source.requirementCode).toBe('A.5.1');
            expect(results[0].paths).toHaveLength(2);
            expect(results[1].source.requirementCode).toBe('A.5.2');
            expect(results[1].paths).toHaveLength(1);
        });
    });

    // ─── Edge Cases ──────────────────────────────────────────────
    describe('Edge cases', () => {
        it('handles empty edge loader', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'anything' },
                emptyLoader,
            );

            expect(result.paths).toHaveLength(0);
            expect(result.source.requirementCode).toBe('<unknown>');
        });

        it('config captures null target framework keys when not specified', async () => {
            const result = await resolveMapping(
                { sourceRequirementId: 'req-a51' },
                testLoader,
            );

            expect(result.config.targetFrameworkKeys).toBeNull();
            expect(result.config.minStrength).toBeNull();
        });

        it('handles wide fan-out without blowup', async () => {
            // Create a loader that returns 50 outgoing edges per node
            const wideLoader: MappingEdgeLoader = async (id) => {
                if (!id.startsWith('req-root')) return [];
                return Array.from({ length: 50 }, (_, i) =>
                    makeEdge(`wide-${i}`,
                        { reqId: id, code: 'ROOT', title: 'Root', fwKey: 'F1', fwName: 'F1' },
                        { reqId: `req-leaf-${i}`, code: `LEAF-${i}`, title: `Leaf ${i}`, fwKey: 'F2', fwName: 'F2' },
                        'RELATED',
                    )
                );
            };

            const result = await resolveMapping(
                { sourceRequirementId: 'req-root', maxDepth: 1 },
                wideLoader,
            );

            expect(result.paths).toHaveLength(50);
        });
    });
});

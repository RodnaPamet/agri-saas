/**
 * Cross-Framework Traceability & Gap Analysis Tests
 *
 * Tests the product-level business semantics applied on top of the
 * mapping resolution engine:
 *
 * 1. Coverage confidence mapping (EQUAL→FULL, SUPERSET→HIGH, etc.)
 * 2. Conservative coverage claims (no overclaiming)
 * 3. Traceability report generation with explanations
 * 4. Gap analysis with correct status determination
 * 5. EQUAL vs SUBSET vs INTERSECT vs RELATED behavior
 * 6. Transitive confidence degradation
 * 7. Explanation generation
 * 8. Sorting and statistics
 *
 * All tests use in-memory edge loaders — no database required.
 */

import {
    strengthToConfidence,
    CONFIDENCE_RANK,
    isActionableCoverage,
    hasAnyCoverage,
    generateExplanation,
    resolveTraceability,
    determineGapStatus,
    analyzeGaps,
} from '@/app-layer/services/cross-framework-traceability';
import { resolveMapping, type MappingEdgeLoader } from '@/app-layer/services/mapping-resolution';
import type { ResolvedMappingEdge, MappingStrengthValue } from '@/app-layer/domain/requirement-mapping.types';

// ─── Test Helpers ────────────────────────────────────────────────────

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

// Framework / requirement fixtures
const ISO = { fwKey: 'ISO27001', fwName: 'ISO 27001' };
const NIST = { fwKey: 'NIST-CSF', fwName: 'NIST CSF 2.0' };
const SOC2 = { fwKey: 'SOC2', fwName: 'SOC 2' };

const ISO_A51 = { reqId: 'req-a51', code: 'A.5.1', title: 'Info Security Policies', ...ISO };
const ISO_A52 = { reqId: 'req-a52', code: 'A.5.2', title: 'Info Security Roles', ...ISO };
const ISO_A515 = { reqId: 'req-a515', code: 'A.5.15', title: 'Access Control', ...ISO };

const NIST_GVOC01 = { reqId: 'req-gvoc01', code: 'GV.OC-01', title: 'Org Context', ...NIST };
const NIST_GVRM01 = { reqId: 'req-gvrm01', code: 'GV.RM-01', title: 'Risk Management', ...NIST };

const SOC2_CC1 = { reqId: 'req-cc1', code: 'CC1', title: 'Practice Environment', ...SOC2 };
const SOC2_CC5 = { reqId: 'req-cc5', code: 'CC5', title: 'Practice Activities', ...SOC2 };
const SOC2_CC6 = { reqId: 'req-cc6', code: 'CC6', title: 'Logical Access', ...SOC2 };

// Edge database with varying strengths
const EDGES: Record<string, ResolvedMappingEdge[]> = {
    // EQUAL mapping: A.5.1 → GV.OC-01
    'req-a51': [
        makeEdge('e1', ISO_A51, NIST_GVOC01, 'EQUAL', 'Semantically equivalent'),
        makeEdge('e2', ISO_A51, SOC2_CC1, 'RELATED', 'Conceptually related'),
    ],
    // SUBSET mapping: A.5.2 → GV.RM-01
    'req-a52': [
        makeEdge('e3', ISO_A52, NIST_GVRM01, 'SUBSET', 'Partial coverage'),
    ],
    // INTERSECT mapping: A.5.15 → CC6
    'req-a515': [
        makeEdge('e4', ISO_A515, SOC2_CC6, 'INTERSECT', 'Overlapping access control scope'),
    ],
    // Transitive: GV.OC-01 → CC5 (SUPERSET)
    'req-gvoc01': [
        makeEdge('e5', NIST_GVOC01, SOC2_CC5, 'SUPERSET', 'NIST broader than SOC2'),
    ],
};

const testLoader: MappingEdgeLoader = async (id) => EDGES[id] ?? [];

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describe('Cross-Framework Traceability', () => {
    // ─── strengthToConfidence ─────────────────────────────────────
    describe('strengthToConfidence', () => {
        it('maps EQUAL to FULL', () => {
            expect(strengthToConfidence('EQUAL')).toBe('FULL');
        });

        it('maps SUPERSET to HIGH', () => {
            expect(strengthToConfidence('SUPERSET')).toBe('HIGH');
        });

        it('maps SUBSET to PARTIAL', () => {
            expect(strengthToConfidence('SUBSET')).toBe('PARTIAL');
        });

        it('maps INTERSECT to OVERLAP', () => {
            expect(strengthToConfidence('INTERSECT')).toBe('OVERLAP');
        });

        it('maps RELATED to INFORMATIONAL', () => {
            expect(strengthToConfidence('RELATED')).toBe('INFORMATIONAL');
        });
    });

    // ─── Coverage Classification ─────────────────────────────────
    describe('Coverage classification', () => {
        it('FULL and HIGH are actionable coverage', () => {
            expect(isActionableCoverage('FULL')).toBe(true);
            expect(isActionableCoverage('HIGH')).toBe(true);
        });

        it('PARTIAL and OVERLAP are NOT actionable coverage', () => {
            expect(isActionableCoverage('PARTIAL')).toBe(false);
            expect(isActionableCoverage('OVERLAP')).toBe(false);
        });

        it('INFORMATIONAL and NONE are NOT actionable coverage', () => {
            expect(isActionableCoverage('INFORMATIONAL')).toBe(false);
            expect(isActionableCoverage('NONE')).toBe(false);
        });

        it('FULL/HIGH/PARTIAL/OVERLAP have some coverage', () => {
            expect(hasAnyCoverage('FULL')).toBe(true);
            expect(hasAnyCoverage('HIGH')).toBe(true);
            expect(hasAnyCoverage('PARTIAL')).toBe(true);
            expect(hasAnyCoverage('OVERLAP')).toBe(true);
        });

        it('INFORMATIONAL and NONE have no coverage', () => {
            expect(hasAnyCoverage('INFORMATIONAL')).toBe(false);
            expect(hasAnyCoverage('NONE')).toBe(false);
        });

        it('confidence ranks are properly ordered', () => {
            expect(CONFIDENCE_RANK.FULL).toBeGreaterThan(CONFIDENCE_RANK.HIGH);
            expect(CONFIDENCE_RANK.HIGH).toBeGreaterThan(CONFIDENCE_RANK.PARTIAL);
            expect(CONFIDENCE_RANK.PARTIAL).toBeGreaterThan(CONFIDENCE_RANK.OVERLAP);
            expect(CONFIDENCE_RANK.OVERLAP).toBeGreaterThan(CONFIDENCE_RANK.INFORMATIONAL);
            expect(CONFIDENCE_RANK.INFORMATIONAL).toBeGreaterThan(CONFIDENCE_RANK.NONE);
        });
    });

    // ─── Explanation Generation ──────────────────────────────────
    describe('Explanation generation', () => {
        it('EQUAL direct → no action required', async () => {
            const trace = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 1, targetFrameworkKeys: ['NIST-CSF'] },
                testLoader,
            );
            const equalPath = trace.paths.find(p => p.effectiveStrength === 'EQUAL');
            const explanation = generateExplanation(equalPath!);

            expect(explanation.summary).toContain('Fully equivalent');
            expect(explanation.actionRequired).toBe(false);
            expect(explanation.suggestedAction).toBeNull();
        });

        it('SUBSET → action required, mentions gaps', async () => {
            const trace = await resolveMapping(
                { sourceRequirementId: 'req-a52', maxDepth: 1 },
                testLoader,
            );
            const subsetPath = trace.paths[0];
            const explanation = generateExplanation(subsetPath);

            expect(explanation.summary).toContain('Partial coverage');
            expect(explanation.summary).toContain('gap remains');
            expect(explanation.actionRequired).toBe(true);
            expect(explanation.suggestedAction).toContain('gaps');
        });

        it('INTERSECT → action required, mentions review', async () => {
            const trace = await resolveMapping(
                { sourceRequirementId: 'req-a515', maxDepth: 1 },
                testLoader,
            );
            const intersectPath = trace.paths[0];
            const explanation = generateExplanation(intersectPath);

            expect(explanation.summary).toContain('Overlap');
            expect(explanation.summary).toContain('review');
            expect(explanation.actionRequired).toBe(true);
        });

        it('RELATED → no action required, informational', async () => {
            const trace = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 1, targetFrameworkKeys: ['SOC2'] },
                testLoader,
            );
            const relatedPath = trace.paths.find(p => p.effectiveStrength === 'RELATED');
            const explanation = generateExplanation(relatedPath!);

            expect(explanation.summary).toContain('Informational');
            expect(explanation.actionRequired).toBe(false);
        });

        it('transitive path includes depth annotation', async () => {
            const trace = await resolveMapping(
                { sourceRequirementId: 'req-a51', maxDepth: 3, targetFrameworkKeys: ['SOC2'] },
                testLoader,
            );
            const transitivePath = trace.paths.find(p => !p.isDirect);
            if (transitivePath) {
                const explanation = generateExplanation(transitivePath);
                expect(explanation.summary).toContain('transitive');
            }
        });
    });

    // ─── Traceability Report ─────────────────────────────────────
    describe('Traceability report', () => {
        it('builds report with correct EQUAL finding', async () => {
            const report = await resolveTraceability(
                'req-a51', 'NIST-CSF', testLoader, { maxDepth: 1 },
            );

            expect(report.targetFrameworkKey).toBe('NIST-CSF');
            expect(report.findings).toHaveLength(1);

            const finding = report.findings[0];
            expect(finding.confidence).toBe('FULL');
            expect(finding.isActionable).toBe(true);
            expect(finding.isDirect).toBe(true);
            expect(finding.target.requirementCode).toBe('GV.OC-01');
        });

        it('builds report with RELATED finding (not actionable)', async () => {
            const report = await resolveTraceability(
                'req-a51', 'SOC2', testLoader, { maxDepth: 1 },
            );

            expect(report.findings).toHaveLength(1);
            const finding = report.findings[0];
            expect(finding.confidence).toBe('INFORMATIONAL');
            expect(finding.isActionable).toBe(false);
            expect(finding.target.requirementCode).toBe('CC1');
        });

        it('builds report with SUBSET finding (partial, not actionable)', async () => {
            const report = await resolveTraceability(
                'req-a52', 'NIST-CSF', testLoader, { maxDepth: 1 },
            );

            expect(report.findings).toHaveLength(1);
            const finding = report.findings[0];
            expect(finding.confidence).toBe('PARTIAL');
            expect(finding.isActionable).toBe(false);
            expect(finding.explanation.actionRequired).toBe(true);
        });

        it('includes edge chain for auditability', async () => {
            const report = await resolveTraceability(
                'req-a51', 'NIST-CSF', testLoader, { maxDepth: 1 },
            );

            const finding = report.findings[0];
            expect(finding.edgeChain).toHaveLength(1);
            expect(finding.edgeChain[0].fromCode).toBe('A.5.1');
            expect(finding.edgeChain[0].toCode).toBe('GV.OC-01');
            expect(finding.edgeChain[0].strength).toBe('EQUAL');
            expect(finding.edgeChain[0].rationale).toBe('Semantically equivalent');
        });

        it('sorts findings by confidence descending', async () => {
            // A.5.1 → SOC2: gets CC1 (RELATED/INFORMATIONAL) and CC5 (transitive via NIST, EQUAL→SUPERSET → effective HIGH)
            const report = await resolveTraceability(
                'req-a51', 'SOC2', testLoader, { maxDepth: 3 },
            );

            // CC5 via transitive (effective=SUPERSET→HIGH) should come before CC1 (RELATED→INFORMATIONAL)
            if (report.findings.length >= 2) {
                expect(report.findings[0].confidenceRank).toBeGreaterThanOrEqual(
                    report.findings[1].confidenceRank,
                );
            }
        });

        it('computes summary statistics correctly', async () => {
            const report = await resolveTraceability(
                'req-a51', 'NIST-CSF', testLoader, { maxDepth: 1 },
            );

            expect(report.summary.totalFindings).toBe(1);
            expect(report.summary.fullCoverage).toBe(1);
            expect(report.summary.bestConfidence).toBe('FULL');
        });

        it('returns NONE bestConfidence when no findings', async () => {
            const report = await resolveTraceability(
                'nonexistent', 'SOC2', testLoader, { maxDepth: 1 },
            );

            expect(report.findings).toHaveLength(0);
            expect(report.summary.bestConfidence).toBe('NONE');
        });
    });

    // ─── Transitive Confidence Degradation ───────────────────────
    describe('Transitive confidence degradation', () => {
        it('EQUAL + SUPERSET → effective SUPERSET → HIGH confidence', async () => {
            // A.5.1 →EQUAL→ GV.OC-01 →SUPERSET→ CC5
            const report = await resolveTraceability(
                'req-a51', 'SOC2', testLoader, { maxDepth: 3 },
            );

            const cc5Finding = report.findings.find(f => f.target.requirementCode === 'CC5');
            expect(cc5Finding).toBeDefined();
            expect(cc5Finding!.mappingStrength).toBe('SUPERSET');
            expect(cc5Finding!.confidence).toBe('HIGH');
            expect(cc5Finding!.isDirect).toBe(false);
            expect(cc5Finding!.depth).toBe(2);
        });

        it('never upgrades confidence through transitivity', async () => {
            // A.5.1 →RELATED→ CC1 (direct, INFORMATIONAL)
            // Even if CC1 maps to something EQUAL, the path A.5.1→CC1 is RELATED
            const report = await resolveTraceability(
                'req-a51', 'SOC2', testLoader, { maxDepth: 1 },
            );

            const cc1Finding = report.findings.find(f => f.target.requirementCode === 'CC1');
            expect(cc1Finding).toBeDefined();
            expect(cc1Finding!.confidence).toBe('INFORMATIONAL');
            // RELATED can never produce actionable coverage
            expect(cc1Finding!.isActionable).toBe(false);
        });
    });

    // ─── Conservative Coverage Claims ────────────────────────────
    describe('Conservative coverage claims', () => {
        it('EQUAL is the only strength that produces FULL confidence', () => {
            expect(strengthToConfidence('EQUAL')).toBe('FULL');
            expect(strengthToConfidence('SUPERSET')).not.toBe('FULL');
            expect(strengthToConfidence('SUBSET')).not.toBe('FULL');
            expect(strengthToConfidence('INTERSECT')).not.toBe('FULL');
            expect(strengthToConfidence('RELATED')).not.toBe('FULL');
        });

        it('SUBSET does NOT count as actionable coverage', () => {
            expect(isActionableCoverage(strengthToConfidence('SUBSET'))).toBe(false);
        });

        it('INTERSECT does NOT count as actionable coverage', () => {
            expect(isActionableCoverage(strengthToConfidence('INTERSECT'))).toBe(false);
        });

        it('RELATED does NOT count as any form of coverage', () => {
            expect(hasAnyCoverage(strengthToConfidence('RELATED'))).toBe(false);
        });
    });
});

describe('Gap Analysis', () => {
    // ─── Gap Status Determination ────────────────────────────────
    describe('determineGapStatus', () => {
        it('FULL → COVERED', () => {
            expect(determineGapStatus('FULL')).toBe('COVERED');
        });

        it('HIGH → COVERED', () => {
            expect(determineGapStatus('HIGH')).toBe('COVERED');
        });

        it('PARTIAL → PARTIALLY_COVERED', () => {
            expect(determineGapStatus('PARTIAL')).toBe('PARTIALLY_COVERED');
        });

        it('OVERLAP → PARTIALLY_COVERED', () => {
            expect(determineGapStatus('OVERLAP')).toBe('PARTIALLY_COVERED');
        });

        it('INFORMATIONAL → REVIEW_NEEDED', () => {
            expect(determineGapStatus('INFORMATIONAL')).toBe('REVIEW_NEEDED');
        });

        it('NONE → NOT_COVERED', () => {
            expect(determineGapStatus('NONE')).toBe('NOT_COVERED');
        });
    });

    // ─── Full Gap Analysis ───────────────────────────────────────
    describe('analyzeGaps', () => {
        const targetReqs = [
            { requirementId: 'req-gvoc01', requirementCode: 'GV.OC-01', requirementTitle: 'Org Context', frameworkKey: 'NIST-CSF', frameworkName: 'NIST CSF 2.0' },
            { requirementId: 'req-gvrm01', requirementCode: 'GV.RM-01', requirementTitle: 'Risk Management', frameworkKey: 'NIST-CSF', frameworkName: 'NIST CSF 2.0' },
        ];

        it('identifies COVERED requirements (EQUAL mapping)', async () => {
            const result = await analyzeGaps(
                ['req-a51'],
                targetReqs,
                'ISO27001',
                'NIST-CSF',
                testLoader,
                { maxDepth: 1 },
            );

            const gvOc = result.entries.find(e => e.targetRequirement.requirementCode === 'GV.OC-01');
            expect(gvOc).toBeDefined();
            expect(gvOc!.status).toBe('COVERED');
            expect(gvOc!.bestConfidence).toBe('FULL');
            expect(gvOc!.bestSource).toBeDefined();
            expect(gvOc!.bestSource!.requirementCode).toBe('A.5.1');
        });

        it('identifies PARTIALLY_COVERED requirements (SUBSET mapping)', async () => {
            const result = await analyzeGaps(
                ['req-a52'],
                targetReqs,
                'ISO27001',
                'NIST-CSF',
                testLoader,
                { maxDepth: 1 },
            );

            const gvRm = result.entries.find(e => e.targetRequirement.requirementCode === 'GV.RM-01');
            expect(gvRm).toBeDefined();
            expect(gvRm!.status).toBe('PARTIALLY_COVERED');
            expect(gvRm!.bestConfidence).toBe('PARTIAL');
        });

        it('identifies NOT_COVERED requirements (no mapping)', async () => {
            const result = await analyzeGaps(
                ['req-a515'],  // ISO A.5.15 only maps to SOC2, not NIST
                targetReqs,
                'ISO27001',
                'NIST-CSF',
                testLoader,
                { maxDepth: 1 },
            );

            // Both NIST targets should be NOT_COVERED since A.5.15 only maps to SOC2
            expect(result.entries.every(e => e.status === 'NOT_COVERED')).toBe(true);
        });

        it('computes correct summary statistics', async () => {
            const result = await analyzeGaps(
                ['req-a51', 'req-a52'],  // A.5.1 covers GV.OC-01 (EQUAL), A.5.2 covers GV.RM-01 (SUBSET)
                targetReqs,
                'ISO27001',
                'NIST-CSF',
                testLoader,
                { maxDepth: 1 },
            );

            expect(result.summary.totalTargetRequirements).toBe(2);
            expect(result.summary.covered).toBe(1);           // GV.OC-01 via EQUAL
            expect(result.summary.partiallyCovered).toBe(1);   // GV.RM-01 via SUBSET
            expect(result.summary.notCovered).toBe(0);
            expect(result.summary.coveragePercent).toBe(50);          // 1/2 COVERED
            expect(result.summary.inclusiveCoveragePercent).toBe(100); // 2/2 COVERED+PARTIAL
        });

        it('sorts entries with gaps first', async () => {
            const result = await analyzeGaps(
                ['req-a51', 'req-a52'],
                targetReqs,
                'ISO27001',
                'NIST-CSF',
                testLoader,
                { maxDepth: 1 },
            );

            // PARTIALLY_COVERED should come before COVERED
            const statuses = result.entries.map(e => e.status);
            const partialIdx = statuses.indexOf('PARTIALLY_COVERED');
            const coveredIdx = statuses.indexOf('COVERED');
            if (partialIdx !== -1 && coveredIdx !== -1) {
                expect(partialIdx).toBeLessThan(coveredIdx);
            }
        });

        it('handles empty source requirements', async () => {
            const result = await analyzeGaps(
                [],
                targetReqs,
                'ISO27001',
                'NIST-CSF',
                testLoader,
            );

            expect(result.entries.every(e => e.status === 'NOT_COVERED')).toBe(true);
            expect(result.summary.coveragePercent).toBe(0);
        });

        it('handles RELATED mapping → REVIEW_NEEDED status', async () => {
            const soc2Targets = [
                { requirementId: 'req-cc1', requirementCode: 'CC1', requirementTitle: 'Practice Environment', frameworkKey: 'SOC2', frameworkName: 'SOC 2' },
            ];

            const result = await analyzeGaps(
                ['req-a51'],  // A.5.1 → CC1 is RELATED
                soc2Targets,
                'ISO27001',
                'SOC2',
                testLoader,
                { maxDepth: 1 },
            );

            const cc1 = result.entries.find(e => e.targetRequirement.requirementCode === 'CC1');
            expect(cc1).toBeDefined();
            expect(cc1!.status).toBe('REVIEW_NEEDED');
            expect(cc1!.bestConfidence).toBe('INFORMATIONAL');
            expect(cc1!.explanation).toContain('manual compliance review');
        });

        it('includes explanation for each entry', async () => {
            const result = await analyzeGaps(
                ['req-a51'],
                targetReqs,
                'ISO27001',
                'NIST-CSF',
                testLoader,
                { maxDepth: 1 },
            );

            for (const entry of result.entries) {
                expect(entry.explanation).toBeTruthy();
                expect(typeof entry.explanation).toBe('string');
            }
        });
    });

    // ─── Conservative Gap Claims ─────────────────────────────────
    describe('Conservative gap claims', () => {
        it('RELATED mapping does not produce COVERED status', async () => {
            const soc2Targets = [
                { requirementId: 'req-cc1', requirementCode: 'CC1', requirementTitle: 'Practice Environment', frameworkKey: 'SOC2', frameworkName: 'SOC 2' },
            ];

            const result = await analyzeGaps(
                ['req-a51'],
                soc2Targets,
                'ISO27001',
                'SOC2',
                testLoader,
                { maxDepth: 1 },  // Only direct — A.5.1 → CC1 is RELATED
            );

            expect(result.entries[0].status).not.toBe('COVERED');
            expect(result.summary.covered).toBe(0);
        });

        it('INTERSECT mapping produces PARTIALLY_COVERED not COVERED', async () => {
            const soc2Targets = [
                { requirementId: 'req-cc6', requirementCode: 'CC6', requirementTitle: 'Logical Access', frameworkKey: 'SOC2', frameworkName: 'SOC 2' },
            ];

            const result = await analyzeGaps(
                ['req-a515'],
                soc2Targets,
                'ISO27001',
                'SOC2',
                testLoader,
                { maxDepth: 1 },
            );

            expect(result.entries[0].status).toBe('PARTIALLY_COVERED');
            expect(result.summary.covered).toBe(0);
            expect(result.summary.partiallyCovered).toBe(1);
        });

        it('SUBSET mapping produces PARTIALLY_COVERED not COVERED', async () => {
            const result = await analyzeGaps(
                ['req-a52'],
                [{ requirementId: 'req-gvrm01', requirementCode: 'GV.RM-01', requirementTitle: 'Risk Management', frameworkKey: 'NIST-CSF', frameworkName: 'NIST CSF 2.0' }],
                'ISO27001',
                'NIST-CSF',
                testLoader,
                { maxDepth: 1 },
            );

            expect(result.entries[0].status).toBe('PARTIALLY_COVERED');
            expect(result.summary.covered).toBe(0);
        });

        it('only EQUAL and SUPERSET produce COVERED status via gap analysis', async () => {
            // EQUAL → COVERED
            const equalResult = await analyzeGaps(
                ['req-a51'],
                [{ requirementId: 'req-gvoc01', requirementCode: 'GV.OC-01', requirementTitle: 'Org Context', frameworkKey: 'NIST-CSF', frameworkName: 'NIST CSF 2.0' }],
                'ISO27001',
                'NIST-CSF',
                testLoader,
                { maxDepth: 1 },
            );
            expect(equalResult.entries[0].status).toBe('COVERED');

            // SUPERSET (transitive: A.5.1 →EQUAL→ GV.OC-01 →SUPERSET→ CC5, effective=SUPERSET)
            const supersetResult = await analyzeGaps(
                ['req-a51'],
                [{ requirementId: 'req-cc5', requirementCode: 'CC5', requirementTitle: 'Practice Activities', frameworkKey: 'SOC2', frameworkName: 'SOC 2' }],
                'ISO27001',
                'SOC2',
                testLoader,
                { maxDepth: 3 },
            );
            expect(supersetResult.entries[0].status).toBe('COVERED');
        });
    });
});

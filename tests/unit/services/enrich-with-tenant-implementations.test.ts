/**
 * Audit Coherence S9 (2026-05-24) — unit tests for the tenant
 * practice-implementation overlay. Pure function — no DB, no
 * mocks; we drive shaped input through and assert the
 * implementingPractices annotation lands per entry.
 */
import {
    enrichWithTenantImplementations,
    type GapAnalysisResult,
    type TenantPracticeImplementation,
} from '@/app-layer/services/cross-framework-traceability';

function entry(
    requirementId: string,
    requirementCode: string,
): GapAnalysisResult['entries'][number] {
    return {
        targetRequirement: {
            requirementId,
            requirementCode,
            requirementTitle: `req ${requirementCode}`,
            frameworkKey: 'SOC2',
            frameworkName: 'SOC 2',
        },
        status: 'NOT_COVERED',
        bestConfidence: 'NONE',
        sourceCount: 0,
        bestSource: null,
        explanation: 'no mapping',
    };
}

function baseResult(): GapAnalysisResult {
    return {
        sourceFramework: 'NIST',
        targetFramework: 'SOC2',
        entries: [entry('r1', 'CC6.1'), entry('r2', 'CC6.2'), entry('r3', 'CC6.3')],
        summary: {
            totalTargetRequirements: 3,
            covered: 0,
            partiallyCovered: 0,
            notCovered: 3,
            reviewNeeded: 0,
            coveragePercent: 0,
            inclusiveCoveragePercent: 0,
        },
    };
}

function impl(
    requirementId: string,
    practiceCode: string,
): TenantPracticeImplementation {
    return {
        practiceId: `ctl-${practiceCode}`,
        practiceCode,
        practiceName: `Practice ${practiceCode}`,
        practiceStatus: 'IMPLEMENTED',
        requirementId,
    };
}

describe('enrichWithTenantImplementations', () => {
    it('annotates every entry, empty array when nothing maps', () => {
        const out = enrichWithTenantImplementations(baseResult(), []);
        expect(out.entries).toHaveLength(3);
        for (const e of out.entries) {
            expect(e.implementingPractices).toEqual([]);
        }
    });

    it('attaches multiple practices to the same target requirement', () => {
        const out = enrichWithTenantImplementations(baseResult(), [
            impl('r1', 'C1'),
            impl('r1', 'C2'),
            impl('r2', 'C3'),
        ]);
        const r1 = out.entries.find(
            (e) => e.targetRequirement.requirementId === 'r1',
        )!;
        const r2 = out.entries.find(
            (e) => e.targetRequirement.requirementId === 'r2',
        )!;
        const r3 = out.entries.find(
            (e) => e.targetRequirement.requirementId === 'r3',
        )!;
        expect(r1.implementingPractices.map((c) => c.practiceCode).sort()).toEqual(
            ['C1', 'C2'],
        );
        expect(r2.implementingPractices.map((c) => c.practiceCode)).toEqual(['C3']);
        expect(r3.implementingPractices).toEqual([]);
    });

    it('ignores implementation rows that point at requirements outside the result', () => {
        const out = enrichWithTenantImplementations(baseResult(), [
            impl('r1', 'C1'),
            // r99 isn't in the gap-analysis entries — should silently drop.
            impl('r99', 'C-orphan'),
        ]);
        expect(out.entries[0].implementingPractices.length).toBeGreaterThan(0);
        for (const e of out.entries) {
            for (const c of e.implementingPractices) {
                expect(['r1', 'r2', 'r3']).toContain(e.targetRequirement.requirementId);
                expect(c.requirementId).toBe(e.targetRequirement.requirementId);
            }
        }
    });

    it('preserves the result summary and framework labels verbatim', () => {
        const original = baseResult();
        const out = enrichWithTenantImplementations(original, []);
        expect(out.sourceFramework).toBe(original.sourceFramework);
        expect(out.targetFramework).toBe(original.targetFramework);
        expect(out.summary).toEqual(original.summary);
    });

    it('does not mutate the input arrays', () => {
        const original = baseResult();
        const originalEntriesRef = original.entries;
        enrichWithTenantImplementations(original, [impl('r1', 'C1')]);
        // Same array reference + no implementingPractices leaked back.
        expect(original.entries).toBe(originalEntriesRef);
        for (const e of original.entries) {
            // The narrower input type has no implementingPractices field.
            expect('implementingPractices' in e).toBe(false);
        }
    });
});

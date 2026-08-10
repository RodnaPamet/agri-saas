/**
 * Unit tests for `summarizePlannedYield`
 * (`src/lib/planning/planned-yield.ts`). No DB, no mocks — pure math.
 *
 * Pins the null-is-not-zero invariant that CLAUDE.md documents for
 * `Planting.plannedYieldKgPerHa`, mirroring the precedent set by
 * `YieldRecord.netTonnesStd` (null when unmeasured, never zero).
 */
import { summarizePlannedYield, type PlannedYieldInputRow } from '@/lib/planning/planned-yield';

describe('summarizePlannedYield', () => {
    it('sums rate × area (m² → ha) for every fully-specified row', () => {
        // 1 ha at 5000 kg/ha = 5000 kg.
        const rows: PlannedYieldInputRow[] = [
            { id: 'p-1', areaM2: 10_000, plannedYieldKgPerHa: 5000 },
            // 0.5 ha at 4000 kg/ha = 2000 kg.
            { id: 'p-2', areaM2: 5_000, plannedYieldKgPerHa: 4000 },
        ];
        const summary = summarizePlannedYield(rows);
        expect(summary.totalPlannedYieldKg).toBe(7000);
        expect(summary.includedPlantingIds).toEqual(['p-1', 'p-2']);
        expect(summary.excludedPlantingIds).toEqual([]);
    });

    // ─── null-is-not-zero: the core invariant ─────────────────────────

    it('EXCLUDES a null planned yield from the total — does not treat it as 0', () => {
        const rows: PlannedYieldInputRow[] = [
            { id: 'p-1', areaM2: 10_000, plannedYieldKgPerHa: 5000 },
            { id: 'p-unset', areaM2: 10_000, plannedYieldKgPerHa: null },
        ];
        const summary = summarizePlannedYield(rows);
        // The total reflects ONLY the priced planting.
        expect(summary.totalPlannedYieldKg).toBe(5000);
        // The unset planting is named as an explicit exclusion, not
        // silently folded into the sum as a zero contribution.
        expect(summary.excludedPlantingIds).toEqual(['p-unset']);
        expect(summary.includedPlantingIds).toEqual(['p-1']);
        expect(summary.includedPlantingIds).not.toContain('p-unset');
    });

    it('a real ZERO planned yield IS included — 0 and null are different claims', () => {
        // "I expect nothing from this succession" is a real, entered
        // claim, distinct from "I have not estimated this succession".
        const rows: PlannedYieldInputRow[] = [
            { id: 'p-zero', areaM2: 10_000, plannedYieldKgPerHa: 0 },
        ];
        const summary = summarizePlannedYield(rows);
        expect(summary.includedPlantingIds).toEqual(['p-zero']);
        expect(summary.excludedPlantingIds).toEqual([]);
        expect(summary.totalPlannedYieldKg).toBe(0);
    });

    it('excludes a planting with no area even when a rate is set', () => {
        const rows: PlannedYieldInputRow[] = [
            { id: 'p-no-area', areaM2: null, plannedYieldKgPerHa: 5000 },
        ];
        const summary = summarizePlannedYield(rows);
        expect(summary.excludedPlantingIds).toEqual(['p-no-area']);
        expect(summary.totalPlannedYieldKg).toBe(0);
    });

    it('excludes non-finite inputs defensively (NaN rate or area)', () => {
        const rows: PlannedYieldInputRow[] = [
            { id: 'p-nan-rate', areaM2: 10_000, plannedYieldKgPerHa: NaN },
            { id: 'p-nan-area', areaM2: NaN, plannedYieldKgPerHa: 5000 },
        ];
        const summary = summarizePlannedYield(rows);
        expect(summary.excludedPlantingIds).toEqual(['p-nan-rate', 'p-nan-area']);
        expect(summary.includedPlantingIds).toEqual([]);
    });

    it('an all-excluded plan reports zero WITH visible exclusions, not silent zero', () => {
        const rows: PlannedYieldInputRow[] = [
            { id: 'p-1', areaM2: 10_000, plannedYieldKgPerHa: null },
            { id: 'p-2', areaM2: null, plannedYieldKgPerHa: null },
        ];
        const summary = summarizePlannedYield(rows);
        expect(summary.totalPlannedYieldKg).toBe(0);
        expect(summary.excludedPlantingIds).toEqual(['p-1', 'p-2']);
        // The zero total is legible as "nothing priced" — not
        // indistinguishable from "priced at zero".
        expect(summary.includedPlantingIds).toHaveLength(0);
    });

    it('returns a zero summary for an empty plan', () => {
        expect(summarizePlannedYield([])).toEqual({
            totalPlannedYieldKg: 0,
            includedPlantingIds: [],
            excludedPlantingIds: [],
        });
    });
});

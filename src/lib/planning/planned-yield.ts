/**
 * Planned-yield summary — PURE aggregation over `Planting` rows.
 *
 * `Planting.plannedYieldKgPerHa` is a grower-entered EXPECTATION, per
 * hectare, and it is nullable on purpose: a planting the grower has not
 * yet estimated carries no expectation at all, which is a different
 * claim from "expect zero" (the same principle already applied to
 * `YieldRecord.netTonnesStd`, which is deliberately NULL when
 * `moisturePct` is unmeasured — see
 * `src/app-layer/usecases/season-recap.ts`).
 *
 * A calculator that folds `null` into a sum as if it were `0` silently
 * understates the farm's expected output whenever ANY planting is
 * missing its estimate — worse, that error is invisible: the total
 * still looks like a real number. So this module never coerces; a
 * planting missing either its planned-yield rate or its area is
 * EXCLUDED from the total and named in `excludedPlantingIds`, so a
 * caller can render "N successions have no yield estimate yet" instead
 * of quietly reporting a low total as if it were complete.
 *
 * No DB, no I/O — takes whatever shape of row a consumer already has
 * (`PlantingProgressRow` from `crop-planning.ts` satisfies this, field
 * for field, with no mapping needed).
 */

/** m² per hectare — plain SI, not the Bulgarian декар convention. */
const M2_PER_HA = 10_000;

export interface PlannedYieldInputRow {
    /** Stable id for this planting — echoed back in the exclusion list. */
    id: string;
    /** Planting footprint, m². Null/non-finite ⇒ excluded (no area to rate against). */
    areaM2: number | null;
    /** Grower-entered expectation, per hectare. Null ⇒ excluded — see module doc. */
    plannedYieldKgPerHa: number | null;
}

export interface PlannedYieldSummary {
    /** Σ (plannedYieldKgPerHa × areaHa) over INCLUDED plantings only. */
    totalPlannedYieldKg: number;
    /** Plantings that priced into the total above. */
    includedPlantingIds: string[];
    /**
     * Plantings left OUT of the total — no planned yield set, or no area
     * to multiply it against. Explicit and named, never folded into the
     * total as a silent zero.
     */
    excludedPlantingIds: string[];
}

/**
 * Fold a set of plantings into one expected-yield total, excluding (not
 * zeroing) any row with no estimate or no area. A `plannedYieldKgPerHa`
 * of exactly `0` is a real claim ("expect nothing from this succession")
 * and IS included — only `null`/non-finite is excluded.
 */
export function summarizePlannedYield(rows: readonly PlannedYieldInputRow[]): PlannedYieldSummary {
    let totalPlannedYieldKg = 0;
    const includedPlantingIds: string[] = [];
    const excludedPlantingIds: string[] = [];

    for (const row of rows) {
        const rate = row.plannedYieldKgPerHa;
        const areaM2 = row.areaM2;
        if (rate == null || areaM2 == null || !Number.isFinite(rate) || !Number.isFinite(areaM2)) {
            excludedPlantingIds.push(row.id);
            continue;
        }
        const areaHa = areaM2 / M2_PER_HA;
        totalPlannedYieldKg += rate * areaHa;
        includedPlantingIds.push(row.id);
    }

    return {
        totalPlannedYieldKg: Math.round(totalPlannedYieldKg * 100) / 100,
        includedPlantingIds,
        excludedPlantingIds,
    };
}

/**
 * GDD on plantings — accumulate Growing Degree Days for a single
 * planting from its sow date to today, over the WeatherObservation rows
 * pulled for the planting's location.
 *
 * Consumes the PURE `accumulateGdd` accumulator in `src/lib/agro/gdd.ts`
 * (average method, base-temp floor). The usecase's only job is to load
 * the right window of weather and feed it in.
 *
 * Base temperature: sourced per-variety from `CropVariety.gddBaseC` (a
 * crop-specific floor — warm-season ≈ 10 °C, cool-season ≈ 4–5 °C),
 * falling back to `GDD_BASE_TEMP_C = 10` °C when the variety carries none.
 * The maturity target comes from `CropVariety.gddToMaturity`.
 *
 * @module usecases/agro-gdd
 */
import type { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { codedNotFound } from '@/lib/errors/types';
import { accumulateGdd, type DailyTemp, type GddDay } from '@/lib/agro/gdd';
import { cachedListRead } from '@/lib/cache/list-cache';

/**
 * Fallback GDD base temperature (°C) — used when a variety carries no
 * `gddBaseC`. The conventional default for many warm-season crops.
 */
export const GDD_BASE_TEMP_C = 10;

/** Bound on observation rows loaded per planting (sow→today window). */
const GDD_MAX_DAYS = 400;

export interface PlantingGddResult {
    plantingId: string;
    /** Sow date the accumulation starts from (ISO date), or null. */
    sowDate: string | null;
    /** Base temperature used (°C). */
    baseTempC: number;
    /** Total accumulated GDD over the window (0 when no weather/sow date). */
    totalGdd: number;
    /** Per-day GDD + running cumulative — for plotting the curve. */
    days: GddDay[];
    /**
     * GDD-to-maturity target for the variety (`CropVariety.gddToMaturity`),
     * when known — else null (the board then shows raw accumulated GDD
     * only, no maturity %).
     */
    targetGdd: number | null;
}

function num(v: unknown): number | null {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Accumulate GDD for one planting from sow date → today.
 *
 * Returns an empty accumulation (`totalGdd: 0, days: []`) — never throws
 * — when the planting has no sow date or no location, so a UI cell can
 * render "—" rather than an error. Throws `notFound` only when the
 * planting id itself doesn't resolve in the tenant.
 */
export async function getPlantingGdd(
    ctx: RequestContext,
    plantingId: string,
    now: Date = new Date(),
): Promise<PlantingGddResult> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const planting = await db.planting.findFirst({
            where: { id: plantingId, tenantId: ctx.tenantId, deletedAt: null },
            select: {
                id: true,
                sowDate: true,
                locationId: true,
                // Per-variety GDD parameters (feat: real maturity %). Both
                // nullable — a variety without them falls back to the 10 °C
                // conventional base and a null target (raw GDD only).
                variety: { select: { gddBaseC: true, gddToMaturity: true } },
            },
        });
        if (!planting) throw codedNotFound('PLANTING_NOT_FOUND', 'Planting not found');

        // Base temperature: the variety's crop-specific floor, else the
        // conventional GDD_BASE_TEMP_C default. Decimal → number.
        const baseTempC = num(planting.variety?.gddBaseC) ?? GDD_BASE_TEMP_C;
        const targetGdd = planting.variety?.gddToMaturity ?? null;

        const empty: PlantingGddResult = {
            plantingId: planting.id,
            sowDate: planting.sowDate ? planting.sowDate.toISOString().slice(0, 10) : null,
            baseTempC,
            totalGdd: 0,
            days: [],
            targetGdd,
        };

        // No sow date or no location ⇒ no accumulation window. Returned
        // OUTSIDE the cache wrapper (cheap, no weather read) — only the
        // weather-dependent accumulation below is cached.
        if (!planting.sowDate || !planting.locationId) return empty;
        const sowDate = planting.sowDate;
        const locationId = planting.locationId;

        // Cache the weather-read + GDD accumulation. The window grows
        // daily (lte: now) so the `day` bucket (today, UTC) is part of
        // the key — the 6h cache still rolls over each calendar day, and
        // a same-day weather-pull invalidates via the
        // `'weather-observation'` version bump. The planting lookup and
        // the empty-window early-return above stay OUTSIDE the cache so a
        // `notFound` / no-window result is never cached.
        const { totalGdd, days } = await cachedListRead({
            ctx,
            entity: 'weather-observation',
            operation: 'gdd',
            params: {
                plantingId: planting.id,
                locationId,
                sowDate: sowDate.toISOString().slice(0, 10),
                day: now.toISOString().slice(0, 10),
                // Part of the key so a variety base-temp change invalidates.
                baseTempC,
            },
            ttlSeconds: 21600,
            loader: () =>
                runInTenantContext(ctx, async (innerDb) => {
                    const obs = await innerDb.weatherObservation.findMany({
                        where: {
                            tenantId: ctx.tenantId,
                            locationId,
                            obsDate: { gte: sowDate, lte: now },
                        },
                        orderBy: { obsDate: 'asc' },
                        take: GDD_MAX_DAYS,
                        select: { obsDate: true, tempMaxC: true, tempMinC: true },
                    });

                    const series: DailyTemp[] = [];
                    for (const o of obs) {
                        const tMax = num(o.tempMaxC);
                        const tMin = num(o.tempMinC);
                        // A day missing either bound contributes nothing — skip it
                        // rather than feed a NaN into the accumulator.
                        if (tMax == null || tMin == null) continue;
                        series.push({ date: o.obsDate.toISOString().slice(0, 10), tempMaxC: tMax, tempMinC: tMin });
                    }

                    const acc = accumulateGdd(series, { baseTempC });
                    return { totalGdd: acc.totalGdd, days: acc.days };
                }),
        });

        return {
            ...empty,
            totalGdd,
            days,
        };
    });
}

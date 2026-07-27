import { Prisma } from '@prisma/client';
import { tonnesPerHectare } from '@/lib/grain/moisture';
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead } from '../policies/common';

/**
 * Season recap — the "Year on the farm" read-model.
 *
 * A THIN, READ-ONLY aggregation across the ag domain that powers both the
 * dashboard recap card (`GET .../reports/season-recap`) and the
 * "Year on the farm" PDF. Authorises via `assertCanRead` at the boundary;
 * every query runs inside `runInTenantContext` (RLS-bound) AND carries an
 * explicit `tenantId` filter (defence in depth). All reads are bounded
 * (`take:`) and there is NO N+1 — each model is read at most once, with the
 * per-location rollup done in memory.
 *
 * ## Scope resolution
 *   - `seasonId` given      → that season (404-tolerant: if it doesn't
 *                             exist for the tenant we degrade to all-time).
 *   - else                  → the most recent Season (year desc, then
 *                             startDate desc).
 *   - else (no seasons)     → ALL-TIME (`seasonId = null`,
 *                             `seasonName = null`, `year = null`).
 *
 * When a season IS in scope, `YieldRecord` rows are filtered by the
 * `seasonId` FK and `LogEntry` rows by `occurredAt` within
 * `[season.startDate, season.endDate]` — `LogEntry` has no `seasonId`
 * column, so its date window is the only honest season boundary.
 *
 * ## Field-name reconciliation (vs. the original spec)
 *   - `Location` has NO `areaHa` column. Hectarage lives on `Parcel.areaHa`
 *     (a Location has many Parcels). `totalAreaHa` therefore SUMs
 *     `Parcel.areaHa` for the in-scope locations (the locations that
 *     produced yield in scope), falling back to ALL tenant parcels when
 *     there is no season scoping.
 *   - `LogEntry` has no direct `locationId` / `seasonId` — activity scope
 *     is the `occurredAt` window only.
 */

/** A bounded cap on every list read — generous for a single farm-year. */
const RECAP_TAKE = 5000;
/** Top-N fields surfaced in the recap. */
const TOP_FIELDS = 3;

/** Prisma Decimal | null → plain number | null. */
function dec(v: Prisma.Decimal | null | undefined): number | null {
    if (v == null) return null;
    return typeof v === 'number' ? v : Number(v.toString());
}

function round4(n: number): number {
    return Math.round(n * 1e4) / 1e4;
}

export interface RecapTopField {
    locationId: string;
    name: string;
    yieldTonnes: number;
    areaHa: number | null;
    tPerHa: number | null;
}

/**
 * `costPerHa` here reports COST_METRICS.SEASON_ACTIVITY_COST: field-event
 * cost inside the season's date window, with no stock and no planting link.
 * It will NOT equal the costs page's attributed figure, by design — see
 * src/lib/grain/cost-metrics.ts.
 */
export interface SeasonRecap {
    seasonId: string | null;
    seasonName: string | null; // null when all-time
    year: number | null;
    totalAreaHa: number; // SUM of in-scope Parcel.areaHa (all tenant parcels when unscoped)
    /**
     * SUM of the HARVESTED area farmers typed on their yield records — the
     * denominator behind `avgYieldTPerHa`, and a different quantity from
     * `totalAreaHa` (which counts every parcel under a producing field).
     * Dividing by the latter is what made the same harvest read 7.0 t/ha on
     * the yield page and 4.2 t/ha in the year-end PDF.
     */
    harvestedAreaHa: number;
    totalYieldTonnes: number; // SUM YieldRecord.grossTonnes in scope (GROSS)
    /**
     * SUM at the 14% standard moisture basis, over the records that carry a
     * moisture reading. This is the only total on which two harvests are
     * comparable — gross tonnages measured at different moistures are not
     * the same quantity of grain.
     */
    totalNetTonnesStd: number;
    /** Gross tonnes from records with NO moisture reading, reported rather
     *  than folded in, so "at 14%" never quietly means "mostly at 14%". */
    unadjustedTonnes: number;
    /** How many in-scope records carry a moisture reading. */
    recordsWithMoisture: number;
    /** In-scope yield record count (the denominator for the above). */
    yieldRecordCount: number;
    /** Comparable tonnage / harvested area. Null when nothing was harvested. */
    avgYieldTPerHa: number | null;
    costPerHa: number | null; // SUM(LogEntry.costAmount in scope) / totalAreaHa; null if NO costAmount rows
    topFields: RecapTopField[]; // top 3 locations by yieldTonnes desc
    activityCount: number; // count of in-scope LogEntry
}

export async function getSeasonRecap(
    ctx: RequestContext,
    seasonId?: string,
): Promise<SeasonRecap> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        // ─── Resolve scope ───────────────────────────────────────────
        let season: { id: string; name: string; year: number | null; startDate: Date; endDate: Date } | null = null;

        if (seasonId) {
            season = await db.season.findFirst({
                where: { id: seasonId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true, name: true, year: true, startDate: true, endDate: true },
            });
        } else {
            const recent = await db.season.findMany({
                where: { tenantId: ctx.tenantId, deletedAt: null },
                orderBy: [{ year: 'desc' }, { startDate: 'desc' }],
                select: { id: true, name: true, year: true, startDate: true, endDate: true },
                take: 1,
            });
            season = recent[0] ?? null;
        }

        const scoped = season != null;

        // ─── Yield: aggregates, not a truncated row scan ─────────────
        //
        // This was `findMany({ take: 5000 })` with NO orderBy, so past the
        // cap the total silently dropped rows AND which rows survived varied
        // between calls — while the portfolio view computed the same
        // quantity as a real DB aggregate. The two views could therefore
        // disagree on one tenant's harvest, with the recap always the one
        // that was quietly wrong. Aggregating in-DB drops nothing and makes
        // the two agree by construction.
        const yieldWhere = {
            tenantId: ctx.tenantId,
            deletedAt: null,
            ...(scoped ? { seasonId: season!.id } : {}),
        };

        const [yieldTotals, yieldByLocationRows] = await Promise.all([
            db.yieldRecord.aggregate({
                where: yieldWhere,
                // Both bases: the comparable one, and gross so the share of
                // the total that could NOT be adjusted stays visible.
                _sum: { grossTonnes: true, netTonnesStd: true, areaHa: true },
                _count: { _all: true, netTonnesStd: true },
            }),
            db.yieldRecord.groupBy({
                by: ['locationId'],
                where: yieldWhere,
                _sum: { grossTonnes: true, netTonnesStd: true, areaHa: true },
            }),
        ]);

        const totalGrossTonnes = round4(dec(yieldTotals._sum.grossTonnes) ?? 0);
        const totalNetTonnesStd = round4(dec(yieldTotals._sum.netTonnesStd) ?? 0);
        // The HARVESTED area the farmer typed — the agronomically correct
        // denominator, and the one the yield page has always used. The old
        // code never read it: it divided by Σ Parcel.areaHa, i.e. every
        // parcel under any field that produced yield, which is why the same
        // harvest printed 7.0 t/ha on screen and 4.2 t/ha in the PDF.
        const totalHarvestedAreaHa = round4(dec(yieldTotals._sum.areaHa) ?? 0);
        const recordCount = yieldTotals._count._all;
        const recordsWithMoisture = yieldTotals._count.netTonnesStd;

        // Tonnes carried by records with NO moisture reading. Reported
        // rather than folded into the adjusted figure, so "at 14%" never
        // quietly means "at 14% plus whatever these were".
        const unadjustedAgg = await db.yieldRecord.aggregate({
            where: { ...yieldWhere, netTonnesStd: null },
            _sum: { grossTonnes: true },
        });
        const unadjustedTonnes = round4(dec(unadjustedAgg._sum.grossTonnes) ?? 0);

        // Kept for the existing consumers; gross is what "total harvested"
        // has always meant on this screen.
        const totalYieldTonnes = totalGrossTonnes;

        // Per-location rollup, now straight from the groupBy.
        const yieldByLocation = new Map<string, number>();
        const netByLocation = new Map<string, number>();
        const harvestedAreaByLocation = new Map<string, number>();
        for (const row of yieldByLocationRows) {
            if (!row.locationId) continue;
            yieldByLocation.set(row.locationId, dec(row._sum.grossTonnes) ?? 0);
            netByLocation.set(row.locationId, dec(row._sum.netTonnesStd) ?? 0);
            harvestedAreaByLocation.set(row.locationId, dec(row._sum.areaHa) ?? 0);
        }

        const inScopeLocationIds = [...yieldByLocation.keys()];

        // ─── Area (Parcel.areaHa) ────────────────────────────────────
        // Scoped → only parcels under the locations that produced yield
        //   (skip the read entirely when no in-scope location produced yield).
        // Unscoped (all-time) → ALL tenant parcels.
        let totalAreaHa = 0;
        const areaByLocation = new Map<string, number>();
        const skipParcels = scoped && inScopeLocationIds.length === 0;
        if (!skipParcels) {
            const parcelRows = await db.parcel.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    deletedAt: null,
                    ...(scoped ? { locationId: { in: inScopeLocationIds } } : {}),
                },
                select: { locationId: true, areaHa: true },
                take: RECAP_TAKE,
            });
            for (const row of parcelRows) {
                const a = dec(row.areaHa) ?? 0;
                totalAreaHa += a;
                areaByLocation.set(row.locationId, (areaByLocation.get(row.locationId) ?? 0) + a);
            }
        }
        totalAreaHa = round4(totalAreaHa);

        // ONE definition of t/ha, shared with the yield page and the PDF:
        // adjusted tonnage over HARVESTED area. `totalAreaHa` (every parcel
        // under the fields that produced) stays as the cropped-area metric
        // it always was — it just stops being a yield denominator, which is
        // what made the same harvest read 7.0 t/ha on screen and 4.2 here.
        //
        // Numerator: the adjusted total plus the tonnes that could not be
        // adjusted, so no harvest is dropped from the average; the DTO
        // reports `unadjustedTonnes` so a reader can see how mixed it is.
        const comparableTonnes = round4(totalNetTonnesStd + unadjustedTonnes);
        const avgYieldTPerHa = tonnesPerHectare(comparableTonnes, totalHarvestedAreaHa);

        // ─── Activity + cost (LogEntry) ──────────────────────────────
        // No seasonId/locationId on LogEntry — scope by occurredAt window.
        const logWhere: Prisma.LogEntryWhereInput = {
            tenantId: ctx.tenantId,
            deletedAt: null,
            ...(scoped ? { occurredAt: { gte: season!.startDate, lte: season!.endDate } } : {}),
        };

        const [activityCount, costAgg] = await Promise.all([
            db.logEntry.count({ where: logWhere }),
            // costAmount is OPTIONAL — _sum is null when no row has a value,
            // and _count counts only rows where costAmount is non-null.
            db.logEntry.aggregate({
                where: { ...logWhere, costAmount: { not: null } },
                _sum: { costAmount: true },
                _count: { costAmount: true },
            }),
        ]);

        const costRowCount = costAgg._count.costAmount;
        const costSum = dec(costAgg._sum.costAmount);
        // costPerHa is null when there is NO costAmount signal at all
        // (honest — it's the only cost data we have), or when area is 0.
        const costPerHa =
            costRowCount > 0 && costSum != null && totalAreaHa > 0
                ? round4(costSum / totalAreaHa)
                : null;

        // ─── Top fields (names from one bounded Location read) ───────
        const topLocationIds = [...yieldByLocation.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, TOP_FIELDS)
            .map(([id]) => id);

        const locationNames = new Map<string, string>();
        if (topLocationIds.length > 0) {
            const locs = await db.location.findMany({
                where: { id: { in: topLocationIds }, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true, name: true },
                take: TOP_FIELDS,
            });
            for (const l of locs) locationNames.set(l.id, l.name);
        }

        const topFields: RecapTopField[] = topLocationIds.map((id) => {
            const yieldTonnes = round4(yieldByLocation.get(id) ?? 0);
            const netTonnes = round4(netByLocation.get(id) ?? 0);
            // Harvested area for THIS field, not its parcel area — same
            // denominator as the headline figure and the yield page.
            const harvested = round4(harvestedAreaByLocation.get(id) ?? 0);
            const areaHa = harvested > 0 ? harvested : null;
            // Fall back to gross for the part with no moisture reading.
            const comparable = netTonnes > 0 ? netTonnes : yieldTonnes;
            return {
                locationId: id,
                name: locationNames.get(id) ?? id,
                yieldTonnes,
                areaHa,
                tPerHa: tonnesPerHectare(comparable, areaHa),
            };
        });

        return {
            seasonId: season?.id ?? null,
            seasonName: season?.name ?? null,
            year: season?.year ?? null,
            totalAreaHa,
            /** Σ of the HARVESTED area farmers typed — the t/ha denominator. */
            harvestedAreaHa: totalHarvestedAreaHa,
            totalYieldTonnes,
            /** Σ at the 14% standard basis (records with a moisture reading). */
            totalNetTonnesStd,
            /** Gross tonnes from records with NO moisture reading. */
            unadjustedTonnes,
            /** How many of `yieldRecordCount` carry a moisture reading. */
            recordsWithMoisture,
            yieldRecordCount: recordCount,
            avgYieldTPerHa,
            costPerHa,
            topFields,
            activityCount,
        };
    });
}

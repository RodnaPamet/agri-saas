import { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead } from '../policies/common';
import type { PrismaTx } from '@/lib/db-context';

/**
 * Per-activity cost rollup (ENTERPRISE-grain, GRAIN module).
 *
 * Reports COST_METRICS.ATTRIBUTED_CROP_COST — cost tied to a planting, and
 * therefore the only one of the three cost metrics that can carry a
 * per-hectare or per-tonne denominator. See src/lib/grain/cost-metrics.ts
 * for why the product has three and how they differ.
 *
 * Rolls up two cost sources, grouped by planting / field (location) /
 * season:
 *   1. `LogEntry.costAmount` — the field-event cost (Ekylibre intervention
 *      cost concept), for the LogEntries linked to a planting via
 *      `LogPlanting`.
 *   2. `StockTransaction.costAmount` — the per-movement cost of the
 *      COST-BEARING stock transactions linked to those same LogEntries (via
 *      `StockTransaction.logEntryId`). See the movement-type policy below.
 *
 * ─── Movement-type policy ───────────────────────────────────────────
 *
 * Only `CONSUMPTION` counts as crop cost. The rollup used to sum EVERY
 * movement type carrying a `costAmount`, which meant `HARVEST_IN` — a
 * POSITIVE quantity, the grain the farm produced — was added into spend.
 * Output booked as cost is not a rounding error; it moves the total in the
 * wrong direction and grows with a good harvest.
 *
 * Each type, and why:
 *
 *   CONSUMPTION  COUNTS. The moment an input is applied to a crop is the
 *                moment it becomes that crop's cost.
 *   RECEIPT      Does NOT count. Buying stock is working capital, not crop
 *                cost — the spend lands on a crop when the stock is
 *                consumed. Counting both would double-count every input:
 *                once on purchase, again on application. (Receipts also
 *                carry no `logEntryId`, so they never joined here anyway;
 *                the exclusion is explicit so a future receipt that DOES
 *                carry one cannot quietly change the meaning of this total.)
 *   HARVEST_IN   Never. It is output.
 *   SALE_OUT     Never. It is revenue.
 *   TRANSFER     Never. Stock moving between locations costs nothing.
 *   ADJUSTMENT   Never. A correction to a count, not money spent.
 *   DISPOSAL     Not today. Written-off stock is a real loss, but it is a
 *                LOSS rather than a cost of growing this crop, and folding
 *                it in silently would overstate what the crop cost to
 *                produce. If it is wanted it belongs as its own column.
 *
 * N+1 avoidance: every level is resolved in BOUNDED batched queries —
 * gather plantings, gather their LogPlanting→logEntryIds in one query,
 * then ONE `logEntry.findMany({ where: { id: { in } } })` and ONE
 * `stockTransaction.findMany({ where: { logEntryId: { in } } })`. The
 * per-planting / per-field / per-season reduction happens in memory.
 *
 * Currency: a single tenant currency is assumed. When costCurrency varies,
 * the FIRST non-null currency seen is passed through (pragmatic — the
 * magnitudes still sum; a multi-currency tenant should normalise upstream).
 */

/**
 * The movement types that are crop COST. Deliberately a whitelist: a new
 * `StockTransactionType` must be argued into this list rather than silently
 * landing in every farmer's cost total the day it is added.
 */
const COST_BEARING_MOVEMENTS = ['CONSUMPTION'] as const;

/**
 * Cap on the unvalued-consumption read. This query exists to produce a
 * COUNT and a reason split, so a farm with more unvalued movements than
 * this has a data problem the exact number would not change — the
 * message ("your cost is a floor") is already delivered at 5,000.
 */
const UNVALUED_TAKE = 5000;

const LIST_TAKE = 500;
// Bound for the batched id-set queries below — plantings × their log
// entries can fan out, so cap the intermediate reads too.
const BATCH_TAKE = 5000;

function dec(v: Prisma.Decimal | null | undefined): number {
    if (v == null) return 0;
    return typeof v === 'number' ? v : Number(v.toString());
}

export interface PlantingCostRow {
    plantingId: string;
    plantingName: string;
    cropVariety: string | null;
    seasonId: string | null;
    locationId: string | null;
    logEntryCost: number;
    stockCost: number;
    totalCost: number;
    /** Distinct currencies the underlying costs were recorded in. Empty
     *  when nothing carried one. */
    currencies: string[];
    /** True when costs in MORE THAN ONE currency were summed into this
     *  row. The total is then not a meaningful single figure and the UI
     *  must say so rather than print it with one of the labels. */
    currencyMixed: boolean;
    /**
     * CONSUMPTION movements on this planting that could not be valued
     * because the lot carried no `unitCostAmount`. The stock MOVED and
     * the planting is counted — only the money is missing, so `stockCost`
     * above is a floor rather than a total.
     */
    unvaluedNoUnitCost: number;
    /**
     * As above, but the lot's unit disagreed with the product's default
     * unit, so `recordInputApplication` refused to multiply a quantity in
     * one unit by a price in another.
     */
    unvaluedUnitMismatch: number;
}

export interface SeasonCostRow {
    seasonId: string | null;
    seasonName: string | null;
    logEntryCost: number;
    stockCost: number;
    totalCost: number;
    /** Distinct currencies the underlying costs were recorded in. Empty
     *  when nothing carried one. */
    currencies: string[];
    /** True when costs in MORE THAN ONE currency were summed into this
     *  row. The total is then not a meaningful single figure and the UI
     *  must say so rather than print it with one of the labels. */
    currencyMixed: boolean;
    /**
     * Cost ÷ HARVESTED area, in the same tonnes/hectare vocabulary the yield
     * pages use. Null when no yield record for this grouping states an area
     * — a cost with no denominator is not "0 per hectare", it is unknown.
     */
    costPerHa: number | null;
    /**
     * Cost ÷ tonnes produced, at the 14% standard moisture basis where the
     * moisture was measured (see src/lib/grain/moisture.ts). This is the
     * figure that answers "what did a tonne of this grain cost me to grow?".
     */
    costPerTonne: number | null;
    /** Harvested hectares behind `costPerHa`. */
    harvestedAreaHa: number | null;
    /** Tonnes behind `costPerTonne`. */
    producedTonnes: number | null;
    plantingCount: number;
}

export interface FieldCostRow {
    locationId: string | null;
    locationName: string | null;
    logEntryCost: number;
    stockCost: number;
    totalCost: number;
    /** Distinct currencies the underlying costs were recorded in. Empty
     *  when nothing carried one. */
    currencies: string[];
    /** True when costs in MORE THAN ONE currency were summed into this
     *  row. The total is then not a meaningful single figure and the UI
     *  must say so rather than print it with one of the labels. */
    currencyMixed: boolean;
    /**
     * Cost ÷ HARVESTED area, in the same hectares the yield pages use. Null
     * when no yield record for this grouping states an area — a cost with no
     * denominator is not "0 per hectare", it is unknown.
     */
    costPerHa: number | null;
    /**
     * Cost ÷ tonnes produced, at the 14% standard moisture basis where the
     * moisture was measured (src/lib/grain/moisture.ts). The figure that
     * answers "what did a tonne of this grain cost me to grow?".
     */
    costPerTonne: number | null;
    /** Harvested hectares behind `costPerHa`. */
    harvestedAreaHa: number | null;
    /** Tonnes behind `costPerTonne`. */
    producedTonnes: number | null;
    plantingCount: number;
}

/**
 * Collect the distinct currencies a row's costs were recorded in.
 *
 * This replaces a `first non-null wins` pick, which made the LABEL on a
 * summed total depend on row order: 100 BGN + 50 EUR displayed as "150 BGN"
 * or "150 EUR" depending on which row the database happened to return
 * first, and the read had no `orderBy`. Both answers were wrong, and the
 * one shown changed between refreshes.
 *
 * There is no FX table anywhere in this product (verified: no
 * exchangeRate / fxRate / currencyRate concept exists), so amounts in
 * different currencies CANNOT be converted, and a single summed total
 * across them is not a number that means anything. The rollup therefore
 * reports what it saw and lets the caller refuse to present a blended
 * figure — see `currencyMixed`.
 */
function addCurrency(seen: Set<string>, next: string | null | undefined): void {
    if (next) seen.add(next);
}

/**
 * Resolve the per-planting cost rows. Runs entirely inside `db` (the
 * caller's RLS-bound tenant transaction). The heavy lifting all three
 * public rollups share.
 */

/**
 * Cost per unit of something, rounded for money display.
 *
 * Null — not zero — when the denominator is missing or zero. "0 per hectare"
 * would read as a free crop; "unknown" is the truth when nobody recorded the
 * area. Mirrors the zero-guard in `tonnesPerHectare`, which is the canonical
 * t/ha definition this page deliberately reuses rather than inventing a
 * third one.
 */
function per(cost: number, denominator: number | null): number | null {
    if (denominator == null || !(denominator > 0)) return null;
    return Math.round((cost / denominator) * 100) / 100;
}

/**
 * Harvested area + comparable tonnage per season and per field.
 *
 * ONE aggregate per grouping — the yield register already holds `areaHa`
 * and the standard-moisture tonnage, keyed by the SAME season / location
 * ids the cost rollup groups by, so a denominator needs no new plumbing.
 * `netTonnesStd` is preferred over `grossTonnes` because two harvests
 * measured at different moistures are not the same quantity of grain; gross
 * fills in where moisture was never measured.
 */
async function loadYieldDenominators(db: PrismaTx, ctx: RequestContext) {
    const [bySeason, byLocation] = await Promise.all([
        db.yieldRecord.groupBy({
            by: ['seasonId'],
            where: { tenantId: ctx.tenantId, deletedAt: null },
            _sum: { areaHa: true, netTonnesStd: true, grossTonnes: true },
        }),
        db.yieldRecord.groupBy({
            by: ['locationId'],
            where: { tenantId: ctx.tenantId, deletedAt: null },
            _sum: { areaHa: true, netTonnesStd: true, grossTonnes: true },
        }),
    ]);
    const shape = (rows: Array<{ _sum: { areaHa: unknown; netTonnesStd: unknown; grossTonnes: unknown } }>, key: 'seasonId' | 'locationId') => {
        const map = new Map<string, { areaHa: number; tonnes: number }>();
        for (const r of rows as Array<Record<string, unknown> & { _sum: Record<string, unknown> }>) {
            const id = r[key];
            if (typeof id !== 'string') continue;
            const net = dec(r._sum.netTonnesStd as Prisma.Decimal | null);
            const gross = dec(r._sum.grossTonnes as Prisma.Decimal | null);
            map.set(id, { areaHa: dec(r._sum.areaHa as Prisma.Decimal | null), tonnes: net > 0 ? net : gross });
        }
        return map;
    };
    return {
        bySeason: shape(bySeason, 'seasonId'),
        byLocation: shape(byLocation, 'locationId'),
    };
}

async function computePlantingCostRows(
    db: PrismaTx,
    ctx: RequestContext,
    filters: { seasonId?: string } = {},
    take = LIST_TAKE,
): Promise<{
    rows: PlantingCostRow[];
    truncated: boolean;
    /** DISTINCT unvalued-consumption counts — see the accumulation below
     *  for why this is not the sum of the rows' own counts. */
    unvalued: { noUnitCost: number; unitMismatch: number };
}> {
    const plantings = await db.planting.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            ...(filters.seasonId ? { cropPlan: { is: { seasonId: filters.seasonId } } } : {}),
        },
        // `createdAt` alone is not a total order — ties resolve
        // arbitrarily, so a capped read could return different plantings
        // (and therefore a different total) for identical requests. `id`
        // breaks the tie.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
            id: true,
            successionNumber: true,
            locationId: true,
            variety: { select: { name: true } },
            cropPlan: { select: { seasonId: true, name: true } },
        },
        // One extra row is the cheapest way to KNOW the cap bit rather than
        // infer it from a full page (which is ambiguous at exactly `take`).
        take: take + 1,
    });
    // Slice rather than mutate: the read result is not ours to shorten in
    // place, and a caller holding the same array would see it change under
    // them (which is exactly how the propagation test caught this).
    const plantingsTruncated = plantings.length > take;
    const plantingPage = plantingsTruncated ? plantings.slice(0, take) : plantings;
    if (plantingPage.length === 0)
        return { rows: [], truncated: false, unvalued: { noUnitCost: 0, unitMismatch: 0 } };

    const plantingIds = plantingPage.map((p) => p.id);

    // ── ONE query: every LogPlanting link for these plantings ──
    //
    // Deterministic order so a capped read returns the SAME subset every
    // time. Without it, an over-cap tenant saw a different total on each
    // refresh of the same page — the worst failure mode a money figure has,
    // because it looks like activity rather than a bug.
    const logLinks = await db.logPlanting.findMany({
        where: { tenantId: ctx.tenantId, plantingId: { in: plantingIds } },
        select: { plantingId: true, logEntryId: true },
        orderBy: [{ logEntryId: 'asc' }, { plantingId: 'asc' }],
        take: BATCH_TAKE + 1,
    });
    const linksTruncated = logLinks.length > BATCH_TAKE;
    const linkPage = linksTruncated ? logLinks.slice(0, BATCH_TAKE) : logLinks;

    // ── Attribution policy: SPLIT EVENLY across the plantings covered ──
    //
    // `LogPlanting` is many-per-entry (@@unique([logEntryId, plantingId,
    // stage])), and the old code collapsed it into a last-write-wins
    // `Map<logEntryId, plantingId>`. A spray covering three plantings
    // therefore dumped its ENTIRE cost onto whichever one the database
    // happened to return last — over a read with no `orderBy`, so the row
    // that carried the cost changed between refreshes. The code comment
    // ("a log entry realises one planting stage") asserted the opposite of
    // what the schema allows.
    //
    // An even split is the honest default: the entry covered N plantings and
    // nothing in the data says how the work divided between them. A
    // pro-rata split by area was considered and rejected — planting area is
    // frequently null, so it would silently fall back to an even split for
    // exactly the farms whose fields differ most, which is worse than being
    // predictably even everywhere.
    //
    // Distinct plantings per entry: the same planting linked at two STAGES
    // is one planting, not two shares.
    const plantingsByEntry = new Map<string, Set<string>>();
    for (const link of linkPage) {
        let set = plantingsByEntry.get(link.logEntryId);
        if (!set) {
            set = new Set<string>();
            plantingsByEntry.set(link.logEntryId, set);
        }
        set.add(link.plantingId);
    }
    const logEntryIds = [...plantingsByEntry.keys()];

    // ── The LogEntry cost for those entries (live rows only) ──
    const logEntries = logEntryIds.length
        ? await db.logEntry.findMany({
              where: { tenantId: ctx.tenantId, id: { in: logEntryIds }, deletedAt: null },
              select: { id: true, costAmount: true, costCurrency: true },
              // guardrail-allow: unbounded — bounded by logEntryIds, which is
              // itself capped above. A `take` here would silently drop cost
              // from a total instead of reporting the cap.
          })
        : [];

    // Soft-deleted entries must take their stock cost with them. The stock
    // query previously reused the UNFILTERED id set, so a deleted journal
    // entry kept contributing its consumption cost forever — invisible while
    // consumption was unvalued, a live money bug the moment it is valued.
    const liveLogEntryIds = logEntries.map((e) => e.id);

    // ── The StockTransaction cost linked to those live entries ──
    //
    // Aggregated in-DB per entry: nothing to truncate, and the sum is the
    // database's rather than a page of rows we happened to read.
    const stockTxGroups = liveLogEntryIds.length
        ? await db.stockTransaction.groupBy({
              by: ['logEntryId'],
              where: {
                  tenantId: ctx.tenantId,
                  logEntryId: { in: liveLogEntryIds },
                  type: { in: [...COST_BEARING_MOVEMENTS] },
              },
              _sum: { costAmount: true },
          })
        : [];

    // Currency is per-movement, so it cannot ride on a _sum. One extra
    // bounded read, distinct on the currencies actually present.
    const stockCurrencies = liveLogEntryIds.length
        ? await db.stockTransaction.findMany({
              where: {
                  tenantId: ctx.tenantId,
                  logEntryId: { in: liveLogEntryIds },
                  type: { in: [...COST_BEARING_MOVEMENTS] },
                  costCurrency: { not: null },
              },
              select: { logEntryId: true, costCurrency: true },
              distinct: ['logEntryId', 'costCurrency'],
              // guardrail-allow: unbounded — one row per (entry, currency),
              // and a tenant has a handful of currencies at most.
          })
        : [];

    // ── Consumptions the valuation could not price ──
    //
    // `recordInputApplication` writes `costAmount: null` when it DECLINES
    // to value a draw-down — the lot carried no `unitCostAmount`, or the
    // lot's unit differs from the product's default unit (multiplying a
    // quantity in one unit by a price in another is nonsense, and "a
    // missing cost is recoverable; a wrong one is a number somebody
    // budgets against"). It logs a warning nobody reads and moves on.
    //
    // Neither case is visible in the `_sum` above: null contributes 0, so
    // an input that was genuinely consumed reports as a FREE one. The
    // understatement flows into ATTRIBUTED_CROP_COST, into
    // GRAIN_NET_WORTH's cashCostTotal, and therefore pushes the
    // calculator's headline net worth UP.
    //
    // The reason is DERIVED here rather than persisted at write time,
    // because a stored reason could never be backfilled: every
    // consumption posted a null cost until the valuation landed, so the
    // rows that most need explaining are exactly the historical ones.
    // Ordered and cap-probed like every other capped read in this function
    // — see the LogPlanting read above. A `take` without an `orderBy` hands
    // back an ARBITRARY subset, and Postgres is free to pick a different
    // one after any VACUUM or plan change, so the reason split and the
    // per-commodity caveats would move between two loads of the same URL.
    // Reading one past the cap is how the other reads detect overflow, and
    // the overflow has to reach `truncated`: a capped count presented as
    // exact is the same lie as a capped total presented as complete.
    const unvaluedPage = liveLogEntryIds.length
        ? await db.stockTransaction.findMany({
              where: {
                  tenantId: ctx.tenantId,
                  logEntryId: { in: liveLogEntryIds },
                  type: { in: [...COST_BEARING_MOVEMENTS] },
                  costAmount: null,
              },
              select: {
                  id: true,
                  logEntryId: true,
                  lot: {
                      select: {
                          unitCostAmount: true,
                          unitId: true,
                          item: { select: { defaultUnitId: true } },
                      },
                  },
              },
              // `id` is a cuid — unique, so a total order on its own.
              orderBy: [{ id: 'asc' }],
              take: UNVALUED_TAKE + 1,
          })
        : [];
    const unvaluedTruncated = unvaluedPage.length > UNVALUED_TAKE;
    const unvaluedTx = unvaluedPage.slice(0, UNVALUED_TAKE);

    // Classification mirrors `recordInputApplication` — price first, units
    // only when a price exists — so the two cannot drift and one
    // transaction can never land in both buckets.
    //
    // The third arm is load-bearing, not defensive padding. `null` means
    // "a priced lot whose units DO agree", which is not an outcome
    // `recordInputApplication` can produce: it would have valued that
    // draw-down. So the row was written by something else — `grain-blend`
    // posts CONSUMPTION with no cost at all, and a seed or an import could
    // too. Those are excluded today only because they carry no
    // `logEntryId` and the query above filters on one; an ELSE-branch
    // fallback would have labelled any that ever did as a unit mismatch,
    // inventing a unit problem on a farm that has none. Naming the
    // condition instead of assuming the complement keeps the reason split
    // true no matter who writes the row.
    const reasonOf = (
        tx: (typeof unvaluedTx)[number],
    ): 'noUnitCost' | 'unitMismatch' | null => {
        if (tx.lot?.unitCostAmount == null) return 'noUnitCost';
        if (tx.lot.unitId !== tx.lot.item?.defaultUnitId) return 'unitMismatch';
        return null;
    };

    // Accumulate per planting.
    const acc = new Map<
        string,
        {
            logCost: number;
            stockCost: number;
            currencies: Set<string>;
            unvaluedNoUnitCost: number;
            unvaluedUnitMismatch: number;
        }
    >();
    const ensure = (pid: string) => {
        let row = acc.get(pid);
        if (!row) {
            row = {
                logCost: 0,
                stockCost: 0,
                currencies: new Set<string>(),
                unvaluedNoUnitCost: 0,
                unvaluedUnitMismatch: 0,
            };
            acc.set(pid, row);
        }
        return row;
    };
    for (const entry of logEntries) {
        const targets = plantingsByEntry.get(entry.id);
        if (!targets?.size) continue;
        const share = dec(entry.costAmount) / targets.size;
        for (const pid of targets) {
            const row = ensure(pid);
            row.logCost += share;
            addCurrency(row.currencies, entry.costCurrency);
        }
    }
    for (const g of stockTxGroups) {
        const targets = g.logEntryId ? plantingsByEntry.get(g.logEntryId) : undefined;
        if (!targets?.size) continue;
        const share = dec(g._sum.costAmount) / targets.size;
        for (const pid of targets) ensure(pid).stockCost += share;
    }
    for (const c of stockCurrencies) {
        const targets = c.logEntryId ? plantingsByEntry.get(c.logEntryId) : undefined;
        if (!targets?.size) continue;
        for (const pid of targets) addCurrency(ensure(pid).currencies, c.costCurrency);
    }
    // Counting rule — deliberately NOT the fractional `share` used for
    // money above. A count cannot be split: when one transaction hangs off
    // an entry touching two plantings, "this planting has an unvalued
    // consumption" is true of BOTH, so each row gets a whole 1. The
    // report-level figure below counts TRANSACTIONS instead, so it stays 1.
    // The two therefore disagree by design, and a test says so.
    for (const tx of unvaluedTx) {
        const targets = tx.logEntryId ? plantingsByEntry.get(tx.logEntryId) : undefined;
        if (!targets?.size) continue;
        const reason = reasonOf(tx);
        if (reason == null) continue; // not an application-time refusal
        for (const pid of targets) {
            const row = ensure(pid);
            if (reason === 'noUnitCost') row.unvaluedNoUnitCost += 1;
            else row.unvaluedUnitMismatch += 1;
        }
    }

    // DISTINCT transaction counts. Summing the per-planting counts would
    // multiply a shared transaction by the number of plantings it touches.
    // Only transactions that actually reached a planting are counted — an
    // orphaned one changes no figure on any surface.
    const attributedUnvalued = unvaluedTx.filter(
        (tx) => tx.logEntryId && plantingsByEntry.get(tx.logEntryId)?.size,
    );
    const unvalued = {
        noUnitCost: attributedUnvalued.filter((tx) => reasonOf(tx) === 'noUnitCost').length,
        unitMismatch: attributedUnvalued.filter((tx) => reasonOf(tx) === 'unitMismatch').length,
    };

    const rows = plantingPage.map((p): PlantingCostRow => {
        const row = acc.get(p.id) ?? {
            logCost: 0,
            stockCost: 0,
            currencies: new Set<string>(),
            unvaluedNoUnitCost: 0,
            unvaluedUnitMismatch: 0,
        };
        const logEntryCost = Math.round(row.logCost * 100) / 100;
        const stockCost = Math.round(row.stockCost * 100) / 100;
        return {
            plantingId: p.id,
            // No hardcoded English fallback: "Planting #3" rendered
            // untranslated for a Bulgarian farmer. A planting whose crop
            // plan has no name is identified by its succession number, and
            // the UI supplies the localised noun.
            plantingName: p.cropPlan?.name
                ? `${p.cropPlan.name} #${p.successionNumber}`
                : `#${p.successionNumber}`,
            cropVariety: p.variety?.name ?? null,
            seasonId: p.cropPlan?.seasonId ?? null,
            locationId: p.locationId,
            logEntryCost,
            stockCost,
            totalCost: Math.round((logEntryCost + stockCost) * 100) / 100,
            currencies: [...row.currencies].sort(),
            currencyMixed: row.currencies.size > 1,
            unvaluedNoUnitCost: row.unvaluedNoUnitCost,
            unvaluedUnitMismatch: row.unvaluedUnitMismatch,
        };
    });

    // ANY of the three caps means the figures below cover only part of the
    // farm. The callers surface this; none of them may present a partial
    // total as a complete one — and that now includes the unvalued COUNTS,
    // which a reader takes for exact every bit as readily as a money
    // figure. (Phrasing note: the obvious comparative wording here would
    // spell the explicit-any cast token, which the hygiene ratchet greps
    // for in raw source and cannot tell from prose.)
    return {
        rows,
        truncated: plantingsTruncated || linksTruncated || unvaluedTruncated,
        unvalued,
    };
}

export async function getCostRollupByPlanting(
    ctx: RequestContext,
    opts: { seasonId?: string; take?: number } = {},
): Promise<{
    rows: PlantingCostRow[];
    truncated: boolean;
    /**
     * DISTINCT counts of CONSUMPTION movements that could not be valued,
     * split by cause. NOT the sum of the per-row counts — one transaction
     * attributed to two plantings is 1 here and 1 on each row.
     */
    unvalued: { noUnitCost: number; unitMismatch: number };
}> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        computePlantingCostRows(db, ctx, { seasonId: opts.seasonId }, opts.take ?? LIST_TAKE),
    );
}

export async function getCostRollupBySeason(
    ctx: RequestContext,
    opts: { seasonId?: string; take?: number } = {},
): Promise<{ rows: SeasonCostRow[]; truncated: boolean }> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        // ?seasonId now narrows EVERY dimension. It used to be accepted and
        // silently ignored here, so a filtered link showed unfiltered totals.
        const { rows, truncated } = await computePlantingCostRows(
            db,
            ctx,
            { seasonId: opts.seasonId },
            opts.take ?? LIST_TAKE,
        );

        const bySeason = new Map<string, SeasonCostRow>();
        for (const r of rows) {
            const key = r.seasonId ?? '__none__';
            let agg = bySeason.get(key);
            if (!agg) {
                agg = {
                    seasonId: r.seasonId,
                    seasonName: null,
                    logEntryCost: 0,
                    stockCost: 0,
                    totalCost: 0,
                    currencies: [],
                    currencyMixed: false,
                    costPerHa: null,
                    costPerTonne: null,
                    harvestedAreaHa: null,
                    producedTonnes: null,
                    plantingCount: 0,
                };
                bySeason.set(key, agg);
            }
            agg.logEntryCost = Math.round((agg.logEntryCost + r.logEntryCost) * 100) / 100;
            agg.stockCost = Math.round((agg.stockCost + r.stockCost) * 100) / 100;
            agg.totalCost = Math.round((agg.totalCost + r.totalCost) * 100) / 100;
            // Union, not first-wins: a season that mixes currencies must
            // report BOTH, so the UI can refuse to print one blended total.
            agg.currencies = [...new Set([...agg.currencies, ...r.currencies])].sort();
            agg.currencyMixed = agg.currencyMixed || r.currencyMixed || agg.currencies.length > 1;
            agg.plantingCount += 1;
        }

        // Resolve season names in ONE query (no N+1).
        const seasonIds = [...bySeason.values()].map((s) => s.seasonId).filter((id): id is string => !!id);
        if (seasonIds.length) {
            const seasons = await db.season.findMany({
                where: { tenantId: ctx.tenantId, id: { in: seasonIds } },
                select: { id: true, name: true },
                // guardrail-allow: unbounded — bounded by the id set above,
                // which is already capped. A second cap here silently
                // dropped NAMES, so a real field past row 500 rendered as
                // "unassigned" — which reads as a data-entry problem rather
                // than a display limit.
            });
            const names = new Map(seasons.map((s) => [s.id, s.name]));
            for (const agg of bySeason.values()) {
                if (agg.seasonId) agg.seasonName = names.get(agg.seasonId) ?? null;
            }
        }
        // Denominators last: cost ÷ area and cost ÷ tonnes only mean
        // anything once the costs for the grouping are complete.
        const denominators = await loadYieldDenominators(db, ctx);
        for (const row of bySeason.values()) {
            const d = row.seasonId ? denominators.bySeason.get(row.seasonId) : undefined;
            row.harvestedAreaHa = d?.areaHa ?? null;
            row.producedTonnes = d?.tonnes ?? null;
            // A blended-currency total is not a number, so it must not
            // become a per-hectare number either.
            row.costPerHa = row.currencyMixed ? null : per(row.totalCost, d?.areaHa ?? null);
            row.costPerTonne = row.currencyMixed ? null : per(row.totalCost, d?.tonnes ?? null);
        }

        return { rows: [...bySeason.values()], truncated };
    });
}

export async function getCostRollupByField(
    ctx: RequestContext,
    opts: { seasonId?: string; take?: number } = {},
): Promise<{ rows: FieldCostRow[]; truncated: boolean }> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        // ?seasonId now narrows EVERY dimension. It used to be accepted and
        // silently ignored here, so a filtered link showed unfiltered totals.
        const { rows, truncated } = await computePlantingCostRows(
            db,
            ctx,
            { seasonId: opts.seasonId },
            opts.take ?? LIST_TAKE,
        );

        const byField = new Map<string, FieldCostRow>();
        for (const r of rows) {
            const key = r.locationId ?? '__none__';
            let agg = byField.get(key);
            if (!agg) {
                agg = {
                    locationId: r.locationId,
                    locationName: null,
                    logEntryCost: 0,
                    stockCost: 0,
                    totalCost: 0,
                    currencies: [],
                    currencyMixed: false,
                    plantingCount: 0,
                    costPerHa: null,
                    costPerTonne: null,
                    harvestedAreaHa: null,
                    producedTonnes: null,
                };
                byField.set(key, agg);
            }
            agg.logEntryCost = Math.round((agg.logEntryCost + r.logEntryCost) * 100) / 100;
            agg.stockCost = Math.round((agg.stockCost + r.stockCost) * 100) / 100;
            agg.totalCost = Math.round((agg.totalCost + r.totalCost) * 100) / 100;
            // Union, not first-wins: a season that mixes currencies must
            // report BOTH, so the UI can refuse to print one blended total.
            agg.currencies = [...new Set([...agg.currencies, ...r.currencies])].sort();
            agg.currencyMixed = agg.currencyMixed || r.currencyMixed || agg.currencies.length > 1;
            agg.plantingCount += 1;
        }

        // Resolve field (location) names in ONE query.
        const locationIds = [...byField.values()].map((f) => f.locationId).filter((id): id is string => !!id);
        if (locationIds.length) {
            const locations = await db.location.findMany({
                where: { tenantId: ctx.tenantId, id: { in: locationIds } },
                select: { id: true, name: true },
                // guardrail-allow: unbounded — bounded by the id set above,
                // which is already capped. A second cap here silently
                // dropped NAMES, so a real field past row 500 rendered as
                // "unassigned" — which reads as a data-entry problem rather
                // than a display limit.
            });
            const names = new Map(locations.map((l) => [l.id, l.name]));
            for (const agg of byField.values()) {
                if (agg.locationId) agg.locationName = names.get(agg.locationId) ?? null;
            }
        }
        const denominators = await loadYieldDenominators(db, ctx);
        for (const row of byField.values()) {
            const d = row.locationId ? denominators.byLocation.get(row.locationId) : undefined;
            row.harvestedAreaHa = d?.areaHa ?? null;
            row.producedTonnes = d?.tonnes ?? null;
            row.costPerHa = row.currencyMixed ? null : per(row.totalCost, d?.areaHa ?? null);
            row.costPerTonne = row.currencyMixed ? null : per(row.totalCost, d?.tonnes ?? null);
        }

        return { rows: [...byField.values()], truncated };
    });
}

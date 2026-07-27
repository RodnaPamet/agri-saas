import { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead } from '../policies/common';
import type { PrismaTx } from '@/lib/db-context';

/**
 * Per-activity cost rollup (ENTERPRISE-grain, GRAIN module).
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
    currency: string | null;
}

export interface SeasonCostRow {
    seasonId: string | null;
    seasonName: string | null;
    logEntryCost: number;
    stockCost: number;
    totalCost: number;
    currency: string | null;
    plantingCount: number;
}

export interface FieldCostRow {
    locationId: string | null;
    locationName: string | null;
    logEntryCost: number;
    stockCost: number;
    totalCost: number;
    currency: string | null;
    plantingCount: number;
}

/** Pick the first non-null currency, preferring an existing value. */
function pickCurrency(current: string | null, next: string | null): string | null {
    return current ?? next ?? null;
}

/**
 * Resolve the per-planting cost rows. Runs entirely inside `db` (the
 * caller's RLS-bound tenant transaction). The heavy lifting all three
 * public rollups share.
 */
async function computePlantingCostRows(
    db: PrismaTx,
    ctx: RequestContext,
    filters: { seasonId?: string } = {},
    take = LIST_TAKE,
): Promise<{ rows: PlantingCostRow[]; truncated: boolean }> {
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
    if (plantingPage.length === 0) return { rows: [], truncated: false };

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

    // logEntryId → plantingId. NOTE: LogPlanting is many-per-entry
    // (@@unique([logEntryId, plantingId, stage])), so this Map is
    // last-write-wins and a spray covering several plantings lands wholly on
    // one of them. The read above is now deterministically ordered, so the
    // choice is at least STABLE between requests; making it correct is a
    // separate change (attribution policy) rather than something to bury
    // here.
    const logEntryToPlanting = new Map<string, string>();
    for (const link of linkPage) logEntryToPlanting.set(link.logEntryId, link.plantingId);
    const logEntryIds = [...logEntryToPlanting.keys()];

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

    // Accumulate per planting.
    const acc = new Map<string, { logCost: number; stockCost: number; currency: string | null }>();
    const ensure = (pid: string) => {
        let row = acc.get(pid);
        if (!row) {
            row = { logCost: 0, stockCost: 0, currency: null };
            acc.set(pid, row);
        }
        return row;
    };
    for (const entry of logEntries) {
        const pid = logEntryToPlanting.get(entry.id);
        if (!pid) continue;
        const row = ensure(pid);
        row.logCost += dec(entry.costAmount);
        row.currency = pickCurrency(row.currency, entry.costCurrency);
    }
    for (const g of stockTxGroups) {
        const pid = g.logEntryId ? logEntryToPlanting.get(g.logEntryId) : undefined;
        if (!pid) continue;
        ensure(pid).stockCost += dec(g._sum.costAmount);
    }
    for (const c of stockCurrencies) {
        const pid = c.logEntryId ? logEntryToPlanting.get(c.logEntryId) : undefined;
        if (!pid) continue;
        const row = ensure(pid);
        row.currency = pickCurrency(row.currency, c.costCurrency);
    }

    const rows = plantingPage.map((p): PlantingCostRow => {
        const row = acc.get(p.id) ?? { logCost: 0, stockCost: 0, currency: null };
        const logEntryCost = Math.round(row.logCost * 100) / 100;
        const stockCost = Math.round(row.stockCost * 100) / 100;
        return {
            plantingId: p.id,
            plantingName: `${p.cropPlan?.name ?? 'Planting'} #${p.successionNumber}`,
            cropVariety: p.variety?.name ?? null,
            seasonId: p.cropPlan?.seasonId ?? null,
            locationId: p.locationId,
            logEntryCost,
            stockCost,
            totalCost: Math.round((logEntryCost + stockCost) * 100) / 100,
            currency: row.currency,
        };
    });

    // Either cap means the figures below cover only part of the farm. The
    // callers surface this; none of them may present a partial total as a
    // complete one.
    return { rows, truncated: plantingsTruncated || linksTruncated };
}

export async function getCostRollupByPlanting(
    ctx: RequestContext,
    opts: { seasonId?: string; take?: number } = {},
): Promise<{ rows: PlantingCostRow[]; truncated: boolean }> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        computePlantingCostRows(db, ctx, { seasonId: opts.seasonId }, opts.take ?? LIST_TAKE),
    );
}

export async function getCostRollupBySeason(
    ctx: RequestContext,
    opts: { take?: number } = {},
): Promise<{ rows: SeasonCostRow[]; truncated: boolean }> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { rows, truncated } = await computePlantingCostRows(db, ctx, {}, opts.take ?? LIST_TAKE);

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
                    currency: null,
                    plantingCount: 0,
                };
                bySeason.set(key, agg);
            }
            agg.logEntryCost = Math.round((agg.logEntryCost + r.logEntryCost) * 100) / 100;
            agg.stockCost = Math.round((agg.stockCost + r.stockCost) * 100) / 100;
            agg.totalCost = Math.round((agg.totalCost + r.totalCost) * 100) / 100;
            agg.currency = pickCurrency(agg.currency, r.currency);
            agg.plantingCount += 1;
        }

        // Resolve season names in ONE query (no N+1).
        const seasonIds = [...bySeason.values()].map((s) => s.seasonId).filter((id): id is string => !!id);
        if (seasonIds.length) {
            const seasons = await db.season.findMany({
                where: { tenantId: ctx.tenantId, id: { in: seasonIds } },
                select: { id: true, name: true },
                take: LIST_TAKE,
            });
            const names = new Map(seasons.map((s) => [s.id, s.name]));
            for (const agg of bySeason.values()) {
                if (agg.seasonId) agg.seasonName = names.get(agg.seasonId) ?? null;
            }
        }
        return { rows: [...bySeason.values()], truncated };
    });
}

export async function getCostRollupByField(
    ctx: RequestContext,
    opts: { take?: number } = {},
): Promise<{ rows: FieldCostRow[]; truncated: boolean }> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { rows, truncated } = await computePlantingCostRows(db, ctx, {}, opts.take ?? LIST_TAKE);

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
                    currency: null,
                    plantingCount: 0,
                };
                byField.set(key, agg);
            }
            agg.logEntryCost = Math.round((agg.logEntryCost + r.logEntryCost) * 100) / 100;
            agg.stockCost = Math.round((agg.stockCost + r.stockCost) * 100) / 100;
            agg.totalCost = Math.round((agg.totalCost + r.totalCost) * 100) / 100;
            agg.currency = pickCurrency(agg.currency, r.currency);
            agg.plantingCount += 1;
        }

        // Resolve field (location) names in ONE query.
        const locationIds = [...byField.values()].map((f) => f.locationId).filter((id): id is string => !!id);
        if (locationIds.length) {
            const locations = await db.location.findMany({
                where: { tenantId: ctx.tenantId, id: { in: locationIds } },
                select: { id: true, name: true },
                take: LIST_TAKE,
            });
            const names = new Map(locations.map((l) => [l.id, l.name]));
            for (const agg of byField.values()) {
                if (agg.locationId) agg.locationName = names.get(agg.locationId) ?? null;
            }
        }
        return { rows: [...byField.values()], truncated };
    });
}

/**
 * A superuser's daily price override (#1587), built to the contract recorded on
 * that issue — v1 / v1.1 / v1.2 plus the 12:26 clarification.
 *
 * Owner ruling 2026-10-10: a typed price ALWAYS wins over the API, on every
 * surface and for every farm, until a superuser clears it. A manual override,
 * not a stale-only fallback — chosen over "API unless missing or stale" and over
 * "newest wins".
 *
 * ## Why a module of its own, beside `market-manual-prices.ts`
 *
 * They share a write shape and nothing else. `'manual'` FILLS A GAP — no free
 * feed publishes MAP at all and the Pink Sheet carries neither MAP nor ammonium
 * nitrate — so it has no feed to outrank and it is entered one series at a time
 * with a history the admin has in front of them. `'platform'` OVERRIDES A LIVE
 * feed for every tenant, is entered a DAY at a time across up to ten
 * commodities, and must be all-or-nothing.
 *
 * The first implementation of this (#1618 at `806fe8e`) folded it into the
 * manual path and inherited that path's wire shape. agrent-ios caught six
 * divergences from the recorded contract; the serious one is in §3 below.
 *
 * ## The denomination is OURS, never the caller's (contract §5(d))
 *
 * `unit` and `currency` are derived from `price-override-denominations.ts` per
 * commodity and are not accepted from a client. The first version took them from
 * the request body, guarded only by a lookup against an existing series — so the
 * denomination was chosen by the first write after creation AND again after every
 * clear, and one caller sending `unit: 'EUR/t'` for diesel would have minted an
 * EUR/t diesel override that wins for every farm. Diesel is ~1.95 EUR/l against
 * ~1950 EUR/t.
 *
 * ## Idempotency comes from the UPSERT, not from `clientMutationId`
 *
 * A deviation from the contract's mechanism, flagged on the issue rather than
 * discovered. §5(d) says dedupe "reuses the existing `(tenantId,
 * clientMutationId)` convention" — but `MarketPriceSeries` and
 * `MarketPricePoint` are GLOBAL tables with no `tenantId` and no
 * `clientMutationId` column, so that convention is not available here.
 *
 * It is also not needed. A cost sheet ACCUMULATES — each create adds a row, so a
 * retry books the day twice — which is why #1524 needed a key. A price day
 * UPSERTS on `(seriesId, date)`, so re-sending the same day produces the
 * identical state and the same `written`. The client's actual requirement ("a
 * retried submission over a bad link does not book a second day") is met by
 * construction.
 *
 * The key is still accepted, in the body and as `Idempotency-Key`, and is
 * recorded on the audit row so a replay is traceable. What it is NOT is the
 * thing preventing a double write.
 *
 * @module app-layer/usecases/market-price-overrides
 */
import { Prisma } from '@prisma/client';
import type { RequestContext } from '../types';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { codedBadRequest, internal } from '@/lib/errors/types';
import { commodityMeta, type CommodityFeed } from '@/lib/market/commodity-vocabulary';
import {
    OVERRIDE_COMMODITIES,
    OVERRIDE_ENTRY,
    resolveOverrideCommodity,
    type OverrideCommodity,
} from '@/lib/market/price-override-denominations';

/** The source value a platform override is published under. */
export const PLATFORM_OVERRIDE_SOURCE = 'platform';

/** Region every override is written for — contract §5. */
const OVERRIDE_REGION = 'BG';

/**
 * How many typed points a cleared run contributes to its audit row.
 *
 * A daily override left running for two years is ~730 points, and an unbounded
 * JSON column on an append-only audit table is a slow way to make a table
 * unreadable. When it truncates it SAYS so, rather than presenting a prefix as
 * the whole history.
 */
const AUDIT_POINT_CAP = 400;

export interface OverrideDayInput {
    /** The observation day every price in this request is for. */
    date: Date;
    prices: { commodity: string; value: number }[];
    clientMutationId?: string | null;
}

export interface OverrideDayResult {
    /** Points written. Equal to `prices.length` on success, by construction. */
    written: number;
    series: {
        commodity: OverrideCommodity;
        seriesId: string;
        unit: string;
        currency: string;
    }[];
}

export interface ClearOverrideResult {
    commodity: OverrideCommodity;
    /** False when there was no live override — a 200, not an error. */
    cleared: boolean;
    /** Points withdrawn from publication. They are NOT deleted. */
    pointsWithdrawn: number;
}

/** One row of the admin form read — contract v1.2 §5(c). */
export interface OverrideFormRow {
    commodity: OverrideCommodity;
    /** What to TYPE in, so a client holds no copy of the §3 table. */
    entryUnit: string;
    entryCurrency: string;
    typed: { value: number; currency: string; unit: string; date: string } | null;
    api: { value: number; currency: string; unit: string; date: string; source: string } | null;
    apiFeed: CommodityFeed;
}

function refuseCommodity(raw: string): never {
    // Two different things to fix, so two codes rather than one. "Not a
    // commodity" means a typo; "not overridable" means the owner has not opened
    // that commodity to overrides, and widening the list is a decision rather
    // than a retry.
    const known = commodityMeta(raw) != null;
    throw codedBadRequest(
        known ? 'COMMODITY_NOT_OVERRIDABLE' : 'UNKNOWN_COMMODITY',
        known
            ? 'That commodity is not one this platform sets a price for.'
            : 'That is not a commodity this platform prices.',
        { commodity: raw },
    );
}

/**
 * Write one DAY's prices, all or nothing (contract §5(d)).
 *
 * One transaction: `runInTenantContext` opens one, so a refusal on the tenth
 * commodity rolls back the first nine. A day that half-commits is worse than one
 * that failed, because the superuser cannot tell which prices are live — and
 * these prices move every farm's calculator.
 */
export async function upsertOverrideDay(
    ctx: RequestContext,
    input: OverrideDayInput,
): Promise<OverrideDayResult> {
    assertPlatformSupport(ctx);

    // Resolved BEFORE the transaction opens. Every refusal below is about the
    // payload rather than about stored state, so there is nothing to roll back
    // and no reason to hold a transaction open while deciding.
    const resolved = input.prices.map((p) => {
        const r = resolveOverrideCommodity(p.commodity);
        if (!r) refuseCommodity(p.commodity);
        return { ...r, value: p.value };
    });

    // A commodity twice in one day is a typo, not two observations. The feeds
    // average genuine duplicates; averaging a typo produces a number nobody
    // entered, and taking the last silently discards the first.
    const seen = new Set<string>();
    for (const r of resolved) {
        if (seen.has(r.commodity)) {
            throw codedBadRequest(
                'DUPLICATE_COMMODITY',
                'That commodity appears twice in one day.',
                { commodity: r.commodity },
            );
        }
        seen.add(r.commodity);
    }

    return runInTenantContext(ctx, async (db) => {
        const series: OverrideDayResult['series'] = [];

        for (const r of resolved) {
            const { unit, currency } = r.entry;

            // The six-column natural key, with OUR denomination in it. A series
            // per (source, commodity, region, stage, currency, unit).
            // Any LIVE override for this commodity, in ANY denomination. The
            // denomination is server-derived and therefore stable, so normally
            // this is either nothing or the series we are about to append to.
            //
            // It is not guaranteed stable forever: if `OVERRIDE_ENTRY` ever
            // changes — the owner moving diesel to EUR/t, say — the new key
            // would mint a SECOND series while the old one stayed live, and two
            // live overrides for one commodity is an ambiguity no consumer can
            // resolve. Refusing names the fix; silently minting would leave the
            // old figure winning on whichever surface happened to pick it.
            const liveAny = await db.marketPriceSeries.findMany({
                where: {
                    source: PLATFORM_OVERRIDE_SOURCE,
                    commodity: r.commodity,
                    clearedAt: null,
                },
                select: { id: true, unit: true, currency: true },
            });
            const wrongDenomination = liveAny.find(
                (sx) => sx.unit !== unit || sx.currency !== currency,
            );
            if (wrongDenomination) {
                throw codedBadRequest(
                    'OVERRIDE_DENOMINATION_CHANGED',
                    'A live override for that commodity is recorded in a different denomination. Clear it before typing a new one.',
                    {
                        commodity: r.commodity,
                        stored: `${wrongDenomination.currency} ${wrongDenomination.unit}`,
                        expected: `${currency} ${unit}`,
                    },
                );
            }

            const existing = await db.marketPriceSeries.findFirst({
                where: {
                    source: PLATFORM_OVERRIDE_SOURCE,
                    commodity: r.commodity,
                    region: OVERRIDE_REGION,
                    stage: null,
                    currency,
                    unit,
                },
                select: { id: true, clearedAt: true },
            });

            const seriesId =
                existing?.id ??
                (
                    await db.marketPriceSeries.create({
                        data: {
                            source: PLATFORM_OVERRIDE_SOURCE,
                            commodity: r.commodity,
                            region: OVERRIDE_REGION,
                            stage: null,
                            label: null,
                            unit,
                            currency,
                        },
                        select: { id: true },
                    })
                ).id;

            // Re-typing after a clear starts a FRESH run: the series is
            // un-cleared, but the previous run's points stay stamped and
            // therefore stay unpublished. Only the dates written below rejoin
            // the current run.
            if (existing?.clearedAt != null) {
                await db.marketPriceSeries.update({
                    where: { id: seriesId },
                    data: { clearedAt: null },
                });
            }

            const price = new Prisma.Decimal(Math.round(r.value * 100) / 100);
            await db.marketPricePoint.upsert({
                where: { seriesId_date: { seriesId, date: input.date } },
                // `clearedAt: null` on BOTH paths. On update it is what brings a
                // re-typed date out of a cleared run and into the current one,
                // which is the whole mechanism — a point stamped by an earlier
                // clear must not stay hidden once it is typed again.
                create: { seriesId, date: input.date, price, clearedAt: null },
                update: { price, clearedAt: null },
            });

            series.push({ commodity: r.commodity, seriesId, unit, currency });
        }

        const day = input.date.toISOString().slice(0, 10);
        await logEvent(db, ctx, {
            action: 'MARKET_PRICE_OVERRIDE_UPSERT',
            entityType: 'MarketPriceSeries',
            entityId: series[0].seriesId,
            details: `Platform price override for ${day}: ${series.length} commodity price(s)`,
            detailsJson: {
                category: 'data_lifecycle',
                entityName: 'MarketPriceSeries',
                operation: 'upserted',
                summary:
                    `Platform price override: ${day}, ` +
                    `${series.length} commodity price(s). These win over the API for every farm.`,
                after: {
                    // `source` is the override's, not the manual path's. The two
                    // must be distinguishable in the trail: one filled a gap, one
                    // overrode a live feed for every farm. A previous version
                    // wrote `'manual'` here while the action said otherwise, and
                    // the test asserted the action and never this.
                    source: PLATFORM_OVERRIDE_SOURCE,
                    date: day,
                    clientMutationId: input.clientMutationId ?? null,
                    prices: series.map((sx, i) => ({
                        commodity: sx.commodity,
                        value: resolved[i].value,
                        unit: sx.unit,
                        currency: sx.currency,
                    })),
                },
            },
        });

        return { written: series.length, series };
    });
}

/**
 * Clear one commodity's override — MARKS it, never deletes (contract §5(b)).
 *
 * The typed history survives and so does the audit trail of what was typed. The
 * read path excludes a cleared series and its stamped points, so "cleared" and
 * "absent from the payload" are the same thing to a client without the rows
 * going anywhere.
 *
 * Scoped by commodity across every region and stage: the override is a
 * platform-wide position on a commodity, and a stray row left behind would keep
 * overriding one surface while the superuser believed they had cleared it.
 */
export async function clearOverride(
    ctx: RequestContext,
    commodityRaw: string,
): Promise<ClearOverrideResult> {
    assertPlatformSupport(ctx);

    const r = resolveOverrideCommodity(commodityRaw);
    if (!r) refuseCommodity(commodityRaw);
    const commodity = r.commodity;

    return runInTenantContext(ctx, async (db) => {
        const live = await db.marketPriceSeries.findMany({
            where: { source: PLATFORM_OVERRIDE_SOURCE, commodity, clearedAt: null },
            select: {
                id: true,
                region: true,
                stage: true,
                unit: true,
                currency: true,
                points: {
                    where: { clearedAt: null },
                    select: { date: true, price: true },
                    orderBy: { date: 'asc' },
                },
            },
        });

        if (live.length === 0) {
            // Not an error. A superuser clearing an override that was never set,
            // or was already cleared, has the outcome they wanted; a 404 would
            // make an idempotent retry look like a failure.
            return { commodity, cleared: false, pointsWithdrawn: 0 };
        }

        const clearedAt = new Date();
        const pointsWithdrawn = live.reduce((n, sx) => n + sx.points.length, 0);

        const flat = live.flatMap((sx) =>
            sx.points.map((pt) => ({
                region: sx.region,
                stage: sx.stage,
                date: pt.date.toISOString().slice(0, 10),
                price: pt.price.toString(),
                unit: sx.unit,
                currency: sx.currency,
            })),
        );
        const kept = flat.slice(0, AUDIT_POINT_CAP);

        await logEvent(db, ctx, {
            action: 'MARKET_PRICE_OVERRIDE_CLEARED',
            entityType: 'MarketPriceSeries',
            entityId: live[0].id,
            details:
                `Cleared the platform price override for ${commodity}: ` +
                `${live.length} series, ${pointsWithdrawn} point(s) withdrawn from publication`,
            detailsJson: {
                category: 'data_lifecycle',
                entityName: 'MarketPriceSeries',
                operation: 'updated',
                summary:
                    `Platform override cleared: ${commodity}, ` +
                    `${pointsWithdrawn} point(s) withdrawn. The feed is authoritative again.`,
                before: {
                    source: PLATFORM_OVERRIDE_SOURCE,
                    commodity,
                    seriesCount: live.length,
                    pointsWithdrawn,
                    // Named rather than implied: a reader of a truncated trail
                    // must know it is truncated.
                    pointsRecorded: kept.length,
                    pointsTruncated: flat.length - kept.length,
                    points: kept,
                },
            },
        });

        const ids = live.map((sx) => sx.id);

        // Points first, then the series. If the order were reversed and the
        // second statement failed, a cleared series would keep publishable
        // points — and the transaction would roll both back, so the order is
        // about reading the code rather than about correctness.
        const stamped = await db.marketPricePoint.updateMany({
            where: { seriesId: { in: ids }, clearedAt: null },
            data: { clearedAt },
        });
        const marked = await db.marketPriceSeries.updateMany({
            where: { id: { in: ids }, clearedAt: null },
            data: { clearedAt },
        });

        // Assert the COUNTS, not that the calls returned. An update that touched
        // fewer rows than it found is a silent success — the shape that left a
        // DB-backed guard permanently red elsewhere in this project.
        if (stamped.count !== pointsWithdrawn || marked.count !== live.length) {
            throw internal(
                `Clearing ${commodity}: expected to stamp ${pointsWithdrawn} point(s) and ` +
                    `${live.length} series, stamped ${stamped.count} and ${marked.count}`,
            );
        }

        return { commodity, cleared: true, pointsWithdrawn };
    });
}

/**
 * The admin form read — contract v1.2 §5(c).
 *
 * Returns a row for EVERY overridable commodity, not only those with an
 * override, because the form is a list of ten fields rather than a list of
 * existing entries. A commodity with neither a typed nor an API price is a row
 * with both null, which is a true statement about it.
 */
export async function readOverrideForm(ctx: RequestContext): Promise<OverrideFormRow[]> {
    assertPlatformSupport(ctx);

    return runInTenantContext(ctx, async (db) => {
        // One query for every series of every overridable commodity, then
        // partitioned in memory. A per-commodity read would be twenty queries
        // for a ten-row form (query-shape guardrail D1: no reads in a loop).
        const all = await db.marketPriceSeries.findMany({
            where: { commodity: { in: [...OVERRIDE_COMMODITIES] } },
            select: {
                source: true,
                commodity: true,
                unit: true,
                currency: true,
                clearedAt: true,
                points: {
                    where: { clearedAt: null },
                    select: { date: true, price: true },
                    // LATEST by observation date, not by write time: a superuser
                    // correcting yesterday's figure today must not have the
                    // correction beat today's price.
                    orderBy: { date: 'desc' },
                    take: 1,
                },
            },
        });

        return OVERRIDE_COMMODITIES.map((commodity): OverrideFormRow => {
            const entry = OVERRIDE_ENTRY[commodity];
            const mine = all.filter((sx) => sx.commodity === commodity);

            const liveOverride = mine.find(
                (sx) => sx.source === PLATFORM_OVERRIDE_SOURCE && sx.clearedAt == null,
            );
            const typedPoint = liveOverride?.points[0];

            // Everything that is not an override and not a hand-entered
            // gap-fill. `manual` is excluded deliberately: it is a typed price
            // too, so presenting it as `api` would tell the owner their override
            // is replacing a feed when it is replacing somebody's typing.
            const apiSeries = mine
                .filter(
                    (sx) =>
                        sx.source !== PLATFORM_OVERRIDE_SOURCE &&
                        sx.source !== 'manual' &&
                        sx.points.length > 0,
                )
                .sort(
                    (a, b) =>
                        (b.points[0]?.date.getTime() ?? 0) - (a.points[0]?.date.getTime() ?? 0),
                )[0];
            const apiPoint = apiSeries?.points[0];

            return {
                commodity,
                entryUnit: entry.unit,
                entryCurrency: entry.currency,
                typed: typedPoint
                    ? {
                          value: Number(typedPoint.price),
                          currency: liveOverride!.currency,
                          unit: liveOverride!.unit,
                          date: typedPoint.date.toISOString().slice(0, 10),
                      }
                    : null,
                api:
                    apiSeries && apiPoint
                        ? {
                              value: Number(apiPoint.price),
                              currency: apiSeries.currency,
                              unit: apiSeries.unit,
                              date: apiPoint.date.toISOString().slice(0, 10),
                              source: apiSeries.source,
                          }
                        : null,
                // The DECLARED feed, from the vocabulary — a different claim
                // from `api`. `apiFeed: 'none'` means no feed exists for this
                // commodity EVER, so a typed price is the only source and
                // clearing it leaves nothing. `api: null` with a real feed means
                // the feed exists but has no current point. One empty column for
                // both would tell the owner their override is replacing
                // something when it is replacing nothing.
                apiFeed: commodityMeta(commodity)?.feed ?? 'none',
            };
        });
    });
}

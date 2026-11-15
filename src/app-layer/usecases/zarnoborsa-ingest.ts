/**
 * Storing ZarnoBorsa rows as `MarketPriceSeries` + `MarketPricePoint` (#3081).
 *
 * ## Separate from the fetch, because only one half needs a browser
 *
 * A plain fetch cannot hold their session, so the pages are read by a headless
 * Chromium that must live OUTSIDE this app's image — `verify-image-deps.mjs`
 * forbids Playwright in the runtime image and exists because `npm prune
 * --omit=dev` cannot remove it. This module takes rows that have already been
 * parsed and does the database work, so the half that carries the real risk
 * of being wrong is testable with no browser anywhere near it.
 *
 * ## The verdict is THREE-valued, and the third is the load-bearing one
 *
 * `clean` / `missing` / `unaudited`, copied from `check-release-sboms.mjs` for
 * the reason #2944 states about the card-health probe: **an empty population
 * produces zero problems, which is byte-identical to a clean result.** A run
 * that parsed nothing — because the session lapsed, or the markup moved —
 * would otherwise report the same "no bad rows" as a healthy one.
 *
 * So `unaudited` means the run could not see, and it is NOT success.
 */
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { ZarnoBorsaRow } from '@/lib/market/zarnoborsa-parse';
import {
    ZARNOBORSA_MARKETS,
    zarnoBorsaCommodity,
    isZarnoBorsaKeptMarket,
} from '@/lib/market/zarnoborsa-markets';

/** The source key every series this module writes carries. */
export const ZARNOBORSA_SOURCE = 'zarnoborsa';
/** The attribution a client renders — «Източник: ZarnoBorsa.com». */
export const ZARNOBORSA_SOURCE_URL = 'https://zarnoborsa.com';
/** EUR per tonne, as the pages print it. */
export const ZARNOBORSA_CURRENCY = 'EUR';
export const ZARNOBORSA_UNIT = 'EUR/t';

export type IngestVerdict = 'clean' | 'partial' | 'unaudited';

export interface ZarnoBorsaIngestResult {
    verdict: IngestVerdict;
    /** Rows handed in. */
    received: number;
    /** Of those, in a market we keep (Bulgaria only). */
    kept: number;
    /** Of those, resolving to a commodity we store. */
    mapped: number;
    seriesTouched: number;
    pointsWritten: number;
    /** Rows in a kept market whose product we do not map, by product id. */
    unmappedProducts: number[];
}

/**
 * Upsert the series and their points.
 *
 * ## Why `locked` is a PARAMETER and not inferred here
 *
 * The caller — the fetch half — is the only thing that can see the «ЗА ПЪЛЕН
 * ДОСТЪП» banner, and a locked page yields rows that parse perfectly. So the
 * lock verdict travels WITH the rows, and this function refuses to write
 * anything when it is set. Inferring it from the rows is impossible: the
 * fixtures carry a legitimately old row on a logged-in page, so no property of
 * the data distinguishes the two worlds.
 */
export async function ingestZarnoBorsaRows(
    rows: readonly ZarnoBorsaRow[],
    opts: { locked: boolean },
): Promise<ZarnoBorsaIngestResult> {
    const result: ZarnoBorsaIngestResult = {
        verdict: 'unaudited',
        received: rows.length,
        kept: 0,
        mapped: 0,
        seriesTouched: 0,
        pointsWritten: 0,
        unmappedProducts: [],
    };

    /*
     * LOCKED OUT — write nothing, and say `unaudited` rather than `clean`.
     *
     * This is the case the whole three-valued verdict exists for: the rows are
     * present and well-formed, so every count below would come out looking
     * healthy while the prices were August's.
     */
    if (opts.locked) return result;

    /*
     * NOTHING PARSED is also `unaudited`, not `clean`.
     *
     * Zero rows means the markup moved or the page did not load. Reporting
     * that as a clean run is how a broken scraper reads as a quiet market —
     * and with these figures driving the grain calculator, a quiet market and
     * a blind scraper must not look alike.
     */
    if (rows.length === 0) return result;

    const kept = rows.filter((r) => isZarnoBorsaKeptMarket(r.marketId));
    result.kept = kept.length;

    const unmapped = new Set<number>();
    const mapped: { row: ZarnoBorsaRow; commodity: string; region: string; stage: string }[] = [];
    for (const row of kept) {
        const commodity = zarnoBorsaCommodity(row.marketId, row.productId);
        const market = ZARNOBORSA_MARKETS.get(row.marketId);
        if (!commodity || !market) {
            unmapped.add(row.productId);
            continue;
        }
        mapped.push({ row, commodity, region: market.region, stage: market.stage });
    }
    result.mapped = mapped.length;
    result.unmappedProducts = [...unmapped].sort((a, b) => a - b);

    /*
     * KEPT ROWS BUT NONE MAPPED is `unaudited` too.
     *
     * It means every product id on the Bulgarian tables is one we do not
     * recognise — which is what a renumbering on their side looks like. The
     * counts would otherwise read as a clean run that simply had nothing to
     * store.
     */
    if (mapped.length === 0) return result;

    /*
     * THE PLAIN CLIENT, NOT `runWithoutRls`, and that is the precedent rather
     * than a shortcut.
     *
     * `MarketPriceSeries` and `MarketPricePoint` are TENANTLESS — a global
     * price catalogue with no `tenantId` — and `market-prices-pull`, which has
     * written these same two tables since the EC feed shipped, uses `prisma`
     * directly. The first draft of this file wrapped every write in
     * `runWithoutRls({ reason: 'zarnoborsa-ingest' })`, and the mechanism
     * refused it: an unregistered reason throws by design.
     *
     * Registering one would have been the wrong fix. A bypass reason is a
     * declaration that a tenant-scoped table is being read across tenants,
     * and it carries a ratchet whose whole purpose is to make that visible.
     * Adding an entry for a table that has no tenant column at all would have
     * spent that signal on nothing and raised the ceiling for a future reader
     * to wonder about.
     */
    for (const m of mapped) {
        /*
         * The series is keyed by the UNIQUE tuple the schema already
         * declares — `(source, commodity, region, stage, currency, unit)` —
         * so an upsert needs no lookup-then-write race.
         *
         * `label` is UPDATED on every run, deliberately: it is the product
         * as the page prints it, so a renamed product should follow. The
         * ids are the identity; the label is display.
         */
        const series = await prisma.marketPriceSeries.upsert({
            where: {
                source_commodity_region_stage_currency_unit: {
                    source: ZARNOBORSA_SOURCE,
                    commodity: m.commodity,
                    region: m.region,
                    stage: m.stage,
                    currency: ZARNOBORSA_CURRENCY,
                    unit: ZARNOBORSA_UNIT,
                },
            },
            update: { label: m.row.label, sourceUrl: ZARNOBORSA_SOURCE_URL },
            create: {
                source: ZARNOBORSA_SOURCE,
                commodity: m.commodity,
                region: m.region,
                stage: m.stage,
                label: m.row.label,
                unit: ZARNOBORSA_UNIT,
                currency: ZARNOBORSA_CURRENCY,
                sourceUrl: ZARNOBORSA_SOURCE_URL,
            },
            select: { id: true },
        });
        result.seriesTouched += 1;

        /*
         * THE POINT IS KEYED ON THE ROW'S OWN DATE, never on the read
         * time, and `@@unique([seriesId, date])` makes the upsert exact.
         *
         * That is what stops a stale row being stored as today's price:
         * the FOB tables carry rows spanning days, and EXW Украйна carried
         * an August row on a page we were properly logged into. Keying on
         * the read time would have filed both as current.
         *
         * `price` is a DECIMAL STRING all the way from the page — the
         * column is `Decimal(12,2)` and these figures reach the grain
         * calculator, so nothing may put a float in between.
         */
        await prisma.marketPricePoint.upsert({
            where: { seriesId_date: { seriesId: series.id, date: new Date(m.row.date) } },
            update: { price: new Prisma.Decimal(m.row.price) },
            create: {
                seriesId: series.id,
                date: new Date(m.row.date),
                price: new Prisma.Decimal(m.row.price),
            },
            select: { id: true },
        });
        result.pointsWritten += 1;
    }

    /*
     * `partial` rather than `clean` when some kept row did not map.
     *
     * It is not a failure — feed wheat, meal and the oils are deliberately
     * unmapped — but it is not nothing either: a product id appearing here
     * that is NOT one of those is a renumbering, and the reading names the
     * ids so the difference is visible without a second investigation.
     */
    result.verdict = unmapped.size > 0 ? 'partial' : 'clean';
    return result;
}

/**
 * Storing МЗХ's weekly purchase prices as `MarketPriceSeries` +
 * `MarketPricePoint` (#3136, server half of agrent-ios#635).
 *
 * In `jobs/` and not `usecases/` for the reason `zarnoborsa-ingest` records:
 * there is no `RequestContext`, no tenant and no policy check to make, because
 * the price catalogue is a global artefact with no farm. `no-direct-prisma`
 * would refuse this file in `usecases/`, and it would be right to.
 *
 * ## The owner's two rulings are DATA, in `mzh-parse.ts`
 *
 * Grains only — the bulletin's fruit-and-vegetable wholesale table is not
 * ingested — and bread wheat only, because the natural key has no grade field
 * and «Фуражна пшеница» would collide with `wheat`. Both live in
 * `COMMODITY_BY_LABEL` / `SKIPPED_LABELS` so the decision is visible as a
 * list rather than buried in a branch.
 *
 * ## The verdict is FOUR-valued, and three of them are not success
 *
 * `clean` / `partial` / `no-bulletin` / `unreadable`. The distinction the
 * triple `scanned/actioned/skipped` cannot carry is WHY zero happened, and
 * the three zero-causes want different responses:
 *
 *   - `no-bulletin` — the index page listed nothing we could place in time.
 *     Either МЗХ has not published, or the page moved. Not an error on a
 *     Monday; an error if it persists.
 *   - `unreadable` — the PDF downloaded and held no grain table. The bulletin
 *     changed shape, or `pdftotext` is missing from the image. **This is the
 *     one that must not read as "no prices this week"**, which is exactly what
 *     a count of zero looks like.
 *   - `partial` — rows were stored AND a label went unmapped, which means a
 *     row was renamed. The reading names the labels, so the difference between
 *     "МЗХ published fewer commodities" and "we stopped recognising one" does
 *     not need a second investigation.
 */
import { Prisma } from '@prisma/client';

import { invalidatePriceTrendsCache } from '@/app-layer/usecases/trends';
import { fetchBulletinIndex, fetchPurchasePrices, MZH_ORIGIN, type MzhFetchOptions } from '@/lib/market/mzh-client';
import { COMMODITY_BY_LABEL } from '@/lib/market/mzh-parse';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';

/** The series identity, fixed by the owner's ruling and by the bulletin's own units. */
export const MZH_SOURCE = 'mzh';
export const MZH_REGION = 'BG';
/**
 * The trade level, and NOT null.
 *
 * `stage` is part of `@@unique([source, commodity, region, stage, currency,
 * unit])`, so null is a VALUE in that key rather than an absence: a second
 * МЗХ series published with a null stage would upsert into the same row and
 * one series would silently carry two meanings. Owner ruling 2026-11-16, after
 * backend-1 named exactly that hazard.
 *
 * `PURCHASE` rather than EC's `FGATE`: «изкупни цени» are what buyers pay
 * producers, which IS farm-gate, but sharing EC's code would assert that the
 * two measure the same thing and nobody has established that.
 */
export const MZH_STAGE = 'PURCHASE';
export const MZH_CURRENCY = 'EUR';
export const MZH_UNIT = 't';

export type MzhVerdict = 'clean' | 'partial' | 'no-bulletin' | 'unreadable';

export interface MzhPricesPullResult {
    /** Rows the bulletin's grain table offered. */
    received: number;
    pointsWritten: number;
    seriesTouched: number;
    verdict: MzhVerdict;
    /** The bulletin date read, or null when none was reached. */
    bulletinDate: string | null;
    /** The week-ending date the figures are «към», or null. */
    asOf: string | null;
    /** Labels the table printed that no rule covers — a renamed row. */
    unmappedLabels: string[];
    /** Mapped labels whose current figure was «*» — «няма данни», never 0. */
    noDataLabels: string[];
    /**
     * Commodities in scope that this run did NOT store, for any reason.
     *
     * The catch-all, and the reason it exists: a row can go missing three
     * ways — renamed (`unmappedLabels`), «няма данни» (`noDataLabels`), or
     * unreadable figures, which the parser's line pattern skips SILENTLY
     * because admitting letters there would make every Cyrillic heading look
     * like a row. Only this comparison sees all three, so only this one stops
     * a quietly shrinking bulletin reading as `clean`.
     */
    missingCommodities: string[];
    cacheKeysInvalidated: number;
    cacheInvalidationFailed: boolean;
}

export async function runMzhPricesPull(
    opts: MzhFetchOptions = {},
): Promise<MzhPricesPullResult> {
    const result: MzhPricesPullResult = {
        received: 0,
        pointsWritten: 0,
        seriesTouched: 0,
        verdict: 'no-bulletin',
        bulletinDate: null,
        asOf: null,
        unmappedLabels: [],
        noDataLabels: [],
        missingCommodities: [],
        cacheKeysInvalidated: 0,
        cacheInvalidationFailed: false,
    };

    const index = await fetchBulletinIndex(opts);
    const newest = index[0];
    if (!newest) {
        // Reported, not thrown: a week МЗХ has not published yet is not a
        // fault, and the log line is what separates that from a moved page.
        logger.warn('mzh.no_bulletin', { component: 'mzh-prices', indexed: index.length });
        return result;
    }
    result.bulletinDate = newest.date;

    const parsed = await fetchPurchasePrices(newest, opts);
    if (!parsed) {
        result.verdict = 'unreadable';
        logger.error('mzh.unreadable_bulletin', {
            component: 'mzh-prices',
            bulletinDate: newest.date,
            href: newest.href,
        });
        return result;
    }

    result.asOf = parsed.asOf;
    result.received = parsed.rows.length;
    result.unmappedLabels = parsed.unmappedLabels;
    result.noDataLabels = parsed.noDataLabels;

    const sourceUrl = `${MZH_ORIGIN}${newest.href}`;

    for (const row of parsed.rows) {
        const series = await prisma.marketPriceSeries.upsert({
            where: {
                source_commodity_region_stage_currency_unit: {
                    source: MZH_SOURCE,
                    commodity: row.commodity,
                    region: MZH_REGION,
                    stage: MZH_STAGE,
                    currency: MZH_CURRENCY,
                    unit: MZH_UNIT,
                },
            },
            // `sourceUrl` follows every run, because it points at the ISSUE the
            // figure came from — a reader checking a price wants the bulletin
            // that printed it, not the first one we ever read.
            update: { label: row.label, sourceUrl },
            create: {
                source: MZH_SOURCE,
                commodity: row.commodity,
                region: MZH_REGION,
                stage: MZH_STAGE,
                label: row.label,
                unit: MZH_UNIT,
                currency: MZH_CURRENCY,
                sourceUrl,
            },
            select: { id: true },
        });
        result.seriesTouched += 1;

        /*
         * KEYED ON THE TABLE'S OWN «към» DATE, never the read time.
         *
         * The bulletin is published days after the week it describes — the 7
         * October issue carries figures «към 30.09.2026» — so storing the read
         * time would file week-old averages as today's price, and every figure
         * would look plausible. `@@unique([seriesId, date])` makes the upsert
         * exact, which is also what makes re-running the job harmless.
         */
        await prisma.marketPricePoint.upsert({
            where: { seriesId_date: { seriesId: series.id, date: new Date(parsed.asOf) } },
            update: { price: new Prisma.Decimal(row.price) },
            create: {
                seriesId: series.id,
                date: new Date(parsed.asOf),
                price: new Prisma.Decimal(row.price),
            },
            select: { id: true },
        });
        result.pointsWritten += 1;
    }

    const expected = new Set(Object.values(COMMODITY_BY_LABEL));
    for (const c of parsed.rows.map((r) => r.commodity)) expected.delete(c);
    result.missingCommodities = [...expected];

    // `partial` for EITHER a renamed label or a commodity that simply did not
    // arrive. A count alone cannot distinguish "МЗХ published fewer rows this
    // week" from "we stopped recognising one", and both are findings.
    result.verdict =
        parsed.unmappedLabels.length > 0 || result.missingCommodities.length > 0
            ? 'partial'
            : 'clean';

    if (result.pointsWritten > 0) {
        /*
         * Drop the cached read payloads for what we just wrote (#3126).
         *
         * `getPriceTrends` serves from Redis for six hours, so without this
         * the whole ingest is invisible until each key expires — which is how
         * ten live ZarnoBorsa series sat behind a stale EC figure while the
         * owner reported that prices were not live.
         *
         * The commodities are the ones ACTUALLY written, never a fixed list.
         */
        const touched = [...new Set(parsed.rows.map((r) => r.commodity))];
        try {
            result.cacheKeysInvalidated = await invalidatePriceTrendsCache(touched);
        } catch {
            // The prices are committed; a failed cache drop costs staleness,
            // not correctness, and must not undo the write.
            result.cacheInvalidationFailed = true;
        }
    }

    logger.info('mzh.reading', {
        component: 'mzh-prices',
        verdict: result.verdict,
        bulletinDate: result.bulletinDate,
        asOf: result.asOf,
        pointsWritten: result.pointsWritten,
        // The denominator beside the figure. In a JOB this belongs in the log
        // FIELDS rather than a `[tag]` console line: `denominator-summary.cjs`
        // collects those out of a jest run, so a tagged line here would be
        // collected by nothing while breaching the no-console rule.
        received: result.received,
        unmappedLabels: result.unmappedLabels,
        noDataLabels: result.noDataLabels,
        missingCommodities: result.missingCommodities,
        cacheKeysInvalidated: result.cacheKeysInvalidated,
        cacheInvalidationFailed: result.cacheInvalidationFailed,
    });

    return result;
}

/**
 * «Последни стойности» — what the farm last entered, so «Нов разход» prefills.
 *
 * Owner decision 2026-10-09: the defaults are the farm's OWN last values —
 * "per decare per crop, and yearly for overhead. Empty the first time. No
 * Agrent-wide table." That last clause is the design: there is no seeded
 * benchmark anywhere in here, and a farm with no history gets an empty object
 * rather than somebody else's numbers.
 *
 * ## TWO halves, and the per-crop one arrived later
 *
 * The owner's split is per-decare for crop costs (rent, seed, fuel, ПРЗ,
 * fertilisers) and yearly for overheads (salaries, other, credit,
 * amortisation). `getCostDefaults` covers the overhead half,
 * `getCropCostDefaults` the per-crop half.
 *
 * This header said the per-crop half was "deliberately absent", and the reason
 * was sound rather than an excuse: `CostEntry` had no commodity column, and
 * agrent-ios measured the only read path that existed — all 4 live cost
 * entries on the owner's farm carry NO link at all:
 *
 *     parcelId 0 · seasonId 0 · plantingId 0 · locationId 0 · itemId 0 · leaseId 0
 *
 * So `CostEntry.parcelId → Parcel.cropType` resolved nothing and a per-crop
 * read would have been a second empty surface. The sharper point agrent-ios
 * made was that per-crop «last values» can only come from entries the new form
 * creates, so the read should key on whatever crop field THAT form writes —
 * and choosing `parcelId` first would have prejudged the allocation design
 * while having no data behind it either.
 *
 * #1583 settled it: `CostEntry.commodityCanonical`, written by the crop form,
 * populated only on a `CROP`-basis row. `getCropCostDefaults` keys on exactly
 * that pair, which is what the old note said the eventual read should do.
 *
 * ## Why it filters by CATEGORY and not by `allocationBasis`
 *
 * An overhead spreads on the HOLDING basis, so filtering on that would look
 * right. It would also return nothing: those same 4 live entries are all
 * `TARGET`. And the question a default answers is "what did I last type for
 * salaries", which is about the figure rather than about how it was spread.
 *
 * @module app-layer/usecases/cost-defaults
 */
import { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { Prisma, type CostCategory } from '@prisma/client';
import { codedBadRequest } from '@/lib/errors/types';
import { normalizeCommodity } from '@/lib/market/commodity-vocabulary';

/**
 * The categories the owner's sheet enters as YEARLY amounts.
 *
 * `RENT` is deliberately absent: it is a per-decare crop line in the owner's
 * split, not an overhead, even though it is as fixed as one.
 */
export const OVERHEAD_CATEGORIES = ['PAYROLL', 'CREDIT', 'DEPRECIATION', 'OTHER'] as const;

export type OverheadCategory = (typeof OVERHEAD_CATEGORIES)[number];

export interface OverheadDefault {
    category: OverheadCategory;
    /** The yearly figure as entered. */
    amount: number;
    currency: string;
    /** When it was incurred — the client shows it so a stale default is visible. */
    incurredOn: Date;
    /** PAYROLL only, and null when the farmer entered a plain total. */
    payrollHeadcount: number | null;
    payrollAnnualPerPerson: number | null;
}

export interface CostDefaults {
    /** One entry per overhead category with prior entries. Absent means none. */
    overheads: OverheadDefault[];
}

const dec = (v: Prisma.Decimal | number | null | undefined): number | null => {
    if (v == null) return null;
    return typeof v === 'number' ? v : Number(v.toString());
};

/**
 * The most recent entry per overhead category.
 *
 * One query, not four. A `findFirst` per category would be four round trips for
 * a screen that opens on a tap, and the whole set is bounded by
 * `OVERHEAD_CATEGORIES.length` anyway — so the rows come back ordered and the
 * first of each category wins.
 *
 * `[{ incurredOn: 'desc' }, { id: 'desc' }]` matches `listPage`'s ordering, and
 * the `id` tie-break is load-bearing for the same reason it states: `incurredOn`
 * is a DATE, so a day with several salary entries has no total order without it
 * and "the latest" would differ between reads.
 *
 * The `take` is a bound rather than a guess at the data: it only has to be big
 * enough that every category's newest row is inside it. Ordered by date
 * descending, 200 covers a farm entering an overhead every week for four years.
 */
/** One prior line of a crop sheet, as the farm last entered it. */
export interface CropCostLine {
    category: CostCategory;
    /**
     * The per-decare rate AS TYPED, or null when the farmer entered a total.
     *
     * Null is returned rather than the line being dropped. A dropped line
     * hides that the farm has such a cost at all; a null says "this line
     * exists and has no rate to prefill", which lets a client show the row
     * unfilled instead of pretending the farm never recorded it.
     */
    amountPerDca: number | null;
    currency: string;
    /** The client shows it so a stale default is visible rather than implied. */
    incurredOn: Date;
    /**
     * The row's NAME — what distinguishes ПРЗ from торове on one sheet.
     *
     * A DEPARTURE worth stating: `CostEntryDTOSchema` deliberately omits
     * `description` from LIST rows, returning it only on a single read,
     * because it is encrypted commercial free text. This read returns it, and
     * the reasons it is acceptable here are specific rather than general — the
     * rows are the CALLER'S OWN farm's, bounded to one sheet, the caller can
     * already read each one individually, and without the name the sheet comes
     * back as several unlabelled amounts, which is not a usable prefill.
     *
     * Do not take this as licence to add `description` to other list reads.
     */
    description: string | null;
}

export interface CropCostDefaults {
    /** The CANONICAL commodity, echoed so a client knows what resolved. */
    commodity: string;
    /** The latest sheet's lines. EMPTY means no history — start blank. */
    lines: CropCostLine[];
}

/**
 * The farm's own last per-crop cost lines, for prefilling a «Култура» sheet.
 *
 * Owner decision 1 for agrent-ios#245: the defaults are the farm's own LAST
 * VALUES, per decare and per crop.
 *
 * ## Why this could not be written before #1583
 *
 * This module's header says the per-crop half was absent because "`CostEntry`
 * has no commodity column", and that a per-crop read keying on
 * `parcelId → Parcel.cropType` would resolve nothing — measured: all four live
 * cost entries on the owner's farm carry no link of any kind. #1583 added
 * `commodityCanonical`, so the read finally has a key that the new form
 * actually populates.
 *
 * ## "The latest SET", not the latest row
 *
 * A sheet is several lines entered together — ПРЗ, торове, seed — and
 * prefilling only the newest would collapse a sheet into one line. So this
 * returns every row sharing the most recent `incurredOn` for that commodity.
 *
 * That definition is a choice and is written here so it is not re-guessed: a
 * farm that enters two sheets on one day gets both, which is the safe
 * direction — a client showing one row too many is recoverable, a client
 * silently dropping a cost line is not.
 *
 * ## The currency can differ from the form's
 *
 * A stored line carries the currency it was entered in. Bulgaria moved to EUR
 * in 2026 and older rows are in BGN, so a client prefilling the NUMBER without
 * reading the currency shows a 24 000 лв salary as €24 000 — wrong by the
 * fixed 1.95583, and plausible. The currency travels per line for that reason.
 */
export async function getCropCostDefaults(
    ctx: RequestContext,
    commodityRaw: string,
): Promise<CropCostDefaults> {
    assertCanRead(ctx);

    // Normalised and REFUSED on a miss, matching the create path. Accepting
    // any spelling and answering with an empty sheet would be
    // indistinguishable from "this crop has no history", so a typo would read
    // as a fact about the farm.
    const commodity = normalizeCommodity(commodityRaw);
    if (commodity == null) {
        // CODED, not prose — `no-server-authored-user-copy` holds thrown
        // English on a downward ratchet, and a code is the half a client can
        // translate. The raw value rides in `params` so a client bug is
        // diagnosable; it is a crop name the caller just sent, never personal
        // data.
        throw codedBadRequest(
            'UNKNOWN_COMMODITY',
            'That crop is not one this calculator can price.',
            { commodity: commodityRaw },
        );
    }

    const rows = await runInTenantContext(ctx, (db) =>
        db.costEntry.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                // The two together: a CROP-basis row is the only kind that
                // carries a commodity, and `commodityCanonical` is only
                // meaningful on one. Filtering on both states the intent and
                // costs nothing.
                allocationBasis: 'CROP',
                commodityCanonical: commodity,
            },
            orderBy: [{ incurredOn: 'desc' }, { id: 'desc' }],
            select: {
                category: true,
                amountPerDca: true,
                currency: true,
                incurredOn: true,
                description: true,
            },
            // One sheet is ~10 lines; this is a bound rather than a guess at
            // the data, and it only has to exceed the largest plausible single
            // day. The slice below takes one day's worth regardless.
            take: 100,
        }),
    );

    if (rows.length === 0) return { commodity, lines: [] };

    // Rows are newest-first, so the first row's date IS the most recent.
    // Compared on the instant rather than the calendar day: `incurredOn` is a
    // DateTime and two entries on one day can differ by hours, which a
    // date-only comparison would merge and an instant comparison keeps apart.
    // The owner's sheet is entered in one sitting, so one instant is one sheet.
    const latest = rows[0].incurredOn.getTime();

    return {
        commodity,
        lines: rows
            .filter((r) => r.incurredOn.getTime() === latest)
            .map((r) => ({
                category: r.category,
                amountPerDca: dec(r.amountPerDca),
                currency: r.currency,
                incurredOn: r.incurredOn,
                description: r.description ?? null,
            })),
    };
}

export async function getCostDefaults(ctx: RequestContext): Promise<CostDefaults> {
    assertCanRead(ctx);

    const rows = await runInTenantContext(ctx, (db) =>
        db.costEntry.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                category: { in: [...OVERHEAD_CATEGORIES] },
            },
            orderBy: [{ incurredOn: 'desc' }, { id: 'desc' }],
            select: {
                category: true,
                amount: true,
                currency: true,
                incurredOn: true,
                payrollHeadcount: true,
                payrollAnnualPerPerson: true,
            },
            take: 200,
        }),
    );

    const newest = new Map<OverheadCategory, OverheadDefault>();
    for (const row of rows) {
        const category = row.category as OverheadCategory;
        // First wins — the rows are already newest-first, so this is the
        // "latest per category" without a second pass or a GROUP BY.
        if (newest.has(category)) continue;
        newest.set(category, {
            category,
            amount: dec(row.amount) ?? 0,
            currency: row.currency,
            incurredOn: row.incurredOn,
            // `?? null`, never `?? 0`: null says the farmer entered a plain
            // total, and zero people earning a salary is a different claim. A
            // prefill that filled zeros over that distinction would overwrite
            // real figures with a number nobody typed.
            payrollHeadcount: row.payrollHeadcount ?? null,
            payrollAnnualPerPerson: dec(row.payrollAnnualPerPerson),
        });
    }

    // Returned in the declared order rather than by date, so the form's fields
    // do not reorder themselves between visits.
    return {
        overheads: OVERHEAD_CATEGORIES.map((c) => newest.get(c)).filter(
            (d): d is OverheadDefault => d != null,
        ),
    };
}

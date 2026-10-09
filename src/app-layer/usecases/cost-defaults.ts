/**
 * «Последни стойности» — what the farm last entered, so «Нов разход» prefills.
 *
 * Owner decision 2026-10-09: the defaults are the farm's OWN last values —
 * "per decare per crop, and yearly for overhead. Empty the first time. No
 * Agrent-wide table." That last clause is the design: there is no seeded
 * benchmark anywhere in here, and a farm with no history gets an empty object
 * rather than somebody else's numbers.
 *
 * ## Overhead only, and that is measured rather than scoped down for effort
 *
 * The owner's split is per-decare for crop costs (rent, seed, fuel, ПРЗ,
 * fertilisers) and yearly for overheads (salaries, other, credit, amortisation).
 * This covers the overhead half.
 *
 * The per-crop half is deliberately absent because `CostEntry` has no commodity
 * column, and agrent-ios measured the only read path that exists today — all 4
 * live cost entries on the owner's farm carry NO link at all:
 *
 *     parcelId 0 · seasonId 0 · plantingId 0 · locationId 0 · itemId 0 · leaseId 0
 *
 * So `CostEntry.parcelId → Parcel.cropType` resolves nothing, and a per-crop
 * defaults read would be a second empty surface. agrent-ios made the sharper
 * point: per-crop «last values» will only ever come from entries the new form
 * creates, which carry `amountPerDca` and whatever crop target #1512 settles
 * on — so the read should key on THAT field, and choosing `parcelId` now would
 * prejudge the allocation design while having no data behind it either.
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
import { Prisma } from '@prisma/client';

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

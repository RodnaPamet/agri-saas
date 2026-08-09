import { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { Prisma } from '@prisma/client';

/**
 * Machinery depreciation — the cost basis behind `Asset.purchaseCost`.
 *
 * WHY THIS EXISTS. `purchaseCost` / `purchaseDate` were captured on the
 * asset register, read back on the detail page, and touched by no
 * calculation anywhere. A money column that no arithmetic reads is how
 * `stockCost` earned its "structurally always 0" reputation; a second
 * dead money field would compound the same distrust. This gives them a
 * basis.
 *
 * WHY IT IS A SEPARATE SECTION, not folded into the crop rollup.
 * `getCostRollupBySeason` totals what a CROP consumed. A tractor is not
 * consumed by one planting, and quietly adding depreciation into those
 * numbers would change every existing figure on the /costs page the day
 * this ships — the same "the number moved and nobody said why" problem.
 * So machinery depreciation is reported alongside, clearly labelled, and
 * the crop totals are untouched.
 *
 * HONESTY RULES, both load-bearing:
 *
 *   1. A tenant on `DepreciationMethod.NONE` gets `method: 'NONE'` and
 *      an EMPTY charge list — not zeroes. "We do not compute this" and
 *      "this costs nothing" must not render identically.
 *   2. An asset with a `purchaseCost` but no `usefulLifeYears` has no
 *      denominator, so its annual charge is UNKNOWN, not zero. Those
 *      assets come back in `unallocated[]` with their cost, so the UI
 *      can say "3 machines worth 120 000 лв are not being depreciated
 *      because they have no useful life set" instead of understating
 *      the total in silence.
 */

/** Bound — a farm's machine register, not a report over history. */
const ASSET_TAKE = 1000;

function dec(v: Prisma.Decimal | null | undefined): number | null {
    if (v == null) return null;
    return typeof v === 'number' ? v : Number(v.toString());
}

export interface MachineryDepreciationCharge {
    assetId: string;
    assetKey: string | null;
    assetName: string;
    purchaseCost: number;
    purchaseDate: string | null;
    usefulLifeYears: number;
    /** Straight-line: cost ÷ useful life. */
    annualCharge: number;
    /**
     * Whole years since purchase, capped at the useful life. Null when
     * `purchaseDate` is unset — we can say what a year costs without
     * knowing when it started, but not how much life is left.
     */
    yearsElapsed: number | null;
    /** Remaining book value, null when `yearsElapsed` is unknown. */
    remainingValue: number | null;
    /** True once the asset is fully written down. */
    fullyDepreciated: boolean;
}

export interface UnallocatedMachine {
    assetId: string;
    assetKey: string | null;
    assetName: string;
    purchaseCost: number;
    /** Why it produced no charge. Rendered verbatim by the UI. */
    reason: 'NO_USEFUL_LIFE';
}

export interface MachineryDepreciationResult {
    method: 'NONE' | 'STRAIGHT_LINE';
    /** Empty when `method` is NONE — see honesty rule 1. */
    charges: MachineryDepreciationCharge[];
    /** Sum of `annualCharge`. 0 when there are no charges. */
    totalAnnualCharge: number;
    /** Assets carrying a cost that could NOT be depreciated. */
    unallocated: UnallocatedMachine[];
    /** Sum of `unallocated[].purchaseCost` — the value NOT represented. */
    unallocatedCost: number;
    /** True when the register hit the read bound. */
    truncated: boolean;
}

const EMPTY: Omit<MachineryDepreciationResult, 'method'> = {
    charges: [],
    totalAnnualCharge: 0,
    unallocated: [],
    unallocatedCost: 0,
    truncated: false,
};

/**
 * Whole years between `from` and `now`, floored at 0. Used only to age
 * an asset against its useful life, so month-level precision would be
 * false confidence.
 */
function wholeYearsSince(from: Date, now: Date): number {
    let years = now.getUTCFullYear() - from.getUTCFullYear();
    const beforeAnniversary =
        now.getUTCMonth() < from.getUTCMonth() ||
        (now.getUTCMonth() === from.getUTCMonth() && now.getUTCDate() < from.getUTCDate());
    if (beforeAnniversary) years -= 1;
    return Math.max(0, years);
}

export async function getMachineryDepreciation(
    ctx: RequestContext,
    opts: { now?: Date } = {},
): Promise<MachineryDepreciationResult> {
    assertCanRead(ctx);
    const now = opts.now ?? new Date();

    return runInTenantContext(ctx, async (db) => {
        const tenant = await db.tenant.findUnique({
            where: { id: ctx.tenantId },
            select: { depreciationMethod: true },
        });
        const method = tenant?.depreciationMethod ?? 'NONE';

        // Honesty rule 1 — opted out means "not computed", so no rows at
        // all rather than a page of zeroes.
        if (method === 'NONE') return { method: 'NONE', ...EMPTY };

        const assets = await db.asset.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null, purchaseCost: { not: null } },
            select: {
                id: true,
                key: true,
                name: true,
                purchaseCost: true,
                purchaseDate: true,
                usefulLifeYears: true,
            },
            orderBy: [{ name: 'asc' }],
            take: ASSET_TAKE + 1,
        });
        const truncated = assets.length > ASSET_TAKE;
        const rows = truncated ? assets.slice(0, ASSET_TAKE) : assets;

        const charges: MachineryDepreciationCharge[] = [];
        const unallocated: UnallocatedMachine[] = [];

        for (const a of rows) {
            const cost = dec(a.purchaseCost);
            if (cost == null) continue;

            // Honesty rule 2 — no denominator means UNKNOWN, not zero.
            if (!a.usefulLifeYears || a.usefulLifeYears <= 0) {
                unallocated.push({
                    assetId: a.id,
                    assetKey: a.key,
                    assetName: a.name,
                    purchaseCost: cost,
                    reason: 'NO_USEFUL_LIFE',
                });
                continue;
            }

            const annualCharge = cost / a.usefulLifeYears;
            const yearsElapsed = a.purchaseDate
                ? Math.min(wholeYearsSince(a.purchaseDate, now), a.usefulLifeYears)
                : null;
            const remainingValue =
                yearsElapsed == null ? null : Math.max(0, cost - annualCharge * yearsElapsed);

            charges.push({
                assetId: a.id,
                assetKey: a.key,
                assetName: a.name,
                purchaseCost: cost,
                purchaseDate: a.purchaseDate ? a.purchaseDate.toISOString() : null,
                usefulLifeYears: a.usefulLifeYears,
                annualCharge,
                yearsElapsed,
                remainingValue,
                fullyDepreciated: yearsElapsed != null && yearsElapsed >= a.usefulLifeYears,
            });
        }

        return {
            method: 'STRAIGHT_LINE',
            charges,
            totalAnnualCharge: charges.reduce((s, c) => s + c.annualCharge, 0),
            unallocated,
            unallocatedCost: unallocated.reduce((s, u) => s + u.purchaseCost, 0),
            truncated,
        };
    });
}

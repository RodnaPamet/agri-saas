import { Prisma } from '@prisma/client';

import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead } from '../policies/common';
import type { CostCategory } from '@prisma/client';
import type { RequestContext } from '../types';

/**
 * Exact cost aggregates for the «Разходи» graphs (#500, owner 2026-11-01).
 *
 * ## Why this exists rather than both clients summing the list
 *
 * The phone and the web each wanted per-type and per-month totals, and each was
 * computing them from `GET /grain/costs`, which is CAPPED. Two consequences,
 * and the second is the one that mattered:
 *
 *   · Two copies of one rule, which drift. Same argument as
 *     `scripts/lib/api-routes.ts` being shared rather than forked.
 *   · The number is WRONG above the cap, and un-disclosably so. "«по последните
 *     500 разхода»" sounds like a disclosure but tells a farmer nothing they can
 *     act on: they cannot tell whether their largest cost category is genuinely
 *     largest or merely recent. The honest version of that caption is "this
 *     total may be wrong and we cannot say by how much", which nobody would
 *     ship.
 *
 * So the database answers it, over every matching row, with no cap.
 *
 * ## Grouped BY CURRENCY, never blended
 *
 * `CostEntry.currency`'s own docblock states the rule: *"Never blended — there
 * is no FX table in this repo, so consumers group BY currency or refuse."* This
 * returns a row per (currency, …) and lets the client choose which to draw.
 *
 * That is deliberately NOT "sum the EUR rows and mention the rest". Picking a
 * display currency here would be inventing an FX policy in an aggregate
 * endpoint, and a farm with BGN and EUR costs would get a confident total that
 * silently answers a different question from the one asked.
 *
 * ## Integer MINOR UNITS on the wire
 *
 * The column is `Decimal(14, 2)`; the wire carries `totalMinor`, an integer
 * number of cents. The multiplication happens in Postgres `numeric` arithmetic
 * — never JavaScript — so no float is involved at any point, which is the house
 * money rule. A client divides by 100 in a decimal type, never a double.
 */

export interface CostSummaryFilter {
    categories?: CostCategory[];
    /** Inclusive lower bound on `incurredOn`. */
    from?: Date;
    /** Inclusive upper bound on `incurredOn`. */
    to?: Date;
}

export interface CostSummaryBucket {
    currency: string;
    /** Integer minor units (cents). Never a float. */
    totalMinor: number;
    count: number;
}

export interface CostSummary {
    byType: (CostSummaryBucket & { category: CostCategory })[];
    byMonth: (CostSummaryBucket & { month: string })[];
    byTypeAndMonth: (CostSummaryBucket & { category: CostCategory; month: string })[];
    currencies: { currency: string; count: number }[];
}

/**
 * The shared WHERE. Built once so the four aggregates cannot disagree about
 * which rows they are over — a per-type total that included a row the per-month
 * total excluded would make two graphs on one screen contradict each other.
 */
function whereClause(ctx: RequestContext, filter: CostSummaryFilter): Prisma.Sql {
    const parts: Prisma.Sql[] = [
        // Tenant scope is NOT optional and NOT inherited here: raw SQL bypasses
        // the application-layer filter that every Prisma query gets, so this is
        // the only thing standing between this aggregate and another farm's
        // costs. RLS is the backstop, not the control.
        // DEFENCE IN DEPTH, not redundancy. These queries run inside
        // `runInTenantContext`, which drops to `app_user` and sets
        // `app.tenant_id`, so RLS already confines them — but the house rule is
        // that every query ALSO filters by tenantId, and here it is what makes
        // the intent legible at the call site rather than depending on a
        // policy two files away.
        Prisma.sql`"tenantId" = ${ctx.tenantId}`,
        Prisma.sql`"deletedAt" IS NULL`,
    ];
    if (filter.categories && filter.categories.length > 0) {
        parts.push(Prisma.sql`"category"::text IN (${Prisma.join(filter.categories)})`);
    }
    if (filter.from) parts.push(Prisma.sql`"incurredOn" >= ${filter.from}`);
    if (filter.to) parts.push(Prisma.sql`"incurredOn" <= ${filter.to}`);
    return Prisma.join(parts, ' AND ');
}

/** `SUM(amount)` as exact integer minor units, in Postgres numeric arithmetic. */
const TOTAL_MINOR = Prisma.sql`(SUM("amount") * 100)::bigint AS "totalMinor"`;

export async function getCostSummary(
    ctx: RequestContext,
    filter: CostSummaryFilter = {},
): Promise<CostSummary> {
    assertCanRead(ctx);
    const where = whereClause(ctx, filter);

    // `runInTenantContext` rather than the global client. RLS is FORCED on
    // `CostEntry`, and raw SQL on the global client runs as the owner role and
    // bypasses it entirely — defeating the isolation layer that the
    // application-level filter is only the second half of. `no-direct-prisma`
    // is the guard that caught me doing it the other way, and it was right.
    return runInTenantContext(ctx, async (db) => {
        // SEQUENTIAL, not `Promise.all`. These share ONE transaction and
        // therefore one connection; issuing four queries concurrently on it is
        // not parallelism, and nothing serialises them for you. Each is an
        // indexed aggregate (`[tenantId, category, incurredOn]`) over a bounded
        // table, so the cost is four fast round trips rather than one.
        //
        // `to_char(…, 'YYYY-MM')` rather than a date: a year-month STRING
        // removes the time-zone question entirely. The phone was bucketing by
        // UTC date and drawing at local midnight, which labelled September «авг».
        const byType = await db.$queryRaw<
            { category: CostCategory; currency: string; totalMinor: bigint; count: bigint }[]
        >`
            SELECT "category", "currency", ${TOTAL_MINOR}, COUNT(*) AS "count"
            FROM "CostEntry" WHERE ${where}
            GROUP BY "category", "currency"
            ORDER BY (SUM("amount") * 100)::bigint DESC
        `;

        const byMonth = await db.$queryRaw<
            { month: string; currency: string; totalMinor: bigint; count: bigint }[]
        >`
            SELECT to_char("incurredOn", 'YYYY-MM') AS "month", "currency", ${TOTAL_MINOR}, COUNT(*) AS "count"
            FROM "CostEntry" WHERE ${where}
            GROUP BY 1, "currency"
            ORDER BY 1 ASC
        `;

        const byTypeAndMonth = await db.$queryRaw<
            { category: CostCategory; month: string; currency: string; totalMinor: bigint; count: bigint }[]
        >`
            SELECT "category", to_char("incurredOn", 'YYYY-MM') AS "month", "currency", ${TOTAL_MINOR}, COUNT(*) AS "count"
            FROM "CostEntry" WHERE ${where}
            GROUP BY "category", 2, "currency"
            ORDER BY 2 ASC
        `;

        const currencies = await db.$queryRaw<{ currency: string; count: bigint }[]>`
            SELECT "currency", COUNT(*) AS "count"
            FROM "CostEntry" WHERE ${where}
            GROUP BY "currency"
            ORDER BY COUNT(*) DESC
        `;

        // `bigint` out of `::bigint` and `COUNT(*)`. This conversion is
        // load-bearing rather than cosmetic: `JSON.stringify` THROWS on a
        // bigint instead of coercing it, so without this the route 500s.
        // Safe as a Number — the column is Decimal(14,2), so the largest
        // representable total is 10^12 cents, four orders of magnitude inside
        // Number.MAX_SAFE_INTEGER.
        const n = (v: bigint) => Number(v);

        return {
            byType: byType.map((r) => ({ ...r, totalMinor: n(r.totalMinor), count: n(r.count) })),
            byMonth: byMonth.map((r) => ({ ...r, totalMinor: n(r.totalMinor), count: n(r.count) })),
            byTypeAndMonth: byTypeAndMonth.map((r) => ({
                ...r,
                totalMinor: n(r.totalMinor),
                count: n(r.count),
            })),
            currencies: currencies.map((r) => ({ ...r, count: n(r.count) })),
        };
    });
}

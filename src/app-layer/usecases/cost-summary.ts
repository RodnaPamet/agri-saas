import { Prisma } from '@prisma/client';
import { EURO_SPELLINGS_LIST } from '@/lib/grain/currencies';

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

/**
 * One currency, one row (#2707).
 *
 * `CostEntry.currency` was free text («Валута») before the EUR-only save path,
 * so grouping by the raw column split one currency across its spellings: the
 * owner's own «Торове» read «11 119,50 EUR и 10,00 EURO» on the phone, and the
 * `currencies` list counted euros among the rows EXCLUDED from a euro total.
 *
 * ## Folded in the SQL, not backfilled
 *
 * A read-time fold fixes every stored row whatever it says, needs no
 * production write, cannot be half-applied, and does not leave the next
 * free-text row to re-break it. Measured before choosing: ZERO migrations
 * contain an `UPDATE "CostEntry"` (against 11 that mention the table), so
 * nothing has ever normalised these values and nothing will.
 *
 * ## The spellings come from `currencies.ts`, and BGN deliberately does not
 *
 * The list is interpolated from `EURO_SPELLINGS_LIST` rather than retyped here
 * — two copies is how the TS and the SQL drift, and that module's docblock
 * already argues against private copies.
 *
 * It is NOT `canonicalCostCurrency`, which folds BGN into EUR too. That
 * function is correct where it is used, beside `normaliseCostToEur`, which
 * converts lev at the fixed peg — fold the label, convert the amount. This
 * aggregate converts nothing, by its own contract three paragraphs up:
 * *"Never blended — there is no FX table in this repo, so consumers group BY
 * currency or refuse."* Folding BGN here without converting would add lev to
 * euros as the same unit, which is a wrong TOTAL rather than a split series.
 * So lev keeps its own row.
 *
 * `btrim` and `upper` before comparing, because the stored values are what
 * somebody typed: « eur », «Euro» and «EUR» are all one currency.
 *
 * ## Every caller GROUPS BY ORDINAL, and that is required rather than tidy
 *
 * `Prisma.sql` turns an interpolated value into a BIND PARAMETER, so repeating
 * this fragment in a `GROUP BY` emits a second set of placeholders — `$1..$5`
 * in the SELECT and `$6..$10` in the GROUP BY. Postgres compares grouping
 * expressions syntactically, decides the two are different, and refuses with
 * `42803: column "CostEntry.currency" must appear in the GROUP BY clause`.
 * Which reads like the fold was never applied, when in fact it was applied
 * twice and the copies did not match.
 *
 * `GROUP BY 1, 2` names the select-list position instead, so the expression
 * exists ONCE per query. That is also the stronger shape: two copies of a
 * CASE in one statement is a thing that can drift, and `byMonth` was already
 * grouping by ordinal for its `to_char` for the same reason.
 */
const CANONICAL_CURRENCY = Prisma.sql`
    CASE
        WHEN upper(btrim("currency")) = ''
          OR upper(btrim("currency")) IN (${Prisma.join(
              EURO_SPELLINGS_LIST.map((c) => Prisma.sql`${c}`),
          )})
        THEN 'EUR'
        ELSE upper(btrim("currency"))
    END`;

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
            SELECT "category", ${CANONICAL_CURRENCY} AS "currency", ${TOTAL_MINOR}, COUNT(*) AS "count"
            FROM "CostEntry" WHERE ${where}
            GROUP BY 1, 2
            ORDER BY (SUM("amount") * 100)::bigint DESC
        `;

        const byMonth = await db.$queryRaw<
            { month: string; currency: string; totalMinor: bigint; count: bigint }[]
        >`
            SELECT to_char("incurredOn", 'YYYY-MM') AS "month", ${CANONICAL_CURRENCY} AS "currency", ${TOTAL_MINOR}, COUNT(*) AS "count"
            FROM "CostEntry" WHERE ${where}
            GROUP BY 1, 2
            ORDER BY 1 ASC
        `;

        const byTypeAndMonth = await db.$queryRaw<
            { category: CostCategory; month: string; currency: string; totalMinor: bigint; count: bigint }[]
        >`
            SELECT "category", to_char("incurredOn", 'YYYY-MM') AS "month", ${CANONICAL_CURRENCY} AS "currency", ${TOTAL_MINOR}, COUNT(*) AS "count"
            FROM "CostEntry" WHERE ${where}
            GROUP BY 1, 2, 3
            ORDER BY 2 ASC
        `;

        const currencies = await db.$queryRaw<{ currency: string; count: bigint }[]>`
            SELECT ${CANONICAL_CURRENCY} AS "currency", COUNT(*) AS "count"
            FROM "CostEntry" WHERE ${where}
            GROUP BY 1
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

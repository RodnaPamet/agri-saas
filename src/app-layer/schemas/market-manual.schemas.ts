/**
 * Write schema for hand-entered market prices.
 *
 * Several fertilisers a Bulgarian farm buys have no reliable free feed —
 * МАП above all, and ammonium nitrate in any usable denomination. The choice
 * was to omit them or to let a platform admin type them, and omitting them
 * makes the fertiliser view answer half the question a farmer actually has.
 *
 * The strictness here is the point. A hand-typed price enters the same table
 * a feed writes to and renders on the same axis, so anything this schema lets
 * through becomes indistinguishable from a quote at the point where it
 * matters — someone deciding when to buy a lorry of urea.
 */
import { z } from '@/lib/openapi/zod';

/** Day-granular observation date, as `YYYY-MM-DD`. */
const ObservationDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
    .transform((raw, ctx) => {
        // Parsed as UTC midnight so a point typed in Sofia and a point pulled
        // from a feed land on the same key. `new Date('2026-08-03')` is
        // already UTC, but going through Date.UTC states it rather than
        // relying on a parsing rule most readers have to look up.
        const [y, m, d] = raw.split('-').map(Number);
        const date = new Date(Date.UTC(y, m - 1, d));
        if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== m - 1) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Not a real calendar date' });
            return z.NEVER;
        }
        return date;
    });

export const ManualPricePointSchema = z.object({
    date: ObservationDate,
    /**
     * Finite and non-negative. A negative price is not a market a farmer can
     * buy in, and NaN/Infinity would poison every average downstream.
     */
    price: z.number().finite().nonnegative(),
});

export const ManualPriceSeriesSchema = z.object({
    /**
     * Any spelling — English, Bulgarian, slug. Resolved through
     * `normalizeAnyCommodity` in the usecase, which accepts INPUTS as well as
     * crops. This is the one write path that is allowed to name diesel or
     * urea, and it is allowed to because it is not the exchange.
     */
    commodity: z.string().min(1).max(120),
    /** 'BG' | 'EU' | 'GLOBAL' | … — free-form, matching the feeds' own regions. */
    region: z.string().min(1).max(32).default('BG'),
    /** Delivery/processing stage. Null for sources with no stage concept. */
    stage: z.string().min(1).max(64).nullish(),
    /** Human label — the product name as the admin knows it. */
    label: z.string().min(1).max(200).nullish(),
    /** As reported, never normalised: 'EUR/t', 'BGN/1000l', 'USD/mt'. */
    unit: z.string().min(1).max(32),
    /** ISO 4217, uppercase. */
    currency: z.string().regex(/^[A-Z]{3}$/, 'Expected a 3-letter ISO currency code'),
    /**
     * Bounded at 500. A manual entry is someone typing a history they have in
     * front of them, not a bulk import; an unbounded array here would be a
     * write-amplification vector on a global table with no tenant scoping.
     */
    points: z.array(ManualPricePointSchema).min(1).max(500),
});

export type ManualPriceSeriesInput = z.infer<typeof ManualPriceSeriesSchema>;

/**
 * One commodity's typed price within a day — #1587 contract §5(d).
 *
 * No `unit` and no `currency`, deliberately. They are derived server-side from
 * `price-override-denominations.ts` per commodity, because a caller that could
 * choose the unit could put a per-tonne figure into the litre series and the
 * six-column key would dutifully create it. Diesel is ~1.95 EUR/l against
 * ~1950 EUR/t, so the field a client does not have is the one that would be
 * wrong by a thousand.
 */
export const PriceOverrideEntrySchema = z.object({
    /** Any accepted spelling; resolved and checked against the override list. */
    commodity: z.string().min(1).max(120),
    value: z.number().finite().nonnegative(),
});

/**
 * A whole DAY of superuser price overrides, written all-or-nothing.
 *
 * `date` is a calendar day, not an instant: these are daily observations and the
 * point key is `(seriesId, date)` with a `@db.Date` column. A client sending a
 * timestamp would have its time silently dropped, so the shape says day.
 */
export const PriceOverrideDaySchema = z.object({
    date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
        .openapi({ example: '2026-10-10' }),
    /**
     * Bounded at 10 — the owner's list is ten commodities (decision 3,
     * 2026-10-10) and the bound is the list's length rather than a round
     * number, so widening the list is the only way to widen the bound.
     */
    prices: z.array(PriceOverrideEntrySchema).min(1).max(10),
    /**
     * Recorded on the audit row for traceability. NOT what prevents a double
     * write: the point upsert is on `(seriesId, date)`, so re-sending a day
     * produces the identical state. See the usecase docblock — these are global
     * tables with no `(tenantId, clientMutationId)` to dedupe on.
     */
    clientMutationId: z.string().min(1).max(200).nullish(),
});

export type PriceOverrideDayInput = z.infer<typeof PriceOverrideDaySchema>;

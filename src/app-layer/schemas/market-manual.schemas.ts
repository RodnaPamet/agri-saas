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
import { z } from 'zod';

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

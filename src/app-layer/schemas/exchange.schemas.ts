import { z } from 'zod';
import { ExchangeSide, ExchangeKind } from '@prisma/client';
import { EXCHANGE_CURRENCY } from '@/lib/exchange/currency';

/**
 * Zod schemas for the Exchange write API. The usecase layer sanitizes all
 * free text (sanitizePlainText / sanitizeOptional) and derives
 * regionName/lat/lon from `regionCode` — these schemas only shape + bound
 * the input. Every schema `.strip()`s unknown keys (matches grain.schemas).
 */

// Decimal magnitudes arrive as number OR numeric string. The Exchange tables
// are GLOBAL (no RLS), so this schema is a load-bearing guard, not a nicety:
// the old `z.union([z.number().positive(), z.string()])` accepted ANY string,
// so "abc" passed Zod and only blew up at Prisma's Decimal column (→ 500), and
// an unbounded value could overflow Decimal(14,3) / (12,2). `boundedDecimal`
// coerces to a bounded, finite number and rejects everything else with a
// clean 400 BEFORE it can reach Prisma.
const NUMERIC_STRING = /^\d+(\.\d{1,3})?$/;
function boundedDecimal(opts: { min: number; max: number; minExclusive?: boolean }) {
    const { min, max, minExclusive = false } = opts;
    return z.union([z.number(), z.string()]).transform((v, ctx) => {
        let n: number;
        if (typeof v === 'number') {
            n = v;
        } else if (NUMERIC_STRING.test(v.trim())) {
            n = Number(v.trim());
        } else {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a numeric value' });
            return z.NEVER;
        }
        if (!Number.isFinite(n)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a finite number' });
            return z.NEVER;
        }
        if (minExclusive ? n <= min : n < min) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `must be ${minExclusive ? 'greater than' : 'at least'} ${min}`,
            });
            return z.NEVER;
        }
        if (n > max) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be at most ${max}` });
            return z.NEVER;
        }
        return n;
    });
}

/** Listing/inquiry tonnage: > 0, capped well under the Decimal(14,3) limit. */
const QuantityTonnes = boundedDecimal({ min: 0, max: 1_000_000, minExclusive: true });
/** Price per tonne: >= 0, capped under the Decimal(12,2) limit; null preserved. */
const PricePerTonne = boundedDecimal({ min: 0, max: 10_000_000 });
/**
 * New listings are EUR-ONLY.
 *
 * This used to be `z.enum(['BGN','EUR','USD']).default('BGN')`, which is what
 * let the marketplace hold three denominations at once while the map labelled
 * all of them "€/t". Narrowing it to a literal is the write-side half of the
 * euro migration: legacy rows were converted once (see
 * `…_exchange_euro_denomination`), and the create path can no longer
 * reintroduce a second currency. The COLUMN still tolerates others — it has to,
 * to express the USD rows that exist — so this is the only gate that matters.
 */
const PriceCurrency = z.literal(EXCHANGE_CURRENCY);

export const CreateListingSchema = z
    .object({
        side: z.nativeEnum(ExchangeSide),
        kind: z.nativeEnum(ExchangeKind),
        commodity: z.string().min(1).max(120),
        quantityTonnes: QuantityTonnes,
        pricePerTonne: PricePerTonne.nullable().optional(),
        priceCurrency: PriceCurrency.default(EXCHANGE_CURRENCY),
        regionCode: z.string().min(1).max(16),
        description: z.union([z.string().max(2000), z.null()]).optional(),
        sellerDisplayName: z.union([z.string().max(120), z.null()]).optional(),
        // Private: never projected into a public listing. Revealed to ONE
        // buyer, only if the seller accepts their inquiry. Short cap because a
        // contact is a phone number or an email, not a paragraph.
        sellerContact: z.union([z.string().max(200), z.null()]).optional(),
        // If present, an expiry MUST be in the future — a past expiresAt would
        // create a listing that is dead-on-arrival (hidden by the read filter).
        expiresAt: z
            .union([
                z
                    .string()
                    .datetime()
                    .refine((s) => new Date(s).getTime() > Date.now(), {
                        message: 'expiresAt must be in the future',
                    }),
                z.null(),
            ])
            .optional(),
    })
    .strip();
export type CreateListingBody = z.infer<typeof CreateListingSchema>;

export const CreateInquirySchema = z
    .object({
        listingId: z.string().min(1),
        message: z.string().min(1).max(2000),
        // Private, same rule as the seller's side: revealed to the seller only
        // if they accept. Optional — a buyer may prefer to be reachable only
        // through whatever the seller shares first.
        inquirerContact: z.union([z.string().max(200), z.null()]).optional(),
        quantityTonnes: QuantityTonnes.nullable().optional(),
    })
    .strip();
export type CreateInquiryBody = z.infer<typeof CreateInquirySchema>;

/** Seller responds to an inquiry. */
export const RespondToInquirySchema = z
    .object({ action: z.enum(['ACCEPTED', 'DECLINED']) })
    .strip();
export type RespondToInquiryBody = z.infer<typeof RespondToInquirySchema>;

/** Seller flips their own listing's lifecycle status. */
export const UpdateListingStatusSchema = z
    .object({ action: z.enum(['WITHDRAWN', 'FULFILLED']) })
    .strip();
export type UpdateListingStatusBody = z.infer<typeof UpdateListingStatusSchema>;

import { z } from 'zod';
import { ExchangeSide } from '@prisma/client';

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
/** Known trading currencies — anything else is rejected (default BGN). */
const PriceCurrency = z.enum(['BGN', 'EUR', 'USD']);

export const CreateListingSchema = z
    .object({
        side: z.nativeEnum(ExchangeSide),
        commodity: z.string().min(1).max(120),
        // Canonical taxonomy key hint from the client; the usecase re-derives
        // from `commodity` when it isn't a known key, so this is advisory.
        commodityKey: z.string().min(1).max(40).optional(),
        quantityTonnes: QuantityTonnes,
        pricePerTonne: PricePerTonne.nullable().optional(),
        priceCurrency: PriceCurrency.default('BGN'),
        regionCode: z.string().min(1).max(16),
        description: z.union([z.string().max(2000), z.null()]).optional(),
        sellerDisplayName: z.union([z.string().max(120), z.null()]).optional(),
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

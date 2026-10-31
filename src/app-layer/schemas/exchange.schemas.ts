import { z } from 'zod';
import { ExchangeSide, ExchangeKind } from '@prisma/client';
import { EXCHANGE_CURRENCY } from '@/lib/exchange/currency';
import { CANONICAL_COMMODITIES, normalizeCommodity } from '@/lib/market/commodity-vocabulary';

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

/**
 * Commodity, NORMALISED to the canonical vocabulary on the way in.
 *
 * This was `z.string().min(1).max(120)` — unvalidated free text. Every
 * spelling of the same grain therefore created its own group in the
 * own-listings index, fragmenting real groups below the k-anonymity floor
 * until they vanished, and letting a writer pick which bucket their price
 * landed in. It also guaranteed the index could never join to
 * `MarketPriceSeries.commodity`, which is a lowercase enum.
 *
 * Accepting-then-normalising rather than rejecting anything non-canonical is
 * deliberate: `Wheat`, `wheat` and `пшеница` are the same intent typed by
 * three different users, and all three should succeed and store `'wheat'`.
 * A genuinely unknown commodity is refused, because storing it would recreate
 * the free-text problem one row at a time — adding one is a deliberate,
 * reviewable edit to CANONICAL_COMMODITIES.
 */
const CommodityField = z
    .string()
    .min(1)
    .max(120)
    .transform((raw, ctx) => {
        const canonical = normalizeCommodity(raw);
        if (!canonical) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Unknown commodity. Expected one of: ${CANONICAL_COMMODITIES.join(', ')}`,
            });
            return z.NEVER;
        }
        return canonical;
    });

/**
 * The listing's own fields, shared by the CREATE and the EDIT schemas (#2543).
 *
 * One definition rather than two, because the edit is a FULL REPLACEMENT of
 * exactly what create accepts — and two copies of a twelve-field shape is how
 * an edit silently stops accepting a field create added. `toListingEdit`'s
 * key-set assertion pins the projection to the same set, so the response, the
 * request and the create path move together or not at all.
 */
const LISTING_FIELDS = {
        side: z.nativeEnum(ExchangeSide),
        kind: z.nativeEnum(ExchangeKind),
        commodity: CommodityField,
        quantityTonnes: QuantityTonnes,
        pricePerTonne: PricePerTonne.nullable().optional(),
        priceCurrency: PriceCurrency.default(EXCHANGE_CURRENCY),
        regionCode: z.string().min(1).max(16),
        description: z.union([z.string().max(2000), z.null()]).optional(),
        sellerDisplayName: z.union([z.string().max(120), z.null()]).optional(),
        /**
         * Publish this listing AS THE FARM — P6.7 (#1816).
         *
         * Accepted whatever the farm's publication state, deliberately. The
         * attribution is resolved LIVE on every read, so a seller who ticks
         * this before publishing their page simply shows as anonymous until
         * they do — and then every listing they already posted becomes
         * attributed, with nothing to back-fill. Refusing here would make the
         * ORDER of two unrelated decisions matter.
         *
         * Defaults to false. A listing is anonymous unless its seller asked
         * otherwise, which is the direction a per-listing consent has to
         * default in.
         */
        publishAsFarm: z.boolean().default(false),
        // Private: never projected into a public listing. Revealed to ONE
        // buyer, only if the seller accepts their inquiry. Short cap because a
        // contact is a phone number or an email, not a paragraph.
        sellerContact: z.union([z.string().max(200), z.null()]).optional(),
        // If present, an expiry MUST be in the future — a past expiresAt would
        // create a listing that is dead-on-arrival (hidden by the read filter).
} as const;

/**
 * `expiresAt` is the ONE field create and edit validate differently, so it
 * sits outside `LISTING_FIELDS` rather than being shared and then overridden.
 *
 * On CREATE it must be in the future: a listing born already past its expiry
 * is dead on arrival, hidden by the read filter the moment it is written.
 *
 * On EDIT that same rule is wrong, and the iOS session found it before it
 * shipped. The seller's `edit` object round-trips `expiresAt` as a string, and
 * a client that does not touch the date sends it back verbatim — so a listing
 * edited ON ITS LAST DAY would be refused for a field nobody changed, and the
 * refusal would be a schema error naming a field the seller never saw. The
 * rule that is actually wanted is "a CHANGED expiry must be in the future",
 * and only the usecase can know whether it changed, because only it has the
 * stored value. See `updateListingFields`.
 */
const ExpiresAtOnCreate = z
    .union([
        z
            .string()
            .datetime()
            .refine((s) => new Date(s).getTime() > Date.now(), {
                message: 'expiresAt must be in the future',
            }),
        z.null(),
    ])
    .optional();

/**
 * Shape only — the future check moves to the usecase. See above.
 *
 * `.nullable()`, NOT `z.union([…, z.null()])`. The two parse identically, and
 * the difference is entirely in what the OpenAPI generator emits: a union
 * becomes `anyOf: [{string, format}, {null}]`, which puts the `format` on a
 * BRANCH rather than on the property. Every one of the spec's other 178
 * `…At` properties carries it on the property itself — including
 * `ExchangeListing.expiresAt`, this same field on the public projection —
 * so a client reading `ExchangeListingEdit.expiresAt` would have been the
 * only one that had to descend a union to learn the encoding.
 * `timestamps-declare-their-format` is what catches it.
 */
const ExpiresAtOnEdit = z.string().datetime().nullable().optional();

export const CreateListingSchema = z
    .object({ ...LISTING_FIELDS, expiresAt: ExpiresAtOnCreate })
    .strip();
export type CreateListingBody = z.infer<typeof CreateListingSchema>;

/**
 * Replace every editable field on one of your own listings — #2543.
 *
 * Owner ruling 2026-10-31: EVERY field is editable, including side, kind and
 * commodity. The narrower option — "all but those three, so a started
 * conversation stays about the same offer" — was offered and declined.
 *
 * A FULL REPLACEMENT rather than a partial patch, which is the whole reason it
 * is a PUT. Five of these fields are nullable, and under a patch "leave the
 * description alone" and "clear the description" are the same JSON unless a
 * sentinel is invented. Replacement removes the ambiguity instead of encoding
 * it.
 *
 * `updatedAt` is a PRECONDITION, not a value: the usecase refuses when it does
 * not match the row. Required rather than optional, deliberately — an optional
 * precondition is one a client can omit and silently lose the protection,
 * which is worse than not having it, because the next reader assumes it is
 * there. Full replacement is what makes it worth the field at all: a lost
 * update discards every field the other editor changed, not one, and the web
 * and the phone can both have this listing open.
 */
export const UpdateListingSchema = z
    .object({
        ...LISTING_FIELDS,
        expiresAt: ExpiresAtOnEdit,
        updatedAt: z.string().datetime(),
    })
    .strip();
export type UpdateListingBody = z.infer<typeof UpdateListingSchema>;

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

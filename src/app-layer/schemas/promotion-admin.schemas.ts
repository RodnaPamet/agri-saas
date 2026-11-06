import { z } from 'zod';
import { httpsUrl } from '@/lib/schemas/url';
import { DAY_KEY_PATTERN } from '@/lib/calendar-day-key';

/**
 * Platform-support write payloads for the global promotions feed (#12).
 *
 * `category` is a String column, so the type system cannot stop a typo. This is
 * the single place the curated set is spelled — same pattern as
 * `AGRI_EVENT_CATEGORIES`, and for the same reason: an unknown value should be
 * rejected on write, not silently rendered as something it isn't.
 */
export const PROMOTION_CATEGORIES = [
    'culture',
    'fertilizer',
    'seeds',
    'products',
    'service',
] as const;

export type PromotionCategory = (typeof PROMOTION_CATEGORIES)[number];

export const PromotionCategorySchema = z.enum(PROMOTION_CATEGORIES);

/**
 * A supplier is identified EITHER by id (picked from the list) or by name
 * (typed fresh, then find-or-created). Requiring exactly one keeps the
 * create-if-missing path from silently ignoring a picked company.
 */
const companyRef = {
    companyId: z.string().min(1).optional(),
    companyName: z.string().min(1).max(200).optional(),
};

const exactlyOneCompany = (v: { companyId?: string; companyName?: string }) =>
    Boolean(v.companyId) !== Boolean(v.companyName);

export const CreatePromotionSchema = z
    .object({
        ...companyRef,
        title: z.string().min(1).max(300),
        body: z.string().max(4000).nullable().optional(),
        category: PromotionCategorySchema.default('service'),
        ctaUrl: httpsUrl().nullable().optional(),
        /**
         * A calendar DAY, `YYYY-MM-DD`, not an instant (#2752).
         *
         * `validTo` is the INCLUSIVE last day. It was `z.coerce.date()`, which
         * accepted whatever each client chose to build — and the console built
         * local midnight, so «2 Nov» arrived as `2026-11-01T22:00:00Z`. Every
         * client producing that conversion independently is how one of them
         * gets it wrong, which is the iOS session's argument for moving it
         * here; the server stores the day's label and nothing has to agree
         * about a zone.
         */
        validFrom: z.string().regex(DAY_KEY_PATTERN).nullable().optional(),
        validTo: z.string().regex(DAY_KEY_PATTERN).nullable().optional(),
        /**
         * ЗЗР рег. № when this promotion advertises a plant protection
         * product, NULL when it does not.
         *
         * A COMPLIANCE INPUT, not a detail. Reg. (EC) 1107/2009 Art 66 puts
         * specific requirements on advertising a ПРЗ — prescribed safety
         * wording, prohibited claim types — and free text cannot tell a
         * pesticide from a fertiliser, so the withhold-until-configured
         * predicate #2664 proposes has nothing to read without this. The
         * column has existed since #2673 and was reachable only by direct
         * database access: absent here, and absent from the console form, so
         * every promotion written through the console had it NULL — which a
         * predicate reads as "not a plant protection product".
         *
         * Set at REVIEW time by the person publishing, never derived from the
         * AI read of a supplier leaflet. `promotion-leaflet-reader.ts` has no
         * slot for it at all, held by
         * `tests/guards/promotion-read-proposes-no-ppp-number.test.ts`: a
         * misread registration number would silently reclassify a pesticide
         * as a fertiliser, which is the one error in this feature that
         * matters.
         *
         * 120 chars to match `catalog.schemas.ts`, which carries the same
         * number on `Item` for the same register.
         */
        pppRegistrationNo: z.string().trim().max(120).nullable().optional(),
        /**
         * The `FileRecord` id of the supplier leaflet this was read from
         * (#2750) — carried through by the console's accept-this-proposal
         * action so the source document stays reachable from the row.
         *
         * A pass-through id, deliberately NOT validated against the file
         * table here: a bad id is a dangling pointer, which is the same
         * state a retention-swept source leaves and which the read path
         * already has to render as "source no longer held". Validating it
         * would buy a nicer error for a case the UI cannot produce, at the
         * cost of a second query on every write.
         */
        sourceFileId: z.string().trim().min(1).max(64).nullable().optional(),
    })
    .strip()
    .refine(exactlyOneCompany, {
        message: 'Provide either an existing companyId or a new companyName, not both',
        path: ['companyName'],
    })
    // Day keys compare as STRINGS — fixed-width and zero-padded, so
    // lexicographic order IS calendar order, with no Date arithmetic to get
    // wrong at a DST boundary. `farmToday`'s docblock makes the same point.
    .refine((v) => !v.validFrom || !v.validTo || v.validTo >= v.validFrom, {
        message: 'The campaign end date must not precede its start date',
        path: ['validTo'],
    });
export type CreatePromotionBody = z.infer<typeof CreatePromotionSchema>;

/**
 * Partial edit. The cross-field window check can't live here — a payload may
 * carry only one end of the span, so the other has to come from the stored row.
 * `updatePromotion` re-checks the merged pair.
 */
export const UpdatePromotionSchema = z
    .object({
        ...companyRef,
        title: z.string().min(1).max(300).optional(),
        body: z.string().max(4000).nullable().optional(),
        category: PromotionCategorySchema.optional(),
        ctaUrl: httpsUrl().nullable().optional(),
        /**
         * A calendar DAY, `YYYY-MM-DD`, not an instant (#2752).
         *
         * `validTo` is the INCLUSIVE last day. It was `z.coerce.date()`, which
         * accepted whatever each client chose to build — and the console built
         * local midnight, so «2 Nov» arrived as `2026-11-01T22:00:00Z`. Every
         * client producing that conversion independently is how one of them
         * gets it wrong, which is the iOS session's argument for moving it
         * here; the server stores the day's label and nothing has to agree
         * about a zone.
         */
        validFrom: z.string().regex(DAY_KEY_PATTERN).nullable().optional(),
        validTo: z.string().regex(DAY_KEY_PATTERN).nullable().optional(),
        /**
         * See `CreatePromotionSchema` for why this is a compliance input. On
         * the edit path it is how a promotion already published as "not a
         * ПРЗ" gets reclassified — explicit `null` clears it, and `undefined`
         * (the field omitted) leaves the stored value alone, which is the
         * distinction `updatePromotion` relies on for every other field here.
         */
        pppRegistrationNo: z.string().trim().max(120).nullable().optional(),
        /**
         * The `FileRecord` id of the supplier leaflet this was read from
         * (#2750) — carried through by the console's accept-this-proposal
         * action so the source document stays reachable from the row.
         *
         * A pass-through id, deliberately NOT validated against the file
         * table here: a bad id is a dangling pointer, which is the same
         * state a retention-swept source leaves and which the read path
         * already has to render as "source no longer held". Validating it
         * would buy a nicer error for a case the UI cannot produce, at the
         * cost of a second query on every write.
         */
        sourceFileId: z.string().trim().min(1).max(64).nullable().optional(),
    })
    .strip()
    .refine((v) => !(v.companyId && v.companyName), {
        message: 'Provide either companyId or companyName, not both',
        path: ['companyName'],
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdatePromotionBody = z.infer<typeof UpdatePromotionSchema>;

export const SetPublishedSchema = z.object({ published: z.boolean() }).strip();

export const UpdateCompanySchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        eik: z.string().max(40).nullable().optional(),
        websiteUrl: httpsUrl().nullable().optional(),
        contactName: z.string().max(200).nullable().optional(),
        contactEmail: z.string().email().max(320).nullable().optional(),
        contactPhone: z.string().max(60).nullable().optional(),
        notes: z.string().max(4000).nullable().optional(),
    })
    .strip()
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdateCompanyBody = z.infer<typeof UpdateCompanySchema>;

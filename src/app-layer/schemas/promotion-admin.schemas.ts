import { z } from 'zod';
import { httpsUrl } from '@/lib/schemas/url';

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
        validFrom: z.coerce.date().nullable().optional(),
        validTo: z.coerce.date().nullable().optional(),
    })
    .strip()
    .refine(exactlyOneCompany, {
        message: 'Provide either an existing companyId or a new companyName, not both',
        path: ['companyName'],
    })
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
        validFrom: z.coerce.date().nullable().optional(),
        validTo: z.coerce.date().nullable().optional(),
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

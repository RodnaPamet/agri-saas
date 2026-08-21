import { z } from 'zod';
import { httpsUrl } from '@/lib/schemas/url';

/**
 * The GLOBAL agriculture-events catalogue (#15) — fairs, trainings, webinars,
 * and subsidy deadlines shared by every tenant.
 *
 * `AgriEvent.category` is a plain `String` column, so the *type* system cannot
 * stop a typo. This module is the single place the curated set is spelled, and
 * every write path (the platform-admin API and the seed) validates against it —
 * an unknown category is rejected at the boundary rather than silently falling
 * through the reader's `default:` arm and being mislabeled as a fair.
 *
 * Each member maps to an existing `ag.events.cat*` i18n key; see the reader in
 * `src/app/t/[tenantSlug]/(app)/events/page.tsx`.
 */
export const AGRI_EVENT_CATEGORIES = ['fair', 'training', 'webinar', 'subsidy-deadline'] as const;

export type AgriEventCategory = (typeof AGRI_EVENT_CATEGORIES)[number];

export const AgriEventCategorySchema = z.enum(AGRI_EVENT_CATEGORIES);

/**
 * Platform-admin create payload. Dates are `z.coerce.date()` rather than the
 * loose date strings the tenant UI schemas accept (`lease.schemas.ts`): this is
 * a machine-facing key-gated API with no date picker in front of it, so an
 * unparseable date should fail at the boundary, not persist as an Invalid Date.
 */
export const CreateAgriEventSchema = z
    .object({
        title: z.string().min(1).max(300),
        description: z.string().max(4000).nullable().optional(),
        category: AgriEventCategorySchema.default('fair'),
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date().nullable().optional(),
        place: z.string().max(300).nullable().optional(),
        url: httpsUrl().nullable().optional(),
    })
    .strip()
    .refine((v) => !v.endsAt || v.endsAt >= v.startsAt, {
        message: 'endsAt must not precede startsAt',
        path: ['endsAt'],
    });
export type CreateAgriEventBody = z.infer<typeof CreateAgriEventSchema>;

/**
 * Update payload — every field optional. The cross-field `endsAt >= startsAt`
 * check cannot live here: a partial update may carry only one of the two, so
 * the surviving value has to come from the stored row. The route re-checks the
 * merged pair after loading it.
 */
export const UpdateAgriEventSchema = z
    .object({
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(4000).nullable().optional(),
        category: AgriEventCategorySchema.optional(),
        startsAt: z.coerce.date().optional(),
        endsAt: z.coerce.date().nullable().optional(),
        place: z.string().max(300).nullable().optional(),
        url: httpsUrl().nullable().optional(),
    })
    .strip()
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdateAgriEventBody = z.infer<typeof UpdateAgriEventSchema>;

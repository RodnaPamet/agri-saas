/**
 * Request shapes for a parcel's history.
 *
 * Deliberately thin. The real rules — which harvest years are allowed, which
 * weed names are catalogue keys, how long a note may be — live in
 * `usecases/parcel-history.ts` and not here, because they are the SAME rules
 * whether a row arrives over HTTP or from a future import. A schema that
 * duplicated them would be a second place to update and a second place to get
 * out of step; a schema that replaced them would leave the usecase trusting
 * its caller.
 *
 * So these validate SHAPE, and the usecase validates MEANING.
 */
import { z } from '@/lib/openapi/zod';

export const CreateCropSeasonSchema = z
    .object({
        /// Harvest year. Bounds are the usecase's — see `assertYear`.
        year: z.number().int(),
        cropType: z.string().min(1),
        /// ISO dates. Optional: a back-filled year may be remembered without
        /// anyone recalling the day it was drilled.
        sownAt: z.string().datetime().nullable().optional(),
        harvestedAt: z.string().datetime().nullable().optional(),
        notes: z.string().nullable().optional(),
        /**
         * kg per DECARE, the farmer's own per-parcel figure.
         *
         * Bounded here as well as in the usecase, because the two refusals
         * differ usefully: the schema answers `VALIDATION_ERROR` for a type
         * error (a string, an object), the usecase answers the coded
         * `YIELD_OUT_OF_RANGE` for a number that is the wrong SIZE. A client
         * can act on the second and only log the first.
         *
         * NOT `YieldRecord` — see the schema comment on the column. Nothing
         * sums this into a production total.
         */
        yieldKgPerDca: z.number().nonnegative().max(100000).nullable().optional(),
    })
    .strip()
    .openapi('CreateParcelCropSeason');
export type CreateCropSeasonBody = z.infer<typeof CreateCropSeasonSchema>;

/**
 * What an observation IS, shared by both routes that create one.
 *
 * Spread into two schemas rather than `.extend()`ed from one, because
 * `CreateWeedObservationSchema` carries an `.openapi()` refId and extending a
 * named schema would register a second component under the same name. One
 * field set, two names.
 *
 * The point of sharing it: the parcel-scoped and task-scoped routes differ in
 * WHO may post and nothing else. A client that can build a body for one can
 * build it for the other, and a new field cannot land on half the surface.
 */
const WEED_OBSERVATION_FIELDS = {
    observedAt: z.string().datetime(),
    /**
     * ONE list, mixed. The server decides which entries are catalogue keys
     * and which are free text — see the usecase's `partitionWeeds`. The
     * client cannot choose the column, which is what keeps the reportable
     * half reportable.
     */
    weeds: z.array(z.string()).min(1),
    notes: z.string().nullable().optional(),
};

export const CreateWeedObservationSchema = z
    .object({ ...WEED_OBSERVATION_FIELDS })
    .strip()
    .openapi('CreateParcelWeedObservation');
export type CreateWeedObservationBody = z.infer<typeof CreateWeedObservationSchema>;

/**
 * The task-scoped variant: `parcelId` moves into the BODY because the path
 * spends its id on the task.
 *
 * The parcel is still mandatory — an observation is always ABOUT a parcel, and
 * a task can touch several, so there is nothing sensible to default to. The
 * server checks the id against the task's own parcel set, so a wrong one is a
 * coded 400 rather than a write landing on a neighbour's field.
 */
export const CreateTaskWeedObservationSchema = z
    .object({
        parcelId: z.string().min(1).max(60),
        ...WEED_OBSERVATION_FIELDS,
    })
    .strip()
    .openapi('CreateTaskWeedObservation');
export type CreateTaskWeedObservationBody = z.infer<typeof CreateTaskWeedObservationSchema>;

/**
 * Partial corrections (owner ruling 2026-11-06).
 *
 * ## Every field `.optional()`, and only the nullable ones `.nullable()`
 *
 * That pairing IS the contract: omitted leaves the stored value alone, explicit
 * `null` clears a nullable field. `year`, `cropType`, `observedAt` and `weeds`
 * are optional and NOT nullable, so a client cannot send `null` to "clear" a
 * required column — the schema refuses it before the usecase has to.
 *
 * ## No `.refine()` for "at least one field", deliberately
 *
 * The usecase answers `NO_FIELDS_TO_UPDATE`, which is a coded refusal a client
 * can switch on, where a schema refinement produces a generic
 * `VALIDATION_ERROR`. It also keeps these as plain objects: a refined schema is
 * a `ZodEffects` and registering an `.openapi()` refId on one is how a
 * component quietly stops appearing under its name.
 */
export const UpdateCropSeasonSchema = z
    .object({
        year: z.number().int().optional(),
        cropType: z.string().min(1).optional(),
        sownAt: z.string().datetime().nullable().optional(),
        harvestedAt: z.string().datetime().nullable().optional(),
        notes: z.string().nullable().optional(),
        /** kg per decare; `null` clears it. See `CreateCropSeasonSchema`. */
        yieldKgPerDca: z.number().nonnegative().max(100000).nullable().optional(),
    })
    .strip()
    .openapi('UpdateParcelCropSeason');
export type UpdateCropSeasonBody = z.infer<typeof UpdateCropSeasonSchema>;

export const UpdateWeedObservationSchema = z
    .object({
        observedAt: z.string().datetime().optional(),
        /**
         * Replaces the list WHOLE when present — the server re-partitions it
         * into catalogue keys and free text, so both stored columns move
         * together. `.min(1)` because emptying an observation in place would
         * leave it asserting that somebody looked and found nothing, which is a
         * different agronomic claim; DELETE is the remedy for "should not
         * exist" and it leaves a tombstone.
         */
        weeds: z.array(z.string()).min(1).optional(),
        notes: z.string().nullable().optional(),
    })
    .strip()
    .openapi('UpdateParcelWeedObservation');
export type UpdateWeedObservationBody = z.infer<typeof UpdateWeedObservationSchema>;

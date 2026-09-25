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
    })
    .strip()
    .openapi('CreateParcelCropSeason');
export type CreateCropSeasonBody = z.infer<typeof CreateCropSeasonSchema>;

export const CreateWeedObservationSchema = z
    .object({
        observedAt: z.string().datetime(),
        /**
         * ONE list, mixed. The server decides which entries are catalogue keys
         * and which are free text — see the usecase's `partitionWeeds`. The
         * client cannot choose the column, which is what keeps the reportable
         * half reportable.
         */
        weeds: z.array(z.string()).min(1),
        notes: z.string().nullable().optional(),
    })
    .strip()
    .openapi('CreateParcelWeedObservation');
export type CreateWeedObservationBody = z.infer<typeof CreateWeedObservationSchema>;

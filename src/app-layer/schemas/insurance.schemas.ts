import { z } from 'zod';

import {
    INSURANCE_PRODUCT_KEYS,
    MAX_AREA_DCA,
    MAX_SUM_INSURED_CENTS,
} from '@/lib/insurance';

/**
 * "Ask for offer" insurance lead from the per-parcel Risk page (#13). Captures
 * the parcel context + an optional snapshot of the satellite risk at request
 * time. Lead-gen only.
 */
export const CreateInsuranceLeadSchema = z
    .object({
        parcelId: z.string().min(1),
        locationId: z.string().min(1).nullable().optional(),
        // Optional ONLY when a quote is present — see the refine below.
        message: z.string().min(1).max(2000).optional(),
        /**
         * What the farmer chose. There is deliberately NO premium, tariff or
         * instalment-amount field: the server recomputes the price from these
         * four inputs, and `.strip()` drops anything else a client sends.
         */
        quote: z
            .object({
                productKey: z.enum(INSURANCE_PRODUCT_KEYS),
                areaDca: z.number().finite().positive().max(MAX_AREA_DCA),
                sumInsuredCents: z.number().int().positive().max(MAX_SUM_INSURED_CENTS),
                instalments: z.union([
                    z.literal(1),
                    z.literal(2),
                    z.literal(3),
                    z.literal(4),
                ]),
            })
            .strip()
            .optional(),
        // Free-form snapshot (overall level + ndvi/ndmi) for the sales record.
        risk: z
            .object({
                overall: z.string().max(20).optional(),
                ndvi: z.number().nullable().optional(),
                ndmi: z.number().nullable().optional(),
            })
            .strip()
            .nullable()
            .optional()
            // Carried here rather than in the OpenAPI path, which used to hold a
            // second copy of this whole object and had already drifted from it.
            .describe('Snapshot of what the farmer was shown when asking.'),
    })
    .strip()
    /**
     * A body must carry a non-blank message OR a quote.
     *
     * Message-only keeps working exactly as before: an installed PWA can run
     * yesterday's bundle for days, and the native clients post here too. This
     * refine is the only thing that made `message` optional.
     */
    .refine(
        (body) =>
            (typeof body.message === 'string' && body.message.trim() !== '') ||
            body.quote !== undefined,
        { message: 'Provide a message or a quote', path: ['message'] },
    );
export type CreateInsuranceLeadBody = z.infer<typeof CreateInsuranceLeadSchema>;

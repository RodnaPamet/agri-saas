/**
 * OperationParcel DTO — one spray-prescription line of a FIELD_OPERATION
 * job, as serialised by `getFieldOperation` (GET /field-operations/{id}).
 *
 * The line is returned as the raw Prisma `OperationParcel` row with four
 * includes (product / doseUnit / parcel / completedBy). Decimal columns
 * (`doseValue`, `parcel.areaHa`) serialise to JSON STRINGS via Prisma's
 * `Decimal.toJSON()`; dates to ISO strings. `.passthrough()` keeps the
 * contract forward-compatible with additive include fields.
 */
import { z } from '@/lib/openapi/zod';
import { UserRefSchema } from './common';

const OpProductRefSchema = z
    .object({ id: z.string(), name: z.string() })
    .passthrough();

const OpDoseUnitRefSchema = z
    .object({ id: z.string(), symbol: z.string(), name: z.string().optional() })
    .passthrough();

const OpParcelRefSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        /** Decimal → string (on-ellipsoid hectares from ST_Area). */
        areaHa: z.string().nullable().optional(),
    })
    .passthrough();

export const OperationParcelDTOSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        taskId: z.string(),
        parcelId: z.string(),
        productItemId: z.string(),
        /** Decimal → string. RATE doses (L/ha) multiply by parcel area on completion. */
        doseValue: z.string(),
        doseUnitId: z.string(),
        targetNote: z.string().nullable().optional(),
        /** PENDING | DONE | SKIPPED. */
        status: z.string(),
        /**
         * Optimistic-lock version. Send it back as `If-Match` on
         * `PATCH …/parcels/{lineId}`.
         *
         * REQUIRED, and it always was on the wire — the route serialises the
         * raw Prisma row, and the column is `Int @default(0)`, so every
         * stored line carries one. It was simply never DECLARED (#1370),
         * which is worse than absent: a client reading the spec could not
         * implement the lock the PATCH documents as mandatory, and iOS
         * decoded it as optional and hid its mark buttons on every line.
         *
         * An undeclared field that is always present is the hardest kind to
         * notice missing — the web client reads it out of route behaviour and
         * works, so nothing fails until somebody generates a client from the
         * contract.
         */
        version: z.number().int(),
        completedAt: z.string().nullable().optional(),
        completedByUserId: z.string().nullable().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        product: OpProductRefSchema,
        doseUnit: OpDoseUnitRefSchema,
        parcel: OpParcelRefSchema,
        completedBy: UserRefSchema.nullable().optional(),
    })
    .passthrough()
    .openapi('OperationParcel', {
        description:
            'A spray-prescription line of a field-operation job: one parcel, one product, one dose. ' +
            'Marking it DONE deducts dose×area from the FEFO inventory lot and writes an INPUT_APPLICATION journal record.',
    });

export type OperationParcelDTO = z.infer<typeof OperationParcelDTOSchema>;

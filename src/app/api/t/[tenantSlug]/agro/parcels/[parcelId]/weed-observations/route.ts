import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { createParcelWeedObservation } from '@/app-layer/usecases/parcel-history';
import { CreateWeedObservationSchema } from '@/app-layer/schemas/parcel-history.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/{slug}/agro/parcels/{parcelId}/weed-observations
 *
 * Record which weeds were identified in this parcel on a date. The client
 * sends ONE list; the server splits it into catalogue keys and free text, so
 * the reportable column cannot be polluted by a mislabelled entry.
 */
export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateWeedObservationSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; parcelId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            // Offline exactly-once — same handle as the task-scoped sibling, so
            // one outbox item can be replayed against either route.
            const idempotencyKey = req.headers.get('Idempotency-Key') || undefined;
            const row = await createParcelWeedObservation(
                ctx,
                {
                    parcelId: params.parcelId,
                    observedAt: new Date(body.observedAt),
                    weeds: body.weeds,
                    notes: body.notes ?? null,
                },
                undefined,
                idempotencyKey,
            );
            return jsonResponse({ id: row.id }, { status: 201 });
        },
    ),
);

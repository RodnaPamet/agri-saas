import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { createParcelWeedObservation } from '@/app-layer/usecases/parcel-history';
import { CreateTaskWeedObservationSchema } from '@/app-layer/schemas/parcel-history.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * `POST /api/t/{tenantSlug}/tasks/{taskId}/weed-observations` — record the
 * weeds met while doing a task, from inside the task.
 *
 * ## Why this exists beside the parcel-scoped route
 *
 * `POST /agro/parcels/{parcelId}/weed-observations` writes the same row and
 * requires general write permission. A MECHANISATOR has none, so closing their
 * own task — the one moment someone is actually standing in the field looking
 * at the weeds — returned 403 on the only write the closing form makes. Owner
 * decision 2026-10-08: scoped to assigned tasks.
 *
 * This route is the SCOPE. It is not a copy of the parcel route with a looser
 * check: the task id in the path is what bounds the widened permission, which
 * is why it is a path segment rather than an optional body field. An optional
 * field that grants authorization when present makes omitting it the safe
 * default instead of the enforced one.
 *
 * ## The parcel set has one definition
 *
 * `parcelId` is checked against `taskParcelIds` — the same function behind
 * `GET /tasks/{taskId}/parcels`. So the parcels a client can draw on the map
 * are exactly the parcels it can post against, and the two cannot drift. A
 * parcel outside that set is `PARCEL_NOT_ON_TASK`, a 400: the request is
 * mis-addressed, which is a client error, not a permission one.
 */
export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateTaskWeedObservationSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; taskId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const row = await createParcelWeedObservation(
                ctx,
                {
                    parcelId: body.parcelId,
                    observedAt: new Date(body.observedAt),
                    weeds: body.weeds,
                    notes: body.notes ?? null,
                },
                { taskId: params.taskId },
            );
            return jsonResponse({ id: row.id }, { status: 201 });
        },
    ),
);

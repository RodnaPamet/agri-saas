import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { recordDiaryTreatment } from '@/app-layer/usecases/diary-treatment';
import { withValidatedBody } from '@/lib/validation/route';
import { RecordDiaryTreatmentSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * Record a treatment already carried out — the two-step «Нов запис» (#1740).
 *
 * Sits under `journal/` rather than `field-operations/` because this is the
 * ДНЕВНИК's own create: the farmer is filling in the register, and what the
 * write composes underneath (one field operation per block, a completed line
 * per parcel) is an implementation of that rather than the thing being asked
 * for.
 *
 * `Idempotency-Key` is the TREATMENT HANDLE, which is the one thing about this
 * route that differs from its neighbour. The handle is returned, so a client
 * that lost the 200 can address the treatment it just wrote; `Task` is
 * `@@unique([tenantId, clientMutationId])`, so the per-block idempotency keys
 * are DERIVED from it and a replay resolves on the handle rather than on any
 * one of them.
 */
export const POST = withApiErrorHandling(
    withValidatedBody(
        RecordDiaryTreatmentSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'JOURNAL');
            const idempotencyKey = req.headers.get('Idempotency-Key') || undefined;
            const result = await recordDiaryTreatment(ctx, body, idempotencyKey);
            return jsonResponse(result, { status: 201 });
        },
    ),
);

import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { recordFarmActivity } from '@/app-layer/usecases/farm-activity';
import { withValidatedBody } from '@/lib/validation/route';
import { RecordFarmActivitySchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * Record a non-chemical activity already carried out — #2316 / agrent-ios #439.
 *
 * Sits beside `journal/treatments` rather than under `field-operations/` for
 * the same reason that one does: the farmer is filling in the register, and
 * what the write composes underneath — one field operation per block, a
 * completed line per parcel — is an implementation of that rather than the
 * thing being asked for.
 *
 * `Idempotency-Key` is the ACTIVITY HANDLE, exactly as it is the treatment
 * handle next door. The handle is returned, so a client that lost the 200 can
 * address what it just wrote; `Task` is `@@unique([tenantId, clientMutationId])`
 * so the per-block keys are DERIVED from it and a replay resolves on the handle
 * rather than on any one of them.
 *
 * ## Why this is a separate route from `journal/treatments`
 *
 * Not symmetry — the two writes refuse different things. A treatment requires a
 * product, a dose and a unit, and for a pesticide a ЗЗР registration and a
 * quarantine period; an activity must carry NONE of them. Serving both from one
 * route would mean seven conditionally-valid fields on a schema whose mirror
 * (`CorrectDiaryTreatmentSchema`) tracks it field for field, which is a lot of
 * new ways to admit a half-filled chemical record — the thing #2316's CHECK
 * exists to prevent.
 *
 * `SEED` is deliberately NOT here: сеитба applies a seed product at a rate and
 * belongs on the treatments route, where the form's «Продукт» column gets the
 * sown variety (owner, 2026-10-25). `tests/guards/field-operation-type-mirrors`
 * holds this route's kinds against `BARE_ACTIVITY_KINDS` so that cannot drift.
 */
export const POST = withApiErrorHandling(
    withValidatedBody(
        RecordFarmActivitySchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'JOURNAL');
            const idempotencyKey = req.headers.get('Idempotency-Key') || undefined;
            const result = await recordFarmActivity(ctx, body, idempotencyKey);
            return jsonResponse(result, { status: 201 });
        },
    ),
);

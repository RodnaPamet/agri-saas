import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { restoreDiaryTreatment } from '@/app-layer/usecases/diary-treatment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * Put a withdrawn treatment back — «Кошче» (#2175).
 *
 * POST rather than DELETE-with-a-flag or PUT: restoring is an action on a
 * resource rather than a replacement of it, and the journal's own
 * `/journal/{id}/restore` is already POST. Matching the sibling matters more
 * here than REST purity, because a client reading one and guessing the other
 * is how #1087 happened.
 *
 * The handle is in the PATH for the reason the GET next door records: iOS writes
 * the full URL including the query string to the device log, unsuppressably.
 *
 * Authorisation lives in the usecase, not here — the decision needs the rows to
 * say who recorded the treatment, and the same gate guards the delete, so
 * whoever could withdraw it can put it back.
 */
export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; treatmentGroupId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'JOURNAL');
        const result = await restoreDiaryTreatment(ctx, params.treatmentGroupId);
        return jsonResponse(result);
    },
);

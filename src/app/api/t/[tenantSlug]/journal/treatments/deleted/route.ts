import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listDeletedTreatments } from '@/app-layer/usecases/diary-treatment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * The «Кошче» listing: treatments that were withdrawn and can be put back
 * (#2175).
 *
 * ## `deleted` is a STATIC segment beside a dynamic sibling
 *
 * `../[treatmentGroupId]/route.ts` would otherwise claim this path. Next
 * resolves a static segment before a dynamic one at the same level, so this
 * wins — and the ambiguity is theoretical anyway: a handle is a server-minted
 * UUID or a client `Idempotency-Key`, neither of which is the word `deleted`.
 *
 * Spelled out because the alternative reads as safer and is worse: a
 * `?deleted=1` flag on a collection GET would put a filter in the query string
 * of a route iOS logs in full, and there is no collection GET here to hang it
 * on — `treatments/route.ts` serves POST only.
 *
 * Read-gated in the usecase. It names no parcels, products or people beyond the
 * user id that performed the deletion, so it carries nothing a journal reader
 * could not already see.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'JOURNAL');
        return jsonResponse(await listDeletedTreatments(ctx));
    },
);

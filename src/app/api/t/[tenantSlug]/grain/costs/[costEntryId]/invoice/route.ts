import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { uploadCostInvoice, detachCostInvoice } from '@/app-layer/usecases/cost-entry';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

type Ctx = { params: Promise<{ tenantSlug: string; costEntryId: string }> };

/**
 * The invoice attached to a cost entry (GRAIN module).
 *
 *   POST   multipart/form-data → uploads the file, mints the FileRecord
 *          through the shared storage pipeline, and points the entry at it.
 *   DELETE → detaches it. The FileRecord SURVIVES — see the usecase.
 *
 * Multipart is handled HERE rather than by a generic upload endpoint
 * because this repo has none: every multipart route mints its FileRecord
 * inline as part of an entity-specific write. Attaching an ALREADY-stored
 * file by id is served by PATCH on the parent route, which runs the same
 * `assertUsableInvoice` gate (tenant + STORED + not deleted).
 */
export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await assertModuleEnabled(ctx, 'GRAIN');

    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
        throw badRequest('Invoice upload requires multipart/form-data');
    }

    const formData = await req.formData();
    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
        throw badRequest('Missing or invalid file in form data');
    }

    const record = await uploadCostInvoice(ctx, params.costEntryId, file);
    return jsonResponse(record, { status: 201 });
});

export const DELETE = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await assertModuleEnabled(ctx, 'GRAIN');
    const record = await detachCostInvoice(ctx, params.costEntryId);
    return jsonResponse(record);
});

/**
 * POST /api/t/[tenantSlug]/evidence/uploads
 * Multipart upload: file + optional metadata fields.
 * Creates FileRecord + Evidence(FILE) in one flow.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { uploadEvidenceFile } from '@/app-layer/usecases/evidence';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);

    const formData = await req.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
        return jsonResponse(
            { error: 'Missing or invalid file in form data' },
            { status: 400 },
        );
    }

    const metadata = {
        title: formData.get('title') as string | undefined,
        controlId: formData.get('controlId') as string | null,
        taskId: formData.get('taskId') as string | null,
        assetId: formData.get('assetId') as string | null,
        category: formData.get('category') as string | null,
        // B8 follow-up — folder rides with the upload form so a
        // batch upload writes the same folder onto every row.
        folder: formData.get('folder') as string | null,
        owner: formData.get('owner') as string | null,
        reviewCycle: formData.get('reviewCycle') as string | null,
        nextReviewDate: formData.get('nextReviewDate') as string | null,
    };

    const evidence = await uploadEvidenceFile(ctx, file, metadata);
    return jsonResponse(evidence, { status: 201 });
});

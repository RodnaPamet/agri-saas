import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { verifyFileIntegrity } from '@/app-layer/usecases/file-integrity';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * The `[fileName]` segment now carries a FileRecord ID, not a path.
 *
 * It was a raw storage path, and Next decodes %2F inside dynamic segments —
 * so the segment could express any key on the shared local volume. The
 * usecase resolves the id tenant-filtered and asserts the tenant key, so the
 * value here is an opaque identifier and nothing is derived from its shape.
 */
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; fileName: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    const expectedHash = url.searchParams.get('hash') || undefined;
    const result = await verifyFileIntegrity(ctx, params.fileName, expectedHash);
    return jsonResponse(result);
});

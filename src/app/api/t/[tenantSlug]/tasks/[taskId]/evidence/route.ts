import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getTaskEvidenceTab, linkTaskEvidence } from '@/app-layer/usecases/task';
import { withValidatedBody } from '@/lib/validation/route';
import { LinkTaskEvidenceSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

// GET — task Evidence-tab payload `{ links, evidence }`, mirroring the
// practice evidence tab so the shared <EvidenceSubTable> renders it.
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; taskId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const data = await getTaskEvidenceTab(ctx, params.taskId);
    return jsonResponse(data);
});

// POST — attach a URL as evidence on the task. File uploads go through
// the multipart /evidence/uploads endpoint with a taskId.
export const POST = withApiErrorHandling(withValidatedBody(LinkTaskEvidenceSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; taskId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const evidence = await linkTaskEvidence(ctx, params.taskId, body);
    return jsonResponse(evidence, { status: 201 });
}));

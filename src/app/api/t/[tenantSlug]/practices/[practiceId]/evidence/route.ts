import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getPracticeEvidenceTab, linkEvidence } from '@/app-layer/usecases/practice';
import { withValidatedBody } from '@/lib/validation/route';
import { LinkEvidenceSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

// GET — combined Evidence-tab payload (#102 item 1): `{ links, evidence }`.
// The evidence-link list and the directly-attached Evidence entities
// both used to ride on the eager practice page-data payload.
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const data = await getPracticeEvidenceTab(ctx, params.practiceId);
    return jsonResponse(data);
});

export const POST = withApiErrorHandling(withValidatedBody(LinkEvidenceSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const link = await linkEvidence(ctx, params.practiceId, body);
    return jsonResponse(link, { status: 201 });
}));

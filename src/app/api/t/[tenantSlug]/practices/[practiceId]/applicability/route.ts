import { getTenantCtx } from '@/app-layer/context';
import { setPracticeApplicability } from '@/app-layer/usecases/practice';
import { withValidatedBody } from '@/lib/validation/route';
import { SetPracticeApplicabilitySchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(withValidatedBody(SetPracticeApplicabilitySchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const practice = await setPracticeApplicability(ctx, params.practiceId, body.applicability, body.justification ?? null);
    return jsonResponse(practice);
}));

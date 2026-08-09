import { getTenantCtx } from '@/app-layer/context';
import { setPracticeStatus } from '@/app-layer/usecases/practice';
import { withValidatedBody } from '@/lib/validation/route';
import { SetPracticeStatusSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(withValidatedBody(SetPracticeStatusSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const practice = await setPracticeStatus(ctx, params.practiceId, body.status);
    return jsonResponse(practice);
}));

import { getTenantCtx } from '@/app-layer/context';
import { setPracticeOwner } from '@/app-layer/usecases/practice';
import { withValidatedBody } from '@/lib/validation/route';
import { SetPracticeOwnerSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(withValidatedBody(SetPracticeOwnerSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const practice = await setPracticeOwner(ctx, params.practiceId, body.ownerUserId);
    return jsonResponse(practice);
}));

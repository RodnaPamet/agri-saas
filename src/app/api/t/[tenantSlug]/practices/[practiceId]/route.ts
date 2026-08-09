import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getPractice, updatePractice } from '@/app-layer/usecases/practice';
import { withValidatedBody } from '@/lib/validation/route';
import { UpdatePracticeSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const practice = await getPractice(ctx, params.practiceId);
    return jsonResponse(practice);
});

export const PATCH = withApiErrorHandling(withValidatedBody(UpdatePracticeSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const practice = await updatePractice(ctx, params.practiceId, body);
    return jsonResponse(practice);
}));

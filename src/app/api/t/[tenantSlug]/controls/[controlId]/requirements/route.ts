import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { mapRequirementToPractice, unmapRequirementFromPractice, listPracticeMappings } from '@/app-layer/usecases/practice';
import { withValidatedBody } from '@/lib/validation/route';
import { MapRequirementSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

// GET — framework mappings for the practice (#102 item 1, Mappings tab).
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const mappings = await listPracticeMappings(ctx, params.practiceId);
    return jsonResponse(mappings);
});

export const POST = withApiErrorHandling(withValidatedBody(MapRequirementSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const mapping = await mapRequirementToPractice(ctx, params.practiceId, body.requirementId);
    return jsonResponse(mapping, { status: 201 });
}));

export const DELETE = withApiErrorHandling(withValidatedBody(MapRequirementSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await unmapRequirementFromPractice(ctx, params.practiceId, body.requirementId);
    return jsonResponse({ success: true });
}));

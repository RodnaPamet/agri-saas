import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { mapAssetToPractice } from '@/app-layer/usecases/traceability';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

// Link-only route — the read side is served by `/assets/[id]/traceability`
// (TraceabilityPanel reads that); the GET list handler was dead and removed.
const LinkSchema = z.object({
    practiceId: z.string().min(1),
    coverageType: z.enum(['FULL', 'PARTIAL', 'UNKNOWN']).optional(),
    rationale: z.string().optional(),
}).strip();

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const body = LinkSchema.parse(await req.json());
    return jsonResponse(await mapAssetToPractice(ctx, params.id, body.practiceId, body.coverageType, body.rationale), { status: 201 });
});

import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { createDataStream, listDataStreams } from '@/app-layer/usecases/data-stream';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { CreateDataStreamSchema } from '@/lib/schemas';



export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const streams = await listDataStreams(ctx);
        return jsonResponse(streams);
    },
);

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const body = CreateDataStreamSchema.parse(await req.json());
        const created = await createDataStream(ctx, body);
        return jsonResponse(created, { status: 201 });
    },
);

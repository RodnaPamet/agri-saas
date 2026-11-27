import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    getProcessMap,
    saveProcessMap,
    setProcessMapCanvasMode,
    deleteProcessMap,
} from '@/app-layer/usecases/process-map';
import { withValidatedBody } from '@/lib/validation/route';
import { SaveProcessMapSchema } from '@/app-layer/schemas/process-map';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { PatchProcessMapSchema } from '@/app-layer/schemas/process-map';


export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const map = await getProcessMap(ctx, params.id);
        return jsonResponse(map);
    },
);

export const PUT = withApiErrorHandling(
    withValidatedBody(
        SaveProcessMapSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const map = await saveProcessMap(ctx, params.id, body);
            return jsonResponse(map);
        },
    ),
);

export const PATCH = withApiErrorHandling(
    withValidatedBody(
        PatchProcessMapSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await setProcessMapCanvasMode(ctx, params.id, body.canvasMode);
            return jsonResponse(result);
        },
    ),
);

export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const result = await deleteProcessMap(ctx, params.id);
        return jsonResponse(result);
    },
);

import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getItemDetail, updateItem } from '@/app-layer/usecases/catalog';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { UpdateItemSchema } from '@/app-layer/schemas/catalog.schemas';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; itemId: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'INVENTORY');
        const item = await getItemDetail(ctx, params.itemId);
        return jsonResponse(item);
    },
);

export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdateItemSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; itemId: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'INVENTORY');
            const item = await updateItem(ctx, params.itemId, body);
            return jsonResponse(item);
        },
    ),
);

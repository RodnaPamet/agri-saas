import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listItems, createItem } from '@/app-layer/usecases/catalog';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { z } from 'zod';
import { ItemQuerySchema, CreateItemSchema } from '@/app-layer/schemas/catalog.schemas';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const query = ItemQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
    const items = await listItems(ctx, { category: query.category, q: query.q });
    return jsonResponse(items);
});

export const POST = withApiErrorHandling(
    withValidatedBody(CreateItemSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'INVENTORY');
        const item = await createItem(ctx, body);
        return jsonResponse(item, { status: 201 });
    }),
);

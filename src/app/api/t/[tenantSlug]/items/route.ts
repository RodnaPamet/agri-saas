import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listItems, createItem } from '@/app-layer/usecases/catalog';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';
import { z } from 'zod';
import { ItemQuerySchema, CreateItemSchema } from '@/app-layer/schemas/catalog.schemas';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const query = ItemQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
    const items = await listItems(ctx, { category: query.category, q: query.q });
    // An ETag-bearing response rather than a plain one (#1845). This read is now
    // on `PERSISTABLE_PATHS`, so a phone keeps it across launches and
    // revalidates on open — and without an ETag that revalidation is a
    // FULL body, not a 304. That is the whole cost argument the 24h age
    // rests on, and CLAUDE.md's rule for a cacheable list GET.
    return jsonWithETag(req, items);
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

import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listLots, listLotsPaginated, createLot } from '@/app-layer/usecases/inventory';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { z } from 'zod';
import { LotQuerySchema, CreateLotSchema } from '@/app-layer/schemas/inventory.schemas';



export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'INVENTORY');
        const q = LotQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
        // Dual-mode (mirrors /locations): ?limit=/?cursor= → cursor page,
        // bare GET → the full array (backward-compatible).
        if (q.limit || q.cursor) {
            const page = await listLotsPaginated(ctx, { limit: q.limit, cursor: q.cursor, itemId: q.itemId });
            return jsonResponse(page);
        }
        const lots = await listLots(ctx, { itemId: q.itemId });
        return jsonResponse(lots);
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateLotSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'INVENTORY');
            const lot = await createLot(ctx, body);
            return jsonResponse(lot, { status: 201 });
        },
    ),
);

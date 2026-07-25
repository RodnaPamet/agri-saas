import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getItemDetail, updateItem } from '@/app-layer/usecases/catalog';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { z } from 'zod';

const UpdateItemSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        category: z
            .enum(['SEED', 'PESTICIDE', 'FERTILIZER', 'AMENDMENT', 'FUEL', 'HARVESTED_PRODUCE', 'OTHER'])
            .optional(),
        defaultUnitId: z.string().min(1).optional(),
        sku: z.string().max(120).nullable().optional(),
        reorderLevel: z.number().nonnegative().nullable().optional(),
        // БАБХ farm-record regulatory fields (structured).
        quarantinePeriodDays: z.number().int().nonnegative().nullable().optional(),
        activeIngredient: z.string().max(200).nullable().optional(),
        pppRegistrationNo: z.string().max(120).nullable().optional(),
    })
    .strip();

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

import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { listAllPromotions, createPromotion } from '@/app-layer/usecases/promotion-admin';
import { CreatePromotionSchema } from '@/app-layer/schemas/promotion-admin.schemas';

/**
 * Platform-support curation of the GLOBAL promotions feed (#12).
 *
 * TWO gates, both load-bearing. `requirePermission('admin.manage')` is
 * necessary but NOT sufficient — permissions resolve from Role, so every
 * tenant's admin holds it. `assertPlatformSupport(ctx)` is the actual practice:
 * it restricts this to the designated platform tenant and 404s everywhere else,
 * so an unrelated tenant's owner is not even told the console exists.
 */
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        assertPlatformSupport(ctx);
        return jsonResponse({ promotions: await listAllPromotions(ctx) });
    }),
);

export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        assertPlatformSupport(ctx);
        const input = CreatePromotionSchema.parse(await req.json());
        const promotion = await createPromotion(ctx, input);
        return jsonResponse({ id: promotion.id }, { status: 201 });
    }),
);

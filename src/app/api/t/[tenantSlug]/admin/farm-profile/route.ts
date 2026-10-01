import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getFarmProfile, upsertFarmProfile } from '@/app-layer/usecases/farm-profile';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { UpdateFarmProfileSchema } from '@/app-layer/schemas/farm-profile.schemas';


export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        return jsonResponse(await getFarmProfile(ctx));
    }),
);

export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = UpdateFarmProfileSchema.parse(await req.json());
        return jsonResponse(await upsertFarmProfile(ctx, body));
    }),
);

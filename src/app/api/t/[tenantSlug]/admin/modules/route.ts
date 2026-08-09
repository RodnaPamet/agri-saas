import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getModuleSettings, setEnabledModules } from '@/app-layer/usecases/modules';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { z } from 'zod';

const UpdateModulesSchema = z.object({
    enabledModules: z.array(
        z.enum(['JOURNAL', 'INVENTORY', 'PLANNING', 'CERTIFICATION', 'VENDORS', 'AUTOMATION', 'PROCESSES', 'AI']),
    ),
}).strip();

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        return jsonResponse(await getModuleSettings(ctx));
    }),
);

export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = UpdateModulesSchema.parse(await req.json());
        const result = await setEnabledModules(ctx, body.enabledModules);
        return jsonResponse(result);
    }),
);

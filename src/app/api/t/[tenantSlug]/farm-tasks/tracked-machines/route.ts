/**
 * The drivers' transparency notice — #2948 stage 3b, the owner's requirement.
 *
 * NAMES AND TYPES ONLY. No positions, no IMEI, no last-seen. This exists to
 * discharge a transparency duty, not to give anybody a map — which is why it
 * is the one machine read every role may call, the operator persona included.
 *
 * It answers for the WHOLE TENANT rather than one task, and that is the point:
 * a driver is entitled to know which machines are tracked, not merely the one
 * they happen to be on today.
 *
 * A STATIC segment beside `[taskId]`. Next resolves static before dynamic, so
 * `tracked-machines` can never be read as a task id and neither route has to
 * inspect the other's.
 */
import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { listTrackedMachines } from '@/app-layer/usecases/task-machines';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        return jsonWithETag(req, await listTrackedMachines(ctx));
    },
);

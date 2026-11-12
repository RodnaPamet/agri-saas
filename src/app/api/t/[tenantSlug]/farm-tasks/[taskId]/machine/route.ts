/**
 * The machine on the caller's own open task — #2948 stage 3b.
 *
 * Under `/farm-tasks` and NOT `/machines`, deliberately:
 * `isOperatorAllowedPath`'s API branch admits `farm-tasks` and no `machines`
 * prefix, so this is reachable by the MECHANISATOR and everything under
 * `/machines` is refused `operator_scope` at the Edge. Moving it would make it
 * unreachable for the only role that needs it.
 *
 * `getTenantCtx` rather than `requirePermission`, because the rule is
 * ASSIGNMENT — "the machine on their own current task" — which no permission
 * flag expresses. The checks live in the usecase, and every refusal is the
 * same 404 as a task that does not exist.
 */
import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { readTaskMachine } from '@/app-layer/usecases/task-machines';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; taskId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        return jsonWithETag(req, await readTaskMachine(ctx, params.taskId));
    },
);

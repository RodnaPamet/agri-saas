/**
 * The locatable machines on a task, and whether each is findable — #2948
 * stage 3b.
 *
 * GET only. Writing a task's assets is an ADMIN action and a later stage; a
 * route that accepted a write here would be gated by nothing, because this
 * file deliberately carries no `requirePermission` — opening a path opens
 * every method on it, which is CLAUDE.md's C.1b rule and the thing this repo
 * has missed nine times.
 *
 * Wider audience than the sibling `/machine` read, and safe to be: this
 * carries CONFIGURATION and no coordinates, so it answers "which of these is
 * findable" without saying where anything is.
 */
import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { listTaskAssets } from '@/app-layer/usecases/task-machines';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; taskId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        return jsonWithETag(req, await listTaskAssets(ctx, params.taskId));
    },
);

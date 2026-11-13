/**
 * The locatable machines on a task, and the write that puts one there — #2948
 * stage 3b (GET) and #3026 (POST).
 *
 * **The two methods have DIFFERENT audiences, and that is the whole shape of
 * this file.** The GET is wider and safe to be: it carries CONFIGURATION and no
 * coordinates, so it answers "which of these is findable" without saying where
 * anything is, and a MECHANISATOR reaches it for their own open task. The POST
 * is `machines.manage` — OWNER and ADMIN only.
 *
 * So the permission wrapper is PER EXPORT, never on the file. This docblock used
 * to say writing here "would be gated by nothing, because this file
 * deliberately carries no `requirePermission`", and that was the condition for
 * adding one: opening a path opens every method on it (CLAUDE.md's C.1b rule,
 * missed nine times in this repo), so the write arrived WITH its own rule
 * rather than inheriting the read's absence of one.
 *
 * `isOperatorAllowedPath` admits `/api/t/{slug}/farm-tasks/…` for the operator
 * persona, so the middleware does NOT keep a MECHANISATOR out of this path.
 * `requirePermission` is the only thing that does, which is exactly the C.1
 * arrangement and exactly how it gets missed.
 */
import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { attachTaskAsset, listTaskAssets } from '@/app-layer/usecases/task-machines';
import { AttachTaskAssetSchema } from '@/app-layer/schemas/task-machines.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';
import { requirePermission } from '@/lib/security/permission-middleware';

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

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; taskId: string }>(
        'machines.manage',
        async (req: NextRequest, { params }, ctx) => {
            const body = AttachTaskAssetSchema.parse(await req.json());
            return jsonResponse(await attachTaskAsset(ctx, params.taskId, body.assetId));
        },
    ),
);

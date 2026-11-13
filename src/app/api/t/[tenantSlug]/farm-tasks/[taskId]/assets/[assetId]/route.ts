/**
 * Detach a machine from a task — #3026.
 *
 * DELETE only, and `machines.manage` like its POST sibling: OWNER and ADMIN.
 * The asset id is in the PATH because a DELETE addresses a member of a
 * collection, which is the opposite of the person-block DELETE's body — that
 * one takes a body because iOS logs the full URL unsuppressably and a third
 * party's USER id in a device log is the disclosure P5.2b exists to prevent.
 * An asset id is the farm's own equipment, so the path is the right place for
 * it.
 *
 * Idempotent: detaching an absent pair answers 2xx with `wasAttached: false`.
 * The phone is an outbox client on rural LTE, so a repeated request is the
 * normal case, and a 404 for work already done would park a poison item in a
 * queue that has nothing wrong with it.
 */
import { NextRequest } from 'next/server';

import { detachTaskAsset } from '@/app-layer/usecases/task-machines';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

export const DELETE = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; taskId: string; assetId: string }>(
        'machines.manage',
        async (_req: NextRequest, { params }, ctx) =>
            jsonResponse(await detachTaskAsset(ctx, params.taskId, params.assetId)),
    ),
);

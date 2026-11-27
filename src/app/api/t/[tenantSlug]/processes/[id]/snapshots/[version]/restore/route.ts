import { getTenantCtx } from '@/app-layer/context';
import { restoreProcessMapSnapshot } from '@/app-layer/usecases/process-map';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';
import { RestoreProcessMapSnapshotSchema } from '@/app-layer/schemas/process-map';

/**
 * Epic P5-PR-B — restore the active map to a target snapshot.
 *
 * RestoreProcessMapSnapshotSchema: { expectedVersion: number } — the version the client
 * believes is current. Forwarded to `replaceGraph` so the
 * Epic-P1 optimistic-concurrency check still gates the write.
 *
 * Returns the freshly-saved map (now at the post-restore
 * version, which is `expectedVersion + 1` — never the target
 * version, since history is preserved by the snapshot system).
 */

export const POST = withApiErrorHandling(
    withValidatedBody(
        RestoreProcessMapSnapshotSchema,
        async (
            req,
            {
                params: paramsPromise,
            }: {
                params: Promise<{
                    tenantSlug: string;
                    id: string;
                    version: string;
                }>;
            },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const target = Number.parseInt(params.version, 10);
            if (!Number.isFinite(target) || target < 1) {
                throw badRequest('Invalid version');
            }
            const map = await restoreProcessMapSnapshot(
                ctx,
                params.id,
                target,
                body.expectedVersion,
            );
            return jsonResponse(map);
        },
    ),
);

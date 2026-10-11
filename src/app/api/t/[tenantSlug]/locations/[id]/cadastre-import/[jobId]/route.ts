/**
 * GET /api/t/[tenantSlug]/locations/[id]/cadastre-import/[jobId]
 *
 * Polled by the import modal while the off-thread `cadastre-import` job fetches
 * + parses + persists. Returns the BullMQ job state plus, on completion, the
 * result counters (imported, notFound) the modal needs; on failure the
 * `failedReason`. Tenant-pinned: a mismatched job is indistinguishable from
 * not-found so ids cannot be enumerated across tenants.
 */
import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { assertCanWrite } from '@/app-layer/policies/common';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { getQueue } from '@/app-layer/jobs/queue';
import { readFailureStamp } from '@/app-layer/jobs/failure-stamp';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string; jobId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        assertCanWrite(ctx);

        const queue = getQueue();
        const job = await queue.getJob(params.jobId);
        if (!job) {
            return jsonResponse({ error: 'Job not found' }, { status: 404 });
        }

        const payload = job.data as { tenantId?: string; locationId?: string };
        if (payload?.tenantId !== ctx.tenantId || payload?.locationId !== params.id) {
            return jsonResponse({ error: 'Job not found' }, { status: 404 });
        }

        const state = await job.getState();
        return jsonResponse({
            jobId: job.id,
            state,
            progress: job.progress,
            result: job.returnvalue ?? null,
            failedReason: job.failedReason ?? null,
            // #1447 — same stamp as the spatial-import poll. Wired here too
            // because `ImportJobStatus` is ONE schema shared by both routes:
            // documenting the fields and returning them from only one of the
            // two would make the spec lie about the other. The cadastre job's
            // codes are `CADASTRE_`-prefixed — the conditions overlap with the
            // upload path but the remedy does not.
            ...readFailureStamp(job.data, state),
        });
    },
);

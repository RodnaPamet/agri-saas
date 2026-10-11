/**
 * GET /api/t/[tenantSlug]/locations/[id]/spatial-import/[jobId]
 *
 * Polled by the import modal while the off-thread `spatial-import` job
 * parses + validates + persists the staged upload. Returns the BullMQ
 * job state plus, on completion, the result counters (parcelCount,
 * format, bounds) the modal needs to refresh the map; on failure, the
 * `failedReason` (a clear per-format / complexity / topology message).
 *
 * Tenant scoping: the job payload carries `tenantId`, so a job that
 * belongs to a different tenant is indistinguishable-from-not-found —
 * an adversary cannot enumerate sibling-tenant job ids by URL fuzzing.
 */
import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { assertCanWrite } from '@/app-layer/policies/common';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedNotFound } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';
import { getQueue } from '@/app-layer/jobs/queue';

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
            // CODED (#1447). The SAME code and message on BOTH branches here, and
            // no params to tell them apart — a security property rather than
            // laziness: a response distinguishing "no such job" from "that job
            // belongs to another tenant" would make job ids enumerable across
            // tenants.
            throw codedNotFound('IMPORT_JOB_NOT_FOUND', 'No such import job.');
        }

        // Tenant pin — same 404 shape on mismatch so job ids can't be
        // enumerated across tenants.
        const payload = job.data as { tenantId?: string; locationId?: string };
        if (payload?.tenantId !== ctx.tenantId || payload?.locationId !== params.id) {
            throw codedNotFound('IMPORT_JOB_NOT_FOUND', 'No such import job.');
        }

        const state = await job.getState();
        return jsonResponse({
            jobId: job.id,
            state,
            progress: job.progress,
            // BullMQ `returnvalue` is the executor's makeResult payload —
            // its `details` carries parcelCount / format / bounds.
            result: job.returnvalue ?? null,
            failedReason: job.failedReason ?? null,
        });
    },
);

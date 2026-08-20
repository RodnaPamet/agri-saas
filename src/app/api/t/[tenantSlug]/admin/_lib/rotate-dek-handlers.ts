/**
 * Shared handler bodies for the per-tenant DEK rotation routes.
 *
 * Both `/admin/tenant-dek-rotation` (canonical) and `/admin/rotate-dek`
 * (GAP-22 alias) wrap these handlers with their own
 * `requirePermission(...)` + `withApiErrorHandling(...)` chains. Two
 * URLs, one implementation. Each route file does its own wrapping so
 * the api-permission-coverage / admin-route-coverage guardrails see
 * the literal `requirePermission` text in each route.ts they scan
 * (the guardrails are text-match-based, not call-graph-based).
 *
 * The leading underscore in `_lib` keeps Next.js from treating this
 * directory as a routable segment.
 */

import { NextRequest, NextResponse } from 'next/server';
import { rotateTenantDek } from '@/lib/security/tenant-key-manager';
import { getQueue } from '@/app-layer/jobs/queue';
import { logEvent } from '@/app-layer/events/audit';
import { prisma } from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';

/**
 * Initiate a per-tenant DEK rotation. Synchronously swaps the
 * Tenant.encryptedDek + Tenant.previousEncryptedDek columns and
 * enqueues a `tenant-dek-rotation` BullMQ job for the re-encrypt
 * sweep. Returns 202 + the job id so callers can poll status.
 */
export async function rotateDekPostHandler(
    _req: NextRequest,
    _routeArgs: unknown,
    ctx: RequestContext,
): Promise<NextResponse> {
    const { jobId, tenantId } = await rotateTenantDek({
        tenantId: ctx.tenantId,
        initiatedByUserId: ctx.userId,
        requestId: ctx.requestId,
    });

    // User-facing audit row — captures attribution for the moment
    // the DEK was swapped (the security-relevant event, distinct
    // from the sweep job's STARTED/COMPLETED entries).
    await logEvent(prisma, ctx, {
        action: 'TENANT_DEK_ROTATED',
        entityType: 'TenantKey',
        entityId: tenantId,
        details: `Per-tenant DEK rotated by admin user ${ctx.userId}`,
        metadata: { jobId, sweepJob: 'tenant-dek-rotation' },
        detailsJson: {
            category: 'data_lifecycle',
            entityName: 'TenantKey',
            operation: 'rotated',
            summary: 'Per-tenant DEK rotated; re-encryption sweep queued',
            after: { jobId, sweepJob: 'tenant-dek-rotation' },
        },
    });

    return NextResponse.json(
        {
            status: 'queued',
            jobId,
            tenantId,
            initiatedByUserId: ctx.userId,
        },
        { status: 202 },
    );
}

/**
 * Poll the state of a previously-enqueued sweep job. Defends
 * against cross-tenant job-id guessing — even if an OWNER from
 * tenant A guesses a job id belonging to tenant B, the response is
 * 404 (not the leaked sibling-tenant payload).
 */
export async function rotateDekGetHandler(
    req: NextRequest,
    _routeArgs: unknown,
    ctx: RequestContext,
): Promise<NextResponse> {
    const url = new URL(req.url);
    const jobId = url.searchParams.get('jobId');
    if (!jobId) {
        return NextResponse.json(
            { error: { code: 'BAD_REQUEST', message: 'jobId required' } },
            { status: 400 },
        );
    }

    const queue = getQueue();
    const job = await queue.getJob(jobId);
    if (!job) {
        return NextResponse.json(
            {
                error: {
                    code: 'NOT_FOUND',
                    message: `No job with id ${jobId}`,
                },
            },
            { status: 404 },
        );
    }

    const payload = job.data as { tenantId?: string } | undefined;
    if (payload?.tenantId && payload.tenantId !== ctx.tenantId) {
        return NextResponse.json(
            {
                error: {
                    code: 'NOT_FOUND',
                    message: `No job with id ${jobId}`,
                },
            },
            { status: 404 },
        );
    }

    const state = await job.getState();
    const progress = job.progress;
    const returnvalue = job.returnvalue ?? null;
    const failedReason = job.failedReason ?? null;

    return NextResponse.json({
        jobId,
        state,
        progress,
        result: returnvalue,
        failedReason,
    });
}

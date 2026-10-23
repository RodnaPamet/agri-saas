/**
 * farm-record-pdf job (feat/farm-record-register) — regenerate a location's
 * current-season БАБХ ДНЕВНИК into its Farm-records register whenever a field
 * task auto-resolves. Enqueued fire-and-forget from `markOperationParcel`
 * (jobId `farm-record:<taskId>` dedups repeated transitions).
 *
 * Flow:
 *   1. Resolve the task's Location (TaskLink, entityType LOCATION). No link → no-op.
 *   2. Regenerate the WHOLE current-season diary (season start → now) so the
 *      register always holds a complete, current document — not a one-row
 *      fragment per task.
 *   3. Persist it via the shared `saveFarmRecordDiary` (FileRecord, domain
 *      'reports', `-auto` suffix), attributed to a real user (the task
 *      assignee/creator — FileRecord.uploadedByUserId is a required FK).
 *
 * INVARIANTS:
 *   - **NEVER throws** into the completion path. Task completion must not fail
 *     because PDF generation did (fail-open, like audit streaming). Any
 *     internal failure → a logged warn + a success JobRunResult no-op.
 *   - Missing FarmProfile / operator-cert data is logged as a warn (the diary
 *     still generates with blanks — paper reality).
 *
 * @module app-layer/jobs/farm-record-pdf
 */
import prisma from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { getPermissionsForRole } from '@/lib/permissions';
import {
    isRegisterEmptyRefusal,
    saveFarmRecordDiary,
} from '@/app-layer/reports/pdf/farm-record-diary';
import type { RequestContext } from '../types';
import type { JobRunResult, FarmRecordPdfPayload } from './types';

export interface FarmRecordPdfResult {
    result: JobRunResult;
    generated: boolean;
}

/** A system RequestContext scoped to a tenant + a real actor user. */
function makeSystemCtx(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `farm-record-pdf-${tenantId}-${Date.now()}`,
        userId,
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

/** Current-season window: Jan 1 of this year → today (ISO YYYY-MM-DD). */
function currentSeasonWindow(): { from: string; to: string } {
    const now = new Date();
    return {
        from: `${now.getUTCFullYear()}-01-01`,
        to: now.toISOString().slice(0, 10),
    };
}

/** Log missing farm-profile / operator-cert data as a warn (non-blocking). */
async function warnOnGaps(tenantId: string): Promise<void> {
    try {
        const [profile, certMember] = await Promise.all([
            prisma.farmProfile.findUnique({ where: { tenantId }, select: { eik: true, producerName: true } }),
            prisma.tenantMembership.findFirst({
                where: { tenantId, status: 'ACTIVE', applicatorCertNo: { not: null } },
                select: { id: true },
            }),
        ]);
        const gaps: string[] = [];
        if (!profile || !profile.producerName) gaps.push('farmProfile');
        if (!certMember) gaps.push('operatorCertificate');
        if (gaps.length) {
            logger.warn('farm-record-pdf: incomplete farm-record data (diary generated with blanks)', {
                component: 'job',
                jobName: 'farm-record-pdf',
                tenantId,
                gaps,
            });
        }
    } catch {
        /* gap check is best-effort — never affects generation */
    }
}

export async function runFarmRecordPdf(payload: FarmRecordPdfPayload): Promise<FarmRecordPdfResult> {
    const jobRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = performance.now();

    return runJob(
        'farm-record-pdf',
        async () => {
            const { tenantId, taskId } = payload;
            let generated = false;

            try {
                // Resolve the task's location + a real actor for attribution.
                const [link, task] = await Promise.all([
                    prisma.taskLink.findFirst({
                        where: { taskId, tenantId, entityType: 'LOCATION' },
                        select: { entityId: true },
                    }),
                    prisma.task.findFirst({
                        where: { id: taskId, tenantId },
                        select: { assigneeUserId: true, createdByUserId: true },
                    }),
                ]);

                const locationId = link?.entityId;
                const uploadedByUserId = task?.assigneeUserId ?? task?.createdByUserId ?? null;

                if (locationId && uploadedByUserId) {
                    await warnOnGaps(tenantId);
                    const { from, to } = currentSeasonWindow();
                    const ctx = makeSystemCtx(tenantId, uploadedByUserId);
                    const saved = await saveFarmRecordDiary(ctx, {
                        locationId,
                        from,
                        to,
                        auto: true,
                        uploadedByUserId,
                    });
                    await runInTenantContext(ctx, (db) =>
                        logEvent(db, ctx, {
                            action: 'FARM_RECORD_AUTOGENERATED',
                            entityType: 'FileRecord',
                            entityId: saved.fileRecordId,
                            details: `Auto-generated ДНЕВНИК for location ${locationId} (${from}…${to})`,
                            detailsJson: {
                                category: 'custom',
                                event: 'farm_record_autogenerated',
                                locationId,
                                taskId,
                                from,
                                to,
                            },
                        }),
                    );
                    generated = true;
                }
            } catch (err) {
                // A block with nothing in the window is not a failure (#2183).
                // The register is now REFUSED rather than rendered blank, so
                // this path is reached on every completion whose location had
                // a quiet season — which is ordinary. Warning about it would
                // teach an operator to ignore this job's warnings, and the one
                // that matters is the next line down.
                if (isRegisterEmptyRefusal(err)) {
                    logger.info('farm-record-pdf: nothing recorded in the window, no register written', {
                        component: 'job',
                        jobName: 'farm-record-pdf',
                        tenantId: payload.tenantId,
                        taskId: payload.taskId,
                    });
                } else {
                    // Fail-open: never surface into the completion path.
                    logger.warn('farm-record-pdf: auto-generation failed (task completion unaffected)', {
                        component: 'job',
                        jobName: 'farm-record-pdf',
                        tenantId: payload.tenantId,
                        taskId: payload.taskId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            const durationMs = Math.round(performance.now() - startMs);
            const result: JobRunResult = {
                jobName: 'farm-record-pdf',
                jobRunId,
                success: true,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs,
                itemsScanned: 1,
                itemsActioned: generated ? 1 : 0,
                itemsSkipped: generated ? 0 : 1,
                details: { generated },
            };
            return { result, generated };
        },
        { tenantId: payload.tenantId },
    );
}

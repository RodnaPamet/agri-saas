/**
 * Evidence retention notification job.
 * Finds evidence expiring within N days and creates reminder Tasks.
 * Idempotent: checks for existing tasks with same evidenceId link.
 *
 * Usage:
 *   import { runEvidenceRetentionNotifications } from '@/app-layer/jobs/retention-notifications';
 *   await runEvidenceRetentionNotifications({ days: 30 });           // all tenants
 *   await runEvidenceRetentionNotifications({ tenantId: 'xxx' });    // single tenant
 */
import { Prisma } from '@prisma/client';
import { formatDate } from '@/lib/format-date';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';
import { isNotificationsEnabled } from '../notifications/settings';
import { emitAutomationEvent } from '../automation';
import type { RequestContext } from '../types';
import { sanitizePlainText } from '@/lib/security/sanitize';

/** Fire-and-forget automation trigger — never blocks the notification job. */
function emitEvidenceTrigger(
    event: 'EVIDENCE_EXPIRING' | 'EVIDENCE_EXPIRED',
    ev: { id: string; tenantId: string; title: string },
    dateIso: string | null,
): Promise<void> {
    // The bus only reads ctx.tenantId + ctx.userId; a full context isn't
    // needed for a system-initiated event.
    const ctx = { tenantId: ev.tenantId, userId: null } as unknown as RequestContext;
    const meta = { entityType: 'Evidence', entityId: ev.id, actorUserId: null };
    const p =
        event === 'EVIDENCE_EXPIRING'
            ? emitAutomationEvent(ctx, {
                  event: 'EVIDENCE_EXPIRING',
                  ...meta,
                  data: { title: ev.title, retentionUntil: dateIso },
                  stableKey: `evidence-expiring-${ev.id}`,
              })
            : emitAutomationEvent(ctx, {
                  event: 'EVIDENCE_EXPIRED',
                  ...meta,
                  data: { title: ev.title, expiredAt: dateIso },
                  stableKey: `evidence-expired-${ev.id}`,
              });
    return p.catch(() => {
        /* best-effort: automation emission must never break the notification job */
    });
}

export interface RetentionNotificationOptions {
    tenantId?: string;
    days?: number;
}

export interface RetentionNotificationResult {
    scanned: number;
    tasksCreated: number;
    skippedDuplicate: number;
}

export async function runEvidenceRetentionNotifications(
    options: RetentionNotificationOptions = {},
): Promise<RetentionNotificationResult> {
    const days = options.days ?? 30;
    const futureDate = new Date(Date.now() + days * 86_400_000);

    const where: Prisma.EvidenceWhereInput = {
        retentionUntil: { not: null, lte: futureDate, gt: new Date() },
        isArchived: false,
        deletedAt: null,
    };
    if (options.tenantId) where.tenantId = options.tenantId;

    const expiring = await prisma.evidence.findMany({
        where,
        select: {
            id: true, tenantId: true, title: true, owner: true,
            retentionUntil: true,
        },
    });

    let tasksCreated = 0;
    let skippedDuplicate = 0;

    for (const ev of expiring) {
        // Check for existing task with same evidence link (idempotent)
        const existingTask = await prisma.task.findFirst({
            where: {
                tenantId: ev.tenantId,
                type: 'IMPROVEMENT',
                status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
                links: {
                    some: {
                        entityType: 'EVIDENCE',
                        entityId: ev.id,
                    },
                },
            } satisfies Prisma.TaskWhereInput,
        });

        if (existingTask) {
            skippedDuplicate++;
            continue;
        }

        // Create Task + link
        // retentionUntil is non-null: the where clause filters `retentionUntil: { not: null }`
        const daysLeft = Math.ceil((new Date(ev.retentionUntil!).getTime() - Date.now()) / 86_400_000);
        // KNOWN BUG: this create misses the required `createdByUserId`
        // field (Task.createdByUserId is NOT NULL). Background jobs have
        // no actor userId — a system-user sentinel is needed.
        // Tracked in #BUG-retention-task-creator.
        // `ev.title` is user-supplied and gets interpolated into
        // `Task.description`, an ENCRYPTED_FIELDS column. Encryption does not
        // protect the renderers that decrypt it, so sanitise the interpolated
        // value at the write — this job runs without a request context, so
        // there is no upstream usecase to have done it.
        const safeTitle = sanitizePlainText(ev.title);
        const task = await prisma.task.create({
            data: {
                tenantId: ev.tenantId,
                type: 'IMPROVEMENT',
                title: `Refresh expiring evidence: ${safeTitle}`,
                description: `Evidence "${safeTitle}" expires in ${daysLeft} days (${formatDate(ev.retentionUntil)}). Please upload refreshed evidence or extend the retention date.`,
                status: 'OPEN',
                priority: daysLeft <= 7 ? 'HIGH' : 'MEDIUM',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- createdByUserId missing: background job has no actor; requires system-user id (tracked #BUG-retention-task-creator)
            } as any,
        });

        // Create task link to evidence
        await prisma.taskLink.create({
            data: {
                taskId: task.id,
                tenantId: ev.tenantId,
                entityType: 'EVIDENCE',
                entityId: ev.id,
            },
        });

        // Enqueue EVIDENCE_EXPIRING email to tenant admins/editors
        // Tenant notification eligibility — skip if notifications are disabled.
        // Uses the same isNotificationsEnabled check as enqueue.ts and digest-dispatcher.
        try {
            const enabled = await isNotificationsEnabled(prisma, ev.tenantId);
            if (!enabled) {
                logger.info('retention notification suppressed — notifications disabled for tenant', {
                    component: 'retention-notifications',
                    tenantId: ev.tenantId,
                    evidenceId: ev.id,
                });
            } else {
                const members = await prisma.tenantMembership.findMany({
                    where: { tenantId: ev.tenantId, role: { in: ['ADMIN', 'EDITOR'] } },
                    include: { user: { select: { email: true, name: true } } },
                });

                // `practiceName` was previously looked up here but
                // never referenced in the notification body —
                // CodeQL `js/useless-assignment-to-local` caught it.
                // Removed the dead lookup; if a future template wants
                // the practice name, surface it through a single
                // `include: { practice: { select: { name: true } } }`
                // on the parent evidence query instead of a per-row
                // extra `prisma.practice.findUnique`.

                for (const m of members) {
                    if (!m.user.email) continue;
                    await prisma.notificationOutbox.create({
                        data: {
                            tenantId: ev.tenantId,
                            type: 'EVIDENCE_EXPIRING',
                            toEmail: m.user.email,
                            subject: `${daysLeft <= 7 ? '⚠️ ' : ''}Evidence expiring in ${daysLeft} day(s): ${ev.title}`,
                            bodyText: `Evidence "${ev.title}" expires in ${daysLeft} days. Please upload refreshed evidence or extend the retention date.`,
                            bodyHtml: null,
                            dedupeKey: `${ev.tenantId}:EVIDENCE_EXPIRING:${m.user.email}:${ev.id}:${new Date().toISOString().slice(0, 10)}`,
                        },
                    }).catch(() => {
                        // Silently skip duplicates (P2002)
                    });
                }
            }
        } catch (err) {
            logger.warn('failed to enqueue evidence expiring emails', { component: 'job' });
        }

        // Audit event
        await prisma.auditLog.create({
            data: {
                tenantId: ev.tenantId,
                entity: 'Evidence',
                entityId: ev.id,
                action: 'EVIDENCE_EXPIRING_SOON',
                details: JSON.stringify({ daysLeft, taskId: task.id, title: ev.title }),
            },
        });

        // Automation trigger — let rules fire on evidence going stale.
        await emitEvidenceTrigger(
            'EVIDENCE_EXPIRING',
            ev,
            ev.retentionUntil ? new Date(ev.retentionUntil).toISOString() : null,
        );

        tasksCreated++;
    }

    // Already-expired evidence → EVIDENCE_EXPIRED trigger (separate signal).
    const expiredWhere: Prisma.EvidenceWhereInput = {
        deletedAt: null,
        isArchived: false,
        expiredAt: { not: null, lt: new Date() },
    };
    if (options.tenantId) expiredWhere.tenantId = options.tenantId;
    const expired = await prisma.evidence.findMany({
        where: expiredWhere,
        select: { id: true, tenantId: true, title: true, expiredAt: true },
        take: 1000,
    });
    for (const ev of expired) {
        await emitEvidenceTrigger(
            'EVIDENCE_EXPIRED',
            ev,
            ev.expiredAt ? new Date(ev.expiredAt).toISOString() : null,
        );
    }

    return { scanned: expiring.length, tasksCreated, skippedDuplicate };
}

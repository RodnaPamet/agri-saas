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
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { formatDate } from '@/lib/format-date';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';
import { enqueueEmail } from '../notifications/enqueue';
import { isNotificationsEnabled } from '../notifications/settings';
import { emitAutomationEvent } from '../automation';
import type { RequestContext } from '../types';
import { withTenantDb } from '@/lib/db-context';
import { resolveSystemUserId } from '@/lib/auth/system-user';
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
            // An existence probe, so `id` and nothing else. Without a
            // `select` this returned every column — including `description`,
            // which is encrypted under the farm's DEK and comes back as a
            // `v2:` envelope here because this job binds no tenant. Nothing
            // reads it today, so that was latent rather than live; narrowing
            // means the first person to reach for `existingTask.description`
            // gets a type error instead of ciphertext (#2723).
            select: { id: true },
        });

        if (existingTask) {
            skippedDuplicate++;
            continue;
        }

        // Create Task + link
        // retentionUntil is non-null: the where clause filters `retentionUntil: { not: null }`
        const daysLeft = Math.ceil((new Date(ev.retentionUntil!).getTime() - Date.now()) / 86_400_000);
        // FIXED in #2729 — the create below now supplies `createdByUserId`
        // from `resolveSystemUserId`. The history is kept because the FAILURE
        // MODE is the reusable part: this comment once named
        // `#BUG-retention-task-creator`, a string that appeared nowhere else
        // in the repo — a known broken write recorded only in the comment
        // that caused it, where the careful explanation is precisely what
        // made it look handled. Scope left out is tracked only if it is an
        // OPEN ISSUE; a prose tracker is not one.
        // `ev.title` is user-supplied and gets interpolated into
        // `Task.description`, an ENCRYPTED_FIELDS column. Encryption does not
        // protect the renderers that decrypt it, so sanitise the interpolated
        // value at the write — this job runs without a request context, so
        // there is no upstream usecase to have done it.
        const safeTitle = sanitizePlainText(ev.title);
        /*
         * INSIDE the farm's context, and that is about the KEY (#2723).
         *
         * `Task.description` is in `ENCRYPTED_FIELDS`. With no tenant bound,
         * `resolveTenantDekPair` returns `NO_DEK_PAIR` — which on the WRITE
         * path is not "no key", it is the `v1:` GLOBAL-KEK fallback. Measured:
         * the same row written bound comes out `v2:`, unbound `v1:`.
         *
         * It reads back perfectly either way, because the extension dispatches
         * per value on the envelope — so nothing ever looked wrong. What was
         * lost is per-tenant key isolation, the property `GLOBAL_KEK_MODELS`
         * exists to protect and whose own comment says a tenant-scoped model
         * must not join that set "precisely because it would throw that
         * isolation away". This threw it away by accident, one row at a time.
         *
         * `withTenantDb` opens a transaction, so the task and its link now
         * commit together — previously a failure between them left a task with
         * no evidence link, which is the state the idempotence probe above
         * cannot see.
         */
        /*
         * #2729 — resolved BEFORE `withTenantDb`, and the ordering is the
         * whole point.
         *
         * `resolveSystemUserId` reads (and on first use writes) through the
         * GLOBAL client. Called inside the transaction below it would want a
         * SECOND pool connection while the first is held, which is #1191's
         * P0.8 deadlock: unreachable at low concurrency and guaranteed at
         * `PG_POOL_MAX`, surfacing as Prisma's `P2028` naming no pool. Same
         * ordering `prewarmTenantKeys` exists to guarantee for the DEK.
         */
        const systemUserId = await resolveSystemUserId(ev.tenantId);

        const task = await withTenantDb(ev.tenantId, async (db) => {
            const created = await db.task.create({
                data: {
                    tenantId: ev.tenantId,
                    type: 'IMPROVEMENT',
                    title: `Refresh expiring evidence: ${safeTitle}`,
                    description: `Evidence "${safeTitle}" expires in ${daysLeft} days (${formatDate(ev.retentionUntil)}). Please upload refreshed evidence or extend the retention date.`,
                    status: 'OPEN',
                    /*
                     * #2729 — `'HIGH'`/`'MEDIUM'` were NOT members of
                     * `WorkItemPriority` (`P0|P1|P2|P3`), so Prisma would have
                     * rejected this payload at runtime. The any-cast that hid
                     * the missing `createdByUserId` suppressed checking on the
                     * WHOLE object, so it hid this too — one cast, two
                     * defects, and `tsc` reported the second one the moment
                     * the cast came off.
                     *
                     * P1/P2 rather than P0 (owner, 2026-11-06): the two bands
                     * preserve the original urgent-versus-not intent, and P0
                     * stays for emergencies rather than being spent on a
                     * seven-day warning.
                     */
                    priority: daysLeft <= 7 ? 'P1' : 'P2',
                    /*
                     * The column is `String` NOT NULL with an FK to `User`, so
                     * the `userId: 'system'` sentinel the sibling jobs use in
                     * their `RequestContext` cannot satisfy it — that string
                     * names no row. Omitting it was cast past the compiler
                     * with a blanket any-cast, which is why this never failed
                     * to typecheck and would have failed at runtime instead.
                     */
                    createdByUserId: systemUserId,
                },
                select: { id: true },
            });
            await db.taskLink.create({
                data: {
                    taskId: created.id,
                    tenantId: ev.tenantId,
                    entityType: 'EVIDENCE',
                    entityId: ev.id,
                },
            });
            return created;
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
                    // `uiLanguage` — the expiry notice is written in each
                    // RECIPIENT's language (#694).
                    include: { user: { select: { email: true, name: true, uiLanguage: true } } },
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
                    // Goes through `enqueueEmail` like every other producer
                    // (#807). This used to build the strings inline and write
                    // `notificationOutbox` directly, which left
                    // `buildEmailContent`'s EVIDENCE_EXPIRING arm unreachable —
                    // #987 deleted that arm as dead, and the second half of
                    // #807 restored it around THESE strings.
                    //
                    // The dedupe key is unchanged: `buildDedupeKey` produces
                    // `tenantId:type:email:entityId:YYYY-MM-DD`, byte-identical
                    // to the literal this replaced, so the daily re-send still
                    // re-sends daily and an already-sent day still dedupes.
                    // P2002 is handled inside `enqueueEmail`, which returns
                    // null rather than throwing.
                    await enqueueEmail(prisma, {
                        tenantId: ev.tenantId,
                        type: 'EVIDENCE_EXPIRING',
                        toEmail: m.user.email,
                        locale: resolveRecipientLocale(m.user.uiLanguage),
                        entityId: ev.id,
                        payload: { title: ev.title, daysRemaining: daysLeft },
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

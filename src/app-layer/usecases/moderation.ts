/**
 * The moderation console's usecases (P5.4a, #1595).
 *
 * ## Everything here runs on the PRIVILEGED client, and that is the design
 *
 * `ModerationAction` and `StatementOfReasons` deny `app_user` for every
 * command, and `ContentReport` admits only a reporter reading their own row.
 * So there is no tenant or person context that could serve this surface — the
 * caller is a platform admin holding an API key, with no `User` in scope at
 * all.
 *
 * That is why `no-direct-prisma` needs an entry for this file: the global
 * handle is not a shortcut here, it is the only client the policies permit.
 * What stands in for RLS is the route gate (`verifyPlatformApiKey`), and the
 * thing to check in review is that nothing here takes a tenant or a user id
 * from a request body.
 *
 * ## `moderatorRef` is a key GENERATION, not a person
 *
 * There is one `PLATFORM_ADMIN_API_KEY` for every operator, so the most
 * precise attribution the credential model can produce is which generation
 * authorised the action — current or previous. It narrows a compromise window
 * to one side of a rotation and is strictly more than a constant.
 *
 * It is **not** a person, and for a DSA trail that is a real limit: a
 * regulator asking "who decided this" gets "somebody holding the key".
 * Per-moderator attribution needs per-moderator credentials — #1599 (P5.8)
 * owns that, and whatever it decides is what this field should carry.
 *
 * `#1553` DECISION 7 is why it is a string and not a `userId` FK: accepting a
 * caller-supplied id would put an unverified name in an attribution field,
 * which is worse than an honest opaque one.
 *
 * ## Acting and answering are one transaction
 *
 * `actOnNotice` writes the `ModerationAction` and moves the notice's `status`
 * together. A notice marked ACTIONED with no action row, or an action with a
 * notice still RECEIVED, are both states a triage queue cannot recover from by
 * looking — so neither is reachable.
 */
import { randomUUID } from 'node:crypto';

import prisma from '@/lib/prisma';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logger } from '@/lib/observability/logger';
import type { PlatformKeyGeneration } from '@/lib/auth/platform-admin';

export type ReportStatus = 'RECEIVED' | 'TRIAGED' | 'ACTIONED' | 'REJECTED';
export type ModerationActionKind =
    | 'NONE'
    | 'CONTENT_REMOVED'
    | 'CONTENT_DEMOTED'
    | 'ACCOUNT_SUSPENDED'
    | 'ACCOUNT_TERMINATED';

/** Page size when a caller pins none. Matches the other admin surfaces. */
const DEFAULT_QUEUE_PAGE = 50;

/** The attribution string stored on every action. See the module docblock. */
export function moderatorRefFor(generation: PlatformKeyGeneration): string {
    // Prefixed so the shape says what kind of thing it is. A bare "current"
    // in an attribution column would read as a person's handle.
    return `platform-key:${generation}`;
}

export interface QueuedNotice {
    id: string;
    createdAt: Date;
    subjectKind: string;
    subjectId: string;
    reasonCode: string;
    status: string;
    /** Whether the notifier gave an id. Never WHICH — see below. */
    anonymous: boolean;
    detail: string | null;
    /** Whether evidence was captured, and the reason if not. */
    snapshot: { capturedAt: Date; captureError: string | null } | null;
}

/**
 * The triage queue.
 *
 * Ordered oldest-first within a status, because the operational question is
 * "what has been waiting longest" — P5's exit criterion is a median handling
 * time, and a newest-first queue optimises the wrong end of it.
 *
 * `reporterUserId` is deliberately NOT returned. A moderator decides on the
 * CONTENT, and knowing who reported it invites deciding on the reporter —
 * which is also why DSA Art 16 notices are answerable without the notifier
 * being identifiable at all. `anonymous` is returned because it changes
 * whether there is anyone to answer to.
 */
export async function listNotices(opts: {
    status?: ReportStatus;
    /**
     * Optional, because `parseLimitParam` returns `undefined` for an absent
     * `?limit=` — that is its way of saying "use the default", and the default
     * belongs here rather than in each route.
     */
    limit?: number;
}): Promise<QueuedNotice[]> {
    const take = opts.limit ?? DEFAULT_QUEUE_PAGE;
    const rows = await prisma.contentReport.findMany({
        where: opts.status ? { status: opts.status } : undefined,
        // The index P5.1 shipped for exactly this: `[status, createdAt]`.
        orderBy: { createdAt: 'asc' },
        take,
        select: {
            id: true,
            createdAt: true,
            subjectKind: true,
            subjectId: true,
            reasonCode: true,
            status: true,
            detail: true,
            reporterUserId: true,
        },
    });

    // One query for the snapshots rather than one per notice.
    const snaps = rows.length
        ? await prisma.reportSnapshot.findMany({
            where: { reportId: { in: rows.map((r) => r.id) } },
            select: { reportId: true, capturedAt: true, captureError: true },
        })
        : [];
    const byReport = new Map(snaps.map((s) => [s.reportId, s]));

    return rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        subjectKind: r.subjectKind,
        subjectId: r.subjectId,
        reasonCode: r.reasonCode,
        status: r.status,
        // The FACT, not the identity.
        anonymous: r.reporterUserId === null,
        detail: r.detail,
        snapshot: byReport.has(r.id)
            ? {
                capturedAt: byReport.get(r.id)!.capturedAt,
                captureError: byReport.get(r.id)!.captureError,
            }
            : null,
    }));
}

/**
 * Record a decision on a notice.
 *
 * `NONE` is a real outcome and the reason `actionKind` is not nullable:
 * "looked and did nothing" must be distinguishable from "never looked", and an
 * absent row cannot express the first. A `NONE` action moves the notice to
 * REJECTED — the judgement — rather than leaving it RECEIVED.
 */
export async function actOnNotice(input: {
    reportId: string;
    actionKind: ModerationActionKind;
    rationale: string;
    generation: PlatformKeyGeneration;
}): Promise<{ actionId: string; status: ReportStatus }> {
    const report = await prisma.contentReport.findUnique({
        where: { id: input.reportId },
        select: { id: true, subjectKind: true, subjectId: true, status: true },
    });
    if (!report) return { actionId: '', status: 'RECEIVED' };

    const actionId = `ma-${randomUUID()}`;
    const status: ReportStatus = input.actionKind === 'NONE' ? 'REJECTED' : 'ACTIONED';

    // ONE transaction. A notice marked ACTIONED with no action row, or an
    // action whose notice still reads RECEIVED, are both states the queue
    // cannot tell from a crash — so neither is reachable.
    await prisma.$transaction([
        prisma.moderationAction.create({
            data: {
                id: actionId,
                reportId: report.id,
                moderatorRef: moderatorRefFor(input.generation),
                actionKind: input.actionKind,
                // Denormalised from the notice, never from the request. A
                // caller-supplied subject would let an action be recorded
                // against content it was not about.
                subjectKind: report.subjectKind,
                subjectId: report.subjectId,
                rationale: sanitizePlainText(input.rationale),
            },
        }),
        prisma.contentReport.update({
            where: { id: report.id },
            data: { status },
        }),
    ]);

    logger.info('moderation.acted', {
        component: 'moderation',
        reportId: report.id,
        actionId,
        actionKind: input.actionKind,
        // The generation, not a person — there is no person to log.
        generation: input.generation,
    });

    return { actionId, status };
}

/**
 * Queue a DSA Art 17 statement of reasons.
 *
 * Written with `deliveredAt` NULL. **The row IS the outbox**: the existing
 * `NotificationOutbox` is tenant-scoped with a non-nullable `tenantId`, and an
 * Art 17 statement is addressed to a PERSON who may have no farm or several —
 * resolving one would be inventing a tenant for a person-scoped obligation.
 *
 * P5.1 already shaped the column for this: "NULL until the push succeeds. The
 * gap between `createdAt` and this is the Art 17 delivery lag, which is a
 * thing a regulator can ask about." P5.4b drains it.
 *
 * Stored RENDERED rather than as a template reference, following the
 * `NotificationOutbox` precedent: what was sent is a fact, and re-rendering
 * later from a since-changed template answers a different question.
 */
export async function queueStatement(input: {
    actionId: string;
    recipientUserId: string;
    locale: string;
    bodyRendered: string;
}): Promise<{ statementId: string }> {
    const statementId = `sor-${randomUUID()}`;
    await prisma.statementOfReasons.create({
        data: {
            id: statementId,
            actionId: input.actionId,
            recipientUserId: input.recipientUserId,
            locale: input.locale,
            bodyRendered: sanitizePlainText(input.bodyRendered),
            // deliveredAt stays NULL. P5.4b stamps it.
        },
    });
    logger.info('moderation.statement_queued', {
        component: 'moderation',
        statementId,
        actionId: input.actionId,
        locale: input.locale,
    });
    return { statementId };
}

/**
 * Statements written and not yet delivered.
 *
 * The operational view this phase needs, and the reason `deliveredAt` is
 * nullable rather than a boolean: a statement that never went out is a
 * compliance failure the console has to SURFACE rather than hide, and P5's
 * exit criterion ("median notice handling under 24h") has to be measured from
 * `createdAt` to `deliveredAt` rather than asserted.
 *
 * `bodyRendered` is not returned. It is the delivered text, it is encrypted at
 * rest, and an undelivered-queue view needs to know THAT something is stuck,
 * not to re-read what it says.
 */
export async function listUndeliveredStatements(limit?: number): Promise<
    Array<{ id: string; actionId: string; recipientUserId: string; locale: string; createdAt: Date }>
> {
    return prisma.statementOfReasons.findMany({
        where: { deliveredAt: null },
        // Oldest first: the lag is the thing being measured.
        orderBy: { createdAt: 'asc' },
        take: limit ?? DEFAULT_QUEUE_PAGE,
        select: {
            id: true,
            actionId: true,
            recipientUserId: true,
            locale: true,
            createdAt: true,
        },
    });
}

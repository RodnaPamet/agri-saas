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
import { suspendAccountOnTx } from './account-suspension';
import { requestAccountDeletionOnTx } from './account-erasure';
import { appendPlatformAuditEntry } from '@/lib/audit/platform-audit-writer';
import { codedBadRequest } from '@/lib/errors/types';
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
    /**
     * How many notices exist about this subject, this one included (#1600).
     *
     * DISPLAY ONLY. `notice-score-is-shadow-only` covers this field alongside
     * `NoticeScore`: nothing may `orderBy` it, because report VOLUME deciding
     * which Art 16 notice a human reads first is a queue order a brigade can
     * drive. A moderator reading "5 notices about this listing" is the point;
     * the queue staying oldest-first is the constraint.
     *
     * Minimum 1, never 0 — the notice being displayed is itself one of them.
     */
    subjectNoticeCount: number;
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

    /**
     * How many notices exist about each SUBJECT on this page (#1600).
     *
     * ## Why this exists at all
     *
     * `PUBLIC_NOTICE_LIMIT`'s docblock justified NOT capping per-subject by
     * saying "P5.2 records a per-subject count without enforcing it, so a
     * threshold can be chosen from data", and #1600 asked for a test of "the
     * per-subject counter P5.2 records". **Neither was true**: nothing anywhere
     * computed such a count. The capability had been INDEXED for —
     * `ContentReport` carries `@@index([subjectKind, subjectId])`, commented
     * "the triage queue's two access paths" — and never built, so no threshold
     * could have been chosen from data. Both claims are corrected in the same
     * change as this.
     *
     * ## DISPLAY ONLY, and that is an owner ruling with teeth behind it
     *
     * A moderator sees it; nothing may order the queue by it. P5.5b drew that
     * line for the AI score and its guard's docblock says the violation to
     * expect is a SORT rather than a read, because "order the triage queue by
     * score" looks like an improvement and is an unevaluated signal deciding
     * which Art 16 notices a human sees first. A raw count is a fact rather
     * than a model output — but it is still a number a brigade can drive, and
     * `notice-score-is-shadow-only` would not have caught an `orderBy` on it.
     * It covers this field now too.
     *
     * ## One `groupBy`, scoped to the page
     *
     * Not one count per row (D1 forbids a read in a loop), and not a global
     * tally (unbounded). The `in` list is the page's own subjects, so the query
     * is bounded by `take` and served by the index above.
     */
    const subjectCounts = rows.length
        ? await prisma.contentReport.groupBy({
            by: ['subjectKind', 'subjectId'],
            where: {
                OR: rows.map((r) => ({ subjectKind: r.subjectKind, subjectId: r.subjectId })),
            },
            _count: { _all: true },
        })
        : [];
    const countKey = (kind: string, id: string) => `${kind}\u0000${id}`;
    const bySubject = new Map(
        subjectCounts.map((c) => [countKey(c.subjectKind, c.subjectId), c._count._all]),
    );

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
        /**
         * Total notices about this subject, including this one — so the
         * minimum is 1 and never 0. DISPLAY ONLY; see the `groupBy` above.
         */
        subjectNoticeCount: bySubject.get(countKey(r.subjectKind, r.subjectId)) ?? 1,
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
    /**
     * REQUIRED by `ActOnNoticeSchema` when the outcome withholds access.
     * Supplied, never derived: a notice names CONTENT, and a reported listing
     * belongs to a farm whose members are several — see the schema.
     */
    suspendUserId?: string;
}): Promise<{ actionId: string; status: ReportStatus; suspended?: boolean }> {
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
    //
    // INTERACTIVE since P5.9, where it was an array. The suspension has to be
    // in the SAME transaction as the decision that records it: an
    // `ACCOUNT_SUSPENDED` row with no suspension is #1635, and a suspension
    // with no row is an unexplained lockout. `suspendAccountOnTx` takes this
    // `tx` rather than opening its own, because a second pool connection
    // inside an open transaction is the #1191 P0.8 deadlock.
    let suspended: boolean | undefined;
    await prisma.$transaction(async (tx) => {
        await tx.moderationAction.create({
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
        });
        await tx.contentReport.update({
            where: { id: report.id },
            data: { status },
        });

        // ACCOUNT_TERMINATED withholds access too, so it suspends here as
        // well. The ERASURE half is P5.6 (#1597, now settled on the Art
        // 17(3)(b) basis) — so a terminated account is locked out today and
        // pseudonymised when that lands, rather than announced and left
        // reachable.
        if (input.actionKind === 'ACCOUNT_SUSPENDED'
            || input.actionKind === 'ACCOUNT_TERMINATED') {
            if (!input.suspendUserId) {
                // Unreachable through the route — `ActOnNoticeSchema`'s
                // refinement refuses it — and asserted here because this
                // usecase is also called directly by tests and could be
                // called by a future surface.
                //
                // A TYPED error, not `new Error`: `no direct Error throws in
                // usecases` caught that, and the coded form also lowers the
                // `no-server-authored-user-copy` count rather than merely not
                // raising it, because the message is a bare code.
                throw codedBadRequest('SUSPEND_TARGET_REQUIRED', 'SUSPEND_TARGET_REQUIRED');
            }
            const outcome = await suspendAccountOnTx(tx, {
                userId: input.suspendUserId,
                generation: input.generation,
                reason: input.rationale,
            });
            suspended = outcome.applied;

            // TERMINATED also FINALISES, owner ruling 2026-10-11. Suspension
            // alone made the Art 17 statement ("we closed your account") true
            // of access and not of the data; this makes it true of both, after
            // the 30-day grace P5.6b already operates.
            //
            // Safe against self-undo, which is the thing to check before
            // wiring a moderation outcome to a self-service path: a terminated
            // account is suspended, and `getUserCtx` → `getSessionOrThrow`
            // refuses `ACCOUNT_SUSPENDED`, so the person cannot reach
            // `DELETE /api/account/deletion` to cancel it.
            //
            // The accepted cost: 30 days becomes an effective deadline on DSA
            // redress for a termination, because an appeal upheld afterwards
            // has nothing left to restore. Anyone shortening that window is
            // shortening an appeal window.
            if (input.actionKind === 'ACCOUNT_TERMINATED') {
                // MODERATION, which is what makes the erasure uncancellable by
                // its subject (#1671). #1654 called this helper with no
                // initiator, so a termination wrote exactly what a person
                // asking to leave writes — and the only thing then stopping a
                // self-undo was the cancel route refusing a suspended account,
                // a side effect of a different control.
                await requestAccountDeletionOnTx(tx, input.suspendUserId, 'MODERATION');
            }
        }
    });

    // The hash-chained platform trail (#1619), BEST-EFFORT via `afterCommit`
    // — owner ruling. The decision has already committed, so a chain-writer
    // failure must not undo it; #1287 is the precedent where that writer failed
    // on 275 of 275 attempts under one runtime, and a moderation queue that
    // cannot be worked because an audit subsystem is sick is its own compliance
    // failure with the DSA clock running.
    //
    // The cost, stated so nobody rediscovers it: there is a crash window
    // between COMMIT and the drain in which a decision exists with no chain
    // entry. The gap is REPORTED (`audit.write_failed`, plus the counter) and
    // not prevented, and a verifier cannot tell "no entry was written" from
    // "nothing happened here".
    //
    // AWAITED directly, not through `afterCommit`, and that is a correction:
    // `afterCommit` only defers when a scope is open, and a scope is opened by
    // `db-context.ts`'s helpers (`runWithAfterCommit`), not by a bare
    // `prisma.$transaction` — which is what this usecase uses. With no scope
    // it fires `void runEffect(...)`: un-awaited, fire-and-forget. So the
    // append raced the caller's next read, and my first version of the test
    // saw zero chain rows.
    //
    // Placed AFTER the transaction either way, which is the property that
    // matters: a rolled-back decision cannot leave a suspension announced in
    // the chain.
    try {
        await appendPlatformAuditEntry({
            scope: 'moderation',
            action: 'MODERATION_ACTION_RECORDED',
            actorUserId: null,
            detailsJson: {
                actionId,
                reportId: report.id,
                actionKind: input.actionKind,
                moderatorRef: moderatorRefFor(input.generation),
                subjectKind: report.subjectKind,
                subjectId: report.subjectId,
                // The RATIONALE is not here. It is moderator free text and
                // `detailsJson` is not an encrypted column; it lives on
                // `ModerationAction.rationale`, which is.
                hasRationale: Boolean(input.rationale),
                ...(input.suspendUserId ? { suspendUserId: input.suspendUserId } : {}),
            },
        });
    } catch (err) {
        logger.error('moderation.audit_append_failed', {
            component: 'moderation',
            actionId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    logger.info('moderation.acted', {
        component: 'moderation',
        reportId: report.id,
        actionId,
        actionKind: input.actionKind,
        // The generation, not a person — there is no person to log.
        generation: input.generation,
    });

    return { actionId, status, ...(suspended === undefined ? {} : { suspended }) };
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
    // #1619 — the same `moderation` chain, best-effort for the same reason.
    //
    // A statement is a separate verb rather than a field on the action's entry:
    // Art 17 requires a decision to be EXPLAINED, so "decided" and "explained"
    // are two obligations and a regulator can be shown the second was met. An
    // action with no statement entry is then visible in the chain rather than
    // inferred from a missing field.
    //
    // No `afterCommit` here: `queueStatement` is a single `create` with no
    // transaction frame of its own, so `afterCommit` would fire inline anyway
    // (it runs the effect immediately when no scope is open). Calling directly
    // says that plainly instead of implying a deferral that does not happen.
    try {
        await appendPlatformAuditEntry({
            scope: 'moderation',
            action: 'MODERATION_STATEMENT_QUEUED',
            actorUserId: null,
            detailsJson: {
                statementId,
                actionId: input.actionId,
                recipientUserId: input.recipientUserId,
                locale: input.locale,
                // NOT `bodyRendered`: it is the delivered text, encrypted at
                // rest, and `detailsJson` is not an encrypted column. P5.4b
                // also replaces it at send time, so a copy here would be a
                // draft the chain presented as final.
            },
        });
    } catch (err) {
        logger.error('moderation.audit_append_failed', {
            component: 'moderation',
            statementId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

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

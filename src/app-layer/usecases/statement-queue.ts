/**
 * Writing a DSA Art 17 statement of reasons into its outbox (#1667).
 *
 * ## Why this is not in `moderation.ts`
 *
 * `queueStatement` lived there, and both callers of the new auto-queue need
 * it: `actOnNotice` (in `moderation.ts`) and `suspendAccount` (in
 * `account-suspension.ts`). `moderation.ts` already imports
 * `suspendAccountOnTx` from `account-suspension.ts`, so having
 * `account-suspension.ts` reach back for `queueStatement` would close a cycle.
 *
 * Same move, same reason, as `moderatorRefFor` in #1674. `moderation.ts`
 * re-exports `queueStatement` so its existing importers — the console route
 * and two integration suites — are untouched.
 */
import { randomUUID } from 'node:crypto';

import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { appendPlatformAuditEntry } from '@/lib/audit/platform-audit-writer';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { env } from '@/env';

import { composeStatementBody } from './statement-body';

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
 * Queue the statement for an action that was just recorded (#1667 ruling 1).
 *
 * ## Why automatic, and why from BOTH paths
 *
 * Before this, a statement existed only if a moderator opened the console and
 * typed one. #1667's measurement was that a suspension sent **nothing** — the
 * decision was taken, the account was locked, and the Art 17 obligation to
 * explain it depended on somebody remembering a second screen.
 *
 * So both paths that record a `ModerationAction` queue one: `actOnNotice`
 * (acting on a notice) and `suspendAccount` (a proactive suspension, whose
 * action row #1674 added for exactly this).
 *
 * ## NEVER throws
 *
 * A failed queue must not undo the action. The suspension is what protects the
 * farm, and a statement that could not be drafted is a compliance gap, not a
 * reason to leave harmful content up — the same ordering `suspendAccount`'s own
 * audit append already uses.
 *
 * The gap stays VISIBLE rather than silent, and by a mechanism that already
 * exists: `queueStatement`'s docblock records that a statement is a separate
 * audit verb precisely so "an action with no statement entry is visible in the
 * chain rather than inferred from a missing field". A `MODERATION_ACTION_RECORDED`
 * with no `MODERATION_STATEMENT_QUEUED` beside it IS the detection. (The
 * console view for it is P5.4 remainder and agrent backend-2's lane — there is
 * no moderation read surface at all yet, which they measured.)
 *
 * ## Composed in the recipient's language, now
 *
 * The locale comes from `User.uiLanguage` through `resolveRecipientLocale`,
 * whose fallback is `bg` rather than `DEFAULT_LOCALE` — see
 * `statement-dispatch.ts` for why handing English to a Bulgarian farmer whose
 * preference merely failed to load would be the bug.
 *
 * The result is still a DRAFT: the dispatch job recomposes through the same
 * `composeStatementBody` at send time, because a person can change their
 * language between the decision and the send.
 */
export async function queueStatementForAction(input: {
    readonly actionId: string;
    readonly recipientUserId: string;
    readonly actionKind: string;
    readonly rationale: string;
}): Promise<{ statementId: string } | null> {
    try {
        const recipient = await prisma.user.findUnique({
            where: { id: input.recipientUserId },
            select: { uiLanguage: true },
        });
        const locale = resolveRecipientLocale(recipient?.uiLanguage);
        const { body } = await composeStatementBody(
            locale,
            input.actionKind,
            input.rationale,
        );
        return await queueStatement({
            actionId: input.actionId,
            recipientUserId: input.recipientUserId,
            locale,
            bodyRendered: body,
        });
    } catch (err) {
        logger.error('moderation.statement_autoqueue_failed', {
            component: 'statement-queue',
            actionId: input.actionId,
            recipientUserId: input.recipientUserId,
            actionKind: input.actionKind,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * Who receives the statement for an action about CONTENT (#1690).
 *
 * Owner ruling: **the member who posted it** — the person whose act was
 * judged. That is what Art 17's "recipient of the service" most naturally
 * means here, and it discloses the decision to nobody who was not already a
 * party to it. The alternative, the farm's owner, would tell an owner about a
 * colleague's moderated content — close to what P5.2b decided a block must
 * never reveal, and the way #1656 was decided.
 *
 * ## Two kinds resolve, two do not — and that split is not mine
 *
 * It mirrors `captureReportSnapshot` in `trust-safety.ts`, which already
 * treats the same two as unsupported and for the same reasons:
 *
 *   LISTING   `ExchangeListing.sellerUserId`
 *   MESSAGE   `ExchangeMessage.senderUserId`
 *   PROFILE   the surface does not exist yet — it arrives with P6
 *   THREAD    a thread is not POSTED. It has two parties, and the seller side
 *             deliberately has no column: `ExchangeThread`'s own comment says
 *             "the seller-side principal needs no column: it is
 *             `listing.sellerUserId`". So "the member who posted it" has no
 *             referent, and picking the inquirer would omit the other party
 *             from a decision about their conversation.
 *
 * Returning `null` leaves the action with no statement, which is VISIBLE
 * rather than silent: `queueStatement` writes `MODERATION_STATEMENT_QUEUED`
 * as a separate audit verb, so an action with no statement entry beside it in
 * the chain is exactly what a reader looks for.
 *
 * ## `subjectId` is reporter-supplied, and resolving through the owner is why
 * that is safe
 *
 * `FileReportSchema` calls `subjectId` "opaque here; the server resolves it",
 * so nothing validates it per kind. Resolving the recipient from the ROW means
 * a bogus id resolves to nothing, and a real id resolves to whoever genuinely
 * owns that row — which is the subject of the decision the moderator actually
 * saw and acted on. A mis-aimed notice is a moderator-review problem, not a
 * resolution one.
 */
export async function resolveContentRecipient(
    subjectKind: string,
    subjectId: string,
): Promise<string | null> {
    try {
        if (subjectKind === 'LISTING') {
            const row = await prisma.exchangeListing.findUnique({
                where: { id: subjectId },
                select: { sellerUserId: true },
            });
            return row?.sellerUserId ?? null;
        }
        if (subjectKind === 'MESSAGE') {
            const row = await prisma.exchangeMessage.findUnique({
                where: { id: subjectId },
                select: { senderUserId: true },
            });
            return row?.senderUserId ?? null;
        }
        // PROFILE and THREAD — see the docblock. Logged at info, not warn: it
        // is the designed outcome for these kinds today, not a fault.
        logger.info('moderation.statement_recipient_unsupported', {
            component: 'statement-queue',
            subjectKind,
        });
        return null;
    } catch (err) {
        logger.error('moderation.statement_recipient_lookup_failed', {
            component: 'statement-queue',
            subjectKind,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

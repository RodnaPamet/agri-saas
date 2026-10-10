/**
 * DSA Art 17 statement dispatch (P5.4b, #1595).
 *
 * Drains `StatementOfReasons` rows with `deliveredAt` NULL, sends each in the
 * RECIPIENT's language, and stamps the delivery.
 *
 * ## `StatementOfReasons` is the outbox, not `NotificationOutbox`
 *
 * The existing outbox is tenant-scoped with a non-nullable `tenantId`, and an
 * Art 17 statement is addressed to a PERSON who may hold no farm or several —
 * resolving one would be inventing a tenant for a person-scoped obligation.
 * P5.1 shaped `deliveredAt` for exactly this: "NULL until the push succeeds.
 * The gap between `createdAt` and this is the Art 17 delivery lag."
 *
 * ## The body is composed HERE, and the console's text is a draft
 *
 * Two requirements pull apart, and this is where they are reconciled:
 *
 *   - P5.1 stores the body RENDERED, because "what was sent is a fact, and
 *     re-rendering later from a since-changed template answers a different
 *     question";
 *   - Art 17 requires it in the RECIPIENT's language, which is only knowable
 *     at send time.
 *
 * So the final text is composed now — a localised wrapper around the
 * moderator's rationale — and written back with the resolved locale before
 * `deliveredAt` is stamped. That keeps "stored rendered = as sent" literally
 * true, and makes the console's `bodyRendered` a draft until this job runs.
 *
 * ## The locale fallback is `bg`, and `en` would be a bug
 *
 * `resolveRecipientLocale` narrows `User.uiLanguage` and falls back to
 * `RECIPIENT_FALLBACK_LOCALE`. That is deliberately NOT `DEFAULT_LOCALE`
 * (`'en'`), which `src/lib/i18n/locales.ts` documents as the fallback for
 * UNAUTHENTICATED surfaces. A statement recipient is a known user whose column
 * defaults to `bg`, so reaching for the unauthenticated constant would hand
 * English to a Bulgarian farmer whose preference merely failed to load — a
 * mistake the schema docblock actively invited until #686.
 *
 * ## A failed send leaves the row undelivered, and that is the point
 *
 * Nothing marks a statement delivered unless the send resolved. An undelivered
 * row stays in the queue the console surfaces, because a statement that never
 * went out is a compliance failure whose danger is that nothing else shows it:
 * the action is recorded, the notice reads ACTIONED, and the recipient simply
 * never heard.
 *
 * One failure does not abort the batch either. A single unreachable mailbox
 * must not stop every other statement that day.
 */
import { randomUUID } from 'node:crypto';

import prisma from '@/lib/prisma';
import { sendEmail } from '@/lib/mailer';
import { logger } from '@/lib/observability/logger';
import { translateFor } from '@/lib/i18n/server-messages';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import type { JobRunResult } from './types';

/** How many to attempt per run. Bounded so one run cannot hold the queue. */
const DEFAULT_BATCH = 50;

export interface StatementDispatchPayload {
    /** Cap for this run. Defaults to 50. */
    limit?: number;
}

export async function runStatementDispatch(
    payload: StatementDispatchPayload = {},
): Promise<{ result: JobRunResult }> {
    const jobRunId = `sd-${randomUUID()}`;
    const startedAt = new Date();
    const take = payload.limit ?? DEFAULT_BATCH;

    let scanned = 0;
    let actioned = 0;
    let skipped = 0;

    // The privileged client: `StatementOfReasons` denies `app_user` for every
    // command, so there is no session context that could read this queue.
    const pending = await prisma.statementOfReasons.findMany({
        where: { deliveredAt: null },
        // Oldest first — the lag is the thing being measured, and P5's exit
        // criterion is a median handling time.
        orderBy: { createdAt: 'asc' },
        take,
        select: { id: true, actionId: true, recipientUserId: true, createdAt: true },
    });
    scanned = pending.length;

    // Both lookups are HOISTED — one query each for the whole batch rather than
    // two per row. At `take: 50` the loop is bounded, so an exemption would
    // have been defensible, but 3 queries beats 101 for no loss of clarity and
    // the per-row failure isolation below is unaffected: a row whose recipient
    // or action is missing from these maps is skipped exactly as before.
    //
    // `email` is decrypted by the extended client's middleware, on `findMany`
    // the same as on `findUnique`.
    const recipients = new Map(
        (await prisma.user.findMany({
            where: { id: { in: pending.map((r) => r.recipientUserId) } },
            select: { id: true, email: true, uiLanguage: true },
        })).map((u) => [u.id, u]),
    );
    const actions = new Map(
        (await prisma.moderationAction.findMany({
            where: { id: { in: pending.map((r) => r.actionId) } },
            select: { id: true, actionKind: true, rationale: true },
        })).map((a) => [a.id, a]),
    );

    for (const row of pending) {
        try {
            const recipient = recipients.get(row.recipientUserId);

            if (!recipient?.email) {
                // No mailbox to send to. Left UNDELIVERED on purpose: this is
                // a compliance gap, not a row to tidy away, and the console's
                // undelivered view is where it has to remain visible.
                skipped += 1;
                logger.warn('statement-dispatch.no_recipient_mailbox', {
                    component: 'statement-dispatch',
                    statementId: row.id,
                });
                continue;
            }

            const locale = resolveRecipientLocale(recipient.uiLanguage);

            // The rationale lives on the ACTION, which is where a moderator
            // wrote it. Reading it rather than trusting the draft body is what
            // makes the delivered text match the decision.
            const action = actions.get(row.actionId);
            if (!action) {
                skipped += 1;
                logger.warn('statement-dispatch.action_missing', {
                    component: 'statement-dispatch',
                    statementId: row.id,
                    actionId: row.actionId,
                });
                continue;
            }

            const subject = await translateFor(locale, 'statementOfReasons.subject');
            const intro = await translateFor(locale, 'statementOfReasons.intro');
            const actionLine = await translateFor(
                locale,
                `statementOfReasons.action.${action.actionKind}`,
            );
            const reasonLabel = await translateFor(locale, 'statementOfReasons.reasonLabel');
            const redress = await translateFor(locale, 'statementOfReasons.redress');

            // Plain text. An Art 17 statement is a legal communication, not a
            // marketing email, and a text body is the one shape every client
            // renders identically.
            const body = [intro, '', actionLine, '', `${reasonLabel}`, action.rationale, '', redress]
                .join('\n');

            await sendEmail({ to: recipient.email, subject, text: body });

            // Stamped only AFTER the send resolved, and the body/locale written
            // back so the stored row is what was actually delivered.
            await prisma.statementOfReasons.update({
                where: { id: row.id },
                data: { deliveredAt: new Date(), locale, bodyRendered: body },
            });
            actioned += 1;

            logger.info('statement-dispatch.delivered', {
                component: 'statement-dispatch',
                statementId: row.id,
                locale,
                // The LAG, which is the regulator-visible number.
                lagMs: Date.now() - row.createdAt.getTime(),
            });
        } catch (err) {
            // One unreachable mailbox must not stop the batch, and the row
            // stays undelivered so the next run retries it.
            skipped += 1;
            logger.warn('statement-dispatch.send_failed', {
                component: 'statement-dispatch',
                statementId: row.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const completedAt = new Date();
    return {
        result: {
            jobName: 'statement-dispatch',
            jobRunId,
            success: true,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
            itemsScanned: scanned,
            itemsActioned: actioned,
            itemsSkipped: skipped,
            // `success: true` with a non-zero skip count is the honest shape:
            // the RUN worked, and the undelivered rows are the finding. A job
            // that failed on one bad mailbox would retry the whole batch and
            // re-send everything that already went out.
            details: { undeliveredAfterRun: skipped },
        },
    };
}

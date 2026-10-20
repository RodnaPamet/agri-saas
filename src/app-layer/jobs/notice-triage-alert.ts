/**
 * Tell a human that notices are waiting (P5.8, #1599).
 *
 * ## Why this exists at all
 *
 * P5.4 built a triage queue. A queue nobody opens has a median handling time of
 * infinity, and P5's exit criterion is **under 24 hours** — so the queue needs
 * something that reaches a person. That is this job, and #1599's exit criterion
 * is that a notice filed on production reaches a human inside the agreed
 * window, demonstrated once end to end.
 *
 * ## ONE email per run, not one per notice
 *
 * `POST /api/public/notices` is UNAUTHENTICATED. At `PUBLIC_NOTICE_LIMIT`
 * (10/min per IP) a per-notice email would let anyone send 600 messages an hour
 * to the moderation mailbox — a mail amplifier pointed at the one address that
 * has to stay readable during an incident. Batching caps it at one message per
 * run regardless of how many notices arrive, which is the property that makes
 * the alert survive the flood it is most needed during.
 *
 * It is also why this is a JOB rather than an `afterCommit` hook on the notice
 * write, which is the repo's usual way to announce a write: `afterCommit` would
 * be immediate and per-notice, and the rate would be the attacker's to choose.
 *
 * ## The URGENT codes are named, and the rest are counted
 *
 * Owner proposal on #1599: immediate for `ILLEGAL_CONTENT` and
 * `HARASSMENT_OR_HATE`, a digest for the rest, "because those two are the ones
 * where 24 hours is already slow".
 *
 * Implemented as one message that LEADS with the urgent ones and counts the
 * others, rather than two separate mails. Two mails would mean two schedules,
 * two failure modes and an operator wondering which one did not arrive; one
 * message whose first line says "2 urgent" is the same information with one
 * thing to deliver. The cadence is 10 minutes, so an urgent notice waits
 * minutes rather than a day — and reversing the choice is editing
 * `URGENT_REASON_CODES`.
 *
 * ## Nothing is marked until the send resolves
 *
 * `alertedAt` is stamped only after the mail is accepted, so a failed send
 * leaves every notice in the queue and the next run tries again. The P5.4b
 * rule: a row marked delivered on a failed send removes the gap from the only
 * place it was visible.
 *
 * ## It is SILENT when unconfigured, and says so once
 *
 * `DSA_CONTACT_EMAIL` was absent on the VM when this was written (2026-10-11)
 * and is **PRESENT as of 2026-10-13**, so this job now sends. While it is
 * unset there is nowhere to send, so the job logs at WARN and does nothing —
 * and it starts working the moment the address exists, with no deploy, which
 * is how it began sending.
 *
 * The unconfigured branch marking nothing is what made that safe: the three
 * notices filed before the address existed were alerted afterwards rather than
 * silently skipped.
 *
 * A caution the first sends earned: a send that RESOLVES is not a message that
 * ARRIVED. The first three alerts stamped `alertedAt` and all three bounced,
 * because the configured domain's MX pointed away from its mailbox (#1760).
 * `/api/webhooks/resend` (#1753) is what surfaces that now; this job still
 * cannot tell on its own.
 */
import { randomUUID } from 'node:crypto';

import { env } from '@/env';
import prisma from '@/lib/prisma';
import { sendEmail } from '@/lib/mailer';
import { logger } from '@/lib/observability/logger';
import { translateFor } from '@/lib/i18n/server-messages';
import { RECIPIENT_FALLBACK_LOCALE } from '@/lib/email/recipient-locale';
import type { JobRunResult } from './types';

/**
 * The two codes where a day is already too long.
 *
 * Owner proposal on #1599. Editing this list is how the escalation threshold
 * changes — there is no second place it is encoded.
 */
export const URGENT_REASON_CODES = ['ILLEGAL_CONTENT', 'HARASSMENT_OR_HATE'] as const;

/** How many notices one message names before it summarises. */
const NAMED_LIMIT = 20;

/** Bound on one run. Far above any plausible volume; see the docblock. */
const DEFAULT_BATCH = 200;

export interface NoticeTriageAlertPayload {
    limit?: number;
}

export async function runNoticeTriageAlert(
    payload: NoticeTriageAlertPayload = {},
): Promise<{ result: JobRunResult }> {
    const jobRunId = `nta-${randomUUID()}`;
    const startedAt = new Date();
    const take = payload.limit ?? DEFAULT_BATCH;

    const finish = (
        scanned: number, actioned: number, skipped: number, details: Record<string, unknown>,
    ): { result: JobRunResult } => {
        const completedAt = new Date();
        return {
            result: {
                jobName: 'notice-triage-alert',
                jobRunId,
                success: true,
                startedAt: startedAt.toISOString(),
                completedAt: completedAt.toISOString(),
                durationMs: completedAt.getTime() - startedAt.getTime(),
                itemsScanned: scanned,
                itemsActioned: actioned,
                itemsSkipped: skipped,
                details,
            },
        };
    };

    const to = env.DSA_CONTACT_EMAIL;
    if (!to) {
        // Checked BEFORE the query: there is nowhere to send, so reading the
        // queue to discard it is pointless. WARN rather than INFO because an
        // unconfigured contact point is an unmet Art 11/12 obligation, not a
        // quiet default — and the log line is what a reader of the production
        // log can act on.
        logger.warn('notice-triage-alert.no_contact_address', {
            component: 'notice-triage-alert',
            hint: 'Set DSA_CONTACT_EMAIL on the VM; /dsa-contact shows its fallback until then.',
        });
        return finish(0, 0, 0, { skippedReason: 'no_contact_address' });
    }

    // The privileged client: `ContentReport` admits only a reporter reading
    // their own row, so there is no session context that could read the queue.
    const waiting = await prisma.contentReport.findMany({
        where: { alertedAt: null },
        // Oldest first — the thing being measured is how long a notice waits.
        orderBy: { createdAt: 'asc' },
        take,
        select: {
            id: true,
            createdAt: true,
            reasonCode: true,
            subjectKind: true,
            // `detail` is deliberately NOT selected. It is the notifier's free
            // text, encrypted at rest, and putting it in an email would move
            // personal data into a mailbox outside the KEK boundary for no
            // operational gain: the moderator opens the console to read it.
        },
    });

    if (waiting.length === 0) {
        return finish(0, 0, 0, { nothingWaiting: true });
    }

    const urgent = waiting.filter(
        (r) => (URGENT_REASON_CODES as readonly string[]).includes(r.reasonCode),
    );

    // The operator reads this, and an operator is a person: the subject and
    // body go through `translateFor` at the fallback locale rather than being
    // English literals, because `no-server-authored-user-copy` holds thrown and
    // emitted prose on a downward ratchet and a mailbox is a user-facing
    // surface like any other.
    const locale = RECIPIENT_FALLBACK_LOCALE;
    const subject = await translateFor(locale, 'noticeTriage.subject', {
        urgent: urgent.length,
        total: waiting.length,
    });
    const intro = await translateFor(locale, 'noticeTriage.intro', {
        total: waiting.length,
        urgent: urgent.length,
    });
    const urgentLabel = await translateFor(locale, 'noticeTriage.urgentLabel');
    const consoleHint = await translateFor(locale, 'noticeTriage.consoleHint');

    const named = (urgent.length > 0 ? urgent : waiting).slice(0, NAMED_LIMIT);
    const lines = named.map(
        (r) => `  - ${r.id}  ${r.reasonCode}  ${r.subjectKind}  ${r.createdAt.toISOString()}`,
    );
    const body = [
        intro,
        '',
        ...(urgent.length > 0 ? [urgentLabel] : []),
        ...lines,
        ...(waiting.length > named.length
            ? [`  … ${waiting.length - named.length} more`]
            : []),
        '',
        consoleHint,
    ].join('\n');

    try {
        await sendEmail({
            to,
            subject,
            text: body,
            purpose: 'notice-triage-alert',
            // EVERY report in the digest, not one (#1769). The stamp below is
            // an `updateMany` over exactly this list, so a bounce has to be
            // able to clear exactly this list — clearing one and leaving the
            // rest is the "retries for one notice out of three" state #1769
            // calls worse than none.
            subjectType: 'ContentReport',
            subjectIds: waiting.map((r) => r.id),
        });
    } catch (err) {
        // Nothing marked. Every notice stays in the queue and the next run
        // tries again — the P5.4b rule: a row marked alerted on a failed send
        // removes the gap from the only place it was visible.
        logger.error('notice-triage-alert.send_failed', {
            component: 'notice-triage-alert',
            waiting: waiting.length,
            urgent: urgent.length,
            error: err instanceof Error ? err.message : String(err),
        });
        return finish(waiting.length, 0, waiting.length, { sendFailed: true });
    }

    const stamped = await prisma.contentReport.updateMany({
        where: { id: { in: waiting.map((r) => r.id) } },
        data: { alertedAt: new Date() },
    });

    logger.info('notice-triage-alert.sent', {
        component: 'notice-triage-alert',
        waiting: waiting.length,
        urgent: urgent.length,
        stamped: stamped.count,
    });

    return finish(waiting.length, stamped.count, 0, { urgent: urgent.length });
}

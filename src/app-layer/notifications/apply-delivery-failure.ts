/**
 * Undo what a bounced email caused (#1769 PR 2).
 *
 * `/api/webhooks/resend` has made delivery failures VISIBLE since #1753. This
 * is the half that acts on one. The join is `OutboundMessage`, written at send
 * time by `sendEmail`: the provider's message id resolves to the purpose that
 * sent it and the rows it was about.
 *
 * ## Why this throws, when the recorder deliberately does not
 *
 * `sendEmail`'s recorder swallows its failures because the email has already
 * left and throwing would un-stamp a digest that was genuinely delivered.
 * The opposite is true here. Nothing has been sent; the work is to undo
 * something; and Resend retries a non-2xx. So a database failure SHOULD
 * surface, because a retry is a second chance at an action that is idempotent
 * anyway — and a swallowed failure here means a DSA alert that bounced is
 * never re-sent, which is exactly the gap #1753 measured.
 *
 * ## Every action is idempotent
 *
 * Resend may deliver the same event more than once, and the retry above makes
 * that likelier rather than less. Clearing `alertedAt` to null twice is the
 * same as once; stamping a failure kind twice overwrites with the same value.
 * No action is a counter, an append, or a toggle.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';

export interface DeliveryFailure {
    /** The provider's message id — the only key `OutboundMessage` is found by. */
    messageId: string;
    /** The provider's event type, e.g. 'email.bounced' / 'email.complained'. */
    kind: string;
    /** When the provider says it happened; defaults to now. */
    at?: Date;
}

export interface DeliveryFailureOutcome {
    /** False when no row matched — an email sent before the recorder shipped. */
    correlated: boolean;
    purpose?: string;
    /** What the action touched, so "ran" is distinguishable from "did nothing". */
    reportsRequeued?: number;
    invitesMarked?: number;
}

/**
 * Resolve a failed message to what sent it and reverse its effect.
 *
 * Returns rather than throws for the UNCORRELATED case, which is not an error:
 * every email sent before #1769 PR 1 shipped has no row, and so does any send
 * whose provider minted no id. The caller logs it and answers 200, because
 * retrying will never produce a row that does not exist.
 */
export async function applyDeliveryFailure(f: DeliveryFailure): Promise<DeliveryFailureOutcome> {
    const at = f.at ?? new Date();

    const row = await prisma.outboundMessage.findUnique({
        where: { messageId: f.messageId },
        select: { purpose: true, subjectType: true, subjectIds: true },
    });
    if (!row) return { correlated: false };

    // Stamped first, and unconditionally, so the row records the failure even
    // when the purpose has no action wired. An observability gap is what
    // #1753 was; leaving one here would repeat it in miniature.
    await prisma.outboundMessage.update({
        where: { messageId: f.messageId },
        data: { failedAt: at, failureKind: f.kind },
    });

    const out: DeliveryFailureOutcome = { correlated: true, purpose: row.purpose };
    const ids = row.subjectIds;
    if (ids.length === 0) return out;

    if (row.purpose === 'notice-triage-alert' && row.subjectType === 'ContentReport') {
        // Put the notices back in the queue. `notice-triage-alert` selects on
        // `{ alertedAt: null }` and nothing else, so clearing the stamp
        // restores EXACTLY the state before the alert that never arrived.
        //
        // Deliberately not narrowed to reports still "unresolved": the job's
        // queue has no such condition, and a webhook that disagreed with the
        // job about which notices are waiting would be two readers of one
        // queue with two definitions.
        //
        // The whole digest, not one id. One email covers N notices and stamps
        // them with a single `updateMany`, so clearing one and leaving the
        // rest is the "retries for one notice out of three" state #1769 calls
        // worse than no correlation at all.
        const { count } = await prisma.contentReport.updateMany({
            where: { id: { in: ids } },
            data: { alertedAt: null },
        });
        out.reportsRequeued = count;
        if (count !== ids.length) {
            // Not an error — a report can be deleted between the alert and
            // the bounce. Logged because a count that is always short would
            // mean the ids are wrong, and silence would hide that.
            logger.warn('mail.bounce_requeue_partial', {
                component: 'bounce-action',
                purpose: row.purpose,
                expected: ids.length,
                requeued: count,
            });
        }
        return out;
    }

    if (row.purpose === 'invite') {
        // Two MODELS behind one purpose: the org path creates an `OrgInvite`
        // and the tenant-admin paths a `TenantInvite`. `sendInviteEmail`
        // records which, derived from its `kind`, so this dispatches on the
        // recorded subject type rather than guessing or trying both.
        const data = { deliveryFailureKind: f.kind, deliveryFailedAt: at };
        if (row.subjectType === 'TenantInvite') {
            out.invitesMarked = (
                await prisma.tenantInvite.updateMany({ where: { id: { in: ids } }, data })
            ).count;
            return out;
        }
        if (row.subjectType === 'OrgInvite') {
            out.invitesMarked = (
                await prisma.orgInvite.updateMany({ where: { id: { in: ids } }, data })
            ).count;
            return out;
        }
    }

    // A purpose with subjects but no action. Named rather than ignored, so a
    // new sender that records subjects and expects them to DO something finds
    // out from a log line instead of from a user.
    logger.info('mail.bounce_no_action', {
        component: 'bounce-action',
        purpose: row.purpose,
        subjectType: row.subjectType,
        subjectCount: ids.length,
    });
    return out;
}

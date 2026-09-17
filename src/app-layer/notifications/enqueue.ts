/**
 * Enqueue an email into the NotificationOutbox.
 *
 * - Builds email content from templates.
 * - Computes dedupeKey to prevent duplicate sends for the same event.
 * - Uses Prisma's unique constraint to skip silently on duplicates.
 * - Logs with requestId for correlation.
 */

import type { PrismaTx } from '@/lib/db-context';
import type { EmailNotificationType } from '@prisma/client';
import { isNotificationsEnabled } from './settings';
import { logger } from '@/lib/observability/logger';
import type { Locale } from '@/lib/i18n/locales';
import {
    buildTaskAssignedEmail,
    buildAccessReviewReminderEmail,
    buildAccessReviewOverdueEscalationEmail,
    type TaskAssignedPayload,
    type AccessReviewReminderPayload,
    type AccessReviewOverdueEscalationPayload,
} from './templates';

export interface EnqueueEmailInput {
    tenantId: string;
    type: EmailNotificationType;
    toEmail: string;
    /**
     * The RECIPIENT's language — required, deliberately not optional (#694).
     *
     * The outbox row stores RENDERED text, so the language is frozen at
     * enqueue time and a forgotten locale is indistinguishable from a chosen
     * one: it would silently ship `bg` to an English speaker with nothing to
     * notice. There are three call sites, so requiring it costs three lines
     * and TypeScript enforces it — strictly better than a guard that greps.
     *
     * Producers resolve it with `resolveRecipientLocale(user.uiLanguage)`. A
     * producer that genuinely has only an email must write
     * `RECIPIENT_FALLBACK_LOCALE` explicitly, so the decision appears in the
     * diff. Same reasoning as the `scanStatus` argument in the upload
     * convention: never restore a default that means "unknown".
     */
    locale: Locale;
    entityId: string;
    payload:
        | TaskAssignedPayload
        | AccessReviewReminderPayload
        | AccessReviewOverdueEscalationPayload;
    sendAfter?: Date;
    requestId?: string;
}

/**
 * Build a dedupe key for idempotent email sending.
 * Format: {tenantId}:{type}:{email}:{entityId}:{YYYY-MM-DD}
 */
export function buildDedupeKey(
    tenantId: string,
    type: string,
    email: string,
    entityId: string,
    date: Date = new Date(),
): string {
    const day = date.toISOString().slice(0, 10); // YYYY-MM-DD
    return `${tenantId}:${type}:${email}:${entityId}:${day}`;
}

/**
 * Enqueue an email notification into the outbox.
 * Silently skips if dedupeKey already exists (idempotent).
 * Silently skips if tenant notifications are disabled.
 *
 * @returns The created record, or null if duplicate/disabled.
 */
export async function enqueueEmail(
    db: PrismaTx,
    input: EnqueueEmailInput,
): Promise<{ id: string; dedupeKey: string } | null> {
    const { tenantId, type, toEmail, locale, entityId, payload, sendAfter, requestId } = input;

    // Check tenant settings — skip if disabled
    const enabled = await isNotificationsEnabled(db, tenantId);
    if (!enabled) {
        if (requestId) {
            logger.debug('notification skipped — disabled for tenant', { component: 'notifications' });
        }
        return null;
    }

    // Build email content from template, in the RECIPIENT's language.
    const { subject, bodyText, bodyHtml } = await buildEmailContent(type, payload, locale);

    // Compute dedupe key
    const dedupeKey = buildDedupeKey(tenantId, type, toEmail, entityId);

    try {
        const record = await db.notificationOutbox.create({
            data: {
                tenantId,
                type,
                toEmail,
                subject,
                bodyText,
                bodyHtml,
                dedupeKey,
                ...(sendAfter ? { sendAfter } : {}),
            },
        });

        if (requestId) {
            logger.debug('notification enqueued', { component: 'notifications', type });
        }

        return { id: record.id, dedupeKey };
    } catch (error: unknown) {
        // Prisma P2002 = unique constraint violation → duplicate, skip silently
        if (isPrismaUniqueConstraintError(error)) {
            if (requestId) {
                logger.debug('notification skipped — duplicate', { component: 'notifications', type });
            }
            return null;
        }
        throw error;
    }
}

/**
 * Build email content based on notification type.
 */
async function buildEmailContent(
    type: EmailNotificationType,
    payload:
        | TaskAssignedPayload
        | AccessReviewReminderPayload
        | AccessReviewOverdueEscalationPayload,
    locale: Locale,
): Promise<{ subject: string; bodyText: string; bodyHtml: string }> {
    switch (type) {
        // EVERY arm here is reachable. Verified by enumerating the type
        // passed at every `enqueueEmail` call site — there are three, in
        // `usecases/task.ts`, `jobs/access-review-reminder.ts` and
        // `jobs/access-review-overdue-escalation.ts`.
        //
        // Nine arms were deleted in #807. They covered types no producer
        // ever passed to `enqueueEmail`: POLICY_* / VENDOR_ASSESSMENT_* /
        // EXCEPTION_EXPIRING lost their models in the GRC teardown, and
        // EVIDENCE_EXPIRING has a live producer that does NOT come through
        // here — `jobs/retention-notifications.ts` writes its own
        // `notificationOutbox` row with strings it localises inline.
        //
        // Those enum VALUES still exist in `EmailNotificationType` and must:
        // `EVIDENCE_EXPIRING` is still written to the outbox by that job, and
        // removing a Postgres enum value is a destructive migration for no
        // gain. What is gone is the unreachable code that claimed to render
        // them.
        case 'TASK_ASSIGNED':
            return buildTaskAssignedEmail(payload as TaskAssignedPayload, locale);
        case 'ACCESS_REVIEW_REMINDER':
            return buildAccessReviewReminderEmail(
                payload as AccessReviewReminderPayload,
                locale,
            );
        case 'ACCESS_REVIEW_OVERDUE_ESCALATION':
            return buildAccessReviewOverdueEscalationEmail(
                payload as AccessReviewOverdueEscalationPayload,
                locale,
            );
        default:
            throw new Error(`Unknown notification type: ${type}`);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isPrismaUniqueConstraintError(error: any): boolean {
    return error?.code === 'P2002' || error?.message?.includes('Unique constraint');
}

/**
 * Email template builders for each EmailNotificationType.
 * Returns { subject, bodyText, bodyHtml } for each type.
 */
import { env } from '@/env';
import { escapeHtml } from '@/lib/security/escape-html';
import { translateFor } from '@/lib/i18n/server-messages';
import type { Locale } from '@/lib/i18n/locales';

export interface EmailTemplateResult {
    subject: string;
    bodyText: string;
    bodyHtml: string;
}

// ─── Evidence Expiring ───

/**
 * #807. `jobs/retention-notifications.ts` used to build these strings inline
 * and write `notificationOutbox` directly, bypassing `enqueueEmail`. That made
 * `buildEmailContent`'s EVIDENCE_EXPIRING arm unreachable — #987 deleted the
 * old English builder for exactly that reason.
 *
 * This one is derived from the strings the JOB was sending, not recovered from
 * git history: those are the localised ones (#694), and the deleted builder
 * was English and synchronous. Same two i18n keys, so no new message keys and
 * no `bg.json` gap.
 */
export interface EvidenceExpiringPayload {
    title: string;
    daysRemaining: number;
}

export async function buildEvidenceExpiringEmail(
    payload: EvidenceExpiringPayload,
    locale: Locale,
): Promise<EmailTemplateResult> {
    const { title, daysRemaining } = payload;
    // The job flagged <= 7 days with a warning glyph in the SUBJECT only.
    // Preserved verbatim: it is what recipients already recognise in an inbox.
    const urgencyTag = daysRemaining <= 7 ? '⚠️ ' : '';

    // Resolved to locals before interpolation, per the escaping convention —
    // `${escapeHtml(await t(...))}` hides the call from the guard's extractor.
    const subject = await translateFor(locale, 'notificationEmail.evidenceExpiring.subject', {
        days: daysRemaining,
        title,
    });
    const body = await translateFor(locale, 'notificationEmail.evidenceExpiring.body', {
        days: daysRemaining,
        title,
    });
    const signature = await translateFor(locale, 'notificationEmail.signature');

    return {
        subject: `${urgencyTag}${subject}`,
        bodyText: [body, '', signature].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <p style="color: #444; line-height: 1.5;">${escapeHtml(body)}</p>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">${escapeHtml(signature)}</p>
</div>`.trim(),
    };
}

// ─── Task Assigned ───

export interface TaskAssignedPayload {
    taskTitle: string;
    taskKey?: string | null;
    taskType: string;
    assigneeName: string;
    assignerName?: string;
    tenantSlug: string;
}

export interface AccessReviewOverdueEscalationPayload {
    adminName: string;
    campaignName: string;
    /// Always positive — the cron only fires after the campaign
    /// is past the grace tail.
    daysOverdue: number;
    pendingDecisions: number;
    totalDecisions: number;
    tenantSlug: string;
    accessReviewId: string;
    reviewerName: string;
    /// Null when the assigned reviewer was an offboarded user
    /// whose email is no longer resolvable.
    reviewerEmail: string | null;
}

/**
 * Task assigned — LOCALISED (#694).
 *
 * ## Why every translated string lands in a local `const` first
 *
 * Not style. `tests/guardrails/html-template-escaping.test.ts` extracts
 * interpolations and requires each to be escaped; writing
 * `${escapeHtml(await t('k', { n }))}` inline puts an object literal inside the
 * interpolation. Before #717 that was INVISIBLE to the guard — escaped or not —
 * because its extractor excluded braces, so this very change would have
 * silently disarmed it across the file. #717 made the extractor brace-balanced,
 * so both forms are now checked; the local-const form is kept because it also
 * keeps each interpolation readable at the point it is escaped.
 */
export async function buildTaskAssignedEmail(
    payload: TaskAssignedPayload,
    locale: Locale,
): Promise<EmailTemplateResult> {
    const { taskTitle, taskKey, taskType, assigneeName, assignerName, tenantSlug } = payload;
    const keyLabel = taskKey ? `[${taskKey}] ` : '';
    const link = absoluteUrl(`/t/${tenantSlug}/farm-tasks`);
    const t = (key: string, params?: Record<string, string | number>) =>
        translateFor(locale, `notificationEmail.taskAssigned.${key}`, params);

    // `taskType` is a Prisma enum member (IMPROVEMENT / TASK / …), not free
    // text, and it is lower-cased for prose. Left untranslated deliberately:
    // translating it needs a per-member key set, which is its own decision.
    const typeLabel = taskType.toLowerCase();

    const subject = await t('subject', { task: `${keyLabel}${taskTitle}` });
    const heading = await t('heading');
    const greeting = await t('greeting', { name: assigneeName });
    const intro = assignerName
        ? await t('introWithAssigner', { taskType: typeLabel, assigner: assignerName })
        : await t('intro', { taskType: typeLabel });
    const viewTasks = await t('viewTasks');
    const viewTasksLine = await t('viewTasksLine', { link });
    const signature = await translateFor(locale, 'notificationEmail.signature');

    return {
        subject,
        bodyText: [
            greeting,
            '',
            intro,
            '',
            `  ${keyLabel}${taskTitle}`,
            '',
            viewTasksLine,
            '',
            signature,
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">${escapeHtml(heading)}</h2>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(greeting)}</p>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(intro)}</p>
  <div style="background: #f4f6fa; border-left: 4px solid #4f46e5; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
    <strong>${escapeHtml(keyLabel)}${escapeHtml(taskTitle)}</strong>
  </div>
  <a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">${escapeHtml(viewTasks)}</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">${escapeHtml(signature)}</p>
</div>`.trim(),
    };
}

// ─── Access Review Reminder (Epic G-4) ───

export interface AccessReviewReminderPayload {
    reviewerName: string;
    campaignName: string;
    /// "tomorrow", "in 5 days", "today", "overdue by 2 days", …
    daysUntilDue: number;
    pendingDecisions: number;
    totalDecisions: number;
    tenantSlug: string;
    accessReviewId: string;
}

export async function buildAccessReviewReminderEmail(
    payload: AccessReviewReminderPayload,
    locale: Locale,
): Promise<EmailTemplateResult> {
    const {
        reviewerName,
        campaignName,
        daysUntilDue,
        pendingDecisions,
        totalDecisions,
        tenantSlug,
        accessReviewId,
    } = payload;

    const link = absoluteUrl(`/t/${tenantSlug}/access-reviews/${accessReviewId}`);
    const t = (key: string, params?: Record<string, string | number>) =>
        translateFor(locale, `notificationEmail.accessReviewReminder.${key}`, params);

    const dueLabel =
        daysUntilDue < 0
            ? await t('dueOverdue', { days: Math.abs(daysUntilDue) })
            : daysUntilDue === 0
                ? await t('dueToday')
                : daysUntilDue === 1
                    ? await t('dueTomorrow')
                    : await t('dueInDays', { days: daysUntilDue });

    // The urgency marker stays in CODE, never in the catalogues:
    // `tests/guards/no-decorative-emoji-in-messages.test.ts` bans decorative
    // emoji in messages/*.json and explicitly sanctions them here.
    const urgencyTag = daysUntilDue <= 1 ? '⏰ ' : '';

    const heading = await t('heading', { dueLabel });
    const greeting = await t('greeting', { name: reviewerName });
    const intro = await t('intro', { dueLabel });
    const campaignLabel = await t('campaignLabel');
    const pendingLabel = await t('pendingLabel');
    const pendingValue = await t('pendingValue', { pending: pendingDecisions, total: totalDecisions });
    const openCampaign = await t('openCampaign');
    const openCampaignLine = await t('openCampaignLine', { link });
    const closeoutNote = await t('closeoutNote');
    const signature = await translateFor(locale, 'notificationEmail.signature');

    return {
        subject: `${urgencyTag}${await t('subject', { dueLabel, campaign: campaignName })}`,
        bodyText: [
            greeting,
            '',
            intro,
            '',
            `  ${campaignLabel}: ${campaignName}`,
            `  ${pendingLabel}: ${pendingValue}`,
            '',
            openCampaignLine,
            '',
            closeoutNote,
            '',
            signature,
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">${escapeHtml(heading)}</h2>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(greeting)}</p>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(intro)}</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 6px 0; color: #666;">${escapeHtml(campaignLabel)}</td><td style="padding: 6px 0;"><strong>${escapeHtml(campaignName)}</strong></td></tr>
    <tr><td style="padding: 6px 0; color: #666;">${escapeHtml(pendingLabel)}</td><td style="padding: 6px 0;"><strong>${escapeHtml(pendingValue)}</strong></td></tr>
  </table>
  <a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">${escapeHtml(openCampaign)}</a>
  <p style="color: #666; font-size: 13px; line-height: 1.5; margin-top: 20px;">${escapeHtml(closeoutNote)}</p>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">${escapeHtml(signature)}</p>
</div>`.trim(),
    };
}

export async function buildAccessReviewOverdueEscalationEmail(
    payload: AccessReviewOverdueEscalationPayload,
    locale: Locale,
): Promise<EmailTemplateResult> {
    const {
        adminName,
        campaignName,
        daysOverdue,
        pendingDecisions,
        totalDecisions,
        tenantSlug,
        accessReviewId,
        reviewerName,
        reviewerEmail,
    } = payload;

    const link = absoluteUrl(`/t/${tenantSlug}/access-reviews/${accessReviewId}`);
    const reviewerLine = reviewerEmail ? `${reviewerName} (${reviewerEmail})` : reviewerName;
    const t = (key: string, params?: Record<string, string | number>) =>
        translateFor(locale, `notificationEmail.accessReviewOverdue.${key}`, params);

    // Marker stays in code — see the note in the reminder builder above.
    const alertTag = '⚠️ ';

    const heading = await t('heading', { days: daysOverdue });
    const greeting = await t('greeting', { name: adminName });
    const intro = await t('intro', { days: daysOverdue });
    const campaignLabel = await t('campaignLabel');
    const reviewerLabel = await t('reviewerLabel');
    const pendingLabel = await t('pendingLabel');
    const pendingValue = await t('pendingValue', { pending: pendingDecisions, total: totalDecisions });
    const daysOverdueLabel = await t('daysOverdueLabel');
    const optionsIntro = await t('optionsIntro');
    const optionReassign = await t('optionReassign');
    const optionForceClose = await t('optionForceClose');
    const optionChase = await t('optionChase');
    const openCampaign = await t('openCampaign');
    const openCampaignLine = await t('openCampaignLine', { link });
    const signature = await translateFor(locale, 'notificationEmail.signature');

    return {
        subject: `${alertTag}${await t('subject', { days: daysOverdue, campaign: campaignName })}`,
        bodyText: [
            greeting,
            '',
            intro,
            '',
            `  ${campaignLabel}: ${campaignName}`,
            `  ${reviewerLabel}: ${reviewerLine}`,
            `  ${pendingLabel}: ${pendingValue}`,
            `  ${daysOverdueLabel}: ${daysOverdue}`,
            '',
            optionsIntro,
            `  - ${optionReassign}`,
            `  - ${optionForceClose}`,
            `  - ${optionChase}`,
            '',
            openCampaignLine,
            '',
            signature,
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">${escapeHtml(heading)}</h2>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(greeting)}</p>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(intro)}</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 6px 0; color: #666;">${escapeHtml(campaignLabel)}</td><td style="padding: 6px 0;"><strong>${escapeHtml(campaignName)}</strong></td></tr>
    <tr><td style="padding: 6px 0; color: #666;">${escapeHtml(reviewerLabel)}</td><td style="padding: 6px 0;">${escapeHtml(reviewerLine)}</td></tr>
    <tr><td style="padding: 6px 0; color: #666;">${escapeHtml(pendingLabel)}</td><td style="padding: 6px 0;"><strong>${escapeHtml(pendingValue)}</strong></td></tr>
    <tr><td style="padding: 6px 0; color: #666;">${escapeHtml(daysOverdueLabel)}</td><td style="padding: 6px 0;"><strong>${daysOverdue}</strong></td></tr>
  </table>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(optionsIntro)}</p>
  <ul style="color: #444; line-height: 1.6;">
    <li>${escapeHtml(optionReassign)}</li>
    <li>${escapeHtml(optionForceClose)}</li>
    <li>${escapeHtml(optionChase)}</li>
  </ul>
  <a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">${escapeHtml(openCampaign)}</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">${escapeHtml(signature)}</p>
</div>`.trim(),
    };
}

// ─── Helpers ───

/**
 * Make an in-app path absolute for email links. Emails render outside the
 * app origin, so a bare `/t/…` path resolves to a host-less `http:///t/…`
 * in the recipient's mail client (the "Redirect Notice" bug). Prefix it with
 * the deployment's public origin — `APP_URL`, falling back to `NEXTAUTH_URL`
 * (always set in a working auth deploy). If neither is configured the path is
 * returned unchanged so nothing crashes.
 */
function absoluteUrl(path: string): string {
    const base = (env.APP_URL || env.NEXTAUTH_URL || '').replace(/\/+$/, '');
    return base ? `${base}${path}` : path;
}

function formatIsoDate(iso: string): string {
    try {
        return new Date(iso).toUTCString();
    } catch {
        return iso;
    }
}


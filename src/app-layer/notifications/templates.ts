/**
 * Email template builders for each EmailNotificationType.
 * Returns { subject, bodyText, bodyHtml } for each type.
 */
import { env } from '@/env';
import { escapeHtml } from '@/lib/security/escape-html';

export interface EmailTemplateResult {
    subject: string;
    bodyText: string;
    bodyHtml: string;
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

export function buildTaskAssignedEmail(payload: TaskAssignedPayload): EmailTemplateResult {
    const { taskTitle, taskKey, taskType, assigneeName, assignerName, tenantSlug } = payload;
    const keyLabel = taskKey ? `[${taskKey}] ` : '';
    const byLine = assignerName ? ` by ${assignerName}` : '';
    const link = absoluteUrl(`/t/${tenantSlug}/farm-tasks`);

    return {
        subject: `Task assigned to you: ${keyLabel}${taskTitle}`,
        bodyText: [
            `Hi ${assigneeName},`,
            '',
            `You have been assigned a ${taskType.toLowerCase()} task${byLine}:`,
            '',
            `  ${keyLabel}${taskTitle}`,
            '',
            `View your tasks: ${link}`,
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">Task assigned to you</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(assigneeName)},</p>
  <p style="color: #444; line-height: 1.5;">You have been assigned a <strong>${escapeHtml(taskType.toLowerCase())}</strong> task${byLine ? ` by <strong>${escapeHtml(assignerName!)}</strong>` : ''}:</p>
  <div style="background: #f4f6fa; border-left: 4px solid #4f46e5; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
    <strong>${escapeHtml(keyLabel)}${escapeHtml(taskTitle)}</strong>
  </div>
  <a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">View Tasks</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Agrent</p>
</div>`.trim(),
    };
}

// ─── Evidence Expiring ───

export interface EvidenceExpiringPayload {
    evidenceTitle: string;
    daysRemaining: number;
    retentionUntil: string;
    controlName?: string | null;
    recipientName: string;
    tenantSlug: string;
}

export function buildEvidenceExpiringEmail(payload: EvidenceExpiringPayload): EmailTemplateResult {
    const { evidenceTitle, daysRemaining, retentionUntil, controlName, recipientName, tenantSlug } = payload;
    const urgency = daysRemaining <= 7 ? '⚠️ ' : '';
    const link = absoluteUrl(`/t/${tenantSlug}/evidence`);

    return {
        subject: `${urgency}Evidence expiring in ${daysRemaining} day(s): ${evidenceTitle}`,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            `Evidence "${evidenceTitle}" is expiring in ${daysRemaining} day(s) (${retentionUntil}).`,
            ...(controlName ? [`Control: ${controlName}`] : []),
            '',
            'Please upload refreshed evidence or extend the retention date.',
            '',
            `View evidence: ${link}`,
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">${escapeHtml(urgency)}Evidence expiring soon</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">Evidence <strong>"${escapeHtml(evidenceTitle)}"</strong> is expiring in <strong>${daysRemaining} day(s)</strong> (${escapeHtml(retentionUntil)}).</p>
  ${controlName ? `<p style="color: #666; line-height: 1.5;">Control: <strong>${escapeHtml(controlName)}</strong></p>` : ''}
  <p style="color: #444; line-height: 1.5;">Please upload refreshed evidence or extend the retention date.</p>
  <a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">View Evidence</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Agrent</p>
</div>`.trim(),
    };
}

// ─── Policy Approval Requested ───

export interface PolicyApprovalRequestedPayload {
    policyTitle: string;
    requesterName: string;
    approverName: string;
    versionNumber?: number;
    tenantSlug: string;
}

export function buildPolicyApprovalRequestedEmail(payload: PolicyApprovalRequestedPayload): EmailTemplateResult {
    const { policyTitle, requesterName, approverName, versionNumber, tenantSlug } = payload;
    const versionLabel = versionNumber ? ` (v${versionNumber})` : '';
    const link = absoluteUrl(`/t/${tenantSlug}/policies`);

    return {
        subject: `Policy approval requested: ${policyTitle}${versionLabel}`,
        bodyText: [
            `Hi ${approverName},`,
            '',
            `${requesterName} has requested your approval for:`,
            '',
            `  ${policyTitle}${versionLabel}`,
            '',
            `Please review and approve or reject the policy.`,
            '',
            `View policies: ${link}`,
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">Policy approval requested</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(approverName)},</p>
  <p style="color: #444; line-height: 1.5;"><strong>${escapeHtml(requesterName)}</strong> has requested your approval for:</p>
  <div style="background: #f4f6fa; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
    <strong>${escapeHtml(policyTitle)}${escapeHtml(versionLabel)}</strong>
  </div>
  <a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">Review Policy</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Agrent</p>
</div>`.trim(),
    };
}

// ─── Policy Approved / Rejected ───

export interface PolicyDecisionPayload {
    policyTitle: string;
    decision: 'APPROVED' | 'REJECTED';
    deciderName: string;
    requesterName: string;
    comment?: string | null;
    tenantSlug: string;
}

export function buildPolicyDecisionEmail(payload: PolicyDecisionPayload): EmailTemplateResult {
    const { policyTitle, decision, deciderName, requesterName, comment, tenantSlug } = payload;
    const isApproved = decision === 'APPROVED';
    const emoji = isApproved ? '✅' : '❌';
    const word = isApproved ? 'approved' : 'rejected';
    const link = absoluteUrl(`/t/${tenantSlug}/policies`);

    return {
        subject: `${emoji} Policy ${word}: ${policyTitle}`,
        bodyText: [
            `Hi ${requesterName},`,
            '',
            `Your policy "${policyTitle}" has been ${word} by ${deciderName}.`,
            ...(comment ? [``, `Comment: ${comment}`] : []),
            '',
            `View policies: ${link}`,
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">${escapeHtml(emoji)} Policy ${escapeHtml(word)}</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(requesterName)},</p>
  <p style="color: #444; line-height: 1.5;">Your policy <strong>"${escapeHtml(policyTitle)}"</strong> has been <strong>${escapeHtml(word)}</strong> by ${escapeHtml(deciderName)}.</p>
  ${comment ? `<div style="background: #f4f6fa; border-left: 4px solid ${isApproved ? '#10b981' : '#ef4444'}; padding: 12px 16px; margin: 16px 0; border-radius: 4px;"><em>${escapeHtml(comment)}</em></div>` : ''}
  <a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">View Policies</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Agrent</p>
</div>`.trim(),
    };
}

// ─── Vendor assessment invitation (Epic G-3) ───

export interface VendorAssessmentInvitationPayload {
    /// Vendor / org name to address — falls back to "Vendor team".
    recipientName: string;
    /// Free-text vendor name shown in the body.
    vendorName: string;
    /// Template name for context.
    templateName: string;
    /// The full external response URL — INCLUDES the raw token.
    /// This is the only place the raw token ever appears, so the
    /// caller is responsible for ensuring it's transmitted only via
    /// the email body and never logged elsewhere.
    responseUrl: string;
    /// ISO timestamp the link expires (formatted in the body).
    expiresAtIso: string;
    /// Optional inviter name for the by-line.
    inviterName?: string;
}

export function buildVendorAssessmentInvitationEmail(
    payload: VendorAssessmentInvitationPayload,
): EmailTemplateResult {
    const {
        recipientName,
        vendorName,
        templateName,
        responseUrl,
        expiresAtIso,
        inviterName,
    } = payload;
    const expiresFormatted = formatIsoDate(expiresAtIso);
    const byLine = inviterName ? ` from ${inviterName}` : '';

    return {
        subject: `Action required: ${templateName} questionnaire`,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            `You've received a vendor assessment questionnaire${byLine}.`,
            '',
            `  Vendor:    ${vendorName}`,
            `  Template:  ${templateName}`,
            `  Expires:   ${expiresFormatted}`,
            '',
            `Open the questionnaire: ${responseUrl}`,
            '',
            'This link is single-use and tied to your assessment. Please do',
            'not forward it.',
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">📋 Vendor assessment requested</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">You've received a vendor assessment questionnaire${byLine ? ` from <strong>${escapeHtml(inviterName!)}</strong>` : ''}.</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="color: #888; padding: 4px 0; width: 100px;">Vendor</td><td style="color: #444;"><strong>${escapeHtml(vendorName)}</strong></td></tr>
    <tr><td style="color: #888; padding: 4px 0;">Template</td><td style="color: #444;">${escapeHtml(templateName)}</td></tr>
    <tr><td style="color: #888; padding: 4px 0;">Expires</td><td style="color: #444;">${escapeHtml(expiresFormatted)}</td></tr>
  </table>
  <a href="${escapeHtml(responseUrl)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">Open questionnaire</a>
  <p style="color: #888; font-size: 12px; line-height: 1.5; margin-top: 16px;">This link is single-use and tied to your assessment. Please do not forward it.</p>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Agrent</p>
</div>`.trim(),
    };
}

// ─── Vendor assessment reminder (Epic G-3 prompt 8) ───

export interface VendorAssessmentReminderPayload {
    recipientName: string;
    vendorName: string;
    templateName: string;
    responseUrl: string;
    expiresAtIso: string;
    inviterName?: string;
}

export function buildVendorAssessmentReminderEmail(
    payload: VendorAssessmentReminderPayload,
): EmailTemplateResult {
    const {
        recipientName,
        vendorName,
        templateName,
        responseUrl,
        expiresAtIso,
        inviterName,
    } = payload;
    const expiresFormatted = formatIsoDate(expiresAtIso);
    const byLine = inviterName ? ` from ${inviterName}` : '';

    return {
        subject: `Reminder: ${templateName} questionnaire`,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            `Just a reminder${byLine} — the vendor assessment questionnaire is still awaiting your response.`,
            '',
            `  Vendor:    ${vendorName}`,
            `  Template:  ${templateName}`,
            `  Expires:   ${expiresFormatted}`,
            '',
            `Open the questionnaire: ${responseUrl}`,
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">Reminder: questionnaire response needed</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">Just a reminder${byLine ? ` from <strong>${escapeHtml(inviterName!)}</strong>` : ''} — the vendor assessment questionnaire is still awaiting your response.</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="color: #888; padding: 4px 0; width: 100px;">Vendor</td><td style="color: #444;"><strong>${escapeHtml(vendorName)}</strong></td></tr>
    <tr><td style="color: #888; padding: 4px 0;">Template</td><td style="color: #444;">${escapeHtml(templateName)}</td></tr>
    <tr><td style="color: #888; padding: 4px 0;">Expires</td><td style="color: #444;">${escapeHtml(expiresFormatted)}</td></tr>
  </table>
  <a href="${escapeHtml(responseUrl)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">Open questionnaire</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Agrent</p>
</div>`.trim(),
    };
}

// ─── Vendor assessment submitted (Epic G-3 prompt 8) ───

export interface VendorAssessmentSubmittedPayload {
    /// Internal admin who initiated the assessment.
    requesterName: string;
    vendorName: string;
    templateName: string;
    submittedAtIso: string;
    /// Internal review-page URL (not the external respondent link).
    reviewUrl: string;
    /// Auto-computed score at submit time. Reviewer may override.
    submittedScore: number;
}

export function buildVendorAssessmentSubmittedEmail(
    payload: VendorAssessmentSubmittedPayload,
): EmailTemplateResult {
    const {
        requesterName,
        vendorName,
        templateName,
        submittedAtIso,
        reviewUrl,
        submittedScore,
    } = payload;
    const ts = formatIsoDate(submittedAtIso);

    return {
        subject: `Vendor questionnaire submitted: ${vendorName}`,
        bodyText: [
            `Hi ${requesterName},`,
            '',
            `${vendorName} just submitted "${templateName}" for review.`,
            '',
            `  Submitted: ${ts}`,
            `  Auto-score: ${submittedScore}`,
            '',
            `Review the response: ${reviewUrl}`,
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">Vendor questionnaire submitted</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(requesterName)},</p>
  <p style="color: #444; line-height: 1.5;"><strong>${escapeHtml(vendorName)}</strong> just submitted <strong>"${escapeHtml(templateName)}"</strong> for review.</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="color: #888; padding: 4px 0; width: 120px;">Submitted</td><td style="color: #444;">${escapeHtml(ts)}</td></tr>
    <tr><td style="color: #888; padding: 4px 0;">Auto-score</td><td style="color: #444;"><strong>${submittedScore}</strong></td></tr>
  </table>
  <a href="${escapeHtml(reviewUrl)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">Review response</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Agrent</p>
</div>`.trim(),
    };
}

// ─── Vendor assessment reviewed (Epic G-3 prompt 8) ───

export interface VendorAssessmentReviewedPayload {
    recipientName: string;
    vendorName: string;
    templateName: string;
    reviewedAtIso: string;
    finalScore: number;
    finalRating: string | null;
    /// Internal review-page URL.
    reviewUrl: string;
}

export function buildVendorAssessmentReviewedEmail(
    payload: VendorAssessmentReviewedPayload,
): EmailTemplateResult {
    const {
        recipientName,
        vendorName,
        templateName,
        reviewedAtIso,
        finalScore,
        finalRating,
        reviewUrl,
    } = payload;
    const ts = formatIsoDate(reviewedAtIso);
    const ratingLine = finalRating ? `Risk rating: ${finalRating}` : '';

    return {
        subject: `Vendor assessment reviewed: ${vendorName}`,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            `The "${templateName}" questionnaire for ${vendorName} has been reviewed.`,
            '',
            `  Reviewed:   ${ts}`,
            `  Final score: ${finalScore}`,
            ...(ratingLine ? [`  ${ratingLine}`] : []),
            '',
            `Open the review: ${reviewUrl}`,
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">Vendor assessment reviewed</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">The <strong>"${escapeHtml(templateName)}"</strong> questionnaire for <strong>${escapeHtml(vendorName)}</strong> has been reviewed.</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="color: #888; padding: 4px 0; width: 120px;">Reviewed</td><td style="color: #444;">${escapeHtml(ts)}</td></tr>
    <tr><td style="color: #888; padding: 4px 0;">Final score</td><td style="color: #444;"><strong>${finalScore}</strong></td></tr>
    ${finalRating ? `<tr><td style="color: #888; padding: 4px 0;">Risk rating</td><td style="color: #444;"><strong>${escapeHtml(finalRating)}</strong></td></tr>` : ''}
  </table>
  <a href="${escapeHtml(reviewUrl)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">Open review</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Agrent</p>
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

export function buildAccessReviewReminderEmail(
    payload: AccessReviewReminderPayload,
): EmailTemplateResult {
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
    const dueLabel =
        daysUntilDue < 0
            ? `overdue by ${Math.abs(daysUntilDue)} day${Math.abs(daysUntilDue) === 1 ? '' : 's'}`
            : daysUntilDue === 0
                ? 'due today'
                : daysUntilDue === 1
                    ? 'due tomorrow'
                    : `due in ${daysUntilDue} days`;
    const urgencyTag = daysUntilDue <= 1 ? '⏰ ' : '';

    return {
        subject: `${urgencyTag}Access review ${dueLabel}: ${campaignName}`,
        bodyText: [
            `Hi ${reviewerName},`,
            '',
            `You have an access review campaign that is ${dueLabel}.`,
            '',
            `  Campaign: ${campaignName}`,
            `  Pending decisions: ${pendingDecisions} of ${totalDecisions}`,
            '',
            `Open the campaign: ${link}`,
            '',
            'Until every subject has a CONFIRM, REVOKE, or MODIFY verdict the campaign cannot be closed and the closeout PDF cannot be generated. Auditors will look for this artifact in the next SOC 2 cycle.',
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">Access review ${escapeHtml(dueLabel)}</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(reviewerName)},</p>
  <p style="color: #444; line-height: 1.5;">You have an access review campaign that is <strong>${escapeHtml(dueLabel)}</strong>.</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="color: #888; padding: 4px 0; width: 160px;">Campaign</td><td style="color: #444;"><strong>${escapeHtml(campaignName)}</strong></td></tr>
    <tr><td style="color: #888; padding: 4px 0;">Pending decisions</td><td style="color: #444;"><strong>${pendingDecisions}</strong> of ${totalDecisions}</td></tr>
  </table>
  <a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">Open campaign</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">Auditors will look for the closeout PDF in the next SOC 2 cycle. Closing the campaign requires every subject to have a CONFIRM, REVOKE, or MODIFY verdict.</p>
  <p style="color: #999; font-size: 12px; margin-top: 8px;">— Agrent</p>
</div>`.trim(),
    };
}

// ─── Access Review Overdue Escalation (Audit Coherence S7) ───

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

export function buildAccessReviewOverdueEscalationEmail(
    payload: AccessReviewOverdueEscalationPayload,
): EmailTemplateResult {
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
    const reviewerLine = reviewerEmail
        ? `${reviewerName} (${reviewerEmail})`
        : reviewerName;

    return {
        subject: `⚠️ Access review ${daysOverdue} days overdue: ${campaignName}`,
        bodyText: [
            `Hi ${adminName},`,
            '',
            `An access review campaign in your tenant is now ${daysOverdue} days past its deadline and still has pending decisions. The assigned reviewer has been receiving daily reminders.`,
            '',
            `  Campaign: ${campaignName}`,
            `  Reviewer: ${reviewerLine}`,
            `  Pending decisions: ${pendingDecisions} of ${totalDecisions}`,
            `  Days overdue: ${daysOverdue}`,
            '',
            'As a tenant admin you can:',
            '  - Reassign the campaign to a different reviewer.',
            '  - Force-close the campaign (this will skip pending verdicts).',
            '  - Chase the reviewer through other channels.',
            '',
            `Open the campaign: ${link}`,
            '',
            'Severely overdue campaigns appear in SOC 2 evidence reviews as control failures — closing this out is high-priority.',
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #b91c1c; font-size: 18px; margin-bottom: 16px;">Access review ${daysOverdue} days overdue</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(adminName)},</p>
  <p style="color: #444; line-height: 1.5;">An access review campaign in your tenant is now <strong>${daysOverdue} days past its deadline</strong> and still has pending decisions. The assigned reviewer has been receiving daily reminders.</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="color: #888; padding: 4px 0; width: 160px;">Campaign</td><td style="color: #444;"><strong>${escapeHtml(campaignName)}</strong></td></tr>
    <tr><td style="color: #888; padding: 4px 0;">Reviewer</td><td style="color: #444;">${escapeHtml(reviewerLine)}</td></tr>
    <tr><td style="color: #888; padding: 4px 0;">Pending decisions</td><td style="color: #444;"><strong>${pendingDecisions}</strong> of ${totalDecisions}</td></tr>
    <tr><td style="color: #888; padding: 4px 0;">Days overdue</td><td style="color: #b91c1c;"><strong>${daysOverdue}</strong></td></tr>
  </table>
  <a href="${escapeHtml(link)}" style="display: inline-block; background: #b91c1c; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">Open campaign</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">Severely overdue campaigns appear in SOC 2 evidence reviews as control failures.</p>
  <p style="color: #999; font-size: 12px; margin-top: 8px;">— Agrent</p>
</div>`.trim(),
    };
}

// ─── Exception expiring (Epic G-5) ───

export interface ExceptionExpiringPayload {
    recipientName: string;
    /// Control identity surfaces in the subject + body so the
    /// recipient can identify which exception without opening.
    controlName: string;
    controlCode?: string | null;
    daysRemaining: 30 | 14 | 7;
    expiresAtIso: string;
    tenantSlug: string;
    /// Linked exception id — drops the recipient straight into the
    /// review surface on the control detail page.
    exceptionId: string;
    controlId: string;
}

export function buildExceptionExpiringEmail(
    payload: ExceptionExpiringPayload,
): EmailTemplateResult {
    const {
        recipientName,
        controlName,
        controlCode,
        daysRemaining,
        expiresAtIso,
        tenantSlug,
        exceptionId,
        controlId,
    } = payload;
    const link = absoluteUrl(`/t/${tenantSlug}/controls/${controlId}#exceptions`);
    const controlLabel = controlCode
        ? `${controlCode} — ${controlName}`
        : controlName;
    const dueLabel = formatIsoDate(expiresAtIso);
    const urgencyTag = daysRemaining <= 7 ? '⏰ ' : '';

    return {
        subject: `${urgencyTag}Control exception expires in ${daysRemaining} days: ${controlLabel}`,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            `A control exception is approaching its review deadline.`,
            '',
            `  Control: ${controlLabel}`,
            `  Expires: ${dueLabel} (${daysRemaining} days)`,
            '',
            `Open the exception: ${link}`,
            '',
            'Renew the exception or accept that the control becomes',
            'in-effect again on the expiry date. Auditors expect every',
            'expired exception to either have a renewal record or a',
            'closing remediation note.',
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">Control exception expires in ${daysRemaining} days</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">A control exception is approaching its review deadline.</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="color: #888; padding: 4px 0; width: 100px;">Control</td><td style="color: #444;"><strong>${escapeHtml(controlLabel)}</strong></td></tr>
    <tr><td style="color: #888; padding: 4px 0;">Expires</td><td style="color: #444;"><strong>${escapeHtml(dueLabel)}</strong> (${daysRemaining} days)</td></tr>
    <tr><td style="color: #888; padding: 4px 0;">Exception</td><td style="color: #444;">${escapeHtml(exceptionId)}</td></tr>
  </table>
  <a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">Open exception</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">Renew the exception or let it lapse — auditors expect every expired exception to have a renewal record or a closing remediation note.</p>
  <p style="color: #999; font-size: 12px; margin-top: 8px;">— Agrent</p>
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


/**
 * Digest Email Templates — Grouped Notification Templates
 *
 * Templates for owner-grouped digest notifications sent from
 * periodic monitoring jobs. Each template renders multiple
 * DueItems for a single recipient into one consolidated email.
 *
 * Digest types:
 *   - DEADLINE_DIGEST  — controls, policies, tasks, risks, test plans
 *   - EVIDENCE_EXPIRY_DIGEST — evidence expiring/expired
 *   - VENDOR_RENEWAL_DIGEST — vendor reviews/renewals
 *
 * @module app-layer/notifications/digest-templates
 */

import type { DueItem, DueItemUrgency, MonitoredEntityType } from '../jobs/types';
import { escapeHtml } from '@/lib/security/escape-html';

export interface EmailTemplateResult {
    subject: string;
    bodyText: string;
    bodyHtml: string;
}

// ─── Shared Helpers ─────────────────────────────────────────────────


const URGENCY_EMOJI: Record<DueItemUrgency, string> = {
    OVERDUE: '🔴',
    URGENT: '🟡',
    UPCOMING: '🟢',
};

const URGENCY_COLOR: Record<DueItemUrgency, string> = {
    OVERDUE: '#ef4444',
    URGENT: '#f59e0b',
    UPCOMING: '#10b981',
};

const URGENCY_LABEL: Record<DueItemUrgency, string> = {
    OVERDUE: 'Overdue',
    URGENT: 'Due Soon',
    UPCOMING: 'Upcoming',
};

const ENTITY_LABEL: Record<MonitoredEntityType, string> = {
    CONTROL: 'Control',
    EVIDENCE: 'Evidence',
    POLICY: 'Policy',
    VENDOR: 'Vendor',
    TASK: 'Task',
    RISK: 'Risk',
    TEST_PLAN: 'Test Plan',
    TREATMENT_PLAN: 'Treatment Plan',
    TREATMENT_MILESTONE: 'Treatment Milestone',
};

const ENTITY_PATH: Record<MonitoredEntityType, string> = {
    CONTROL: 'controls',
    EVIDENCE: 'evidence',
    POLICY: 'policies',
    VENDOR: 'vendors',
    TASK: 'tasks',
    RISK: 'risks',
    TEST_PLAN: 'controls', // test plans live under controls
    // Both treatment-plan + milestone deep-link to the parent risk's
    // detail page where the treatment-plan card surfaces them.
    TREATMENT_PLAN: 'risks',
    TREATMENT_MILESTONE: 'risks',
};

// ─── Text Rendering Helpers ─────────────────────────────────────────

function renderItemText(item: DueItem): string {
    const emoji = URGENCY_EMOJI[item.urgency];
    return `  ${emoji} ${item.name} — ${item.reason}`;
}

function renderItemHtml(item: DueItem, tenantSlug: string): string {
    const color = URGENCY_COLOR[item.urgency];
    const label = URGENCY_LABEL[item.urgency];
    const path = ENTITY_PATH[item.entityType];
    const entityLabel = ENTITY_LABEL[item.entityType];

    return `
<tr>
  <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">
    <span style="display: inline-block; background: ${escapeHtml(color)}; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600;">${escapeHtml(label)}</span>
  </td>
  <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666; font-size: 13px;">${escapeHtml(entityLabel)}</td>
  <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">
    <a href="/t/${escapeHtml(tenantSlug)}/${escapeHtml(path)}" style="color: #4f46e5; text-decoration: none; font-weight: 500;">${escapeHtml(item.name)}</a>
  </td>
  <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666; font-size: 13px;">${escapeHtml(item.reason)}</td>
</tr>`.trim();
}

// ─── Digest Table Builder ───────────────────────────────────────────

function buildDigestTable(items: DueItem[], tenantSlug: string): string {
    const rows = items.map(i => renderItemHtml(i, tenantSlug)).join('\n');
    return `
<table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
  <thead>
    <tr style="background: #f8fafc;">
      <th style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">Status</th>
      <th style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">Type</th>
      <th style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">Name</th>
      <th style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">Details</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>`.trim();
}

function summaryLine(items: DueItem[]): string {
    const overdue = items.filter(i => i.urgency === 'OVERDUE').length;
    const urgent = items.filter(i => i.urgency === 'URGENT').length;
    const upcoming = items.filter(i => i.urgency === 'UPCOMING').length;
    const parts: string[] = [];
    if (overdue > 0) parts.push(`🔴 ${overdue} overdue`);
    if (urgent > 0) parts.push(`🟡 ${urgent} due soon`);
    if (upcoming > 0) parts.push(`🟢 ${upcoming} upcoming`);
    return parts.join(', ');
}

// ─── Deadline Digest ────────────────────────────────────────────────

export interface DeadlineDigestPayload {
    recipientName: string;
    tenantSlug: string;
    items: DueItem[];
}

export function buildDeadlineDigestEmail(payload: DeadlineDigestPayload): EmailTemplateResult {
    const { recipientName, tenantSlug, items } = payload;
    const summary = summaryLine(items);
    const overdue = items.filter(i => i.urgency === 'OVERDUE').length;
    const urgencyMarker = overdue > 0 ? '🔴 ' : '';

    return {
        subject: `${urgencyMarker}Compliance Deadline Digest: ${items.length} item(s) need attention`,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            `You have ${items.length} item(s) that need attention:`,
            summary,
            '',
            ...items.map(renderItemText),
            '',
            `View your dashboard: /t/${tenantSlug}/dashboard`,
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 8px;">${escapeHtml(urgencyMarker)}Compliance Deadline Digest</h2>
  <p style="color: #666; font-size: 14px; margin-bottom: 16px;">${escapeHtml(summary)}</p>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">You have <strong>${items.length} item(s)</strong> that need your attention:</p>
  ${buildDigestTable(items, tenantSlug)}
  <a href="/t/${escapeHtml(tenantSlug)}/dashboard" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; margin-top: 8px;">View Dashboard</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Agrent</p>
</div>`.trim(),
    };
}

// ─── Evidence Expiry Digest ─────────────────────────────────────────

export interface EvidenceExpiryDigestPayload {
    recipientName: string;
    tenantSlug: string;
    items: DueItem[];
}

export function buildEvidenceExpiryDigestEmail(payload: EvidenceExpiryDigestPayload): EmailTemplateResult {
    const { recipientName, tenantSlug, items } = payload;
    const expired = items.filter(i => i.urgency === 'OVERDUE').length;
    const urgencyMarker = expired > 0 ? '⚠️ ' : '';

    return {
        subject: `${urgencyMarker}Evidence Expiry Alert: ${items.length} item(s) expiring`,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            `${items.length} evidence item(s) are expiring or have expired:`,
            '',
            ...items.map(renderItemText),
            '',
            'Please upload refreshed evidence or extend retention dates.',
            '',
            `View evidence: /t/${tenantSlug}/evidence`,
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 8px;">${escapeHtml(urgencyMarker)}Evidence Expiry Alert</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;"><strong>${items.length} evidence item(s)</strong> are expiring or have expired:</p>
  ${buildDigestTable(items, tenantSlug)}
  <p style="color: #444; line-height: 1.5;">Please upload refreshed evidence or extend retention dates.</p>
  <a href="/t/${escapeHtml(tenantSlug)}/evidence" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; margin-top: 8px;">View Evidence</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Agrent</p>
</div>`.trim(),
    };
}

// ─── Vendor Renewal Digest ──────────────────────────────────────────

export interface VendorRenewalDigestPayload {
    recipientName: string;
    tenantSlug: string;
    items: DueItem[];
}

export function buildVendorRenewalDigestEmail(payload: VendorRenewalDigestPayload): EmailTemplateResult {
    const { recipientName, tenantSlug, items } = payload;
    const overdue = items.filter(i => i.urgency === 'OVERDUE').length;
    const urgencyMarker = overdue > 0 ? '🔴 ' : '';

    return {
        subject: `${urgencyMarker}Vendor Renewal Alert: ${items.length} vendor(s) need attention`,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            `${items.length} vendor(s) have upcoming or overdue reviews/renewals:`,
            '',
            ...items.map(renderItemText),
            '',
            `View vendors: /t/${tenantSlug}/vendors`,
            '',
            '— Agrent',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 8px;">${escapeHtml(urgencyMarker)}Vendor Renewal Alert</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;"><strong>${items.length} vendor(s)</strong> have upcoming or overdue reviews/renewals:</p>
  ${buildDigestTable(items, tenantSlug)}
  <a href="/t/${escapeHtml(tenantSlug)}/vendors" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; margin-top: 8px;">View Vendors</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Agrent</p>
</div>`.trim(),
    };
}

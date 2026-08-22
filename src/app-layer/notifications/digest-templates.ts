/**
 * Digest Email Templates — Grouped Notification Templates
 *
 * Templates for owner-grouped digest notifications sent from
 * periodic monitoring jobs. Each template renders multiple
 * DueItems for a single recipient into one consolidated email.
 *
 * Digest types:
 *   - DEADLINE_DIGEST  — practices, policies, tasks, risks, test plans
 *   - EVIDENCE_EXPIRY_DIGEST — evidence expiring/expired
 *
 * @module app-layer/notifications/digest-templates
 */

import type { DueItem, DueItemReason, DueItemUrgency, MonitoredEntityType } from '../jobs/types';
import { escapeHtml } from '@/lib/security/escape-html';
import { translateFor } from '@/lib/i18n/server-messages';
import type { Locale } from '@/lib/i18n/locales';

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

/**
 * `URGENCY_LABEL` and `ENTITY_LABEL` used to be module-level English maps.
 * They are catalogue lookups now (#694): the digest is written in the
 * RECIPIENT's language, and a constant cannot know who is reading.
 *
 * The enum MEMBER is the key, so a new member fails at the lookup rather than
 * silently rendering its raw identifier.
 */
const urgencyLabel = (u: DueItemUrgency, locale: Locale) =>
    translateFor(locale, `notificationEmail.digest.urgency.${u}`);

const entityLabel = (e: MonitoredEntityType, locale: Locale) =>
    translateFor(locale, `notificationEmail.digest.entity.${e}`);

/** A `DueItem.reason` descriptor, rendered for one recipient. */
const reasonText = (reason: DueItemReason, locale: Locale) =>
    translateFor(locale, `notificationEmail.digest.reason.${reason.key}`, reason.params);

/**
 * Deep-link path segment per entity type. These must be REAL route
 * segments under `src/app/t/[tenantSlug]/(app)/` — the digest email is
 * the one surface where a wrong value is invisible until a user clicks
 * it and lands on a 404.
 *
 * `TASK` mapped to `tasks` here for a long time; the route has been
 * `farm-tasks` since the farm-task rename, so every task line in every
 * digest email pointed at a page that does not exist. Nothing caught
 * it: the map is `Record<MonitoredEntityType, string>`, and any string
 * satisfies that.
 */
const ENTITY_PATH: Record<MonitoredEntityType, string> = {
    EVIDENCE: 'evidence',
    TASK: 'farm-tasks',
};

// ─── Text Rendering Helpers ─────────────────────────────────────────

async function renderItemText(item: DueItem, locale: Locale): Promise<string> {
    const emoji = URGENCY_EMOJI[item.urgency];
    const reason = await reasonText(item.reason, locale);
    return `  ${emoji} ${item.name} — ${reason}`;
}

async function renderItemHtml(
    item: DueItem,
    tenantSlug: string,
    locale: Locale,
): Promise<string> {
    const color = URGENCY_COLOR[item.urgency];
    const path = ENTITY_PATH[item.entityType];
    // Resolved to locals BEFORE the template literal — see the note in
    // `templates.ts`: an interpolation carrying an object literal was
    // invisible to the escaping guard until #717, and this keeps every
    // interpolation brace-free and readable at the point it is escaped.
    const label = await urgencyLabel(item.urgency, locale);
    const entity = await entityLabel(item.entityType, locale);
    const reason = await reasonText(item.reason, locale);

    return `
<tr>
  <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">
    <span style="display: inline-block; background: ${escapeHtml(color)}; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600;">${escapeHtml(label)}</span>
  </td>
  <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666; font-size: 13px;">${escapeHtml(entity)}</td>
  <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">
    <a href="/t/${escapeHtml(tenantSlug)}/${escapeHtml(path)}" style="color: #4f46e5; text-decoration: none; font-weight: 500;">${escapeHtml(item.name)}</a>
  </td>
  <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666; font-size: 13px;">${escapeHtml(reason)}</td>
</tr>`.trim();
}

// ─── Digest Table Builder ───────────────────────────────────────────

async function buildDigestTable(
    items: DueItem[],
    tenantSlug: string,
    locale: Locale,
): Promise<string> {
    const rows = (await Promise.all(items.map((i) => renderItemHtml(i, tenantSlug, locale)))).join('\n');
    const th = {
        status: await translateFor(locale, 'notificationEmail.digest.table.status'),
        type: await translateFor(locale, 'notificationEmail.digest.table.type'),
        name: await translateFor(locale, 'notificationEmail.digest.table.name'),
        details: await translateFor(locale, 'notificationEmail.digest.table.details'),
    };
    return `
<table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
  <thead>
    <tr style="background: #f8fafc;">
      <th style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">${escapeHtml(th.status)}</th>
      <th style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">${escapeHtml(th.type)}</th>
      <th style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">${escapeHtml(th.name)}</th>
      <th style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">${escapeHtml(th.details)}</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>`.trim();
}

async function summaryLine(items: DueItem[], locale: Locale): Promise<string> {
    const counts = {
        overdue: items.filter((i) => i.urgency === 'OVERDUE').length,
        dueSoon: items.filter((i) => i.urgency === 'URGENT').length,
        upcoming: items.filter((i) => i.urgency === 'UPCOMING').length,
    };
    // Emoji stay in CODE — `no-decorative-emoji-in-messages` bans them in
    // messages/*.json and sanctions them here.
    const emoji = { overdue: '🔴', dueSoon: '🟡', upcoming: '🟢' } as const;
    const parts: string[] = [];
    for (const k of ['overdue', 'dueSoon', 'upcoming'] as const) {
        if (counts[k] === 0) continue;
        const text = await translateFor(locale, `notificationEmail.digest.summary.${k}`, {
            count: counts[k],
        });
        parts.push(`${emoji[k]} ${text}`);
    }
    return parts.join(', ');
}

// ─── Deadline Digest ────────────────────────────────────────────────

export interface DeadlineDigestPayload {
    recipientName: string;
    tenantSlug: string;
    items: DueItem[];
}

export async function buildDeadlineDigestEmail(
    payload: DeadlineDigestPayload,
    locale: Locale,
): Promise<EmailTemplateResult> {
    const { recipientName, tenantSlug, items } = payload;
    const summary = await summaryLine(items, locale);
    const overdue = items.filter((i) => i.urgency === 'OVERDUE').length;
    const urgencyMarker = overdue > 0 ? '🔴 ' : '';
    const link = `/t/${tenantSlug}/dashboard`;
    const t = (key: string, params?: Record<string, string | number>) =>
        translateFor(locale, `notificationEmail.digest.deadline.${key}`, params);

    const subject = await t('subject', { count: items.length });
    const heading = await t('heading');
    const greeting = await t('greeting', { name: recipientName });
    const intro = await t('intro', { count: items.length });
    const cta = await t('cta');
    const ctaLine = await t('ctaLine', { link });
    const signature = await translateFor(locale, 'notificationEmail.signature');
    const table = await buildDigestTable(items, tenantSlug, locale);
    const lines = await Promise.all(items.map((i) => renderItemText(i, locale)));

    return {
        subject: `${urgencyMarker}${subject}`,
        bodyText: [greeting, '', intro, summary, '', ...lines, '', ctaLine, '', signature].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 8px;">${escapeHtml(urgencyMarker)}${escapeHtml(heading)}</h2>
  <p style="color: #666; font-size: 14px; margin-bottom: 16px;">${escapeHtml(summary)}</p>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(greeting)}</p>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(intro)}</p>
  ${table}
  <a href="/t/${escapeHtml(tenantSlug)}/dashboard" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; margin-top: 8px;">${escapeHtml(cta)}</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">${escapeHtml(signature)}</p>
</div>`.trim(),
    };
}

// ─── Evidence Expiry Digest ─────────────────────────────────────────

export interface EvidenceExpiryDigestPayload {
    recipientName: string;
    tenantSlug: string;
    items: DueItem[];
}

export async function buildEvidenceExpiryDigestEmail(
    payload: EvidenceExpiryDigestPayload,
    locale: Locale,
): Promise<EmailTemplateResult> {
    const { recipientName, tenantSlug, items } = payload;
    const expired = items.filter((i) => i.urgency === 'OVERDUE').length;
    const urgencyMarker = expired > 0 ? '⚠️ ' : '';
    const link = `/t/${tenantSlug}/evidence`;
    const t = (key: string, params?: Record<string, string | number>) =>
        translateFor(locale, `notificationEmail.digest.evidenceExpiry.${key}`, params);

    const subject = await t('subject', { count: items.length });
    const heading = await t('heading');
    const greeting = await t('greeting', { name: recipientName });
    const intro = await t('intro', { count: items.length });
    const advice = await t('advice');
    const cta = await t('cta');
    const ctaLine = await t('ctaLine', { link });
    const signature = await translateFor(locale, 'notificationEmail.signature');
    const table = await buildDigestTable(items, tenantSlug, locale);
    const lines = await Promise.all(items.map((i) => renderItemText(i, locale)));

    return {
        subject: `${urgencyMarker}${subject}`,
        bodyText: [greeting, '', intro, '', ...lines, '', advice, '', ctaLine, '', signature].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 8px;">${escapeHtml(urgencyMarker)}${escapeHtml(heading)}</h2>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(greeting)}</p>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(intro)}</p>
  ${table}
  <p style="color: #444; line-height: 1.5;">${escapeHtml(advice)}</p>
  <a href="/t/${escapeHtml(tenantSlug)}/evidence" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; margin-top: 8px;">${escapeHtml(cta)}</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">${escapeHtml(signature)}</p>
</div>`.trim(),
    };
}

// ─── Vendor Renewal Digest ──────────────────────────────────────────


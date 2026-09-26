/**
 * Email template builders for each EmailNotificationType.
 * Returns { subject, bodyText, bodyHtml } for each type.
 */
import { env } from '@/env';
import { escapeHtml } from '@/lib/security/escape-html';
import { formatCents } from '@/lib/insurance';
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

export interface InsuranceLeadPayload {
    /** Farm that asked. The operator needs to know whose land this is. */
    tenantName: string;
    tenantSlug: string;
    parcelName: string;
    locationName?: string | null;
    cropType?: string | null;
    areaHa?: number | null;
    /** What the farmer typed. Free text, escaped at every render site. */
    /** Absent for a quote-only lead: the farmer picked a product, wrote nothing. */
    message?: string;
    /** The reading the farmer was looking at when they asked, if any. */
    riskOverall?: string | null;
    ndvi?: number | null;
    ndmi?: number | null;
    /**
     * The quote as STORED on the lead. Read from `quoteJson`, never recomputed
     * at render time — the operator must see the figures the farmer was shown,
     * not what today's tariff would produce.
     */
    quote?: {
        productKey: string;
        areaDca: number;
        sumInsuredCents: number;
        tariffBp: number;
        premiumCents: number;
        instalmentsCents: number[];
        premiumPerDcaCents: number;
        currencySymbol: string;
        /** What the area covers. Absent on leads written before #1121. */
        areaScope?: 'parcel' | 'crop-at-location' | 'custom';
        /** Only set for 'crop-at-location'. */
        coveredParcelCount?: number;
    } | null;
}

export interface ExchangeMessagePayload {
    /** The commodity the listing is for — what the recipient will recognise. */
    commodity: string;
    /** The RECIPIENT's tenant slug, for a link that lands in their own tenant. */
    tenantSlug: string;
    threadId: string;
}

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


// ─── Insurance lead (Farm Risk, 2026-09-23) ───

/**
 * A farmer asked for an insurance quote on a parcel.
 *
 * Addressed to the PLATFORM OPERATOR, not to the tenant — the tenant is the
 * subject of this mail, not its reader, which is why it is enqueued with
 * `audience: 'platform'` and is not silenced by the tenant's own notification
 * switch.
 *
 * Written in `RECIPIENT_FALLBACK_LOCALE` at the call site rather than resolved
 * from a user row, and deliberately so: the recipient is an address from
 * configuration with no `User` behind it, and the convention is that a
 * producer holding only an email writes the locale EXPLICITLY so the decision
 * shows up in the diff instead of hiding in a default.
 *
 * Every interpolated value is resolved to a local `const` first. The
 * alternative — `${escapeHtml(await t('k'))}` inline — was invisible to the
 * escaping guard until #717 widened its extractor, and the local-const form
 * keeps each value readable at the point it is escaped.
 */
/**
 * "There is something new in a conversation you are part of."
 *
 * Deliberately carries NO message preview, which is the opposite of
 * `buildInsuranceLeadEmail`. This mail is deduped to one per thread per day
 * (see `notifyOtherParty`), so by the time it is read there may be one new
 * message or nine. Quoting one of them would misrepresent the conversation and
 * invite a reply to the wrong thing. A nudge plus a link is honest; a preview
 * would not be.
 *
 * It also keeps private text out of an inbox we do not control. The inquiry
 * mail quotes its message because an inquiry IS one message; a thread is not.
 */
export async function buildExchangeMessageEmail(
    payload: ExchangeMessagePayload,
    locale: Locale,
): Promise<EmailTemplateResult> {
    const { commodity, tenantSlug, threadId } = payload;
    const t = (key: string, params?: Record<string, string | number>) =>
        translateFor(locale, `notificationEmail.exchangeMessage.${key}`, params);

    const link = absoluteUrl(`/t/${tenantSlug}/exchange/threads/${threadId}`);
    const subject = await t('subject', { commodity });
    const heading = await t('heading');
    const intro = await t('intro', { commodity });
    const openLink = await t('open');
    const signature = await translateFor(locale, 'notificationEmail.signature');

    return {
        subject,
        bodyText: [intro, '', link, '', signature].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">${escapeHtml(heading)}</h2>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(intro)}</p>
  <a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">${escapeHtml(openLink)}</a>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">${escapeHtml(signature)}</p>
</div>`.trim(),
    };
}

export async function buildInsuranceLeadEmail(
    payload: InsuranceLeadPayload,
    locale: Locale,
): Promise<EmailTemplateResult> {
    const { tenantName, tenantSlug, parcelName, locationName, cropType, areaHa, message } = payload;
    const { riskOverall, ndvi, ndmi, quote } = payload;
    const t = (key: string, params?: Record<string, string | number>) =>
        translateFor(locale, `notificationEmail.insuranceLead.${key}`, params);

    const link = absoluteUrl(`/t/${tenantSlug}/farm-risk`);
    const subject = await t('subject', { farm: tenantName, parcel: parcelName });
    const heading = await t('heading');
    const intro = await t('intro', { farm: tenantName });
    const parcelLabel = await t('parcelLabel');
    const messageLabel = await t('messageLabel');
    const readingLabel = await t('readingLabel');

    // Every translated string is resolved into a local const BEFORE it is
    // interpolated. The inline `await t(...)` form inside a template literal is
    // invisible to the escaping guard, so it would pass review and ship
    // unescaped (CLAUDE.md).
    let quoteBlock: { label: string; lines: string[] } | null = null;
    if (quote) {
        const quoteLabel = await t('quoteLabel');
        const productLabel = await t('productLabel');
        const areaLabel = await t('areaLabel');
        const sumInsuredLabel = await t('sumInsuredLabel');
        const tariffLabel = await t('tariffLabel');
        const premiumLabel = await t('premiumLabel');
        const perDcaLabel = await t('perDcaLabel');
        const scheduleLabel = await t('scheduleLabel');
        const onceLabel = await t('once');
        const productName = await translateFor(
            locale,
            `insurance.products.${quote.productKey}.name`,
        );
        /**
         * The unit is TRANSLATED, not hardcoded. This line read
         * `${quote.areaDca} dca` until #1121 — an English unit in an email that
         * goes out in Bulgarian, where it is "дка".
         */
        const areaValue = await t('areaUnit', { dca: quote.areaDca });
        /**
         * What the area covers, appended to the area itself so the operator
         * reads one figure with its meaning: "1240 dca — all 12 wheat parcels
         * at Polje Sever". 'parcel' adds nothing, being the default.
         */
        let areaText = areaValue;
        if (quote.areaScope === 'crop-at-location' && quote.coveredParcelCount != null) {
            /**
             * TWO keys, not one ICU plural: `translateFor` does plain `{name}`
             * interpolation and has NO plural support, so a `{count, plural, …}`
             * message reaches the operator's inbox as its own source text. A
             * guard now pins this (`tests/guards/no-icu-plural-in-email-copy`).
             */
            const parcels =
                quote.coveredParcelCount === 1
                    ? await t('scopeParcelsOne', { product: productName })
                    : await t('scopeParcelsMany', {
                          count: quote.coveredParcelCount,
                          product: productName,
                      });
            // Without a location name the "at …" half would dangle.
            areaText = locationName
                ? await t('areaScopeCrop', { area: areaValue, parcels, location: locationName })
                : await t('areaScopeCropNoLocation', { area: areaValue, parcels });
        } else if (quote.areaScope === 'custom') {
            areaText = await t('areaScopeCustom', { area: areaValue });
        }
        const sym = quote.currencySymbol;
        const schedule =
            quote.instalmentsCents.length === 1
                ? onceLabel
                : `${quote.instalmentsCents.length} x ${quote.instalmentsCents
                      .map((c) => formatCents(c, sym))
                      .join(', ')}`;

        quoteBlock = {
            label: quoteLabel,
            lines: [
                `${productLabel}: ${productName}`,
                `${areaLabel}: ${areaText}`,
                `${sumInsuredLabel}: ${formatCents(quote.sumInsuredCents, sym)}`,
                `${tariffLabel}: ${quote.tariffBp / 100} %`,
                `${premiumLabel}: ${formatCents(quote.premiumCents, sym)}`,
                `${perDcaLabel}: ${formatCents(quote.premiumPerDcaCents, sym)}`,
                `${scheduleLabel}: ${schedule}`,
            ],
        };
    }
    const openLink = await t('open');
    const signature = await translateFor(locale, 'notificationEmail.signature');

    // One line of parcel facts, skipping what is absent rather than printing
    // "null" or an empty bracket.
    const facts = [parcelName, locationName, cropType, areaHa != null ? `${areaHa} ha` : null]
        .filter((v): v is string => Boolean(v))
        .join(' · ');

    // The reading the farmer was shown. Absent when Earth Engine had nothing —
    // which is a real state, so the block is omitted rather than shown empty.
    const reading =
        riskOverall || ndvi != null || ndmi != null
            ? [riskOverall, ndvi != null ? `NDVI ${ndvi}` : null, ndmi != null ? `NDMI ${ndmi}` : null]
                  .filter((v): v is string => Boolean(v))
                  .join(' · ')
            : null;

    return {
        subject,
        bodyText: [
            intro,
            '',
            `${parcelLabel}: ${facts}`,
            ...(reading ? [`${readingLabel}: ${reading}`] : []),
            ...(quoteBlock ? ['', `${quoteBlock.label}:`, ...quoteBlock.lines] : []),
            ...(message ? ['', `${messageLabel}:`, message] : []),
            '',
            link,
            '',
            signature,
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">${escapeHtml(heading)}</h2>
  <p style="color: #444; line-height: 1.5;">${escapeHtml(intro)}</p>
  <div style="background: #f4f6fa; border-left: 4px solid #4f46e5; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
    <div><strong>${escapeHtml(parcelLabel)}:</strong> ${escapeHtml(facts)}</div>
    ${reading ? `<div><strong>${escapeHtml(readingLabel)}:</strong> ${escapeHtml(reading)}</div>` : ''}
  </div>
  ${
      quoteBlock
          ? `<div style="background: #f4f6fa; border-left: 4px solid #16a34a; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
    <div><strong>${escapeHtml(quoteBlock.label)}</strong></div>
    ${quoteBlock.lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}
  </div>`
          : ''
  }
  ${
      message
          ? `<p style="color: #444; line-height: 1.5;"><strong>${escapeHtml(messageLabel)}:</strong></p>
  <p style="color: #444; line-height: 1.5; white-space: pre-line;">${escapeHtml(message)}</p>`
          : ''
  }
  <a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">${escapeHtml(openLink)}</a>
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


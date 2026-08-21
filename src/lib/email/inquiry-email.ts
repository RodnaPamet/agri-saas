/**
 * Exchange inquiry email — tells a seller that another tenant expressed
 * interest in one of their marketplace listings.
 *
 * Email is the ONE channel the Exchange is allowed to cross the tenant
 * boundary on: tenant A's inquiry reaches tenant B's admins. Delivery is
 * best-effort and fail-open — the inquiry row is already committed before
 * this runs, so a mailer outage (or the dev/console sink when no SMTP is
 * configured) never fails the inquiry. Returns `{ sent }`, never throws.
 *
 * Mirrors the send shape of `src/lib/email/invite-email.ts`.
 */
import { ConsoleEmailProvider, getEmailProvider, sendEmail } from '@/lib/mailer';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { escapeHtml } from '@/lib/security/escape-html';
import { translateFor } from '@/lib/i18n/server-messages';
import { type Locale } from '@/lib/i18n/locales';
import { RECIPIENT_FALLBACK_LOCALE } from './recipient-locale';

import { commodityLabel } from '@/lib/market/commodity-label';

export interface InquiryEmailParams {
    /** Recipient (a seller-tenant admin/owner email). */
    to: string;
    /**
     * The RECIPIENT's language, from their persisted `User.uiLanguage` — not
     * the locale of whoever triggered the send. A request-scoped translator
     * would give the inquirer's language to the seller, which is the wrong
     * person: this is the one Exchange channel that crosses a tenant
     * boundary. Same reasoning as the notification writer in
     * `promotions.ts`; same helper.
     *
     * Optional so the existing call shape stays valid. Absent falls back to
     * `RECIPIENT_FALLBACK_LOCALE` — deliberately NOT `DEFAULT_LOCALE`, which
     * is `'en'` and is documented as the fallback for UNAUTHENTICATED pages
     * (login, invite preview) so those stay English. This recipient is always
     * an authenticated user, and `User.uiLanguage` defaults to `'bg'` at the
     * column — so `'bg'` is what they would have had, and reaching for the
     * unauthenticated constant here would hand English to a Bulgarian farmer
     * whose preference merely failed to load.
     */
    locale?: Locale;
    /**
     * The listing's canonical commodity SLUG (`wheat`, `ammonium-nitrate`).
     *
     * It used to be documented here as "e.g. Wheat", and that stopped being
     * true at #484, which made the stored value a lowercase slug. Nothing
     * noticed, so a seller received "New interest in your **wheat** listing"
     * — the same defect #677 fixed in the UI, still live in the one Exchange
     * channel that leaves the product. Resolved to a localised name below.
     */
    commodity: string;
    /** SELL or BUY — the side of the seller's own listing. */
    side: string;
    /**
     * The inquiry's free-text message.
     *
     * Sanitised upstream by `sanitizePlainText`, which is NOT sufficient here:
     * that function decodes entities by design, so `&lt;a&gt;` arrives as a
     * live `<a>`. Every use below is escaped at the sink — see the HTML block.
     */
    message: string;
    /** Optional quantity the buyer is after, as a display string. */
    quantityTonnes?: string | null;
    /** Absolute link to the seller's inquiries page. */
    inquiriesUrl: string;
}

/**
 * Send the "new interest" email to a seller admin. Returns `{ sent }` —
 * `false` on any mailer failure (already logged); never throws.
 */
export async function sendInquiryEmail(
    params: InquiryEmailParams,
): Promise<{ sent: boolean }> {
    const { to, commodity, side, message, quantityTonnes, inquiriesUrl } = params;
    const locale = params.locale ?? RECIPIENT_FALLBACK_LOCALE;
    const t = (key: string, vars?: Record<string, string | number>) =>
        translateFor(locale, `exchange.email.${key}`, vars);

    // The commodity name, in the RECIPIENT's language. `translateFor` returns
    // the key path on a miss, which `commodityLabel` already treats as "no
    // entry" and title-cases — so a slug that predates the catalogue reads as
    // `Triticale` rather than `trends.commodities.triticale`.
    const resolvedCommodity = await translateFor(
        locale,
        `trends.commodities.${commodity}`,
    );
    const commodityName = commodityLabel(
        (key) => (key === commodity ? resolvedCommodity : key),
        commodity,
    );
    const sideWord = await t(side === 'SELL' ? 'sideSell' : 'sideBuy');

    const subject = await t('subject', { commodity: commodityName });
    const qtyLine = quantityTonnes
        ? await t('quantity', { quantity: quantityTonnes })
        : '';
    const introLine = await t('intro', { side: sideWord, commodity: commodityName });
    const messageLabel = await t('messageLabel');
    const reviewText = await t('reviewText', { url: inquiriesUrl });
    const reviewLink = await t('reviewLink');
    const privacyLine = await t('privacy');

    const text = [
        introLine,
        '',
        qtyLine || null,
        `${messageLabel} ${message}`,
        '',
        reviewText,
        '',
        privacyLine,
    ]
        .filter((l) => l !== null && l !== '')
        .join('\n');

    // EVERY interpolated value is escaped here, including the ones that look
    // safe. This email crosses the tenant boundary — it is the one Exchange
    // channel that does — so an unescaped value is markup delivered from the
    // platform's own signed domain into ANOTHER tenant's owner/admin inbox.
    // The realistic payloads are a credential-phishing anchor and a remote
    // image that discloses the reader's IP and read time, neither of which
    // needs a script tag to work.
    //
    // `message` is the attacker-controlled one, but commodity/side/quantity
    // are escaped too: whether they are attacker-controlled today is a
    // property of upstream code that can change, and a template with a mix of
    // escaped and unescaped holes teaches the next editor the wrong rule.
    const html = [
        `<p>${escapeHtml(introLine)}</p>`,
        qtyLine ? `<p style="color:#475467">${escapeHtml(qtyLine)}</p>` : '',
        `<p style="color:#475467">${escapeHtml(messageLabel)}</p><blockquote style="margin:0;border-left:3px solid #d0d5dd;padding-left:12px;color:#344054">${escapeHtml(message)}</blockquote>`,
        `<p><a href="${escapeHtml(inquiriesUrl)}">${escapeHtml(reviewLink)}</a></p>`,
        // Says what the code does, and no more. Responding is not the trigger
        // — ACCEPTING is: `respondToInquiry` stamps `contactSharedAt` on ACCEPT
        // only, and the reveal gate withholds both sides' details on a decline.
        // The earlier wording ("shared when you choose to respond") described a
        // decline as sharing, which it never was.
        `<p style="color:#667085;font-size:13px">${escapeHtml(privacyLine)}</p>`,
    ].join('');

    try {
        await sendEmail({ to, subject, text, html });
        // Console sink in prod = logged, not delivered — report not-sent.
        if (
            env.NODE_ENV === 'production' &&
            getEmailProvider() instanceof ConsoleEmailProvider
        ) {
            logger.warn('exchange.inquiry_email_not_delivered_no_smtp', {
                component: 'inquiry-email',
                reason: 'no SMTP configured (console sink)',
            });
            return { sent: false };
        }
        return { sent: true };
    } catch (err) {
        logger.warn('exchange.inquiry_email_send_failed', {
            component: 'inquiry-email',
            error: err instanceof Error ? err.message : String(err),
        });
        return { sent: false };
    }
}

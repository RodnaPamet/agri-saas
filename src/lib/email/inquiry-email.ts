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
 * Localized: copy comes from the `exchange.email` message namespace so a
 * Bulgarian seller gets a Bulgarian email. Default locale is **Bulgarian**
 * — this is a Bulgarian product and the seller-tenant's admins are Bulgarian
 * farms; per-seller locale preference wiring is a follow-up (pass `locale`).
 *
 * Mirrors the send shape of `src/lib/email/invite-email.ts`.
 */
import { ConsoleEmailProvider, getEmailProvider, sendEmail } from '@/lib/mailer';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import enMessages from '../../../messages/en.json';
import bgMessages from '../../../messages/bg.json';

type EmailLocale = 'en' | 'bg';

interface EmailCopy {
    subject: string;
    intro: string;
    quantity: string;
    messageLabel: string;
    reviewText: string;
    reviewLink: string;
    privacy: string;
    sideSell: string;
    sideBuy: string;
}

const COPY: Record<EmailLocale, EmailCopy> = {
    en: enMessages.exchange.email,
    bg: bgMessages.exchange.email,
};

/** Minimal `{var}` interpolation — the email copy uses next-intl placeholders. */
function fmt(tpl: string, vars: Record<string, string>): string {
    return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

export interface InquiryEmailParams {
    /** Recipient (a seller-tenant admin/owner email). */
    to: string;
    /** The listing's commodity, e.g. "Wheat". */
    commodity: string;
    /** SELL or BUY — the side of the seller's own listing. */
    side: string;
    /** The inquiry's free-text message (already sanitized). */
    message: string;
    /** Optional quantity the buyer is after, as a display string. */
    quantityTonnes?: string | null;
    /** Absolute link to the seller's inquiries page. */
    inquiriesUrl: string;
    /** Seller-facing locale — defaults to Bulgarian (the product's primary language). */
    locale?: EmailLocale;
}

/**
 * Send the "new interest" email to a seller admin. Returns `{ sent }` —
 * `false` on any mailer failure (already logged); never throws.
 */
export async function sendInquiryEmail(
    params: InquiryEmailParams,
): Promise<{ sent: boolean }> {
    const { to, commodity, side, message, quantityTonnes, inquiriesUrl, locale = 'bg' } = params;
    const c = COPY[locale];
    const sideWord = side === 'SELL' ? c.sideSell : c.sideBuy;

    const subject = fmt(c.subject, { commodity });
    const qtyLine = quantityTonnes ? fmt(c.quantity, { quantity: quantityTonnes }) : '';
    const text = [
        fmt(c.intro, { side: sideWord, commodity }),
        '',
        qtyLine || null,
        `${c.messageLabel} ${message}`,
        '',
        fmt(c.reviewText, { url: inquiriesUrl }),
    ]
        .filter((l) => l !== null)
        .join('\n');

    const html = [
        `<p>${fmt(c.intro, { side: `<strong>${sideWord}</strong>`, commodity: `<strong>${commodity}</strong>` })}</p>`,
        quantityTonnes
            ? `<p style="color:#475467">${fmt(c.quantity, { quantity: `<strong>${quantityTonnes}</strong>` })}</p>`
            : '',
        `<p style="color:#475467">${c.messageLabel}</p><blockquote style="margin:0;border-left:3px solid #d0d5dd;padding-left:12px;color:#344054">${message}</blockquote>`,
        `<p><a href="${inquiriesUrl}">${c.reviewLink}</a></p>`,
        `<p style="color:#667085;font-size:13px">${c.privacy}</p>`,
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

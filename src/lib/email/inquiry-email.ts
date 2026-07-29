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

export interface InquiryEmailParams {
    /** Recipient (a seller-tenant admin/owner email). */
    to: string;
    /** The listing's commodity, e.g. "Wheat". */
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

    const subject = `New interest in your ${commodity} listing`;
    const qtyLine = quantityTonnes ? `Quantity of interest: ${quantityTonnes} t\n` : '';
    const text = [
        `Another farm expressed interest in your ${side} listing for ${commodity}.`,
        '',
        qtyLine ? qtyLine.trimEnd() : null,
        `Message: ${message}`,
        '',
        `Review it and respond here: ${inquiriesUrl}`,
    ]
        .filter((l) => l !== null)
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
        `<p>Another farm expressed interest in your <strong>${escapeHtml(side)}</strong> listing for <strong>${escapeHtml(commodity)}</strong>.</p>`,
        quantityTonnes
            ? `<p style="color:#475467">Quantity of interest: <strong>${escapeHtml(quantityTonnes)} t</strong></p>`
            : '',
        `<p style="color:#475467">Message:</p><blockquote style="margin:0;border-left:3px solid #d0d5dd;padding-left:12px;color:#344054">${escapeHtml(message)}</blockquote>`,
        `<p><a href="${escapeHtml(inquiriesUrl)}">Review the inquiry and respond</a></p>`,
        `<p style="color:#667085;font-size:13px">Contact details are shared only when you choose to respond.</p>`,
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

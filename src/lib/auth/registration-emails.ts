/**
 * The two emails registration v2 can send, and why there are exactly two.
 *
 * `POST /api/auth/register/start` answers identically whatever the address
 * turns out to be — that is what stops it being an account-enumeration oracle.
 * But "identical response" must not mean "identical outcome", or a person who
 * already has an account would submit the form, be told to check their inbox,
 * and find nothing there. The difference has to land somewhere, and the only
 * safe place is the MAILBOX, which only its owner can read.
 *
 * So:
 *
 *   * a new or still-unverified address gets a **code**;
 *   * an address that already has a verified account gets **"you already have
 *     one, sign in"** — which is both the honest answer and the useful one,
 *     and tells the real owner that somebody tried.
 *
 * Neither sender throws. A mailer failure must not change the HTTP response
 * (that would reinstate the oracle through the error path) and must not undo
 * the code already stored. Failures go to the log and the delivery counter,
 * which is where an operator looks and an attacker cannot.
 */
import { sendEmail } from '@/lib/mailer';
import { logger } from '@/lib/observability/logger';
import { translateFor } from '@/lib/i18n/server-messages';
import type { Locale } from '@/lib/i18n/locales';
import { escapeHtml } from '@/lib/security/escape-html';
import { RECIPIENT_FALLBACK_LOCALE } from '@/lib/email/recipient-locale';
import { CODE_TTL_MS } from './email-verification-code';

/** Minutes, for the copy. Derived from the TTL so the two cannot disagree. */
const TTL_MINUTES = Math.round(CODE_TTL_MS / 60_000);

/**
 * Send the 6-digit code.
 *
 * The code is in the BODY and deliberately not in the subject. A subject line
 * shows up in lock-screen notifications and inbox previews, and it is the part
 * of a message most likely to be retained in a relay's logs — none of which
 * are places a one-time credential should appear.
 */
export async function sendVerificationCodeEmail(
    email: string,
    code: string,
    locale: Locale = RECIPIENT_FALLBACK_LOCALE,
): Promise<void> {
    const t = (key: string, params?: Record<string, string | number>) =>
        translateFor(locale, `auth.email.${key}`, params);

    try {
        await sendEmail({
            to: email,
            subject: await t('codeSubject'),
            text: [
                await t('codeIntro'),
                '',
                await t('codeBody'),
                '',
                code,
                '',
                await t('codeExpiry', { minutes: TTL_MINUTES }),
                '',
                await t('codeIgnore'),
            ].join('\n'),
            html: [
                `<p>${escapeHtml(await t('codeIntro'))}</p>`,
                `<p>${escapeHtml(await t('codeBody'))}</p>`,
                // Letter-spaced and large because the whole job of this element
                // is to be read off one screen and typed into another.
                `<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0">${escapeHtml(code)}</p>`,
                `<p>${escapeHtml(await t('codeExpiry', { minutes: TTL_MINUTES }))}</p>`,
                `<p>${escapeHtml(await t('codeIgnore'))}</p>`,
            ].join(''),
        });
    } catch (err) {
        logger.warn('registration code email send failed', {
            component: 'auth',
            event: 'registration_code_email_failed',
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Tell an existing account holder that someone tried to register as them.
 *
 * Carries no code, no link and no token — there is nothing to act on beyond
 * signing in, and a credential in this message would make "register with
 * someone else's address" a way to send them one.
 */
export async function sendAlreadyRegisteredEmail(
    email: string,
    locale: Locale = RECIPIENT_FALLBACK_LOCALE,
): Promise<void> {
    const t = (key: string) => translateFor(locale, `auth.email.${key}`);

    try {
        await sendEmail({
            to: email,
            subject: await t('existingSubject'),
            text: [
                await t('existingIntro'),
                '',
                await t('existingBody'),
                '',
                await t('existingIgnore'),
            ].join('\n'),
            html: [
                `<p>${escapeHtml(await t('existingIntro'))}</p>`,
                `<p>${escapeHtml(await t('existingBody'))}</p>`,
                `<p>${escapeHtml(await t('existingIgnore'))}</p>`,
            ].join(''),
        });
    } catch (err) {
        logger.warn('already-registered email send failed', {
            component: 'auth',
            event: 'already_registered_email_failed',
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

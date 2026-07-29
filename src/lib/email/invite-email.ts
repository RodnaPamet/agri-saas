/**
 * Invite email — sends the acceptance link to an invited recipient.
 *
 * Invites previously only minted a token + URL that an admin had to
 * copy and share out-of-band; the "Invite by email" button never
 * actually emailed anyone. This wires the invite-create flow to the
 * shared mailer so the recipient gets the link directly.
 *
 * Delivery is best-effort and fail-open: the invite row is already
 * committed before this runs, so a mailer outage (or the dev/console
 * sink when no SMTP is configured) never fails invite creation — the
 * caller still returns the URL so the admin can copy it as a fallback.
 * The boolean result lets the caller tell the admin whether the email
 * actually went out.
 *
 * Mirrors the send shape of `src/lib/auth/email-verification.ts`.
 */
import { ConsoleEmailProvider, getEmailProvider, sendEmail } from '@/lib/mailer';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { escapeHtml } from '@/lib/security/escape-html';

export interface InviteEmailParams {
    /** Recipient address (the invited email). */
    to: string;
    /** Absolute acceptance URL (origin already prepended by the caller). */
    acceptUrl: string;
    /** "organization" or "workspace" — the kind of space being joined. */
    kind: 'organization' | 'workspace';
    /** Human-facing name of the org / tenant (slug or display name). */
    spaceName: string;
    /** Human-facing role label, e.g. "Org admin", "Editor". */
    roleLabel: string;
    /** Display name of the inviting admin, if known. */
    invitedByName?: string | null;
    /** Invite expiry, for the "expires in N days" line. */
    expiresAt: Date;
    /** Stamped at the send site (Date.now() is unavailable in some sandboxes). */
    now?: Date;
}

function daysUntil(expiresAt: Date, now: Date): number {
    return Math.max(
        1,
        Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000),
    );
}

/**
 * Send the invite acceptance email. Returns `{ sent }` — `false` on any
 * mailer failure (already logged); never throws.
 */
export async function sendInviteEmail(
    params: InviteEmailParams,
): Promise<{ sent: boolean }> {
    const {
        to,
        acceptUrl,
        kind,
        spaceName,
        roleLabel,
        invitedByName,
        expiresAt,
        now = new Date(),
    } = params;

    const inviter = invitedByName?.trim()
        ? `${invitedByName.trim()} invited you`
        : `You've been invited`;
    const days = daysUntil(expiresAt, now);
    const subject = `Invitation to join ${spaceName} on Agrent`;

    const text = [
        `${inviter} to join the ${kind} "${spaceName}" on Agrent as ${roleLabel}.`,
        '',
        `Accept your invitation:`,
        acceptUrl,
        '',
        `This link expires in ${days} day${days === 1 ? '' : 's'}.`,
        `If you weren't expecting this, you can ignore this email.`,
    ].join('\n');

    // Escaped at the sink. `spaceName` and the display name inside `inviter`
    // are chosen by whoever created the space, and an invitation is delivered
    // to someone who is not yet a member — so the recipient has no prior trust
    // relationship with the sender and every reason to click. Escaping the
    // composed `inviter` also escapes the apostrophe in its own literal, which
    // renders identically.
    const html = [
        `<p>${escapeHtml(inviter)} to join the ${escapeHtml(kind)} <strong>${escapeHtml(spaceName)}</strong> on Agrent as <strong>${escapeHtml(roleLabel)}</strong>.</p>`,
        `<p><a href="${escapeHtml(acceptUrl)}">Accept your invitation</a></p>`,
        `<p style="color:#667085;font-size:13px">This link expires in ${days} day${days === 1 ? '' : 's'}. If you weren't expecting this, you can ignore this email.</p>`,
    ].join('');

    try {
        await sendEmail({ to, subject, text, html });
        // The mailer falls back to a console sink when no SMTP is configured;
        // in production that means the message was LOGGED, not delivered.
        // Report it as not-sent so the caller surfaces the copy-link fallback
        // instead of a false "emailed" confirmation, and warn loudly so the
        // missing SMTP config is discoverable. (The console sink is the
        // intended dev default — only treat it as a non-delivery in prod.)
        if (
            env.NODE_ENV === 'production' &&
            getEmailProvider() instanceof ConsoleEmailProvider
        ) {
            logger.warn('invite.email_not_delivered_no_smtp', {
                component: 'invite-email',
                kind,
                reason: 'no SMTP configured (console sink); set SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM',
            });
            return { sent: false };
        }
        return { sent: true };
    } catch (err) {
        logger.warn('invite.email_send_failed', {
            component: 'invite-email',
            kind,
            error: err instanceof Error ? err.message : String(err),
        });
        return { sent: false };
    }
}

/**
 * Password lifecycle — change (authenticated) + reset (token-driven).
 *
 * Two flows, one module because they share the same invariants:
 *
 *   change  ─▶ changePassword(userId, current, next)
 *               verify the current password, then swap the hash and
 *               revoke every session.
 *
 *   reset   ─▶ issuePasswordReset(email)         (forgot-password)
 *               mint a single-use token, email the link.
 *           ─▶ consumePasswordReset(token, next) (reset-password)
 *               claim the token, swap the hash, revoke every session.
 *
 * ## Token model (reset)
 * Mirrors `email-verification.ts`: 32 bytes of entropy → raw token in
 * the email link only; the DB stores `SHA-256(raw)` so a leaked dump
 * cannot be replayed. Single-use is enforced by a conditional
 * `updateMany` claim (`usedAt IS NULL AND expiresAt > now`) — concurrent
 * submits of the same link race to exactly one winner. TTL is 1 hour:
 * account-takeover-adjacent, so much shorter than the 24h verify-email
 * link.
 *
 * ## Session invalidation (both flows)
 * Changing OR resetting a password revokes EVERY session for the user:
 *   - `User.sessionVersion` is incremented (the throttled JWT-callback
 *     backstop), and
 *   - every live `UserSession` row is stamped `revokedAt` (the
 *     per-request Epic C.3 check, which is immediate, not throttled).
 * For `changePassword` this includes the caller's own session — the
 * route signals `reauthRequired` so the UI redirects to sign-in. This
 * is deliberate: a password change should not leave a stale session
 * alive anywhere, and an attacker resetting a compromised account must
 * not keep the victim's (or their own) session past the reset.
 *
 * ## Enumeration safety
 * `issuePasswordReset` returns `void` whether or not the email maps to
 * a credentials user — the caller always responds with the same 200.
 * Accounts that sign in only through OAuth have no `passwordHash`; a
 * reset is silently a no-op for them (there is no password to reset).
 *
 * ## What is NEVER logged
 * Plaintext passwords and raw reset tokens never touch the logger — see
 * `security-events.ts`, which hashes the email for correlation.
 */

import crypto from 'node:crypto';

import prisma from '@/lib/prisma';
import { getAppBaseUrl } from './app-base-url';
import { sendEmail } from '@/lib/mailer';
import { logger } from '@/lib/observability/logger';
import { hashForLookup } from '@/lib/security/encryption';

import { hashPassword, verifyPassword } from './passwords';
import { translateFor } from '@/lib/i18n/server-messages';
import { isLocale } from '@/lib/i18n/locales';
import { escapeHtml } from '@/lib/security/escape-html';
import { RECIPIENT_FALLBACK_LOCALE } from '@/lib/email/recipient-locale';
import {
    recordPasswordResetRequested,
    recordPasswordResetCompleted,
    recordPasswordChanged,
} from './security-events';

// ── Policy ─────────────────────────────────────────────────────────────

/** Reset-token lifetime. 1 hour — short, because a reset link is an
 *  account-takeover primitive. (Verify-email links get 24h; they are
 *  lower stakes.) */
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** 32 bytes of entropy → 64 hex chars. 256 bits is unguessable. */
const TOKEN_BYTES = 32;

// ── Token helpers ──────────────────────────────────────────────────────

function generateRawToken(): string {
    return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function hashToken(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

function normaliseEmail(email: string): string {
    return (email ?? '').trim().toLowerCase();
}

// ── Issue (forgot-password) ────────────────────────────────────────────

export interface IssuePasswordResetOptions {
    /** Caller-supplied requestId for log correlation. */
    requestId?: string;
}

/**
 * Issue a fresh password-reset token for the given address and send the
 * reset email. Always resolves — callers MUST return the same 200 shape
 * regardless of outcome so the response can't be used to enumerate
 * registered emails.
 *
 * No-ops (silently) when:
 *   - no user owns the email, OR
 *   - the user has no `passwordHash` (OAuth-only account — nothing to
 *     reset).
 *
 * Any prior outstanding tokens for the user are deleted so only the
 * newest link is live; an expired-token sweep is folded into the same
 * transaction to keep the table tidy without a separate cron.
 */
export async function issuePasswordReset(
    email: string,
    opts: IssuePasswordResetOptions = {},
): Promise<void> {
    const identifier = normaliseEmail(email);
    if (!identifier) return;

    const user = await prisma.user.findUnique({
        where: { emailHash: hashForLookup(identifier) },
        select: { id: true, email: true, passwordHash: true, uiLanguage: true },
    });

    // Enumeration-safe no-op: unknown email, or an OAuth-only account
    // that never had a password. The caller still returns 200.
    if (!user || !user.passwordHash) return;

    const raw = generateRawToken();
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS);

    await prisma.$transaction([
        // Drop the user's prior reset tokens (a new request invalidates
        // the old link) plus any globally-expired rows — opportunistic
        // cleanup, issuance is rare enough to make a cron unnecessary.
        prisma.passwordResetToken.deleteMany({
            where: { OR: [{ userId: user.id }, { expiresAt: { lt: new Date() } }] },
        }),
        prisma.passwordResetToken.create({
            data: { userId: user.id, tokenHash, expiresAt },
        }),
    ]);

    await recordPasswordResetRequested({
        userId: user.id,
        email: user.email,
        requestId: opts.requestId,
    });

    // Must be ABSOLUTE. A mail client has no base document, so a relative
    // href renders as dead text and the user has no way to reset. See
    // getAppBaseUrl — APP_URL is optional in env, so this previously fell
    // back to '' and produced exactly that.
    const base = getAppBaseUrl();
    const resetUrl = `${base}/reset-password?token=${encodeURIComponent(raw)}`;

    // Written in the RECIPIENT's language. `translateFor` takes an explicit
    // locale because `getTranslations()` resolves from the request cookie —
    // the wrong source for anything addressed to a specific person. See #694.
    const locale = isLocale(user.uiLanguage) ? user.uiLanguage : RECIPIENT_FALLBACK_LOCALE;
    const t = (key: string) => translateFor(locale, `auth.email.${key}`);

    try {
        await sendEmail({
            to: user.email,
            subject: await t('resetSubject'),
            text: [
                await t('resetIntro'),
                '',
                await t('resetBody'),
                '',
                resetUrl,
                '',
                await t('resetIgnore'),
            ].join('\n'),
            html: [
                `<p>${escapeHtml(await t('resetIntro'))}</p>`,
                `<p>${escapeHtml(await t('resetBody'))}</p>`,
                `<p><a href="${escapeHtml(resetUrl)}">${escapeHtml(await t('resetCta'))}</a></p>`,
                `<p>${escapeHtml(await t('resetIgnore'))}</p>`,
            ].join(''),
        });
    } catch (err) {
        // Token is already stored; mailer failure must not propagate
        // (the caller returns the same 200 regardless — enumeration
        // safety). Operator sees the failure in the mailer's own logs.
        logger.warn('password-reset email send failed', {
            component: 'auth',
            userId: user.id,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ── Consume (reset-password) ───────────────────────────────────────────

export type ConsumePasswordResetResult =
    | { ok: true; userId: string }
    | { ok: false; reason: 'invalid' | 'expired' };

/**
 * Consume a raw reset token and set `newPassword` as the user's
 * password. `newPassword` MUST already have passed
 * `validatePasswordPolicy` + `checkPasswordAgainstHIBP` at the route
 * boundary — this function only owns the token + persistence half.
 *
 *   - ok=true   → password swapped, every session revoked.
 *   - invalid   → token never existed, already used, or lost the
 *                 single-use claim race.
 *   - expired   → token row existed but past its TTL (row is burned so
 *                 a retry can't succeed if the clock drifts).
 */
export async function consumePasswordReset(
    rawToken: string,
    newPassword: string,
): Promise<ConsumePasswordResetResult> {
    const raw = (rawToken ?? '').trim();
    if (!raw) return { ok: false, reason: 'invalid' };

    const tokenHash = hashToken(raw);
    const record = await prisma.passwordResetToken.findUnique({
        where: { tokenHash },
        include: { user: { select: { id: true, email: true } } },
    });

    // Missing, or already consumed — indistinguishable to the caller on
    // purpose (a used token and a never-issued token both read "invalid").
    if (!record || record.usedAt) return { ok: false, reason: 'invalid' };

    if (record.expiresAt.getTime() < Date.now()) {
        // Burn the expired row so a clock-skew retry can't slip through.
        await prisma.passwordResetToken
            .update({ where: { id: record.id }, data: { usedAt: new Date() } })
            .catch(() => undefined);
        return { ok: false, reason: 'expired' };
    }

    // Atomic single-use claim. If a concurrent submit already flipped
    // `usedAt`, count is 0 and this caller loses the race.
    const claim = await prisma.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
    });
    if (claim.count !== 1) return { ok: false, reason: 'invalid' };

    // Hash outside the transaction so bcrypt's ~200ms doesn't hold a
    // DB transaction open.
    const passwordHash = await hashPassword(newPassword);
    const now = new Date();

    await prisma.$transaction([
        prisma.user.update({
            where: { id: record.userId },
            data: { passwordHash, sessionVersion: { increment: 1 } },
        }),
        prisma.userSession.updateMany({
            where: { userId: record.userId, revokedAt: null },
            data: { revokedAt: now, revokedReason: 'user:password-reset' },
        }),
        // Defensive: invalidate any other live tokens for this user
        // (there should be none — issuance deletes priors — but a
        // raced double-request must not leave a second usable link).
        prisma.passwordResetToken.updateMany({
            where: { userId: record.userId, usedAt: null },
            data: { usedAt: now },
        }),
    ]);

    await recordPasswordResetCompleted({
        userId: record.userId,
        email: record.user.email,
    });

    return { ok: true, userId: record.userId };
}

// ── Change (authenticated) ─────────────────────────────────────────────

export type ChangePasswordResult =
    | { ok: true }
    | { ok: false; reason: 'no_password' | 'wrong_password' };

/**
 * Change the password for an already-authenticated user.
 * `newPassword` MUST already have passed `validatePasswordPolicy` +
 * `checkPasswordAgainstHIBP` at the route boundary.
 *
 *   - no_password    → the account has no `passwordHash` (OAuth-only);
 *                      there is nothing to change.
 *   - wrong_password → `currentPassword` does not verify.
 *   - ok=true        → password swapped, EVERY session revoked
 *                      (including the caller's — the route returns
 *                      `reauthRequired`).
 */
export async function changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    opts: { requestId?: string } = {},
): Promise<ChangePasswordResult> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, passwordHash: true },
    });
    if (!user || !user.passwordHash) return { ok: false, reason: 'no_password' };

    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) return { ok: false, reason: 'wrong_password' };

    const passwordHash = await hashPassword(newPassword);
    const now = new Date();

    await prisma.$transaction([
        prisma.user.update({
            where: { id: userId },
            data: { passwordHash, sessionVersion: { increment: 1 } },
        }),
        prisma.userSession.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: now, revokedReason: 'user:password-change' },
        }),
    ]);

    await recordPasswordChanged({
        userId: user.id,
        email: user.email,
        requestId: opts.requestId,
    });

    return { ok: true };
}

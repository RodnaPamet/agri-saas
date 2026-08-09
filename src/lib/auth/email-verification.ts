/**
 * Email-verification token flow.
 *
 * Schema reuse: the Prisma `VerificationToken` model (NextAuth-shaped,
 * already on the schema) stores `identifier` (email), `token` (stored
 * as SHA-256 hash of the raw value — NEVER the raw value), and
 * `expires`. Raw tokens only ever exist in memory on the issue side and
 * on the verify side; the DB stores only the hash so a leaked DB dump
 * can't grant instant access.
 *
 * Lifecycle:
 *
 *   register / resend ─▶ issueEmailVerification
 *                          │    delete any prior tokens for this email
 *                          │    cryptographic random(32) → raw token
 *                          │    SHA-256(raw) → stored hash
 *                          │    insert { email, hash, expires: now + TTL }
 *                          └──▶ sendEmail with URL containing raw token
 *
 *   email click ──▶ GET /api/auth/verify-email?token=<raw>
 *                          │
 *                          ▼
 *                  consumeEmailVerification
 *                     │  SHA-256(raw) → hash
 *                     │  find token row; reject if missing / expired
 *                     │  delete row (single-use)
 *                     │  user.emailVerified = now()
 *                     └─▶ returns { ok, userId?, email? }
 *
 * No raw token touches the logger — only the hash. Audit events fire
 * via `security-events.ts` so verification activity lands in the same
 * hash-chained trail as login successes.
 */

import crypto from 'node:crypto';

import prisma from '@/lib/prisma';
import { getAppBaseUrl } from './app-base-url';
import { sendEmail } from '@/lib/mailer';
import { logger } from '@/lib/observability/logger';
import { recordVerificationEmailDelivery } from '@/lib/observability/metrics';
import { hashForLookup } from '@/lib/security/encryption';

import {
    recordEmailVerificationIssued,
    recordEmailVerified,
} from './security-events';

// ── Policy ─────────────────────────────────────────────────────────────

/** Token lifetime in milliseconds. 24h is NIST 800-63B's guidance for
 *  one-time verification links — long enough for users to get round to
 *  clicking, short enough that an intercepted link isn't useful a week
 *  later. */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** 32 bytes of entropy → 64 hex chars. OWASP recommends ≥128 bits for
 *  session-equivalent tokens; 256 bits is a safe ceiling. */
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

// ── Issue ──────────────────────────────────────────────────────────────

export interface IssueVerificationOptions {
    /** The user id that owns this email. Used for audit attribution. */
    userId: string;
    /** Caller-supplied requestId for log correlation. */
    requestId?: string;
    /**
     * Originating flow. Threaded onto the OTel metric so operators
     * can pivot the failure-rate dashboard between first-signup and
     * resend traffic. Defaults to `register` — set `resend` from the
     * `/api/auth/verify-email/resend` route.
     */
    flow?: 'register' | 'resend';
}

/**
 * Issue a fresh email-verification token for the given address and
 * send the verification email.
 *
 * Any prior outstanding tokens for the same email are deleted — a user
 * requesting a resend invalidates their previous link (and an attacker
 * who slipped in on a stolen-email link doesn't stay in).
 *
 * Failure to enqueue the email does NOT delete the token; callers that
 * expose this function to untrusted input should return the same 200 OK
 * shape regardless of whether the email actually went out, to keep the
 * response behaviour enumeration-safe.
 */
export async function issueEmailVerification(
    email: string,
    opts: IssueVerificationOptions,
): Promise<void> {
    const identifier = normaliseEmail(email);
    if (!identifier) throw new Error('issueEmailVerification: empty email');

    const raw = generateRawToken();
    const tokenHash = hashToken(raw);
    const expires = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

    // Replace-by-identifier: drop any prior tokens for this email first
    // so only the latest link is valid. Uses a transaction so a resend
    // mid-verify can't leave two live tokens for the same user.
    //
    // Opportunistic global cleanup: issuance is rare enough (~once per
    // user ever, plus resends) that folding a deleteMany-where-expired
    // into the same transaction keeps the table tidy without a separate
    // cron. If issuance volume ever grows, flip this to a scheduled job
    // via `pruneExpiredVerificationTokens` below.
    await prisma.$transaction([
        prisma.verificationToken.deleteMany({
            where: { OR: [{ identifier }, { expires: { lt: new Date() } }] },
        }),
        prisma.verificationToken.create({
            data: {
                identifier,
                token: tokenHash,
                expires,
            },
        }),
    ]);

    await recordEmailVerificationIssued({
        userId: opts.userId,
        email: identifier,
        requestId: opts.requestId,
    });

    // Build the verification URL. Must be ABSOLUTE: a mail client has no
    // base document to resolve against, so a relative href renders as dead
    // text and the link is unusable. APP_URL is optional in env, so this
    // previously fell back to '' and shipped exactly that.
    const base = getAppBaseUrl();
    const verifyUrl = `${base}/api/auth/verify-email?token=${encodeURIComponent(raw)}`;

    const flow = opts.flow ?? 'register';
    try {
        await sendEmail({
            to: identifier,
            subject: 'Verify your email',
            text: [
                'Welcome to Agrent.',
                '',
                'Click the link below to verify your email address. The link expires in 24 hours.',
                '',
                verifyUrl,
                '',
                "If you didn't request this, you can ignore this message — the link won't do anything until you click it.",
            ].join('\n'),
            html: [
                '<p>Welcome to Agrent.</p>',
                '<p>Click the link below to verify your email address. The link expires in 24 hours.</p>',
                `<p><a href="${verifyUrl}">Verify email</a></p>`,
                "<p>If you didn't request this, you can ignore this message — the link won't do anything until you click it.</p>",
            ].join(''),
        });
        recordVerificationEmailDelivery({ outcome: 'sent', flow });
    } catch (err) {
        // Don't propagate — the token is already stored. Operator sees
        // the failure in the mailer's own logs PLUS the OTel counter
        // (the first user-visible signal would be locked-out signups
        // once AUTH_REQUIRE_EMAIL_VERIFICATION=1; the metric trips
        // before then). The API caller gets the same 200 regardless
        // of mailer outcome (enumeration safety).
        recordVerificationEmailDelivery({ outcome: 'failed', flow });
        logger.warn('verification email send failed', {
            component: 'auth',
            event: 'verification_email_send_failed',
            flow,
            userId: opts.userId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ── Consume ────────────────────────────────────────────────────────────

export type ConsumeResult =
    | { ok: true; userId: string; email: string }
    | { ok: false; reason: 'invalid' | 'expired' };

/**
 * Consume a raw verification token. Returns a typed result; callers
 * decide how to shape the response.
 *
 *   - ok=true  → User.emailVerified has been set to NOW(); the token row
 *                is deleted; the caller can proceed to log the user in
 *                automatically or redirect to /login.
 *   - invalid  → token hash wasn't found in the DB (never issued, or
 *                already consumed). Indistinguishable at the DB layer
 *                from "the token was valid but has been purged".
 *   - expired  → row existed but `expires < now`. Row is deleted to
 *                prevent a second attempt at the same link from
 *                succeeding if the clock drifts.
 *
 * `invalid` and `expired` are both user-facing — the verify endpoint
 * surfaces them because knowing "your link expired" is a legitimately
 * useful UX message that isn't a meaningful enumeration vector (an
 * attacker guessing 256-bit tokens is already past any other practice).
 */
export async function consumeEmailVerification(
    rawToken: string,
): Promise<ConsumeResult> {
    const raw = (rawToken ?? '').trim();
    if (!raw) return { ok: false, reason: 'invalid' };

    const tokenHash = hashToken(raw);

    const record = await prisma.verificationToken.findUnique({
        where: { token: tokenHash },
    });
    if (!record) return { ok: false, reason: 'invalid' };

    if (record.expires.getTime() < Date.now()) {
        await prisma.verificationToken
            .delete({ where: { token: tokenHash } })
            .catch(() => undefined);
        return { ok: false, reason: 'expired' };
    }

    const identifier = record.identifier;
    const user = await prisma.user.findUnique({
        where: { emailHash: hashForLookup(identifier) },
        select: { id: true, email: true, emailVerified: true },
    });
    if (!user) {
        // Token points at a user that no longer exists — e.g. account
        // deleted between issue and verify. Clean up and report invalid.
        await prisma.verificationToken
            .delete({ where: { token: tokenHash } })
            .catch(() => undefined);
        return { ok: false, reason: 'invalid' };
    }

    // Single transaction so we never end up with "token deleted but
    // user not updated" (or vice versa).
    await prisma.$transaction([
        prisma.verificationToken.delete({ where: { token: tokenHash } }),
        // Only write emailVerified if not already set, so repeat clicks
        // don't shift the verification timestamp around.
        ...(user.emailVerified
            ? []
            : [
                  prisma.user.update({
                      where: { id: user.id },
                      data: { emailVerified: new Date() },
                  }),
              ]),
    ]);

    await recordEmailVerified({ userId: user.id, email: user.email });

    return { ok: true, userId: user.id, email: user.email };
}

// ── Maintenance ────────────────────────────────────────────────────────

/**
 * Delete every verification token whose `expires` has passed. Safe to
 * call any time — idempotent, tenant-agnostic, O(expired-rows) at the DB.
 *
 * Wire-up options (pick one, don't do both):
 *   - A BullMQ job scheduled via `src/app-layer/jobs/` (daily cadence is
 *     plenty; tokens have a 24h TTL).
 *   - A one-shot `scripts/prune-verification-tokens.ts` invoked by a
 *     cron on the VM.
 *
 * As written today, `issueEmailVerification` also folds a prune into
 * its own write transaction so stale rows get cleaned up naturally
 * while issuance is occurring. The helper below is for *operators* who
 * want to force a sweep or schedule one without going through issue.
 */
export async function pruneExpiredVerificationTokens(): Promise<number> {
    const result = await prisma.verificationToken.deleteMany({
        where: { expires: { lt: new Date() } },
    });
    return result.count;
}

/**
 * Six-digit email-verification codes, for registration v2 (P3.5).
 *
 * The product's existing verification is a 32-byte token in a clicked link
 * (`email-verification.ts`). This is the other shape: a code a person reads
 * from an open inbox and types into a form they have not left. Both prove the
 * same thing, so the difference that matters is not the length — it is that a
 * code has a 10^6 keyspace and is therefore GUESSABLE.
 *
 * Everything unusual below follows from that one fact:
 *
 *   * **Attempts are counted and capped.** 10^6 is minutes of work at any
 *     useful request rate. `MAX_ATTEMPTS` is the control, and it is enforced
 *     by a conditional UPDATE rather than a read-then-write, so parallel
 *     guesses cannot each read `attempts: 4` and all proceed.
 *   * **The TTL is minutes, not a day.** A link lives 24h because people get
 *     round to clicking. A code is typed inside a signup already in progress,
 *     so a long life buys nothing and widens the window a guesser has.
 *   * **Exhausting the attempts DESTROYS the code.** Refusing while leaving it
 *     alive would let an attacker burn a victim's code — but worse, it would
 *     make the cap a per-code speed bump instead of a wall: the attacker just
 *     waits for the honest user to request a new one and keeps going. Forcing
 *     reissue means every 10^6 guess budget costs a fresh email.
 *
 * `generateCode` uses `crypto.randomInt`, NOT `Math.floor(Math.random() * …)`
 * and not `randomBytes % 1000000`. The modulo is the subtle one: 2^32 is not a
 * multiple of 10^6, so `% 1000000` is biased toward low values — small, but it
 * is free to avoid and the bias is in exactly the region a guesser tries first.
 */
import crypto from 'node:crypto';

import prisma from '@/lib/prisma';
import { hashForLookup, hashForLookupCandidates } from '@/lib/security/encryption';

/** Digits in a code. Six is what a person will retype without resenting it. */
export const CODE_LENGTH = 6;

/**
 * How long a code lives. Fifteen minutes covers a slow mail hop plus a person
 * switching to their inbox and back; it does not cover walking away and
 * resuming tomorrow, which is what `resend` is for.
 */
export const CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Wrong guesses allowed against one code before it is destroyed.
 *
 * Five, with a 10^6 keyspace, bounds a single code's exposure at 5-in-a-million
 * — and because exhaustion forces a reissue, a sustained attack needs one
 * delivered email per five guesses, which is both slow and loud.
 */
export const MAX_ATTEMPTS = 5;

export type VerifyFailure = 'invalid' | 'expired' | 'too_many_attempts';
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

/** Lowercase and trim, so `  Ivan@Example.BG ` and `ivan@example.bg` are one identity. */
export function normaliseEmail(email: string): string {
    return (email ?? '').trim().toLowerCase();
}

/**
 * A uniformly random code, zero-padded, as a string.
 *
 * It is a STRING throughout and never a number: `012345` is a valid code, and
 * a number round-trip silently makes it `12345`, which then fails to verify
 * for one person in ten with no way to tell why.
 */
export function generateCode(): string {
    const max = 10 ** CODE_LENGTH;
    return String(crypto.randomInt(0, max)).padStart(CODE_LENGTH, '0');
}

/** SHA-256 of the digits. The raw code lives only in the email and in memory. */
function hashCode(code: string): string {
    return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak — so
 * the lengths are checked first and a mismatch returns false without calling
 * it. Both operands here are SHA-256 hex and therefore always 64 chars, so
 * that branch is unreachable in practice; it is written anyway because "this
 * can't happen" is how the next caller gets a throw instead of a false.
 */
function sameDigest(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Issue a fresh code for an email, replacing any outstanding one.
 *
 * Returns the RAW code for the caller to email. It is deliberately not sent
 * from here: the caller owns the message, its locale and its template, and a
 * function that both mints a credential and performs I/O is one that cannot
 * be tested without a mail double.
 *
 * Replace-by-email, so a resend invalidates the previous code. Expired rows
 * anywhere in the table are swept in the same transaction — issuance is rare
 * enough that this keeps the table bounded without a scheduled job, the same
 * reasoning `issueEmailVerification` records.
 */
export async function issueEmailVerificationCode(email: string): Promise<string> {
    const identifier = normaliseEmail(email);
    if (!identifier) throw new Error('issueEmailVerificationCode: empty email');

    const code = generateCode();
    const emailHash = hashForLookup(identifier);

    await prisma.$transaction([
        prisma.emailVerificationCode.deleteMany({
            where: {
                OR: [
                    { emailHash: { in: hashForLookupCandidates(identifier) } },
                    { expiresAt: { lt: new Date() } },
                ],
            },
        }),
        prisma.emailVerificationCode.create({
            data: {
                emailHash,
                codeHash: hashCode(code),
                expiresAt: new Date(Date.now() + CODE_TTL_MS),
            },
        }),
    ]);

    return code;
}

/**
 * Check a code for an email, consuming it on success.
 *
 * Every failure is reported as a reason the CALLER may choose to collapse.
 * They are distinguished here because the issuing surface needs them — a
 * resend prompt for `expired` is useful, and `too_many_attempts` has to be
 * distinguishable from `invalid` or the operator cannot tell a fat-fingered
 * user from an attack. An ENUMERATION-sensitive route should collapse them,
 * and `/api/auth/register/verify` does.
 */
export async function verifyEmailVerificationCode(
    email: string,
    code: string,
): Promise<VerifyResult> {
    const identifier = normaliseEmail(email);
    const supplied = (code ?? '').trim();
    if (!identifier || !supplied) return { ok: false, reason: 'invalid' };

    const row = await prisma.emailVerificationCode.findFirst({
        where: { emailHash: { in: hashForLookupCandidates(identifier) } },
        orderBy: { createdAt: 'desc' },
    });
    if (!row) return { ok: false, reason: 'invalid' };

    if (row.expiresAt.getTime() < Date.now()) {
        await prisma.emailVerificationCode.delete({ where: { id: row.id } }).catch(() => undefined);
        return { ok: false, reason: 'expired' };
    }

    if (row.attempts >= MAX_ATTEMPTS) {
        await prisma.emailVerificationCode.delete({ where: { id: row.id } }).catch(() => undefined);
        return { ok: false, reason: 'too_many_attempts' };
    }

    if (!sameDigest(row.codeHash, hashCode(supplied))) {
        // Count the failure with a CONDITIONAL update rather than
        // `attempts: row.attempts + 1`. Concurrent guesses all read the same
        // row, so a read-then-write lets N parallel requests each store
        // `attempts + 1` and consume one slot between them — the cap would
        // bound round trips, not guesses. `increment` is applied by the
        // database to whatever the current value is.
        const bumped = await prisma.emailVerificationCode.update({
            where: { id: row.id },
            data: { attempts: { increment: 1 } },
            select: { attempts: true },
        });
        // Destroy on exhaustion, so the budget cannot be topped up by waiting
        // for the honest user to request a new code (see the file docblock).
        if (bumped.attempts >= MAX_ATTEMPTS) {
            await prisma.emailVerificationCode
                .delete({ where: { id: row.id } })
                .catch(() => undefined);
            return { ok: false, reason: 'too_many_attempts' };
        }
        return { ok: false, reason: 'invalid' };
    }

    // Single-use: the row goes whether or not anything downstream succeeds. A
    // code that survived its own successful use would be replayable, and the
    // caller's follow-on work (marking the user verified) is idempotent.
    await prisma.emailVerificationCode.delete({ where: { id: row.id } }).catch(() => undefined);
    return { ok: true };
}

/** Delete every expired row. For the P3.5e sweep; issuance also sweeps opportunistically. */
export async function pruneExpiredVerificationCodes(): Promise<number> {
    const { count } = await prisma.emailVerificationCode.deleteMany({
        where: { expiresAt: { lt: new Date() } },
    });
    return count;
}

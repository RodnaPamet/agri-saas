/**
 * Credentials authentication chokepoint.
 *
 * ## Purpose
 * One function ({@link authenticateWithPassword}) owns the entire
 * email+password auth decision, top to bottom. NextAuth's Credentials
 * provider delegates here; the retired /api/auth/register login handler (#1376)
 * delegates here; any future server action delegates here. Every
 * password-based login attempt flows through this exact path — which
 * is what makes rate-limiting, audit logging, email-verification
 * enforcement, and lockout trivially bolt-on in later prompts: wrap or
 * augment this one function.
 *
 * ## Layering
 * ```
 *   caller (NextAuth authorize / API route / server action)
 *         └─▶ authenticateWithPassword
 *                 ├─▶ user lookup                  (prisma)
 *                 ├─▶ password verify              (lib/auth/passwords)
 *                 ├─▶ email-verification gate      (optional, see below)
 *                 └─▶ silent rehash-on-verify      (lib/auth/passwords)
 * ```
 * Session issuance (JWT/cookie) is the CALLER's job — NextAuth handles
 * it when invoked via the Credentials provider; the legacy API route
 * calls `signToken` directly. This file stays free of HTTP / session
 * concerns on purpose.
 *
 * ## Error shape (account-enumeration safe)
 * Every *authentication* failure returns
 * `{ ok: false, reason: 'credentials_invalid' }`. We do NOT distinguish
 *   - email not in DB
 *   - email in DB but no `passwordHash` (OAuth-only user)
 *   - email + passwordHash exist but password doesn't match
 * …because doing so lets an attacker enumerate registered emails via
 * the response. Timing is also equalised: the not-found branch runs a
 * dummy bcrypt compare (see {@link dummyVerify}) so wall-clock leakage
 * matches the real-verify branch.
 *
 * `email_not_verified` is intentionally separate — once
 * `AUTH_REQUIRE_EMAIL_VERIFICATION` is turned on in a later prompt,
 * callers may want to tell a legitimate user "check your inbox" rather
 * than showing the generic "bad credentials" message. The default for
 * that flag is OFF so existing behaviour is preserved.
 *
 * ## What does NOT live here
 *   - Rate limiting / lockout / audit emission: wrap the caller, don't
 *     mutate this function. Keeps the contract ("verify these creds,
 *     tell me yes or no") narrow.
 *   - Session / cookie issuance: caller's responsibility.
 *   - Password policy (length / breach list): that gates *setting* a
 *     password, not checking one. See
 *     `validatePasswordPolicy` in `./passwords.ts`.
 */

import prisma from '@/lib/prisma';
import { env } from '@/env';
import {
    checkCredentialsAttempt,
    resetCredentialsBackoff,
} from './credential-rate-limit';
import {
    dummyVerify,
    hashPassword,
    needsRehash,
    verifyPassword,
} from './passwords';
import {
    recordLoginFailure,
    recordLoginSuccess,
} from './security-events';
import { hashForLookup, hashForLookupCandidates } from '@/lib/security/encryption';
import {
    evaluateProgressiveRateLimit,
    recordProgressiveFailure,
    resetProgressiveFailures,
    LOGIN_PROGRESSIVE_POLICY,
} from '@/lib/security/rate-limit';

/**
 * Sleep for `ms` milliseconds. Used to apply the progressive
 * delay from {@link LOGIN_PROGRESSIVE_POLICY} before the expensive
 * bcrypt verify. `unref` is not needed — the timer runs to
 * completion inside the auth request.
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SHA-256 hex of the lowercased email for use as a
 * progressive-rate-limit key. Mirrors `hashIdentifier` in
 * `credential-rate-limit.ts` so an attacker scraping the in-memory
 * store can't enumerate registered emails.
 */
async function progressiveKeyFor(email: string): Promise<string> {
    const normalised = email.trim().toLowerCase();
    const encoder = new TextEncoder();
    const buf = await crypto.subtle.digest(
        'SHA-256',
        encoder.encode(normalised),
    );
    const hex = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return `login-progressive:${hex}`;
}

// ── Public contract ────────────────────────────────────────────────────

export type AuthFailureReason =
    /** Unknown email, no password set, or wrong password — all collapse here. */
    | 'credentials_invalid'
    /** Email-verification is required and the account has not completed it. */
    | 'email_not_verified'
    /** Per-identifier attempt count exceeded. Surfaces retryAfterSeconds. */
    | 'rate_limited';

export type AuthResult =
    | {
          ok: true;
          userId: string;
          email: string;
          name: string | null;
      }
    | {
          ok: false;
          reason: AuthFailureReason;
          /** Only populated when reason === 'rate_limited'. */
          retryAfterSeconds?: number;
      };

export interface AuthenticateInput {
    email: string;
    password: string;
    /** Request id for log correlation. Optional so call sites (NextAuth
     *  Credentials.authorize) that don't have it don't have to fabricate one. */
    requestId?: string;
}

// ── Chokepoint ─────────────────────────────────────────────────────────

/**
 * Verify an email+password pair and return an {@link AuthResult}.
 *
 * Contract guarantees:
 *   - Always returns (never throws); caller sees a typed discriminated
 *     union instead of an exception surface.
 *   - Constant-ish time between "user not found" and "password wrong" —
 *     see `dummyVerify`.
 *   - On success, silently re-hashes the password at the current
 *     {@link BCRYPT_COST} if the stored hash is stale. Old users get
 *     migrated in place on their next login — no reset email needed.
 *   - Does NOT issue a session or set cookies. Pure "are these creds
 *     good?" question; the caller wires the session on yes.
 */
export async function authenticateWithPassword(
    input: AuthenticateInput,
): Promise<AuthResult> {
    const email = (input.email ?? '').trim().toLowerCase();
    const password = input.password ?? '';
    const requestId = input.requestId;

    // Empty input — fast path that still burns bcrypt time so an attacker
    // can't distinguish empty-input early-return from real verify latency.
    if (!email || !password) {
        await dummyVerify(password);
        return { ok: false, reason: 'credentials_invalid' };
    }

    // Per-identifier rate-limit gate. Runs BEFORE bcrypt so an attacker
    // hammering one account doesn't get to keep spending CPU. Per-IP
    // limits live in `src/lib/rate-limit/authRateLimit.ts` at the
    // NextAuth-endpoint layer and catch volumetric abuse from a single
    // source; this gate catches credential-stuffing where the attacker
    // rotates IPs but targets one account.
    //
    // Two layers run together:
    //   1. Upstash sliding-window (existing) — cross-instance, 5/15min.
    //   2. Progressive delay + lockout (Epic A.3) — in-memory, tier-based:
    //        3 fails → 5s, 5 fails → 30s, 10 fails → 15min lockout.
    // Both must pass. Either layer can short-circuit with rate_limited.
    const rl = await checkCredentialsAttempt(email);
    if (!rl.ok) {
        // Audit + operational log. If we know who the account belongs to
        // we attribute to their tenant; otherwise logger-only (see
        // security-events.ts for the branching).
        const maybeUser = await prisma.user
            .findFirst({ where: { emailHash: { in: hashForLookupCandidates(email) } }, select: { id: true } })
            .catch(() => null);
        await recordLoginFailure({
            email,
            userId: maybeUser?.id ?? null,
            method: 'credentials',
            reason: 'rate_limited',
            requestId,
        });
        return {
            ok: false,
            reason: 'rate_limited',
            retryAfterSeconds: rl.retryAfterSeconds,
        };
    }

    // Progressive check. Skipped in the same test scenarios the
    // Upstash check skips — keep the two in lockstep.
    const progressiveKey = await progressiveKeyFor(email).catch(() => null);
    const runProgressive =
        progressiveKey !== null &&
        env.AUTH_TEST_MODE !== '1' &&
        env.RATE_LIMIT_ENABLED !== '0';
    if (runProgressive && progressiveKey) {
        const decision = await evaluateProgressiveRateLimit(
            progressiveKey,
            LOGIN_PROGRESSIVE_POLICY,
        );
        if (!decision.allowed) {
            const maybeUser = await prisma.user
                .findFirst({ where: { emailHash: { in: hashForLookupCandidates(email) } }, select: { id: true } })
                .catch(() => null);
            await recordLoginFailure({
                email,
                userId: maybeUser?.id ?? null,
                method: 'credentials',
                reason: 'rate_limited',
                requestId,
            });
            // Burn a bcrypt-equivalent time window before returning so
            // the attacker's stopwatch can't distinguish lockout from a
            // real verify.
            await dummyVerify(password);
            return {
                ok: false,
                reason: 'rate_limited',
                retryAfterSeconds: decision.retryAfterSeconds,
            };
        }
        // Apply the progressive delay BEFORE the verify so the
        // attacker's wall clock feels it. Legitimate users also
        // feel it past tier thresholds — intentional; the typo-
        // allowance is the free attempts below tier 1.
        if (decision.delayMs > 0) {
            await sleep(decision.delayMs);
        }
    }

    let user: {
        id: string;
        email: string;
        name: string | null;
        passwordHash: string | null;
        emailVerified: Date | null;
    } | null = null;
    try {
        user = await prisma.user.findFirst({
            where: { emailHash: { in: hashForLookupCandidates(email) } },
            select: {
                id: true,
                email: true,
                name: true,
                passwordHash: true,
                emailVerified: true,
            },
        });
    } catch {
        // DB lookup errors are indistinguishable from "user not found" at
        // the API boundary. The caller's observability wrapper will log
        // the real reason if it matters.
        await dummyVerify(password);
        await recordLoginFailure({
            email,
            userId: null,
            method: 'credentials',
            reason: 'credentials_invalid',
            requestId,
        });
        return { ok: false, reason: 'credentials_invalid' };
    }

    if (!user || !user.passwordHash) {
        // Unknown email, or OAuth-only user with no password set. Burn
        // bcrypt time against the dummy hash so the attacker's stopwatch
        // can't tell the difference.
        await dummyVerify(password);
        if (runProgressive && progressiveKey) {
            await recordProgressiveFailure(progressiveKey, LOGIN_PROGRESSIVE_POLICY);
        }
        await recordLoginFailure({
            email,
            userId: user?.id ?? null,
            method: 'credentials',
            // Separate reason so operational logs can distinguish enumerated
            // emails from legitimate-user-wrong-password. NEVER surfaced to
            // the client — the caller collapses every failure to one string.
            reason: user ? 'credentials_invalid' : 'unknown_email',
            requestId,
        });
        return { ok: false, reason: 'credentials_invalid' };
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
        if (runProgressive && progressiveKey) {
            await recordProgressiveFailure(progressiveKey, LOGIN_PROGRESSIVE_POLICY);
        }
        await recordLoginFailure({
            email,
            userId: user.id,
            method: 'credentials',
            reason: 'credentials_invalid',
            requestId,
        });
        return { ok: false, reason: 'credentials_invalid' };
    }

    // ── Post-verify gates ──
    // Email verification: off by default. When AUTH_REQUIRE_EMAIL_VERIFICATION
    // flips on, accounts with a null `emailVerified` get a distinct reason
    // code so the UI can funnel them into the "check your inbox" flow
    // instead of showing a generic "bad credentials" message.
    if (env.AUTH_REQUIRE_EMAIL_VERIFICATION === '1' && !user.emailVerified) {
        await recordLoginFailure({
            email,
            userId: user.id,
            method: 'credentials',
            reason: 'email_not_verified',
            requestId,
        });
        return { ok: false, reason: 'email_not_verified' };
    }

    // ── Silent rehash-on-verify migration ──
    // If the stored hash is weaker than the current BCRYPT_COST, take
    // the plaintext we already have in hand and store a fresh hash. The
    // next login won't need this path. Errors here MUST NOT fail the
    // login — the user already proved they know the password.
    if (needsRehash(user.passwordHash)) {
        try {
            const newHash = await hashPassword(password);
            await prisma.user.update({
                where: { id: user.id },
                data: { passwordHash: newHash },
            });
        } catch {
            // Swallow — rehash is best-effort housekeeping, not a gate.
        }
    }

    // Successful auth: clear the per-email rate-limit counter so a user
    // who typo'd 3 times then got it right isn't locked out the next
    // time they come back. Best-effort; Upstash sliding-window ages
    // naturally even if this no-ops.
    await resetCredentialsBackoff(email).catch(() => undefined);
    if (progressiveKey) {
        await resetProgressiveFailures(progressiveKey);
    }

    await recordLoginSuccess({
        email: user.email,
        userId: user.id,
        method: 'credentials',
        requestId,
    });

    return {
        ok: true,
        userId: user.id,
        email: user.email,
        name: user.name,
    };
}

/**
 * Test-only helper: clears the Epic A.3 progressive-failure counter
 * for a given email. Sibling to `__resetCredentialsRateLimitForTests`
 * from `credential-rate-limit.ts`, but for the second, independent
 * counter added by brute-force hardening. Tests that exercise the
 * CREDENTIALS_RATE_LIMIT bucket must also reset this one, otherwise
 * the per-failure delays (5s / 30s / 15min-lockout) stack on top of
 * the rate-limit attempts and blow past jest timeouts.
 */
export async function __resetProgressiveForTests(email: string): Promise<void> {
    const key = await progressiveKeyFor(email);
    await resetProgressiveFailures(key);
}

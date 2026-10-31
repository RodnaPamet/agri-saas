/**
 * Native authorization codes — mint, and exchange exactly once.
 *
 * WHY A CODE AT ALL. Google refuses OAuth inside embedded webviews
 * (`disallowed_useragent`), so a native client must sign in through the SYSTEM
 * browser. That browser cannot set a cookie the app's webview can read, so
 * something has to cross the gap. A short-lived single-use code crosses it —
 * and nothing else does. A token in a redirect URL would be written to browser
 * history, possibly to OS logs, and handed to whatever app claims the scheme.
 *
 * WHY PKCE IS LOAD-BEARING. On iOS a custom URL scheme can be registered by
 * ANOTHER app. If a code alone were sufficient, intercepting the redirect would
 * be equivalent to stealing the session. Requiring the verifier means the
 * interceptor holds a value it cannot use: only the client that generated the
 * verifier can spend the code.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@/env';
import type { NativeAuthCodePurpose } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { runWithAuditContext } from '@/lib/audit-context';
import { logger } from '@/lib/observability/logger';

/**
 * SECONDS, not minutes.
 *
 * The code travels through a redirect the OS and the browser may both record.
 * Its security rests on being stale almost immediately — long enough for an app
 * to be foregrounded and issue one HTTPS request, and no longer. 60s is
 * generous for that and still far inside the window where a leaked history
 * entry is useful to anyone.
 */
/**
 * Name of the HttpOnly cookie that carries the PKCE challenge + redirect URI
 * across the system-browser sign-in.
 *
 * Defined HERE, not in either route, for two reasons. A Next route module may
 * only export handlers and a fixed set of config keys — exporting a constant
 * from one made `.next/types` reject the module (invisible in CI, which
 * typechecks without a build). And the two routes that need it were each
 * declaring their OWN copy of the literal, so changing one would have broken
 * the handoff silently: `/start` would set a cookie `/complete` never reads,
 * and every native sign-in would fail with a missing-handoff error pointing
 * nowhere near the cause.
 */
export const HANDOFF_COOKIE = 'agrent-native-handoff';

/** How long the handoff cookie lives — the user has to finish sign-in in it. */
export const HANDOFF_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export const AUTH_CODE_TTL_SECONDS = 60;

/**
 * How long a `PENDING_MFA` ticket lives. FIVE MINUTES, not the 60 seconds a
 * SESSION code gets, and the difference is the task each one bounds.
 *
 * A session code is handed over in a redirect the OS may log, and the app
 * redeems it immediately with no human in the loop — so a minute is generous
 * and staleness is the whole point. A ticket waits on a PERSON: open the
 * authenticator, find the right entry among however many they have, read six
 * digits, switch back, type them. A first-time user does not do that in a
 * minute, and a ticket that expires mid-task sends them back to the Apple
 * button with no idea why.
 *
 * Five rather than longer because the ticket is a bearer value on a phone,
 * and because the authenticator is usually on the SAME device — an app switch
 * and back, which agrent-ios confirmed needs no countdown on screen.
 */
export const MFA_TICKET_TTL_SECONDS = 5 * 60;

export function hashCode(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

/** PKCE S256: base64url(SHA-256(verifier)). */
export function deriveChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Compare in constant time.
 *
 * The challenge is not a secret, but the comparison still runs on an
 * attacker-supplied value, and a length-independent early return is a habit
 * worth not forming in auth code.
 */
function challengeMatches(expected: string, actual: string): boolean {
    const a = Buffer.from(expected);
    const b = Buffer.from(actual);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
    return Promise.resolve(runWithAuditContext({ source: 'system' }, fn)) as Promise<T>;
}

export interface IssuedCode {
    /** Returned ONCE, delivered via the redirect. Never stored. */
    raw: string;
    expiresAt: Date;
}

/**
 * Mint a code for a session that already exists.
 *
 * Takes the session ROW ID, not the external `sessionId` claim: a code whose FK
 * does not resolve would exchange into tokens hanging off nothing, which is the
 * unrevocable-credential failure the whole native-auth design exists to avoid.
 */
export async function issueAuthCode(input: {
    /**
     * NULL only for a `PENDING_MFA` ticket, which has no session yet — see
     * the schema comment on `NativeAuthCode.userSessionId`. A `SESSION` code
     * always has one, and `exchangeAuthCode` refuses a row that does not.
     */
    userSessionRowId: string | null;
    userId: string;
    tenantId: string | null;
    codeChallenge: string;
    redirectUri: string;
    /**
     * What the row may be redeemed for. Defaults to `SESSION`, which is what
     * every existing caller means — the browser handoff, where the MFA gate
     * already ran at `native/complete`.
     *
     * `PENDING_MFA` is the Apple path: a ticket that is NOT a grant. The
     * exchange filters on this column, so such a row is invisible there.
     */
    purpose?: NativeAuthCodePurpose;
}): Promise<IssuedCode> {
    const raw = randomBytes(32).toString('base64url');
    // Per PURPOSE, because the two bound different tasks — see
    // `MFA_TICKET_TTL_SECONDS`. Reading one constant for both would give a
    // person five times less time than the design says they have.
    const purpose = input.purpose ?? 'SESSION';
    const ttl = purpose === 'PENDING_MFA' ? MFA_TICKET_TTL_SECONDS : AUTH_CODE_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await asSystem(() =>
        prisma.nativeAuthCode.create({
            data: {
                codeHash: hashCode(raw),
                userSessionId: input.userSessionRowId,
                userId: input.userId,
                tenantId: input.tenantId,
                codeChallenge: input.codeChallenge,
                redirectUri: input.redirectUri,
                expiresAt,
                purpose,
            },
        }),
    );

    return { raw, expiresAt };
}

export type ExchangeResult =
    | { ok: true; userSessionRowId: string; userId: string; tenantId: string | null }
    | { ok: false; reason: 'unknown' | 'expired' | 'consumed' | 'pkce_mismatch' | 'session_invalid' };

/**
 * Spend a code, once.
 *
 * THE CLAIM IS ATOMIC. `updateMany` with `consumedAt: null` is the test-and-set:
 * two concurrent exchanges of the same code race, exactly one sees `count === 1`,
 * and the loser is refused. A read-then-write would let both win and mint two
 * token families from one authorization — the same reasoning that shapes invite
 * redemption in `tenant-invites.ts`.
 *
 * PKCE IS CHECKED BEFORE THE CLAIM. A wrong verifier must not burn the code: a
 * legitimate client retrying after a network blip would otherwise be locked out
 * by an attacker who guessed once. So a mismatch is refused WITHOUT consuming,
 * and the real client can still complete.
 */
export async function exchangeAuthCode(input: {
    rawCode: string;
    codeVerifier: string;
}): Promise<ExchangeResult> {
    // `findFirst` with `purpose` and NOT `findUnique` on `codeHash` alone.
    //
    // This is the line that makes a pending-MFA ticket unusable as a grant. A
    // `PENDING_MFA` row simply does not match, so it falls out as
    // `reason: 'unknown'` — refused by the ABSENCE of a row rather than by a
    // conditional further down that a later edit could drop. It also keeps the
    // refusal opaque: a caller cannot tell a ticket from a bad code from an
    // expired one, which is the same reasoning the uniform `invalid_grant`
    // already rests on.
    //
    // Still one indexed read: `codeHash` is UNIQUE, so this is the same index
    // hit plus a filter on the row it returns.
    const row = await prisma.nativeAuthCode.findFirst({
        where: { codeHash: hashCode(input.rawCode), purpose: 'SESSION' },
        select: {
            id: true, userSessionId: true, userId: true, tenantId: true,
            codeChallenge: true, expiresAt: true, consumedAt: true,
            session: { select: { revokedAt: true, expiresAt: true } },
        },
    });

    if (!row) return { ok: false, reason: 'unknown' };
    if (row.consumedAt) return { ok: false, reason: 'consumed' };
    if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

    if (!challengeMatches(row.codeChallenge, deriveChallenge(input.codeVerifier))) {
        // Deliberately does NOT consume — see the docblock.
        logger.warn('native-auth.pkce_mismatch', { component: 'native-auth' });
        return { ok: false, reason: 'pkce_mismatch' };
    }

    if (
        !row.session ||
        row.session.revokedAt !== null ||
        row.session.expiresAt.getTime() <= Date.now()
    ) {
        return { ok: false, reason: 'session_invalid' };
    }

    const claimed = await asSystem(() =>
        prisma.nativeAuthCode.updateMany({
            where: { id: row.id, consumedAt: null },
            data: { consumedAt: new Date() },
        }),
    );
    if (claimed.count !== 1) return { ok: false, reason: 'consumed' };

    // A `SESSION` row always has a session — the column is only nullable for
    // a `PENDING_MFA` ticket. Refusing rather than asserting it: a non-null
    // operator here would turn a data anomaly into a runtime crash on an
    // unauthenticated route.
    if (!row.userSessionId) return { ok: false, reason: 'session_invalid' };

    return {
        ok: true,
        userSessionRowId: row.userSessionId,
        userId: row.userId,
        tenantId: row.tenantId,
    };
}

/**
 * Allowlist for redirect targets.
 *
 * Without this the start endpoint is an open redirect that also happens to
 * carry an authorization code — the worst possible combination. Configured
 * rather than hard-coded so a spike build can register its own scheme without
 * a code change, but EMPTY BY DEFAULT: an unset allowlist refuses everything
 * rather than allowing everything.
 */
export function isAllowedRedirect(uri: string, allowlist: string[]): boolean {
    return classifyRedirect(uri, allowlist) === 'allowed';
}

/**
 * Why the caller needs three answers and the CLIENT only gets one.
 *
 * `isAllowedRedirect` collapses two very different situations into `false`:
 * the allowlist is UNCONFIGURED (so every redirect is refused, and the feature
 * is off), or the allowlist is configured and this URI simply is not on it.
 *
 * On 2026-08-21 the first was true in production — `NATIVE_AUTH_REDIRECT_ALLOWLIST`
 * was absent from `/opt/agrent/.env` entirely — so the whole native sign-in flow
 * refused every redirect and answered `redirect_uri_not_allowed`, which reads as
 * "your client sent a bad URI". Nothing distinguished a misconfigured server
 * from a misbehaving client. That is the same distinction the restore drill
 * needed in #678: "the answer is no" and "I could not ask" are different facts.
 *
 * The distinction is for the SERVER LOG ONLY. The HTTP response stays
 * `redirect_uri_not_allowed` in both cases on purpose: this route is
 * unauthenticated, and telling an anonymous caller "our allowlist is empty"
 * hands them a fact about our configuration they have no business having.
 */
/**
 * The configured allowlist, parsed.
 *
 * Extracted because there were TWO identical copies — `auth/native/start` and
 * `auth/native/complete` — and #2495 step 6 needed a third. Two copies of a
 * security-relevant parser is a thing that eventually disagrees; three is
 * asking for it. The parse is trivial, which is exactly why it gets copied and
 * exactly why it should not be.
 *
 * Returns `[]` for an unset or empty variable, which `classifyRedirect` reads
 * as `allowlist_unconfigured` rather than as "nothing is allowed" — that
 * distinction is the whole reason the verdict has three values.
 */
export function nativeRedirectAllowlist(): string[] {
    return env.NATIVE_AUTH_REDIRECT_ALLOWLIST.split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

export type RedirectVerdict = 'allowed' | 'not_on_allowlist' | 'allowlist_unconfigured';

export function classifyRedirect(uri: string, allowlist: string[]): RedirectVerdict {
    if (allowlist.length === 0) return 'allowlist_unconfigured';
    return allowlist.some((prefix) => prefix.length > 0 && uri.startsWith(prefix))
        ? 'allowed'
        : 'not_on_allowlist';
}

// ── The pending-MFA ticket ──────────────────────────────────────────────

/**
 * Wrong TOTP codes a single ticket tolerates before it is burned.
 *
 * A `SESSION` code is 32 random bytes and needs no attempt limit — guessing
 * it is not a strategy. A ticket's second factor is SIX DIGITS, so the
 * ticket does need one, and the limit belongs on the ticket rather than on
 * the IP or the user: it bounds exactly one sign-in attempt and cannot be
 * sidestepped by reconnecting.
 *
 * Five, matching the web challenge's per-user allowance, so a person does not
 * get a different number of tries depending on which device they are holding.
 */
export const MAX_MFA_TICKET_ATTEMPTS = 5;

export type MfaTicketResult =
    /**
     * The factor was presented. NO session row is referenced: the caller
     * records one now, AFTER the code passed, so issuing a ticket can never
     * evict a live session at a farm with `maxConcurrentSessions` set.
     */
    | { ok: true; userId: string; tenantId: string }
    /**
     * The ticket itself is no good — expired, consumed, unknown, wrong
     * purpose, or a PKCE mismatch. ONE reason for all of them, deliberately:
     * the same argument the uniform `invalid_grant` rests on. A caller
     * learning WHICH of five checks defeated it gets free help, and a person
     * holding a legitimate ticket learns nothing useful from the distinction
     * either. The remedy is identical in every case: start sign-in again.
     */
    | { ok: false; reason: 'ticket_invalid' }
    /** The ticket is fine and the CODE was wrong. */
    | { ok: false; reason: 'code_invalid'; attemptsRemaining: number }
    /** Six digits were not supplied. Costs no attempt — see below. */
    | { ok: false; reason: 'code_malformed' };

/**
 * Redeem a `PENDING_MFA` ticket with a TOTP code.
 *
 * The Apple counterpart of `exchangeAuthCode`. Apple sign-in happens inside
 * the app with no browser sheet, so the gate the other providers get at
 * `native/complete` has nowhere to stand; this is where the factor is
 * collected instead.
 *
 * A malformed code costs no attempt. The phone sends six digits from a number
 * pad so it should never reach here, but spending one of five tries on input
 * that was never a guess would punish a stutter in the client rather than an
 * attacker — and an attacker gains nothing by sending garbage.
 */
export async function redeemMfaTicket(input: {
    rawCode: string;
    codeVerifier: string;
    totpCode: string;
}): Promise<MfaTicketResult> {
    if (!/^\d{6}$/.test(input.totpCode)) return { ok: false, reason: 'code_malformed' };

    const row = await prisma.nativeAuthCode.findFirst({
        where: { codeHash: hashCode(input.rawCode), purpose: 'PENDING_MFA' },
        select: {
            id: true, userSessionId: true, userId: true, tenantId: true,
            codeChallenge: true, expiresAt: true, consumedAt: true, mfaAttempts: true,
            session: { select: { revokedAt: true, expiresAt: true } },
        },
    });

    if (!row) return { ok: false, reason: 'ticket_invalid' };
    if (row.consumedAt) return { ok: false, reason: 'ticket_invalid' };
    if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'ticket_invalid' };
    if (!challengeMatches(row.codeChallenge, deriveChallenge(input.codeVerifier))) {
        logger.warn('native-auth.mfa_ticket_pkce_mismatch', { component: 'native-auth' });
        return { ok: false, reason: 'ticket_invalid' };
    }
    if (
        !row.session ||
        row.session.revokedAt !== null ||
        row.session.expiresAt.getTime() <= Date.now()
    ) {
        return { ok: false, reason: 'ticket_invalid' };
    }
    if (!row.tenantId) {
        // A ticket is only ever issued for a tenant whose policy requires a
        // factor, so a tenantless one cannot be verified against any policy.
        logger.warn('native-auth.mfa_ticket_without_tenant', { component: 'native-auth' });
        return { ok: false, reason: 'ticket_invalid' };
    }

    const { verifyMfaChallenge } = await import('@/app-layer/usecases/mfa-challenge');
    const remainingBefore = MAX_MFA_TICKET_ATTEMPTS - row.mfaAttempts;
    const verdict = await verifyMfaChallenge(
        row.userId,
        row.tenantId,
        input.totpCode,
        remainingBefore,
    );

    if (!verdict.success) {
        const attempts = row.mfaAttempts + 1;
        const attemptsRemaining = Math.max(0, MAX_MFA_TICKET_ATTEMPTS - attempts);
        // Burn the ticket ON the final miss, in the same write, so the client
        // learns `attemptsRemaining: 0` from this response rather than from a
        // sixth request that would have to fail differently to tell it.
        await asSystem(() =>
            prisma.nativeAuthCode.updateMany({
                where: { id: row.id, consumedAt: null },
                data: {
                    mfaAttempts: attempts,
                    ...(attemptsRemaining === 0 ? { consumedAt: new Date() } : {}),
                },
            }),
        );
        logger.warn('native-auth.mfa_ticket_code_rejected', {
            component: 'native-auth',
            userId: row.userId,
            attemptsRemaining,
        });
        return { ok: false, reason: 'code_invalid', attemptsRemaining };
    }

    // Same atomic claim as the session exchange: the winner is whoever sets
    // `consumedAt` from null, so two concurrent correct codes mint one pair.
    const claimed = await asSystem(() =>
        prisma.nativeAuthCode.updateMany({
            where: { id: row.id, consumedAt: null },
            data: { consumedAt: new Date() },
        }),
    );
    if (claimed.count !== 1) return { ok: false, reason: 'ticket_invalid' };

    return { ok: true, userId: row.userId, tenantId: row.tenantId };
}

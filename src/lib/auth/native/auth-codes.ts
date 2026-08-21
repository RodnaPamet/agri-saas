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
    userSessionRowId: string;
    userId: string;
    tenantId: string | null;
    codeChallenge: string;
    redirectUri: string;
}): Promise<IssuedCode> {
    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000);

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
    const row = await prisma.nativeAuthCode.findUnique({
        where: { codeHash: hashCode(input.rawCode) },
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
export type RedirectVerdict = 'allowed' | 'not_on_allowlist' | 'allowlist_unconfigured';

export function classifyRedirect(uri: string, allowlist: string[]): RedirectVerdict {
    if (allowlist.length === 0) return 'allowlist_unconfigured';
    return allowlist.some((prefix) => prefix.length > 0 && uri.startsWith(prefix))
        ? 'allowed'
        : 'not_on_allowlist';
}

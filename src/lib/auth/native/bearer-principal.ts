/**
 * Server-side principal derivation for native bearer clients.
 *
 * WHY THIS EXISTS — the divergence is one layer below middleware.
 *
 * `getToken()` already accepts an `Authorization: Bearer` header
 * (`next-auth/jwt/index.js:83`), so `src/middleware.ts` authorises a bearer
 * today with no change: `checkTenantAccess` sees the identical claims and
 * returns the identical answer, including the `membershipsTruncated` deferral.
 *
 * But `getServerSession()` reads the session from cookies ONLY
 * (`next-auth/core/routes/session.js:43` — `sessionStore.value`; the header is
 * never consulted). `auth()` is `getServerSession(authOptions)`, and every
 * `/api/t/**` handler runs `requirePermission -> getTenantCtx ->
 * getSessionOrThrow -> auth()`. So a bearer passes the Edge and then 401s at
 * the server gate.
 *
 * That breaks in exactly the place the requirement names. `checkTenantAccess`
 * returns 'allow' when `membershipsTruncated` and defers the decision to the
 * DB-backed server gate — which, under a bearer, has no principal at all. A
 * user in more than MAX_JWT_MEMBERSHIPS tenants succeeds with a cookie and
 * fails with a bearer, for the same request. Closing that is this module's job.
 *
 * HOW IT AVOIDS BECOMING A SECOND, LOOSER PATH:
 *
 *   - ONE locator. The token is found by the same `getToken({ req, secret })`
 *     middleware calls. Claims are never reconstructed — a second producer that
 *     missed `applyMembershipClaims`'s ACTIVE filter, deleted-tenant filter,
 *     ordering or 50-item slice would be silently more (or less) permissive
 *     than the cookie, in a population no fixture covers.
 *   - ONE shaper. The `Session` is built by the SAME `authOptions.callbacks
 *     .session` the cookie path runs, so the two cannot disagree on shape.
 *   - Cookie WINS. If a session cookie is present it is used and this module is
 *     never consulted, so the web client's behaviour is bit-for-bit unchanged.
 */
import { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { headers } from 'next/headers';
import type { NextAuthOptions, Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import { env } from '@/env';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { verifyAndTouchSession } from '@/lib/security/session-tracker';
import { logger } from '@/lib/observability/logger';

/**
 * Build the `Session` a bearer credential authorises, or null.
 *
 * Returns null — never throws — so a caller that also supports cookies can fall
 * through unchanged.
 */
export async function resolveBearerSession(): Promise<Session | null> {
    const resolved = await resolveBearer();
    if (!resolved) return null;
    const { token } = resolved;

    // ── Which farms still owe a second factor (#3199) ──────────────────
    //
    // `getTenantCtx` refuses a farm on `mfaPendingTenantIds`, and that list was
    // produced in exactly one place: the cookie `jwt` callback, which has the
    // database and a sign-in `iat`. A bearer is minted ONCE by
    // `buildSessionClaims` and presented unchanged, so it never carried the
    // list, and every farm read as "nothing owed" for the life of the
    // session. Two cases that leaves open:
    //
    //   * the Apple path collects a code for ONE farm (the one the ticket
    //     names), so a member of a second farm whose policy is REQUIRED
    //     reached it without that farm's factor; and
    //   * a farm that turns MFA on, or is joined, after the session was minted
    //     stays open to it for as long as the phone keeps refreshing.
    //
    // So the list is resolved HERE, per request, by the same function the
    // cookie path uses. The anchor cannot be the token's `iat` — an access
    // token is minted every 15 minutes, so a rule relative to it would
    // re-challenge for ever (see `MfaClaimSource`). It is the SESSION's
    // sign-in instead: every refresh keeps the same `UserSession` row, so its
    // `createdAt` plays the role the cookie's `iat` plays. Less the Apple
    // ticket's lifetime, because that flow verifies the code BEFORE it creates
    // the row, so the challenge that produced the session predates it by up
    // to that long.
    //
    // Farm routes only. The session-wide `mfaPending` stays as minted, so a
    // person's own account pages remain reachable: this bearer passed a second
    // factor at mint, and what changed since is a FARM's requirement, which is
    // that farm's to enforce.
    const pending = await bearerPendingTenantIds(token, resolved.sessionCreatedAt);
    if (pending === 'refuse') return null;
    token.mfaPendingTenantIds = pending;

    const userId = token.userId ?? token.sub;

    // The SAME shaper the cookie path uses. The empty shell mirrors what
    // NextAuth core hands the callback, so the callback cannot tell the two
    // apart — which is the point.
    const shell: Session = {
        user: {
            id: userId as string,
            // The session callback overwrites every field it cares about; these
            // are only here to satisfy the shell's type. `email` is NOT copied
            // by the callback, and a bearer principal deliberately carries none
            // — nothing downstream reads it, and inventing one would be worse.
            email: '',
            tenantId: null,
            role: 'READER',
            uiLanguage: DEFAULT_LOCALE,
            mfaPending: false,
            memberships: [],
            orgMemberships: [],
        },
        expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };

    return authSessionCallback(shell, token);
}

/**
 * Validate the `Authorization: Bearer` credential and return its CLAIMS.
 *
 * Extracted so there is exactly ONE validator for a bearer, with two shapers
 * over it: `resolveBearerSession` (a `Session`, for `auth()`) and the
 * `/api/auth/native/adopt` route (a session COOKIE, for a WKWebView). A second
 * validator that drifted on the revocation check or the `token.error` check
 * would be silently more permissive than this one, in a population no fixture
 * covers — the same "ONE locator / ONE shaper" reasoning this module already
 * applies to claim production.
 */
export async function resolveBearerToken(): Promise<JWT | null> {
    return (await resolveBearer())?.token ?? null;
}

/**
 * The validator itself, also reporting when the session was signed in — the
 * anchor `resolveBearerSession` needs. Undefined when the row could not be
 * read (no lineage, or the fail-open branch below).
 */
async function resolveBearer(): Promise<{ token: JWT; sessionCreatedAt: Date | undefined } | null> {
    const h = await headers();
    const authorization = h.get('authorization');
    if (!authorization || !authorization.startsWith('Bearer ')) return null;

    // `getToken` accepts a NextRequest, so the shim is fully typed — no `as
    // any`, which `auth-stack-pinning` forbids in this path anyway. The URL is
    // irrelevant: getToken reads headers and cookies only.
    const req = new NextRequest('http://internal.invalid/', {
        headers: new Headers(h),
    });

    const token = await getToken({ req, secret: env.AUTH_SECRET });
    if (!token) return null;

    // A token minted by the jwt callback carries `error` when the session was
    // already known-bad at mint time; middleware denies those. Belt and braces
    // for any path that reaches here without traversing middleware.
    if (typeof token.error === 'string' && token.error.length > 0) return null;

    const userId = token.userId ?? token.sub;
    if (!userId) return null;

    // LIVE revocation check.
    //
    // This is the difference between a bearer and a cookie, and it matters. A
    // session cookie is re-minted by the jwt callback on every session read, so
    // the `error` flag it carries is at most one request stale. An access token
    // is minted ONCE and presented unchanged until it expires, so nothing
    // inside it can learn that an admin revoked the session five minutes ago.
    //
    // Checking the row here — on a path that is already DB-bound, since
    // getTenantCtx resolves membership from the database immediately after —
    // makes revocation take effect on the NEXT REQUEST rather than at the next
    // refresh. That is what lets "an admin revoking a session invalidates the
    // token" be true without a lifetime-shaped caveat.
    //
    // `verifyAndTouchSession` fails open on a transient DB error, deliberately
    // and consistently with the cookie path (see the 2026-08-18 enforcement
    // note): failing closed would turn a database blip into a fleet-wide
    // sign-out. A definite "revoked" is honoured; an unknown answer is not
    // manufactured into one.
    let sessionCreatedAt: Date | undefined;
    if (typeof token.userSessionId === 'string' && token.userSessionId) {
        try {
            const result = await verifyAndTouchSession(token.userSessionId);
            if (result.revoked) return null;
            sessionCreatedAt = result.createdAt;
        } catch (err) {
            logger.warn('native-auth.session_check_failed', {
                component: 'native-auth',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return { token, sessionCreatedAt };
}

/**
 * The farms this bearer must still present a factor for, or `'refuse'` when
 * the check could not complete for a farm that asked to fail CLOSED.
 *
 * An unknown anchor (no session row could be read) treats nothing as
 * satisfied — the resolver's own rule for an undefined `tokenIssuedAt` — so
 * it holds rather than releases. Same direction as the cookie path.
 */
async function bearerPendingTenantIds(
    token: JWT,
    sessionCreatedAt: Date | undefined,
): Promise<string[] | 'refuse'> {
    const userId = (token.userId ?? token.sub) as string;
    const tenantIds = (token.memberships ?? [])
        .map((m) => m.tenantId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (tenantIds.length === 0) return [];

    const [{ resolveMfaRequirementsForTenants }, { MFA_TICKET_TTL_SECONDS }] = await Promise.all([
        import('@/lib/auth/mfa-requirement'),
        import('@/lib/auth/native/auth-codes'),
    ]);
    const tokenIssuedAt = sessionCreatedAt
        ? Math.floor(sessionCreatedAt.getTime() / 1000) - MFA_TICKET_TTL_SECONDS
        : undefined;
    const verdict = await resolveMfaRequirementsForTenants({ userId, tenantIds, tokenIssuedAt });

    if (verdict.dependencyFailure) {
        // Fail closed only where a farm asked for it; otherwise keep the claim
        // as minted, exactly as the cookie path does — refusing by default
        // would sign every phone out whenever the settings read hiccups.
        logger.warn('native-auth.mfa_check_failed', { component: 'native-auth' });
        return verdict.failClosed || token.mfaFailClosed === true
            ? 'refuse'
            : (token.mfaPendingTenantIds ?? []);
    }
    return verdict.pendingTenantIds;
}

/**
 * Invoke the configured `session` callback.
 *
 * Imported lazily to avoid a module cycle: `src/auth.ts` is the natural home of
 * `authOptions`, and it imports plenty that would drag the world into an Edge
 * bundle if pulled in eagerly here.
 */
async function authSessionCallback(
    session: Session,
    token: Parameters<NonNullable<NonNullable<NextAuthOptions['callbacks']>['session']>>[0]['token'],
): Promise<Session> {
    const { authOptions } = await import('@/auth');
    const cb = authOptions.callbacks?.session;
    if (!cb) return session;
    // NextAuth types the callback as a union over jwt/database strategies; this
    // app is jwt-only (`session: { strategy: 'jwt' }`), so only `session` and
    // `token` are ever read. The cast is to the callback's own parameter type,
    // not to `any` — `auth-stack-pinning` forbids the latter in this path.
    type SessionCbArgs = Parameters<NonNullable<NonNullable<NextAuthOptions['callbacks']>['session']>>[0];
    const args = { session, token } as unknown as SessionCbArgs;
    const result = await cb(args);
    return result as Session;
}

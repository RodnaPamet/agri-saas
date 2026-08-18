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
    if (typeof token.userSessionId === 'string' && token.userSessionId) {
        try {
            const result = await verifyAndTouchSession(token.userSessionId);
            if (result.revoked) return null;
        } catch (err) {
            logger.warn('native-auth.session_check_failed', {
                component: 'native-auth',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // The SAME shaper the cookie path uses. The empty shell mirrors what
    // NextAuth core hands the callback, so the callback cannot tell the two
    // apart — which is the point.
    const shell: Session = {
        user: {
            id: userId,
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

    const shaped = await authSessionCallback(shell, token);
    return shaped;
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

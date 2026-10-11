/**
 * POST /api/auth/native/mfa — a pending-MFA ticket + a TOTP code → a token pair.
 *
 * The Apple half of the second-factor gate. Google and Microsoft sign-in go
 * through the system browser, so their code is typed in the sign-in sheet and
 * `native/complete` simply refuses to issue an auth code until the cookie
 * session's `mfaPending` clears. Apple's `ASAuthorizationController` hands the
 * app an identity token directly: there is no sheet, so there is nowhere for
 * that to happen and this route is where the factor is collected instead.
 *
 * ## The ticket is not a credential
 *
 * `POST /api/auth/native/apple` returns a `PENDING_MFA` ticket rather than a
 * token pair. That row is a `NativeAuthCode` — server-stored, SHA-256 hashed,
 * single-use through an atomic `consumedAt` claim, short-lived, PKCE-bound,
 * RLS-covered — and it carries NO claims. A ticket that were a JWT with
 * session claims is the whole bug class this change set exists to remove.
 *
 * `native/exchange` reads `{ codeHash, purpose: 'SESSION' }`, so a ticket is
 * NOT FOUND there: refused by the absence of a matching row rather than by a
 * conditional a later edit could drop.
 *
 * ## Unauthenticated, like the routes either side of it
 *
 * The ticket and the PKCE verifier are the credential. Rate-limited at the
 * pre-auth tier accordingly, and the ticket carries its own attempt cap —
 * five, matching the web challenge, so the number of tries does not depend on
 * which device someone is holding.
 *
 * ## Why the ticket failures are uniform and the CODE failure is not
 *
 * An expired, consumed, unknown or wrong-purpose ticket, and a PKCE
 * mismatch, all answer `MFA_TICKET_INVALID`. Separating them tells somebody
 * probing which of five checks defeated them, and tells a person holding a
 * real ticket nothing they can act on — the remedy is identical: sign in
 * again.
 *
 * A wrong CODE is different. It is the one failure the person can fix by
 * trying again, so it says so, and carries `attemptsRemaining` — at zero the
 * ticket is already burned in that same response, so the app can say "too
 * many wrong codes, sign in again" without a sixth request to discover it.
 * Shape agreed with agrent-ios, who has to render both.
 */
import { NextRequest, NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest, codedForbidden } from '@/lib/errors/types';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { redeemMfaTicket } from '@/lib/auth/native/auth-codes';
import { recordNewSession } from '@/lib/security/session-tracker';
import { SESSION_MAX_AGE_SECONDS } from '@/lib/auth/session-lifetime';
import {
    ACCESS_TOKEN_TTL_SECONDS,
    issueRefreshToken,
} from '@/lib/auth/native/refresh-tokens';

export const runtime = 'nodejs';

async function handleNativeMfa(req: NextRequest): Promise<NextResponse> {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        throw codedBadRequest('MFA_TICKET_INVALID', 'The sign-in attempt is no longer valid.');
    }

    const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const ticket = obj.ticket;
    const verifier = obj.code_verifier ?? obj.codeVerifier;
    const code = obj.code;
    if (
        typeof ticket !== 'string' || !ticket ||
        typeof verifier !== 'string' || !verifier ||
        typeof code !== 'string' || !code
    ) {
        throw codedBadRequest('MFA_TICKET_INVALID', 'The sign-in attempt is no longer valid.');
    }

    const redeemed = await redeemMfaTicket({
        rawCode: ticket,
        codeVerifier: verifier,
        totpCode: code,
    });

    if (!redeemed.ok) {
        if (redeemed.reason === 'code_invalid') {
            throw codedBadRequest(
                'MFA_CODE_INVALID',
                'That code is not right.',
                { attemptsRemaining: redeemed.attemptsRemaining },
            );
        }
        if (redeemed.reason === 'code_malformed') {
            // Costs no attempt, and says so with its own code: the phone sends
            // six digits from a number pad, so reaching here is a client bug
            // rather than a person mistyping, and it should be debuggable as
            // one rather than looking like a wrong code.
            throw codedBadRequest('MFA_CODE_MALFORMED', 'A six-digit code is required.');
        }
        throw codedForbidden('MFA_TICKET_INVALID', 'The sign-in attempt is no longer valid.');
    }

    // ── The session is created HERE, not when the ticket was issued ────
    //
    // `recordNewSession` enforces `maxConcurrentSessions`, so writing the row
    // at ticket time made every 202 cost the person a session slot. Somebody
    // holding only a stolen Apple ID — the first factor alone, exactly who
    // this second factor exists to stop — could start Apple sign-in
    // repeatedly and evict the real person's live sessions without ever
    // knowing a code. Abandoned tickets left rows behind too.
    //
    // Past this line the factor has been presented and verified, so a session
    // is warranted. It is still recorded BEFORE the pair is minted, so the
    // pair hangs off a revocable row and shows up in /admin/members exactly
    // as a browser sign-in does.
    //
    // Raised by agrent-ios reviewing #1649 — the same mistake the refusal
    // path had one commit earlier, and worse here because it is reachable by
    // somebody who cannot complete the sign-in.
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
    const recorded = await recordNewSession({
        userId: redeemed.userId,
        tenantId: redeemed.tenantId,
        expiresAt,
    });
    const sessionRow = {
        id: recorded.rowId,
        sessionId: recorded.sessionId,
        userId: redeemed.userId,
        tenantId: redeemed.tenantId,
        expiresAt,
    };

    const { buildSessionClaims } = await import('@/auth');
    const claims = await buildSessionClaims({
        // 'inherit-satisfied': the factor was just presented, above. This is
        // the one route that EARNS that value in the request rather than
        // inheriting it from a credential issued earlier.
        mfa: 'inherit-satisfied',
        userId: sessionRow.userId,
        tenantId: sessionRow.tenantId,
        userSessionId: sessionRow.sessionId,
    });
    if (!claims) {
        throw codedForbidden('MFA_TICKET_INVALID', 'The sign-in attempt is no longer valid.');
    }

    const [accessToken, refresh] = await Promise.all([
        encode({ token: claims, secret: env.AUTH_SECRET, maxAge: ACCESS_TOKEN_TTL_SECONDS }),
        issueRefreshToken({
            userSessionRowId: sessionRow.id,
            userId: sessionRow.userId,
            tenantId: sessionRow.tenantId,
            sessionExpiresAt: sessionRow.expiresAt,
        }),
    ]);

    logger.info('native-auth.mfa_completed', {
        component: 'native-auth',
        userId: sessionRow.userId,
        tenantId: sessionRow.tenantId ?? undefined,
    });

    return NextResponse.json({
        accessToken,
        refreshToken: refresh.raw,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshExpiresAt: refresh.expiresAt.toISOString(),
        termsPending: claims.termsPending === true,
    });
}

export const POST = withApiErrorHandling(handleNativeMfa, {
    rateLimit: { config: LOGIN_LIMIT, scope: 'native-auth-mfa' },
});

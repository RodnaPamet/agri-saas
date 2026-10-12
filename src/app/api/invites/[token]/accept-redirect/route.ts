/**
 * /api/invites/:token/accept-redirect
 *
 * GET — redeem the invite and redirect to /t/<slug>/dashboard.
 *
 * Used as the `callbackUrl` after sign-in from /invite/[token]:
 *   /login?callbackUrl=/api/invites/<token>/accept-redirect
 *
 * On success the user is redirected to their new tenant dashboard.
 * On failure (expired, wrong email, etc.) they are redirected to
 * /invite/<token>?error=<reason> so the invite page can surface the message.
 *
 * Sign-in required. Any tenant (no tenant permission middleware applies).
 */
import { NextRequest, NextResponse } from 'next/server';
import { authWithSuspension } from '@/lib/auth/session-gate';
import { recordSuspendedRefusal } from '@/lib/auth/suspended-refusal-audit';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { redeemInvite } from '@/app-layer/usecases/tenant-invites';
import { INVITE_REDEEM_LIMIT } from '@/lib/security/rate-limit';
import { enforceRateLimit, getClientIp, isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';

export async function GET(
    req: NextRequest,
    routeArgs: { params: Promise<{ token: string }> },
) {
    if (!isRateLimitBypassed()) {
        const enforcement = await enforceRateLimit(req, {
            scope: 'invite-redeem',
            config: INVITE_REDEEM_LIMIT,
            ip: getClientIp(req),
        });
        if (enforcement.response) return enforcement.response;
    }

    const { token } = await routeArgs.params;
    const origin = resolvePublicOrigin(req);
    // `authWithSuspension` rather than the throwing sibling: this is a bare
    // `GET` a BROWSER navigates to, so a thrown 403 would be rendered as raw
    // JSON. The refusal is a redirect to the surface that already explains
    // invite failures (#1652).
    const { session, suspended } = await authWithSuspension();

    if (!session?.user?.id || !session.user.email) {
        // Not signed in — send back to sign-in with this route as callbackUrl.
        const loginUrl = new URL('/login', origin);
        loginUrl.searchParams.set('callbackUrl', req.nextUrl.pathname);
        return NextResponse.redirect(loginUrl);
    }

    if (suspended) {
        // BEFORE `redeemInvite`, so the invite is not consumed — the owner's
        // ruling is that it stays pending and still works after a lift.
        //
        // A stable CODE in the query, not a sentence: the `catch` below puts
        // `err.message` there and the invite page renders it, which is
        // server-authored English on a ratchet. `?error=ACCOUNT_SUSPENDED`
        // matches what every other gate answers and the page can key its own
        // Bulgarian copy on it.
        // Recorded for platform admins (#1656). `recordSuspendedRefusal`
        // directly rather than through the gate's parameter, because this
        // route refuses by REDIRECTING and so uses the non-throwing door —
        // the recorder is the shared piece, and the gate's parameter is only
        // a convenience for callers that throw.
        await recordSuspendedRefusal(session.user.id, {
            attempted: 'INVITE_ACCEPTANCE',
            surface: 'TENANT',
            token,
        });

        const inviteUrl = new URL(`/invite/${token}`, origin);
        inviteUrl.searchParams.set('error', 'ACCOUNT_SUSPENDED');
        return NextResponse.redirect(inviteUrl);
    }

    try {
        const result = await redeemInvite({
            token,
            userId: session.user.id,
            userEmail: session.user.email,
        });
        const dashUrl = new URL(`/t/${result.slug}/dashboard`, origin);
        return NextResponse.redirect(dashUrl);
    } catch (err) {
        const inviteUrl = new URL(`/invite/${token}`, origin);
        // Surface a human-readable error without leaking internals.
        const isAppError =
            typeof err === 'object' &&
            err !== null &&
            'status' in err &&
            'message' in err;
        if (isAppError) {
            inviteUrl.searchParams.set('error', String((err as { message: string }).message));
        } else {
            inviteUrl.searchParams.set('error', 'Could not accept invite. Please try again.');
        }
        return NextResponse.redirect(inviteUrl);
    }
}

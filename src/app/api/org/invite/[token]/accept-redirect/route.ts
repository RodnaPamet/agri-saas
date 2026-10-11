/**
 * Epic D — /api/org/invite/[token]/accept-redirect
 *
 * GET — redeem the org invite and redirect to /org/<slug>.
 *
 * Used as the form-submit target on /invite/org/[token]: the page
 * renders a `<form action="/api/org/invite/<token>/accept-redirect" method="POST">`
 * which the browser then follows the 303-style redirect on, landing
 * the user on the org portfolio.
 *
 * GET-style fallback so the same URL works as a callbackUrl after
 * OAuth sign-in (the `start-signin` cookie path is preferred for
 * unauthenticated users; this route is for the already-signed-in
 * happy path).
 *
 * On success the user is redirected to /org/<slug>.
 * On failure (expired, wrong email, etc.) they are redirected to
 * /invite/org/<token>?error=<reason> so the invite page can surface
 * the message.
 *
 * Sign-in required. Rate limited per IP, mirroring the tenant flow.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authWithSuspension } from '@/lib/auth/session-gate';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { redeemOrgInvite } from '@/app-layer/usecases/org-invites';
import { INVITE_REDEEM_LIMIT } from '@/lib/security/rate-limit';
import {
    enforceRateLimit,
    getClientIp,
    isRateLimitBypassed,
} from '@/lib/security/rate-limit-middleware';

async function handle(
    req: NextRequest,
    routeArgs: { params: Promise<{ token: string }> },
) {
    if (!isRateLimitBypassed()) {
        const enforcement = await enforceRateLimit(req, {
            scope: 'org-invite-redeem',
            config: INVITE_REDEEM_LIMIT,
            ip: getClientIp(req),
        });
        if (enforcement.response) return enforcement.response;
    }

    const { token } = await routeArgs.params;
    const origin = resolvePublicOrigin(req);
    // Non-throwing, for the reason given on the tenant accept-redirect: a
    // browser navigates here, so a JSON 403 would be shown as JSON (#1652).
    const { session, suspended } = await authWithSuspension();

    if (!session?.user?.id || !session.user.email) {
        const loginUrl = new URL('/login', origin);
        loginUrl.searchParams.set('callbackUrl', req.nextUrl.pathname);
        return NextResponse.redirect(loginUrl);
    }

    if (suspended) {
        // Before `redeemOrgInvite`, so the invite stays pending. Code, not
        // prose — see the tenant route.
        const inviteUrl = new URL(`/invite/org/${token}`, origin);
        inviteUrl.searchParams.set('error', 'ACCOUNT_SUSPENDED');
        return NextResponse.redirect(inviteUrl, 303);
    }

    try {
        const result = await redeemOrgInvite({
            token,
            userId: session.user.id,
            userEmail: session.user.email,
            requestId: req.headers.get('x-request-id') ?? undefined,
        });
        const dashUrl = new URL(`/org/${result.organizationSlug}`, origin);
        return NextResponse.redirect(dashUrl, 303);
    } catch (err) {
        const inviteUrl = new URL(`/invite/org/${token}`, origin);
        const isAppError =
            typeof err === 'object' &&
            err !== null &&
            'status' in err &&
            'message' in err;
        if (isAppError) {
            inviteUrl.searchParams.set(
                'error',
                String((err as { message: unknown }).message ?? 'Invite redemption failed'),
            );
        } else {
            inviteUrl.searchParams.set('error', 'Invite redemption failed');
        }
        return NextResponse.redirect(inviteUrl, 303);
    }
}

export async function GET(
    req: NextRequest,
    routeArgs: { params: Promise<{ token: string }> },
) {
    return handle(req, routeArgs);
}

export async function POST(
    req: NextRequest,
    routeArgs: { params: Promise<{ token: string }> },
) {
    return handle(req, routeArgs);
}

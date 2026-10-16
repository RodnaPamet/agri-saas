import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

import { env } from '@/env';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { buildGoogleAuthorizeUrl, GOOGLE_INTEGRATION_FLAG } from '@/app-layer/integrations/providers/google';

/**
 * #2005 — start the Google consent flow for Drive + Calendar.
 *
 * POST returns the Google authorize URL and sets a short-lived HttpOnly
 * `google_oauth_state` cookie carrying `<state>.<tenantSlug>`. The browser
 * navigates there; Google redirects back to the tenant-agnostic callback,
 * which verifies the state and creates the connection.
 *
 * Shaped after the SharePoint connect route, including the cookie layout. The
 * cookie NAME differs on purpose: a shared name would let a consent started
 * for one provider complete for the other, since the callback trusts the
 * cookie for the tenant.
 *
 * Gated by `admin.manage` and by the `integrations.google` runtime flag.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, { params }, ctx) => {
            await assertFeatureEnabled(GOOGLE_INTEGRATION_FLAG, ctx.userId);

            const state = randomUUID();
            const origin = resolvePublicOrigin(req);
            const redirectUri = `${origin}/api/integrations/google/callback`;
            const authorizeUrl = buildGoogleAuthorizeUrl({ redirectUri, state });

            const res = NextResponse.json({ authorizeUrl });
            // `<state>.<tenantSlug>` — state is a UUID (no dots), so the
            // callback splits on the FIRST dot and the remainder is the slug.
            // HttpOnly + SameSite=Lax survives the top-level OAuth redirect;
            // 10 minutes is long enough to read a consent screen and short
            // enough that a stale cookie cannot be replayed later.
            res.cookies.set('google_oauth_state', `${state}.${params.tenantSlug}`, {
                httpOnly: true,
                sameSite: 'lax',
                secure: env.NODE_ENV === 'production',
                path: '/',
                maxAge: 600,
            });
            return res;
        },
    ),
);

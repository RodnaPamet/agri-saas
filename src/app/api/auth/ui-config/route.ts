/**
 * GET /api/auth/ui-config
 *
 * Returns the small set of auth-related flags the login page needs to
 * decide which practices to render. Client fetches this on mount.
 *
 * Why a runtime endpoint rather than a `NEXT_PUBLIC_*` env var:
 * `NEXT_PUBLIC_*` values are inlined at `next build` time — toggling
 * one requires a rebuild + image push + rollout. A tiny server route
 * reads `process.env` at request time, so an operator flips the flag
 * via the VM's `.env.prod` + `docker compose up -d --force-recreate`.
 *
 * No secrets leak here; the endpoint exposes only the flags the
 * browser would otherwise have to learn at build time.
 */

import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { isFeatureEnabled } from '@/lib/feature-flags';

export const dynamic = 'force-dynamic';

// Epic E — wrapped for x-request-id + standardized error contract.
// Never throws in normal operation; the wrapper is here so a future
// runtime fault (env-loader regression, etc.) yields a consistent
// 5xx shape rather than a Next.js stack-trace HTML page.
export const GET = withApiErrorHandling(async () => {
    // Resolved with no user: the login page has nobody signed in, so the
    // question is whether the CAPABILITY is launched rather than whether this
    // person is in a cohort. Same call the landing page and `/start` make.
    const registrationOpen = await isFeatureEnabled('social.farm-registration', null);

    return NextResponse.json({
        // When set, the public login page hides the email/password
        // form even if the Credentials provider is registered server-
        // side. Keeps prod OAuth-only at the UI layer while leaving
        // the backend available for API / tests / future admin tooling.
        credentialsFormHidden:
            process.env.AUTH_CREDENTIALS_UI_HIDDEN === '1',
        /**
         * Cloudflare Turnstile sitekey, or null when bot screening is not
         * configured (P3.5c).
         *
         * A sitekey is PUBLIC by design — it is rendered into the widget on
         * every page that uses it, and Cloudflare treats it as such. The
         * secret is what must never leave the server, and it is read only by
         * `verifyTurnstile`.
         *
         * Exposed here rather than as `NEXT_PUBLIC_TURNSTILE_SITEKEY` for the
         * reason this whole route exists, stated above: a `NEXT_PUBLIC_*`
         * value is inlined at build time, so supplying a key would need a
         * rebuild and a rollout. Read per request, the operator pastes both
         * values into the env file and recreates the container.
         *
         * `null` means render no widget. A client must branch on it rather
         * than passing it through — an empty sitekey renders a broken widget
         * that no amount of retrying fixes.
         */
        turnstileSitekey: process.env.TURNSTILE_SITEKEY || null,
        /**
         * Whether `/start` — the registration wizard — is open (P3.8's
         * `social.farm-registration`).
         *
         * The login page needs it for the same reason the landing page does:
         * `/start` calls `notFound()` when the flag is off, so a "create an
         * account" link offered while it is off leads to a 404, which reads as
         * a broken site rather than an unlaunched feature.
         *
         * It is here rather than inlined because the login page is a CLIENT
         * component and cannot resolve a flag itself, and because this route
         * is the one request it already makes on mount — so the answer costs
         * no extra round trip.
         */
        registrationOpen,
    });
});

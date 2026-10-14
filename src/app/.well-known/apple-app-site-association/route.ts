/**
 * `/.well-known/apple-app-site-association` — the document Apple fetches
 * before it will let a Universal Link open the native app (#1763).
 *
 * ## What was wrong
 *
 * Nothing served this path. No route, no file under `public/`, no entry in
 * `PUBLIC_PATH_EXACT` — so the middleware did exactly what it should with an
 * unmatched path and sent the visitor to `/login`:
 *
 *     307 -> https://app.agrent.bg/login?next=%2F.well-known%2Fapple-app-site-association
 *
 * Measured on production again on 2026-10-14 before this change. Apple fetches
 * this unauthenticated, from its own CDN, and a redirect is a hard failure —
 * so NO link to `app.agrent.bg` could open the app, and every shared link fell
 * back to Safari silently. The native side was already built and waiting
 * (`applinks:app.agrent.bg`, app id `9423GKWL67.bg.agrent.app`).
 *
 * ## Why `components` is EMPTY, and why that is the point
 *
 * This is the half of #1763 that #1623 argues against rushing, and it is
 * right: an AASA file is a PUBLISHED CLAIM that the listed paths open the app.
 * Listing a path that opens nothing sends someone who taps a link into the app
 * and into a dead end — worse than the browser fallback, which at least
 * renders something. Apple also caches the document, so a premature claim is
 * not a quick revert.
 *
 * None of the five candidate paths can be claimed today:
 *
 *   - `/f/[handle]` — a farm's public page, P6.5, unbuilt.
 *   - `/m`          — direct messages, P8, unbuilt.
 *   - `/go`         — named by P6.7 without a defined meaning.
 *   - `/c`, `/l`    — undefined anywhere in this repo. #1623 records that this
 *                     is an owner decision and that `agrent-ios` asked it come
 *                     from the owner directly rather than relayed.
 *
 * So the document associates the domain with the app and claims no paths. That
 * fixes the defect that is wrong on its own terms — a well-known path must not
 * 307 — without shipping a claim nobody can honour. Adding a path later is a
 * one-line change to `APPLINK_COMPONENTS` plus Apple's cache TTL, and doing it
 * BEFORE the app ships means no installed client ever cached an empty set.
 *
 * ## `webcredentials` is claimed, because that one IS true today
 *
 * Unlike the applinks paths, the credential association is useful now and
 * claims nothing about screens: it lets iOS offer Password AutoFill and
 * associate saved credentials for this domain with the app. The app already
 * signs people in against this origin.
 *
 * ## The Edge half is not optional
 *
 * `src/lib/auth/guard.ts` carries `/.well-known/apple-app-site-association` in
 * `PUBLIC_PATH_EXACT`. Without it this handler never runs and the 307 is
 * unchanged — the same shape as SCIM, the `iflk_` key, the three signed
 * webhooks, the platform-admin key, and the Art 16 notice form that answered
 * 401 for seven weeks (#1745). A closed door and an empty queue look identical
 * from inside.
 *
 * EXACT rather than a `/.well-known/` prefix: a prefix would open every method
 * on everything beneath that segment, and nothing else under it is meant to be
 * public yet.
 */
import { NextResponse } from 'next/server';

/** Statically served; nothing here depends on a request. */
export const dynamic = 'force-static';

/**
 * `<team id>.<bundle id>`, from the owner's Apple Developer account
 * (team `9423GKWL67`, app `bg.agrent.app`). Not secret — it is published in
 * this document by design, and it is in the iOS entitlement too.
 */
export const APP_ID = '9423GKWL67.bg.agrent.app';

/**
 * The paths that open the app. DELIBERATELY EMPTY — see the docblock.
 *
 * Exported so a client can read the claim rather than restating it, which is
 * what #1623 asks for ("the server half should publish the path list in a form
 * a client can read rather than leaving each side to restate it"). An empty
 * array is a legitimate, readable answer: it says the association exists and
 * no path opens the app yet.
 */
export const APPLINK_COMPONENTS: Array<Record<string, unknown>> = [];

export async function GET() {
    return NextResponse.json(
        {
            applinks: {
                details: [{ appIDs: [APP_ID], components: APPLINK_COMPONENTS }],
            },
            webcredentials: { apps: [APP_ID] },
        },
        {
            // Apple's documentation asks for `application/json`, which
            // `NextResponse.json` sets. Stated because an extensionless static
            // file under `public/` would have been served as
            // `application/octet-stream` — the reason this is a route handler
            // rather than a file.
            headers: {
                'cache-control': 'public, max-age=3600',
            },
        },
    );
}

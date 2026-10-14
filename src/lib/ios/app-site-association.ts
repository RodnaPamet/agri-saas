/**
 * The Apple app-site-association document, and the claims it makes (#1763).
 *
 * ## Why this is a lib module and not the route
 *
 * It began as exports from `src/app/.well-known/apple-app-site-association/route.ts`
 * and `tests/guards/app-router-module-exports.test.ts` refused it: Next's
 * generated type constraints reject a `route.ts` exporting anything but an
 * HTTP handler or route-segment config. That guard exists because the error is
 * invisible to CI — `tsc --noEmit` on a clean checkout has no `.next/types`,
 * so three such violations accumulated on main before anyone noticed. It
 * caught a fourth here.
 *
 * Separating them is better regardless: the document's CONTENT is testable
 * without a request, and the claim is importable by anything that needs to
 * read it rather than restate it.
 */

/**
 * `<team id>.<bundle id>`, from the owner's Apple Developer account
 * (team `9423GKWL67`, app `bg.agrent.app`).
 *
 * Not a secret — it is published in this document by design and appears in the
 * iOS entitlement. The team prefix is load-bearing: a bare bundle id looks
 * plausible and is what Apple rejects.
 */
export const APP_ID = '9423GKWL67.bg.agrent.app';

/**
 * The paths that open the app. DELIBERATELY EMPTY.
 *
 * An AASA file is a PUBLISHED CLAIM that the listed paths open the app, and
 * Apple caches it. A path that opens nothing sends someone who taps a link
 * into the app and into a dead end — worse than the browser fallback, which at
 * least renders something. That is #1623's argument and it is the deciding
 * one.
 *
 * None of the five candidates can be claimed yet:
 *
 *   - `/f/[handle]` — a farm's public page, P6.5, unbuilt.
 *   - `/m`          — direct messages, P8, unbuilt.
 *   - `/go`         — named by P6.7 with no defined meaning.
 *   - `/c`, `/l`    — undefined anywhere in this repo. #1623 records that as an
 *                     owner decision, and that `agrent-ios` asked it come from
 *                     the owner directly rather than relayed.
 *
 * Exported so a client can READ the claim rather than restate it — what #1623
 * asks for. An empty array is a readable answer: the association exists, and
 * no path opens the app yet.
 */
export const APPLINK_COMPONENTS: ReadonlyArray<Record<string, unknown>> = [];

export interface AppSiteAssociation {
    applinks: { details: Array<{ appIDs: string[]; components: Array<Record<string, unknown>> }> };
    webcredentials: { apps: string[] };
}

/**
 * The document Apple fetches.
 *
 * `webcredentials` IS claimed, unlike the applink paths, because it is true
 * today and says nothing about screens: it lets iOS offer Password AutoFill
 * and associate saved credentials for this origin with the app, and the app
 * already signs people in here.
 */
export function buildAppSiteAssociation(): AppSiteAssociation {
    return {
        applinks: {
            details: [{ appIDs: [APP_ID], components: [...APPLINK_COMPONENTS] }],
        },
        webcredentials: { apps: [APP_ID] },
    };
}

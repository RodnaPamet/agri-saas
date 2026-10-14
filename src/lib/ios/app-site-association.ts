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
 * The path that opens the app: `/m/*`.
 *
 * ## The scheme is TWO paths, by two recorded owner rulings
 *
 * #1623, both asked directly rather than relayed because that issue asked for
 * it:
 *
 *   2026-10-12 13:42 — `/c` and `/l` DROPPED. "The AASA will list only paths
 *                      with a screen behind them… a path absent from it
 *                      simply falls back to the browser, which is the BETTER
 *                      outcome of the two."
 *   2026-10-12 14:35 — `/go` DROPPED on the same reasoning: a path with no
 *                      defined meaning cannot open anything.
 *
 * `/f/[handle]` is a farm's public page, keyed by a SEPARATE public handle and
 * not the tenant slug — the two diverging later would be a breaking change to
 * a published link format. `/m` is direct messages. Both have a defined
 * meaning; neither has a screen yet (P6.9 and P8).
 *
 * ## This field has changed four times and only the record is useful
 *
 *   empty            #1786, declining to claim anything before the meanings
 *                    were settled.
 *   all but /api/*   #1780, mine. A catch-all over the whole origin, which
 *                    would have hijacked every emailed invite, password reset
 *                    and /t/<slug>/… link on a phone with the app installed.
 *                    Reverted by #1791.
 *   five prefixes    #1794, mine. Claimed on an owner answer to a question I
 *                    framed from this issue's BODY and #1786's docblock, both
 *                    of which predate the rulings above. The body's table
 *                    lists five; the comments drop three.
 *   two prefixes     here, on the rulings themselves.
 *
 * An issue's BODY is the question and its COMMENTS are the answers. Acting on
 * the first produced a published claim contradicting two direct owner
 * decisions from two days earlier — and because the question was framed from
 * the wrong list, the answer to it was not wrong, it was answering the wrong
 * question. A relayed report is what surfaced it.
 *
 * ## What the claim costs while the screens are unbuilt
 *
 * `/m` serves no web page and the app has no `onOpenURL` handler, so a tapped
 * link opens the app at its home screen rather than rendering a 404 in Safari.
 * That is accepted so the client can build against a published list.
 *
 * ## `/f/*` HAS BEEN WITHDRAWN, and the prediction above is why
 *
 * This docblock warned that the claim "becomes a REGRESSION the day one ships
 * as a web route while the app still cannot open it — a working page starts
 * being hijacked". That day is 2026-10-14: P6.5 (#1814) ships `/f/[handle]` as
 * a real, server-rendered public page, and P6.9's iOS screen does not exist.
 *
 * So the claim now costs exactly what it was predicted to. An iOS user tapping
 * a shared farm link — or scanning a printed QR code (P6.7) — would open the
 * app at its home screen INSTEAD of seeing the farm, while the same link in
 * any other browser works. Withdrawing the claim is strictly better: the
 * owner's own ruling says a path absent from the AASA "simply falls back to
 * the browser, which is the BETTER outcome of the two", and now there is
 * something in the browser worth falling back to.
 *
 * It returns when P6.9 ships a screen that can open it. The collision check in
 * the test is derived from the filesystem, so it will keep refusing the claim
 * for as long as the page exists and nothing re-argues it — which is the right
 * default, because the iOS half landing is the thing that changes the answer.
 *
 * Exported so a client READS the claim rather than restating it (#1623).
 */
export const APPLINK_COMPONENTS: ReadonlyArray<Record<string, unknown>> = [
    { '/': '/m/*' },
];

export interface AppSiteAssociation {
    applinks: { details: Array<{ appIDs: string[]; components: Array<Record<string, unknown>> }> };
    webcredentials: { apps: string[] };
}

/**
 * The document Apple fetches.
 *
 * `webcredentials` is claimed and currently does NOTHING. The justification
 * here used to read "it is true today… the app already signs people in here",
 * and agrent-ios checked `Agrent/Agrent.entitlements` rather than recalling
 * it: the app holds `aps-environment`, `com.apple.developer.applesignin` and
 * `associated-domains: [applinks:app.agrent.bg]` — no `webcredentials:` entry.
 * iOS needs BOTH halves for Password AutoFill, so this one is inert. There is
 * also nothing to fill: the app has no password field, and sign-in is Google
 * and Microsoft through the system web sheet plus Sign in with Apple.
 *
 * Kept rather than dropped, because it costs nothing and adding the
 * entitlement is an owner decision needing a signing-profile refresh. The
 * comment is corrected because a false justification outlives the person who
 * wrote it, and the next reader would have taken "it is true today" as a
 * measurement.
 */
export function buildAppSiteAssociation(): AppSiteAssociation {
    return {
        applinks: {
            details: [{ appIDs: [APP_ID], components: [...APPLINK_COMPONENTS] }],
        },
        webcredentials: { apps: [APP_ID] },
    };
}

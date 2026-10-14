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
 * The paths that open the app.
 *
 * ## These are claimed on the OWNER'S DIRECT authority, which is the point
 *
 * This array was deliberately EMPTY, because #1623 recorded that `/c` and `/l`
 * had no defined meaning anywhere in this repo and that **agrent-ios asked the
 * decision come from the owner DIRECTLY rather than relayed through them** —
 * three relayed decisions on this project had already differed from his direct
 * answer.
 *
 * It was then filled in twice on a relay and both times that was wrong. #1780
 * first claimed `["NOT /api/*", "*"]` — the whole origin — and then narrowed to
 * these five on a peer's message; the narrow version reached production and
 * was reverted by #1791. The owner has since answered directly: claim all
 * five. That answer, not the list, is what changed.
 *
 * The meanings (agrent-ios#206, owner 2026-10-11):
 *
 *   /f/*   a farm's public page, keyed by a SEPARATE public handle — not the
 *          tenant slug. The two diverging later would be a breaking change to
 *          a published link format, which is why it was worth asking.
 *   /l/*   a listing its farm has made public (Борса).
 *   /c/*   a channel (P9).
 *   /go/*  short codes behind QR codes and A6 prints.
 *   /m/*   direct messages (P8.8).
 *
 * ## What this claim costs, stated plainly
 *
 * An AASA file is a PUBLISHED claim, and Apple caches it. None of these five
 * serves a web page yet and the app has no `onOpenURL` handler yet, so a
 * tapped link today opens the app at its home screen rather than rendering a
 * 404 in Safari. That is the known cost of publishing ahead of the handlers,
 * and it is the owner's call to pay it so the client can build against a
 * published list.
 *
 * It becomes a REGRESSION the day one of these ships as a web route while the
 * app still cannot open it — at that point a working page starts being
 * hijacked. `tests/unit/apple-app-site-association.test.ts` fails on exactly
 * that, derived from the filesystem rather than listed.
 *
 * Exported so a client READS the claim rather than restating it (#1623), which
 * is the same reasoning that put `entryUnit` on the #1587 form read instead of
 * in two clients.
 */
export const APPLINK_COMPONENTS: ReadonlyArray<Record<string, unknown>> = [
    { '/': '/f/*' },
    { '/': '/l/*' },
    { '/': '/c/*' },
    { '/': '/go/*' },
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

/**
 * Edge-compatible auth guard helpers.
 * Pure functions — no Node.js or Prisma imports.
 * Used by middleware.ts for path classification and redirect building.
 */
import { NextResponse } from 'next/server';
import { CSP_REPORT_PATH } from '@/lib/security/csp';
import { sanitizeRedirectPath } from './safe-redirect';

// ─── Public path allowlist ───

export const PUBLIC_PATH_PREFIXES = [
    // P6.5 (#1814) — a farm's PUBLIC page, `/f/[handle]`. The whole point is
    // that a stranger with a shared link or a printed QR code reaches it with
    // no session.
    //
    // A PREFIX and not an exact entry, deliberately: the handle is part of the
    // path, so there is no finite set of exact paths to list. What that opens
    // is `/f` and everything under `/f/`, and nothing else —
    // `matchesPublicPrefix` requires the match to end at a separator or at the
    // end of the string, so `/fx`, `/fx/admin` and `/f-debug` stay gated.
    // Measured against the live predicate rather than assumed, because the
    // pre-#1770 `startsWith` behaviour would have opened all three.
    //
    // No trailing slash, so a bare `/f` is public too and answers 404 — the
    // honest reply for an address with no handle. Gating it would redirect an
    // anonymous visitor to a login page they have no account for.
    //
    // Anything added under `/f/` later is public by this entry. That is the
    // cost of a prefix and it is the right trade here, because every path
    // under `/f/` is by definition a published profile.
    // P6.3 (#1812) — the bytes of an image a published farm profile
    // references, `/api/public/media/{hash}`. Public for the same reason
    // `/f` is: a stranger with a shared link or a printed QR code reaches the
    // page with no session, and a page whose images 401 is not a public page.
    //
    // A PREFIX and not an exact entry, because the hash is part of the path
    // and there is no finite set of paths to list.
    //
    // What the trailing slash does HERE is narrower than the usual story, and
    // worth stating precisely because I first wrote the usual story and it was
    // wrong. `matchesPublicPrefix` already segment-bounds a bare entry, so
    // `/api/public/mediaX` stays gated with or without the slash — that is
    // #1770's fix and it is why the `/api/scim` vs `/api/scimulator` hazard
    // named further down no longer applies to THIS predicate.
    //
    // The slash decides one thing: whether the BARE `/api/public/media` is
    // public. An explicit trailing slash is honoured verbatim, so the bare
    // path does not match and stays gated — which is what we want, since
    // nothing serves it and a 401 is the honest answer for an API path rather
    // than a redirect to a login page an anonymous visitor has no account for.
    //
    // Measured rather than reasoned: deleting the slash fails
    // `public-media-edge-reachability`'s bare-path case and nothing else. The
    // sibling cases stay green, which is how I found out the rest of this
    // comment used to be false.
    //
    // The slash DOES carry the sibling property one layer out, in
    // `publicMediaRateLimit`, which matches with a plain `startsWith` — and
    // there deleting it fails the sibling assertion instead. Two files, two
    // mechanisms, one character.
    //
    // Only a CHILD path distinguishes a prefix entry from an exact one; a
    // sibling cannot. That is the measurement #1817 recorded the hard way, so
    // `tests/guards/public-media-route-classification.test.ts` probes
    // `/api/public/media/<hash>` against the LIVE predicate rather than
    // asserting the list contains a string.
    //
    // What a prefix opens is every METHOD, not just GET. The route exports
    // only `GET`, so POST and DELETE 405 rather than reaching a handler —
    // that is the whole defence, and it is why the route must not grow a
    // mutating export without a different gate.
    '/api/public/media/',
    '/f',
    '/invite/',          // Invite preview page (tenant + org) — public so unauthenticated users can see invite details
    '/api/auth',         // Auth.js callbacks, session, csrf, providers
    '/api/invites/',     // Tenant invite redemption API (public) + start-signin cookie setter
    '/api/org/invite/',  // Org invite API (public) — start-signin cookie setter + accept-redirect, mirrors /api/invites/
    '/api/scim/',        // SCIM 2.0 provisioning (RFC 7644). Every request carries a
                         // tenant-scoped OPAQUE bearer token, not a NextAuth JWE, so
                         // `getToken()` below cannot validate one and returns null —
                         // which 401'd every SCIM request at the Edge before any
                         // handler ran, from the day the feature shipped. The Edge
                         // has no DB, so it CANNOT verify a hashed SCIM token; the
                         // only place that can is the route itself.
                         //
                         // This is a deliberate hole in the Edge gate and it is only
                         // safe because every data-bearing handler under
                         // `/api/scim/v2` authenticates itself via
                         // `authenticateScimRequest`. That is not a convention to be
                         // remembered — it is enforced, fail-closed and derived from
                         // the filesystem, by
                         // `tests/guards/scim-routes-self-authenticate.test.ts`.
                         // Do not add a route here without reading that guard.
    // ── Platform-admin API ──
    //
    // Eleven routes (tenant bootstrap, ownership transfer, agri-events,
    // news-derived-events review, support-scheme review, and the P0.4 feature
    // flag console + its cohort membership) authenticate with
    // `PLATFORM_ADMIN_API_KEY` via `verifyPlatformApiKey`, sent as the
    // `x-platform-admin-key` header by an operator with curl. No session
    // cookie, so `getToken()` returned null and the Edge refused every one
    // of them — the documented caller could never reach the handler.
    // Verified: key-only POST /api/admin/tenants → 401 from the middleware.
    //
    // Safe to open for the same reason as the webhooks below:
    // `verifyPlatformApiKey` fails CLOSED in every direction — 503 when
    // PLATFORM_ADMIN_API_KEY is unset, 401 on mismatch, constant-time
    // comparison, and it runs unconditionally at the top of each handler.
    // Enforced by tests/guards/public-routes-self-authenticate.test.ts.
    //
    // What this SKIPS, deliberately: `isAdminPath` below also applies a
    // Sec-Fetch-Site cross-site check to `/api/admin`. That guards
    // browser-originated requests, and these are not browser routes — no UI
    // in src/ calls them, and a cross-site attacker cannot set a custom
    // header without a CORS preflight nor guess the key. The header key is
    // the control; the origin check was never the one doing the work here.
    //
    // LISTED INDIVIDUALLY, not as a bare `/api/admin/` prefix. The first
    // attempt opened the whole prefix and the fail-closed guard immediately
    // flagged `/api/admin/diagnostics`, which uses a DIFFERENT auth model —
    // `getLegacyCtx` + `permissions.canAdmin`, i.e. an admin SESSION, not
    // the platform key. It still fails closed (getSessionOrThrow throws),
    // so it was not a hole; but opening the prefix would have stripped its
    // Edge role-floor and cross-site check for no benefit at all. A tenth
    // platform-key route added later is caught by the same guard's
    // reachability half, so this list cannot silently go stale.
    '/api/admin/agri-events',
    '/api/admin/news-derived-events',
    '/api/admin/support-schemes',
    '/api/admin/tenants',
    // The flag console's CHILDREN. The console's own path is in
    // PUBLIC_PATH_EXACT below rather than spelled as a bare prefix here,
    // because `startsWith('/api/admin/feature-flags')` would also open a
    // future `/api/admin/feature-flagsomething` — the `/api/scim` vs
    // `/api/scimulator` hazard named a few lines up. The siblings above carry
    // that latent widening; a new entry need not inherit it.
    '/api/admin/feature-flags/',
    // Platform-level master-KEK rotation (the global-column sweep). Same gate
    // and same reachability argument as the flag console above:
    // `verifyPlatformApiKey` fails closed in every direction, and without this
    // entry the Edge 401s an `x-platform-admin-key` request before the handler
    // runs. Spelled with the trailing slash for children; the path itself is in
    // PUBLIC_PATH_EXACT below.
    '/api/admin/key-rotation/',
    // The farm-claim review queue's CHILDREN — `/:claimId/verify` and
    // `/:claimId/dispute` (P3.9). Same gate and same reachability argument as
    // the two above: `verifyPlatformApiKey` fails closed in every direction,
    // and WITHOUT this entry the Edge 401s an `x-platform-admin-key` request
    // before the handler runs, so staff verification would have been
    // unreachable while looking perfectly implemented. That is the sixth
    // instance of this shape in this file, which is why the guard's
    // reachability half exists.
    //
    // Trailing slash for the children only; the queue's own path is in
    // PUBLIC_PATH_EXACT below, so `startsWith('/api/admin/farm-claims')`
    // cannot also open a future `/api/admin/farm-claimsomething`.
    '/api/admin/farm-claims/',
    // ── Moderation console (P5.4a, #1595) ──
    //
    // `/api/admin/moderation/notices` and `.../statements` verify
    // `x-platform-admin-key` through `verifyPlatformApiKey`, and the Edge
    // 401s an `x-platform-admin-key` request before any handler runs. Without
    // this entry both would have been unreachable while looking perfectly
    // implemented — the SEVENTH instance of the shape this file's guard was
    // written for, and it caught mine within minutes of the routes existing.
    //
    // Trailing slash, because the children are the surface: there is no
    // `/api/admin/moderation` route of its own, and the slash stops this
    // opening a future `/api/admin/moderationsomething`.
    //
    // Assertion B of `public-routes-self-authenticate` is what keeps this from
    // being a hole: a route behind a public prefix must authenticate itself,
    // and these two do it first, before reading a body.
    '/api/admin/moderation/',
    // ── Signed webhooks ──
    //
    // Each of these verifies its OWN credential — a Stripe signature, an
    // HMAC-SHA256 over the raw body, a per-connection integration secret —
    // and none of them can carry a NextAuth session cookie, because the
    // sender is Stripe / the AV scanner / a third-party service. So
    // `getToken()` returned null and every one of them was refused at the
    // Edge before its handler ran. They had NEVER been delivered.
    //
    // Verified by driving the real middleware: all three answered
    // `401 {"error":"Unauthorized"}` — `unauthorizedJson()`, not the
    // handler's own refusal. Latent rather than live on the current
    // deployment (Stripe is unconfigured, AV scanning disabled), which is
    // exactly what let it survive: it fails SILENTLY on the day someone
    // turns either on.
    //
    // Opening the Edge here is safe only because every handler
    // self-authenticates and fails CLOSED with no secret configured —
    // Stripe throws, AV 500s in production, integrations 401. That is
    // enforced, not remembered, by
    // `tests/guards/public-routes-self-authenticate.test.ts`.
    '/api/integrations/webhooks/',
    '/_next',            // Next.js internals
];

export const PUBLIC_PATH_EXACT = new Set([
    // The Google consent RETURN (#2495). EXACT, not a prefix: it is one path,
    // and a prefix would open everything added under `/api/integrations/google/`
    // later — `/connect` among them, which is the admin-gated route that STARTS
    // the flow.
    //
    // It has to be here because the request arrives from GOOGLE, not from a
    // browsing session. The native branch runs its consent in an EPHEMERAL
    // browser that holds no cookie at all — that is the whole design, and the
    // reason `GoogleOAuthState` exists as a server-held row instead of a
    // cookie. So the Edge calls `getToken()`, finds nothing, and
    // `unauthorizedJson()` refuses the request before the handler ever runs.
    //
    // Measured in production 2026-11-01: the owner reached Google, consented,
    // and got a bare `{"error":"Unauthorized"}` page at app.agrent.bg. Two
    // `GoogleOAuthState` rows had been minted by `/connect` seconds earlier and
    // were still UNCONSUMED, which is the tell — the claim never ran, so the
    // refusal was upstream of `claimNativeState` rather than inside it.
    //
    // Note the near miss: `/api/auth` IS a public prefix, so Google SIGN-IN
    // (`/api/auth/callback/google`) has always worked. Only the INTEGRATION
    // callback lives outside it, which is why this looked like a Google
    // configuration fault for as long as it did.
    //
    // Opening it is safe because the handler authenticates itself, in both
    // branches and without reference to the Edge:
    //   · native — `claimNativeState` ATOMICALLY claims a single-use,
    //     expiring, hashed state row, then `contextForStarter` re-checks that
    //     the person who started the flow is STILL an active admin of that
    //     farm. A replay finds the row consumed and is refused.
    //   · web — `getTenantCtx` + `assertCanAdmin`, reading the caller's cookie
    //     exactly as before.
    // A request carrying no valid state and no session reaches neither.
    '/api/integrations/google/callback',

    // P6.8 (#1817) — the public farm directory. EXACT and not a prefix: it is
    // one path, so the narrower claim is the right one, and a prefix would
    // open anything added beneath it later. It carries no credential to
    // verify, which is the point — a stranger browsing has no account.
    //
    // I first added this to PUBLIC_PATH_PREFIXES by anchoring next to
    // `/api/public/notices` and assuming that list was the exact one. It is
    // not: PREFIXES runs to line ~226 and this Set starts after it. The tell
    // was a probe — `/api/public/farms/secret` came back PUBLIC while
    // `/api/public/farmsomething` came back gated, which is the signature of a
    // prefix entry under `matchesPublicPrefix` and not of an exact one. Only a
    // CHILD path distinguishes the two forms; a sibling cannot.
    '/api/public/farms',

    // The landing page (P3.8). EXACT, so ONLY the root opens — no prefix, and
    // nothing under `/` inherits it.
    //
    // This is the first genuinely public PAGE in the product: until now an
    // unauthenticated visitor to `/` was redirected to `/login`, and the only
    // unauthenticated surfaces were the sign-in flow and `/privacy`. A landing
    // page is public by definition, so the change is the feature rather than a
    // side effect — but it is worth saying out loud, because "the app has no
    // public pages" was true the day before this entry and is a thing people
    // reason from.
    //
    // The page itself renders no tenant data and reads no session beyond
    // deciding which call to action to show.
    '/',
    // The legal surfaces (P3.1). EXACT, like the root: these two pages are
    // public and nothing underneath them should inherit it.
    //
    // `/terms` is linked from the registration wizard's consent checkbox, so a
    // visitor has to be able to read it BEFORE an account exists — the same
    // argument that already makes `/privacy` public. A terms page you cannot
    // reach without accepting it is not a term you agreed to.
    //
    // `/dsa-contact` is the Digital Services Act single point of contact, and
    // the people who need it are by definition not signed in: a user who has
    // been restricted, an authority, a court. Gating it would defeat the whole
    // purpose of having one.
    //
    // Both render no tenant data and read no session at all.
    // The registration wizard (P3.8). EXACT, like the others here.
    //
    // THIS WAS MISSING AND THE FEATURE WAS BROKEN BY IT. `/start` was
    // allowlisted in `tenant-isolation-structural` — so it was allowed to live
    // outside `/t/[tenantSlug]` — and never added here, so an anonymous
    // visitor got `307 -> /login?next=%2Fstart`. Registration was unreachable
    // for exactly the people it exists for: steps 1-2 run with no session at
    // all, which is the whole design.
    //
    // It hid because `social.farm-registration` was off, so nobody was looking
    // at `/start`; and the 404 the page returns when the flag is off happens
    // INSIDE the page, which the middleware never reaches. So "it 404s anyway"
    // was not even true — it redirected.
    //
    // Third time this repo has had the two-list bug (`/privacy`, then the
    // legal pages, now this). The lists are `PUBLIC_PATH_EXACT` here and
    // `ALLOWED_ROOT_PAGES` in tenant-isolation-structural, and satisfying one
    // looks identical to being finished.
    '/start',
    '/terms',
    '/dsa-contact',
    '/favicon.ico',
    '/robots.txt',
    '/sitemap.xml',
    // Not a static asset: the platform flag console (P0.4). Exact rather than a
    // prefix so only this path and `/api/admin/feature-flags/...` open — see
    // the note beside the prefix entry. It authenticates itself with
    // `verifyPlatformApiKey` on every method, read paths included, which is
    // what direction B of `public-routes-self-authenticate` requires and what
    // `tests/unit/admin-feature-flags-console.test.ts` executes.
    '/api/admin/feature-flags',
    // Platform master-KEK rotation. Exact rather than a bare prefix for the
    // same reason as the flag console: `startsWith('/api/admin/key-rotation')`
    // would also open a future `/api/admin/key-rotation-report`. Note the
    // TENANT-scoped `/api/t/{slug}/admin/key-rotation` is unrelated and stays
    // behind the session gate, where it belongs.
    '/api/admin/key-rotation',
    // `GET /api/admin/farm-claims` — the review queue (P3.9). EXACT, with its
    // children carried by the trailing-slash prefix above.
    '/api/admin/farm-claims',
    // The lookup-hash rehash sweep (#1237). EXACT and with NO children prefix,
    // because unlike the two above it has no child paths — adding a prefix
    // "for symmetry" would open paths that do not exist yet, which is how
    // `/api/scim` nearly opened `/api/scimulator`. Same platform gate and the
    // same reachability argument: `x-platform-admin-key` carries no NextAuth
    // JWE, so without this entry the Edge 401s before the handler runs.
    '/api/admin/lookup-rehash',
    // Resend delivery events (#1753). Machine-facing and signature-verified in
    // the handler (Svix over the raw body), so the Edge cannot authenticate it
    // — the same shape as `/api/stripe/webhook` and `/api/storage/av-webhook`.
    //
    // EXACT, and this entry started life in PUBLIC_PATH_PREFIXES by mistake
    // with a comment claiming it was here. The two are not interchangeable:
    // `matchesPublicPrefix` matches at a SEGMENT boundary, so the prefix form
    // opened `/api/webhooks/resend/**` — every child path of a route that has
    // no children. What hid it is worth recording, because the check looked
    // thorough: I probed `/api/webhooks/other` and got `false`, and read that
    // as proof the entry was exact. A SIBLING cannot distinguish the two
    // forms; only a CHILD can. The probe had no power over the property it
    // was run to establish.
    '/api/webhooks/resend',
    // ── Apple Universal Links (#1763) ──
    //
    // Apple fetches `/.well-known/apple-app-site-association` from its own
    // CDN, UNAUTHENTICATED, and a redirect is a hard failure. Without this
    // entry the middleware 307s it to `/login` — measured on production on
    // 2026-10-14 — so NO link to this origin could open the native app, while
    // the iOS side was already built and waiting on `applinks:app.agrent.bg`.
    //
    // EXACT, not a `/.well-known/` prefix: a prefix opens every method on
    // everything beneath that segment and nothing else under it is public yet.
    // The entry above is the cautionary tale for getting that wrong.
    //
    // The handler claims no applink PATHS (#1623 — `/c` and `/l` have no
    // defined meaning anywhere, and the screens `/f` and `/m` would open do
    // not exist), so this opens a document that associates the app and
    // promises nothing. Assertion B of `public-routes-self-authenticate` does
    // not apply: it is not an API route, and the document is published by
    // design rather than protected.
    '/.well-known/apple-app-site-association',

    // ══ Narrowed from PUBLIC_PATH_PREFIXES (#1838) ══
    //
    // Every entry below serves exactly ONE path, with no route beneath it.
    // They sat in the prefix list, which is fail-open: a prefix claims a
    // SUBTREE, so the next route added under any of them would have been
    // public by inheritance with nobody deciding. Nothing existed under them,
    // so there was no hole to exploit — which is precisely why it would have
    // gone unnoticed. An unauthenticated route looks exactly like a working
    // one.
    //
    // The adjacency was part of the mechanism: a dozen single-path entries
    // sitting in the prefix list made the prefix list look like where a
    // single path goes. `public-prefix-claims-its-subtree` now derives the
    // question from the route tree — does a route sit AT the entry path, or
    // BENEATH it? — so the list cannot drift back.
    //
    // Narrowing a claim could not be done at all until `isPublicPath`
    // stripped the query once: `matchesPublicPrefix` treated `?` as a
    // boundary and a `Set` lookup cannot, so moving `/login` would have
    // gated `/login?next=…`, the exact URL an unauthenticated visitor is
    // redirected to.

    // ── auth pages, reachable without a session by definition ──
    '/login',
    // No `src/app/register` exists. The only `register` directory is
    // `src/app/api/auth/register`, already covered by `/api/auth`, so this
    // entry serves nothing today — kept as an EXACT claim rather than
    // deleted, because narrowing is behaviour-preserving for the one path
    // `guard.test.ts` pins while deleting would change it.
    '/register',
    '/forgot-password', // Password-reset request — unauthenticated users must reach it
    '/reset-password', // Password-reset confirm — reached from an emailed token link
    '/no-tenant', // Landing page for uninvited users — must not gate-loop
    '/tenants', // R-1: tenant picker — reachable before active-tenant is set

    // Privacy notice — MUST be readable without an account: the promotions
    // consent box links to it before a request is submitted, and a
    // prospective user has to be able to read it before signing up. It
    // renders no tenant data, so there is nothing to gate.
    '/privacy',

    // ── probes and sinks, anonymous by design ──
    '/api/health', // Health check (no auth) — deprecated alias
    '/api/livez', // Liveness probe (no auth)
    '/api/readyz', // Readiness probe (no auth)
    '/api/metrics', // web-vitals telemetry sink — anonymous RUM beacons
    '/api/staging/seed', // Staging seed endpoint (token-gated internally)

    // CSP violation sink. Same class as `/api/metrics`: a browser posts
    // violation reports with NO credentials, so `getToken()` returned null
    // and the Edge 401'd every one of them — from the day the feature
    // shipped (2026-03-21) until #704. The ring buffer was permanently
    // empty, the admin summary permanently zero, and `csp.ts:16` told
    // operators to "monitor" something that could not happen; five months of
    // CSP tightening shipped with its safety net disconnected.
    //
    // Spelled as the CONSTANT, not a literal, and that is load-bearing. The
    // same value goes into three response headers — `report-uri`, `Report-To`
    // and `Reporting-Endpoints` — so a literal here could drift from what
    // browsers are actually told. The duplicated-literal shape is exactly
    // what produced that bug; `/api/metrics` still has it.
    //
    // Being a constant also hid it from the guard that was supposed to cover
    // it: `public-prefix-segment-boundary` harvested entries with a
    // quoted-literal regex and swept 32 of 33 (#1848). The lists are read as
    // VALUES now.
    //
    // Direction B of `public-routes-self-authenticate` applies: the POST is
    // designed anonymous (per-IP rate limit, 16 KB cap, always 204, never
    // leaks state), and the GET summary authenticates itself with
    // `verifyPlatformApiKey`.
    CSP_REPORT_PATH,

    // ── signed webhooks ──
    //
    // Each verifies its OWN credential — a Stripe signature, an HMAC-SHA256
    // over the raw body — and neither can carry a NextAuth session cookie,
    // because the sender is Stripe or the AV scanner. So `getToken()`
    // returned null and both were refused at the Edge before their handler
    // ran. They had NEVER been delivered.
    //
    // Verified by driving the real middleware: both answered
    // `401 {"error":"Unauthorized"}` — `unauthorizedJson()`, not the
    // handler's own refusal. Latent rather than live on the current
    // deployment (Stripe is unconfigured, AV scanning disabled), which is
    // exactly what let it survive: it fails SILENTLY on the day someone
    // turns either on.
    //
    // Opening the Edge here is safe only because every handler
    // self-authenticates and fails CLOSED with no secret configured —
    // Stripe throws, AV 500s in production. That is enforced, not
    // remembered, by `tests/guards/public-routes-self-authenticate.test.ts`.
    //
    // `/api/integrations/webhooks/` stays a PREFIX and keeps the third share
    // of that argument, because its route is `[provider]` — a subtree claim
    // is what it means.
    '/api/stripe/webhook',
    '/api/storage/av-webhook',

    // ── public API, anonymous by design or by legal duty ──
    //
    // P3.7 — runs while someone types their ЕИК into the registration form,
    // before any account exists. EXACT, not a `/api/public/` prefix: a prefix
    // would open every future neighbour under it by accident, and this is the
    // only route there that has been argued for.
    '/api/public/eik-check',

    // P5.2 — the anonymous DSA Art 16 notice form (#1745).
    //
    // **This was missing and the route 401'd for seven weeks.** Art 16
    // requires a mechanism ANY person or entity can use to notify illegal
    // content, so an account requirement is an account requirement on
    // exercising a right — and the Edge calls `getToken()`, which understands
    // only a NextAuth cookie, so every anonymous notice was refused before
    // the handler ran. Measured on production: `POST /api/public/notices` →
    // 401, three times.
    //
    // The eighth instance of the Epic C.1a/b/c class, and the one that shows
    // why the rule is TWO halves: the handler side was argued for carefully
    // in `public-routes-self-authenticate.test.ts` ("anonymous by design, and
    // by LEGAL DUTY"), and that argument is about the handler. Nothing asked
    // whether the Edge agreed. `public-route-exemptions-are-edge-reachable`
    // now joins the two lists.
    '/api/public/notices',
]);

// `webmanifest` — the PWA manifest is fetched by the browser WITHOUT
// credentials (`<link rel="manifest">` default), so without this it hits the
// auth gate, 307-redirects to /login, and the browser parses the HTML login
// page as JSON → "Manifest: Line 1, column 1, Syntax error".
// `geojson` — bundled static map overlays under /public/geo (e.g. the Exchange
// map's oblast boundaries); same static-public-asset class as the rest.
const STATIC_EXTENSIONS = /\.(ico|png|jpg|jpeg|gif|svg|webp|css|js|woff|woff2|ttf|eot|map|json|webmanifest|geojson)$/;

/**
 * Everything before the first `?` or `#`.
 *
 * Exported so the two guards that assert on this module's boundary rules can
 * state it, rather than reimplementing the split and drifting from it.
 */
export function stripQueryAndFragment(pathname: string): string {
    const cut = pathname.search(/[?#]/);
    return cut === -1 ? pathname : pathname.slice(0, cut);
}

/**
 * Does `pathname` fall under a public `prefix`, at a SEGMENT boundary?
 *
 * ## Why a bare `startsWith` is the wrong predicate here
 *
 * `PUBLIC_PATH_PREFIXES` is a FAIL-OPEN list: an entry that matches means the
 * auth gate is skipped. It was matched with `pathname.startsWith(prefix)`, and
 * 20 of its 27 entries carry no trailing slash — so each one also opened every
 * path that merely BEGINS with its characters. A future
 * `/api/metrics-internal`, `/api/admin/tenants-purge` or `/api/readyz-debug`
 * would have been public, and nothing would have said so: the failure is a
 * route that is reachable without a session, which looks like a working route.
 *
 * This repo already knows the rule. `CLAUDE.md`, on the SCIM entry:
 *
 *   > The trailing slash on the prefix is load-bearing — `'/api/scim'` would
 *   > also open `/api/scimulator`.
 *
 * `'/api/scim/'` is written correctly for exactly that reason. The other 20
 * were the same hazard with no slash, and a convention that holds only when
 * every author remembers it is not a convention — the same shape as the
 * `getUserId` rate-limit opt-in (see `resolveRateLimitScope`).
 *
 * ## The rule
 *
 * A match must end at a path separator or at the end of the string, so a
 * prefix opens the path itself and its CHILDREN, never a sibling that shares
 * its spelling:
 *
 *     '/api/metrics'  opens  /api/metrics        (itself)
 *                            /api/metrics/live   (a child)
 *                     NOT    /api/metrics-internal
 *
 * An entry already ending in `/` is a declared prefix and keeps its meaning
 * unchanged, which is why `'/api/scim/'` behaves identically before and after.
 *
 * ## What this changed, measured
 *
 * Checked against all 461 route paths under `src/app`: **zero** real routes
 * lose public access. The predicate only ever NARROWS, and it narrows nothing
 * that exists — it closes the door on names nobody has used yet. Held by
 * `tests/guards/public-prefix-segment-boundary.test.ts`, which drives this
 * function and derives the real-route half from the filesystem.
 */
/**
 * A prefix match must end at a path separator. Query and fragment are NOT in
 * this set: `isPublicPath` strips them once, before either list is consulted,
 * so by the time a pathname reaches here it has neither. Handling them in two
 * places is what made `/login` unsafe to narrow — see `isPublicPath`.
 */
const PREFIX_BOUNDARY = new Set(['/']);

export function matchesPublicPrefix(pathname: string, prefix: string): boolean {
    if (!pathname.startsWith(prefix)) return false;
    // The prefix IS the whole path.
    if (pathname.length === prefix.length) return true;
    // An explicit trailing slash is a declared prefix; honour it verbatim.
    if (prefix.endsWith('/')) return true;
    // Otherwise the entry's last segment must END here — at a path separator,
    // or at a query/fragment delimiter. Anything else is a sibling that merely
    // shares a spelling.
    //
    // Query and fragment used to be boundaries here, to keep
    // `/login?next=/dashboard` public — the real login-redirect shape, pinned
    // in `tests/unit/guard.test.ts`. They are not any more, because
    // `isPublicPath` now strips them before consulting either list. That is
    // not a simplification for its own sake: a `Set` lookup cannot treat `?`
    // as a boundary, so while this predicate handled queries and
    // `PUBLIC_PATH_EXACT` did not, the two lists DISAGREED about them and no
    // entry could be narrowed from one to the other without silently changing
    // what it covers.
    return PREFIX_BOUNDARY.has(pathname[prefix.length]);
}

/**
 * Check if a pathname is public (should bypass auth).
 */
export function isPublicPath(pathname: string): boolean {
    // Strip query and fragment ONCE, here, so the three checks below cannot
    // disagree about them.
    //
    // They used to disagree. `matchesPublicPrefix` treated `?` as a segment
    // boundary and `PUBLIC_PATH_EXACT` is a `Set` lookup that cannot, so
    // `/login` was public WITH a query as a prefix entry and would have
    // become non-public the moment it was narrowed to an exact one —
    // redirecting an unauthenticated visitor to `/login?next=…` and then
    // gating the page they were sent to. `/reset-password?token=…` has the
    // same shape. Narrowing a claim should not depend on which list it sits
    // in, so the query comes off before either is consulted.
    //
    // This also makes a versioned asset public: `STATIC_EXTENSIONS` is
    // `$`-anchored, so `/logo.png?v=2` did not match it before and does now.
    // That is a widening, and a deliberate one — the un-queried form is
    // already public and Next serves the same file either way, so no new
    // resource becomes reachable.
    const path = stripQueryAndFragment(pathname);

    // Exact matches
    if (PUBLIC_PATH_EXACT.has(path)) return true;

    // Prefix matches, at a SEGMENT BOUNDARY — see `matchesPublicPrefix`.
    if (PUBLIC_PATH_PREFIXES.some((prefix) => matchesPublicPrefix(path, prefix))) return true;

    // Static file extensions
    if (STATIC_EXTENSIONS.test(path)) return true;

    return false;
}

/**
 * Check if a pathname is an API route.
 */
export function isApiRoute(pathname: string): boolean {
    return pathname.startsWith('/api/');
}

/**
 * Check if a pathname requires admin role.
 * Recognizes both flat and tenant-scoped admin paths.
 */
export function isAdminPath(pathname: string): boolean {
    // Flat: /admin, /api/admin
    if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) return true;
    // Tenant-scoped: /t/:slug/admin, /api/t/:slug/admin
    if (/^\/t\/[^/]+\/admin/.test(pathname)) return true;
    if (/^\/api\/t\/[^/]+\/admin/.test(pathname)) return true;
    return false;
}

/**
 * Check if a pathname is a tenant-scoped route.
 */
export function isTenantPath(pathname: string): boolean {
    return pathname.startsWith('/t/') || pathname.startsWith('/api/t/');
}

/**
 * PERSON-scoped paths: surfaces that belong to a human rather than to a farm.
 *
 * The third scope, alongside `isTenantPath` and `isOrgPath`. A request resolves
 * to one of the three, and these are the ones with no tenant in the URL at all:
 * a person's own account, their onboarding, and the social graph.
 *
 * ── it gates paths that mostly DO NOT EXIST YET, deliberately ──
 *
 * Measured 2026-10-02: of the four prefixes, only `/account/` has routes (6
 * files under `src/app/account/`). `/api/me/`, `/api/social/` and
 * `/onboarding/` have none. That is the intended order — the gate lands before
 * the routes, so a surface added later is behind it by default rather than
 * needing someone to remember. It also means the usual danger applies in
 * reverse: a test that relied on real routes existing would pass vacuously, so
 * `tests/unit/person-path-parity.test.ts` drives SYNTHETIC pathnames through
 * the real middleware and prints the population it covers.
 */
export function isPersonPath(pathname: string): boolean {
    return (
        pathname === '/account' ||
        pathname.startsWith('/account/') ||
        pathname === '/onboarding' ||
        pathname.startsWith('/onboarding/') ||
        pathname === '/api/me' ||
        pathname.startsWith('/api/me/') ||
        pathname === '/api/social' ||
        pathname.startsWith('/api/social/') ||
        // P1.6 (#1192) — `/api/account/**` joined the person population by
        // owner ruling 2026-10-13. It had been in NEITHER population: not a
        // tenant path, not a person path, so its seven routes (profile,
        // language, bottom-tabs, avatar, avatar/[userId], export, deletion)
        // took no Edge MFA gate and no read tier, relying entirely on
        // `getUserCtx` refusing an MFA-pending session at the handler.
        //
        // Defensible while it lasted — there is no PAGE under `/api/account/`,
        // and the Edge half's stated purpose was protecting pages — but it made
        // this predicate mean less than its name, which is the shape that
        // produced three gate-coverage findings in one day (#1652, #1665,
        // #1745). The handler half stays; this adds the Edge half.
        pathname === '/api/account' ||
        pathname.startsWith('/api/account/')
    );
}

/**
 * The SOCIAL half of the person paths — the part an operator-only user is kept
 * out of.
 *
 * Owner ruling, 2026-10-02: the MECHANISATOR lockdown does NOT extend to a
 * field operator's own account. The lockdown exists to keep a shared field
 * device off the FARM's data, not off the person's own identity, and blocking
 * `/account/` would mean an operator could never change their own password.
 * So `/account/` and `/onboarding/` stay open to them and the social graph does
 * not.
 *
 * `/social/` (the web surface) is listed although no such route exists yet, for
 * the same gate-before-routes reason as `isPersonPath`. Adding the page later
 * must not silently open it to a persona confined to one screen.
 */
export function isOperatorBlockedPersonPath(pathname: string): boolean {
    return (
        pathname === '/api/social' ||
        pathname.startsWith('/api/social/') ||
        pathname === '/social' ||
        pathname.startsWith('/social/')
    );
}

/** Which half of the person scope a path belongs to. */
export type PersonSurface = 'account' | 'social';

/**
 * Classify a person path. Shared by the Edge gate and `getUserCtx` so the two
 * enforcement points cannot drift into disagreeing about what "social" means.
 */
export function personSurfaceOf(pathname: string): PersonSurface {
    return isOperatorBlockedPersonPath(pathname) ? 'social' : 'account';
}

/**
 * Check if a pathname is an org-scoped route.
 *
 * Mirror of `isTenantPath` for the hub-and-spoke organization layer.
 * Used by the middleware-level org-access gate (GAP O4-1) to decide
 * whether to apply the JWT-bound org membership check on top of the
 * existing layout/page/API guards.
 */
export function isOrgPath(pathname: string): boolean {
    return pathname.startsWith('/org/') || pathname.startsWith('/api/org/');
}

/**
 * Check if a path should remain accessible when MFA is pending.
 * These routes are allowed so users can complete MFA enrollment/challenge.
 */
export function isMfaAllowedPath(pathname: string): boolean {
    // MFA challenge page and enrollment API routes
    if (/^\/t\/[^/]+\/auth\/mfa/.test(pathname)) return true;
    if (/^\/api\/t\/[^/]+\/security\/mfa/.test(pathname)) return true;
    // The enrolment PAGE, and this was a lockout until it was added.
    //
    // Under a REQUIRED policy a member who has never enrolled gets a pending
    // session, so §4 sends them to `/t/:slug/auth/mfa`. That page's
    // not-enrolled branch offers one way out: a link to
    // `/t/:slug/security/mfa` (`mfa-go-enroll-btn`). That path was NOT
    // allowed here, so §4 bounced it straight back to `/auth/mfa` — and the
    // person could not enrol at all. Not on the web, and not through Google
    // or Microsoft in the phone's sign-in sheet either, which is where
    // #1646's `otpauth://` link lives. Only the admins the anti-lockout
    // check guarantees were unaffected.
    //
    // ANCHORED to the page itself, `/security/mfa` and not `/security/*`: a
    // pending session has an outstanding security control, and opening the
    // rest of the security area to it would be a far wider hole than the one
    // being closed. The page's own calls go to the `/api/t/:slug/security/mfa`
    // routes already allowed above.
    //
    // Safe because enrolling does NOT clear the gate: `mfaPending` falls only
    // when `UserMfaEnrollment.lastChallengeAt >= token.iat`, and the
    // enrolment usecase never writes `lastChallengeAt` (verified: zero
    // occurrences in `mfa-enrollment.ts`). So somebody who enrols a fresh
    // authenticator must still complete a challenge afterwards, and cannot
    // use this door to skip one. Found by agrent-ios on #1649.
    if (/^\/t\/[^/]+\/security\/mfa\/?$/.test(pathname)) return true;
    // Auth callbacks (sign-out, etc.)
    if (pathname.startsWith('/api/auth/')) return true;
    return false;
}

/**
 * Paths an UNCONSENTED session may still reach (P3.1).
 *
 * The consent gate holds a signed-in user whose `acceptedTermsAt` is null.
 * Three classes have to stay open or the hold becomes a trap:
 *
 *   1. the consent page and the route that records the acceptance — the way
 *      OUT of the hold;
 *   2. `/terms` and `/privacy` — you cannot ask somebody to accept a document
 *      they are not allowed to read, and these are public anyway, so this is
 *      belt-and-braces for a signed-in reader;
 *   3. `/api/auth/` — sign-out above all. A user who declines must be able to
 *      leave rather than be stuck between a gate and a session they cannot
 *      drop. This is the same carve-out `isMfaAllowedPath` makes, for the
 *      same reason.
 *
 * The MFA challenge paths are also exempt, which is ORDERING rather than
 * generosity: MFA is a security control and consent is a compliance record,
 * so a session with an outstanding second factor must clear that first. The
 * middleware runs the MFA gate before this one; exempting those paths here
 * keeps the two from deadlocking if that order is ever changed.
 */
export function isTermsAllowedPath(pathname: string): boolean {
    if (pathname === '/accept-terms') return true;
    if (pathname === '/api/auth/accept-terms') return true;
    // The two ways OUT, exempt for the same reason `/api/auth/accept-terms` is
    // (#1192, P1.6). Widening `isPersonPath` to `/api/account/**` brought those
    // routes under this gate for the first time, and without these two entries
    // it would have introduced a regression rather than a control: a person who
    // reads the terms and DECLINES could no longer delete the account that was
    // created for them, nor take a copy of their data.
    //
    // That is conditioning Art 17 erasure and Art 15 access on accepting the
    // terms, which is backwards — and it is a NEW refusal, because before the
    // widening the terms gate never reached these paths at all. The slow-mode
    // escape rule in reverse: the route out must never be behind the thing it
    // lets you escape.
    if (pathname === '/api/account/deletion') return true;
    if (pathname === '/api/account/export') return true;
    if (pathname === '/terms' || pathname === '/privacy') return true;
    if (pathname === '/dsa-contact') return true;
    if (pathname.startsWith('/api/auth/')) return true;
    // MFA first — see the ordering note above.
    if (isMfaAllowedPath(pathname)) return true;
    return false;
}

/**
 * Re-exported so every existing caller keeps ONE implementation.
 *
 * The body moved to `./safe-redirect` because this module imports
 * `next/server`, which a client component cannot pull in — and the MFA
 * challenge page, a client component, is exactly where an unsanitised `next`
 * was being navigated to.
 */
export { sanitizeRedirectPath };

/**
 * Build a login redirect URL with a safe 'next' parameter.
 */
export function buildLoginRedirect(
    baseUrl: string,
    pathname: string
): URL {
    const loginUrl = new URL('/login', baseUrl);
    const safeNext = sanitizeRedirectPath(pathname);
    if (safeNext !== '/') {
        loginUrl.searchParams.set('next', safeNext);
    }
    return loginUrl;
}

/**
 * Return a 401 Unauthorized JSON response for API routes.
 */
export function unauthorizedJson(): NextResponse {
    return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
    );
}

/**
 * The reason a 403 was returned, as a code a client can switch on.
 *
 * Closed union rather than `string`, because the value is the half of the
 * response a client is meant to BRANCH on: a typo in a free-form reason is a
 * 403 nobody can handle, and it fails at the call site rather than on a phone.
 * `FORBIDDEN` is the unparameterised default and carries no meaning beyond
 * "refused" — reach for it only when none of the others fits, and add a member
 * instead if the case recurs.
 */
export type ForbiddenCode =
    | 'ADMIN_REQUIRED'
    | 'CSRF_BLOCKED'
    | 'MFA_REQUIRED'
    | 'TERMS_ACCEPTANCE_REQUIRED'
    | 'FORBIDDEN';

/**
 * Return a 403 Forbidden JSON response in the canonical error envelope.
 *
 * ## Why the shape changed
 *
 * This used to answer `{ error: '<English sentence>' }`. Every other 4xx in
 * this API answers `{ error: { code, message } }` via `toApiErrorResponse`, so
 * the middleware's 403s were the one family a client could not switch on — and
 * agrent-ios reported accepting BOTH shapes to cope, which is a client paying
 * for a server inconsistency (#1391).
 *
 * The sentence was also the only thing distinguishing the four refusals, so
 * telling "you are not an admin" from "your session needs MFA" meant matching
 * English prose. A client that did so would break on a copy edit; a client
 * that did not could only say "forbidden".
 *
 * ## The contract
 *
 * `code` is for the client. `message` stays an English developer-facing
 * fallback and is NOT translated — these four are reached by a client that
 * should render its own localised copy keyed on `code`, and a half-localised
 * sentence from the server is worse than an obviously-English one. The status
 * stays **403** for all four: nothing here is a 401, because the caller IS
 * authenticated and is being refused.
 *
 * Note the sibling `unauthorizedJson` still answers a bare string. That is
 * deliberate scope, not an oversight — it is a 401 with exactly one cause, so
 * there is nothing to switch on. If a second cause ever appears it wants this
 * treatment too.
 */
export function forbiddenJson(code: ForbiddenCode, message: string): NextResponse {
    return NextResponse.json(
        { error: { code, message } },
        { status: 403 }
    );
}

/**
 * Extract the tenant slug from a tenant-scoped URL path.
 *
 * Handles both:
 *   /t/:slug/...           → slug
 *   /api/t/:slug/...       → slug
 *
 * Returns null for any path that is not tenant-scoped.
 */
export function extractTenantSlugFromPath(pathname: string): string | null {
    // /t/:slug/...  or  /t/:slug (trailing-slash-less)
    const webMatch = pathname.match(/^\/t\/([^/]+)(?:\/|$)/);
    if (webMatch) return webMatch[1];

    // /api/t/:slug/...
    const apiMatch = pathname.match(/^\/api\/t\/([^/]+)(?:\/|$)/);
    if (apiMatch) return apiMatch[1];

    return null;
}

/**
 * Pure gate function: check whether a user's memberships array allows access
 * to the given path. Extracted as a pure function so it can be unit-tested
 * without Next.js framework machinery.
 *
 * R-1: `memberships` replaces the old single-slug `jwtTenantSlug` parameter.
 * A user is allowed through to `/t/:slug/...` if ANY of their memberships
 * contains a matching slug.
 *
 * Returns:
 *   'allow'             — pass through
 *   'no_tenant_access'  — authed user has no tenant memberships at all
 *   'cross_tenant'      — the URL slug is not in any of the user's memberships
 *
 * `membershipsTruncated` — set when the JWT carries only a capped subset
 * of the user's memberships (see `MAX_JWT_MEMBERSHIPS` in `auth.ts`). A
 * slug-miss is then NOT definitive — the slug may be a membership that
 * did not fit — so the gate returns 'allow' and lets the authoritative,
 * DB-backed server-side check (`TenantLayout` / `getTenantCtx`) decide.
 * This is safe because the middleware gate is the early-rejection layer,
 * never the sole authority.
 */
export type TenantGateResult = 'allow' | 'no_tenant_access' | 'cross_tenant';

export function checkTenantAccess(
    pathname: string,
    memberships: ReadonlyArray<{ slug: string }> | null | undefined,
    membershipsTruncated = false,
): TenantGateResult {
    // Only gate tenant-scoped routes.
    const urlSlug = extractTenantSlugFromPath(pathname);
    if (!urlSlug) return 'allow';

    // Public paths that should always pass (e.g. MFA challenge within a tenant URL).
    // Already checked upstream in isPublicPath, but be defensive.
    if (isPublicPath(pathname)) return 'allow';

    // An empty list is unambiguous — a truncated list is never empty, so
    // this genuinely means the user holds no memberships.
    if (!memberships || memberships.length === 0) return 'no_tenant_access';

    if (!memberships.some((m) => m.slug === urlSlug)) {
        // Slug not in the (possibly capped) list. If capped, defer to
        // the server-side gate rather than redirect a legitimate member.
        return membershipsTruncated ? 'allow' : 'cross_tenant';
    }
    return 'allow';
}

/**
 * MECHANISATOR operator lockdown — is this tenant-scoped path one the
 * restricted machine-operator persona is allowed to reach? Everything else
 * is redirected to `/t/{slug}/my-work` (pages) or 403'd (APIs) by the
 * middleware. Extracted pure so the allowlist is unit-testable without the
 * Edge runtime. The middleware wires the NextResponse branches, and those are
 * covered by `tests/unit/operator-lockdown-enforced.test.ts`, which imports the
 * real middleware export at `:98`.
 *
 * This sentence previously read "E2E covers those". It never did — a grep for
 * MECHANISATOR across `tests/e2e/` returns nothing, and always would have. The
 * 2026-08-19 enforcement-seam audit named this docblock as one of three
 * asserting coverage that did not exist, and called them a principal reason
 * fifteen unenforced seams went unnoticed.
 *
 * Allowed:
 *   - Pages: the "My work" screen, the field-operation completion flow, the
 *     fields/locations map (where the sprayer sees where to spray), and the
 *     offline-diagnostics instrument at `/diagnostics/offline` (#812) — the
 *     operator's own phone is the one this page measures, so locking them out
 *     of it put the instrument out of reach of its subject. Matched EXACTLY,
 *     not by `/diagnostics/` prefix.
 *   - APIs: the queue (`farm-tasks`), the field-operation data + parcel
 *     marking (`field-operations`), task status changes (`tasks`), the
 *     locations data + map tiles (`locations`), and vegetation-index tile
 *     overlays (`agro`). All read-only beyond the assignee-completion path.
 *
 * `slug` is the tenant slug already parsed from the path.
 */
export function isOperatorAllowedPath(pathname: string, slug: string): boolean {
    if (pathname.startsWith('/api/')) {
        // farm-tasks / field-operations / tasks — the queue + completion.
        // locations — the fields map the sprayer needs on the job (list,
        //   detail, parcels, basemap tiles all live under /locations/*).
        // agro — vegetation-index tile overlays (NDVI/NDMI/…) rendered on
        //   that map. All read-only; write attempts still hit the canWrite gate.
        return /^\/api\/t\/[^/]+\/(farm-tasks|field-operations|tasks|locations|agro)(\/|$|\?)/.test(pathname);
    }
    return (
        pathname === `/t/${slug}/my-work` ||
        pathname.startsWith(`/t/${slug}/my-work/`) ||
        pathname.startsWith(`/t/${slug}/field/`) ||
        // The fields/locations page — where the sprayer sees where to spray.
        pathname === `/t/${slug}/locations` ||
        pathname.startsWith(`/t/${slug}/locations/`) ||
        // The offline-diagnostics instrument (#812). EXACT match, deliberately
        // NOT `startsWith('/t/<slug>/diagnostics/')`: `diagnostics` is a
        // namespace, and a future sibling under it inherits nothing from this
        // decision. Widening a lockdown by prefix grants access to routes that
        // do not exist yet and were never considered.
        //
        // Why the operator of all personas: MECHANISATOR is the FIELD user —
        // the one who works with no signal, queues journal entries and photos
        // into the IndexedDB outbox, and therefore actually suffers the storage
        // eviction this page measures. Everyone who could already open it is an
        // admin somewhere with a connection.
        pathname === `/t/${slug}/diagnostics/offline` ||
        pathname === `/t/${slug}/diagnostics/offline/`
    );
}

// ── Org-route gate (mirror of the tenant gate) ───────────────────────

/**
 * Extract the org slug from `/org/:slug/...` or `/api/org/:slug/...`.
 * Returns null for any path that is not org-scoped.
 */
export function extractOrgSlugFromPath(pathname: string): string | null {
    const webMatch = pathname.match(/^\/org\/([^/]+)(?:\/|$)/);
    if (webMatch) return webMatch[1];

    const apiMatch = pathname.match(/^\/api\/org\/([^/]+)(?:\/|$)/);
    if (apiMatch) return apiMatch[1];

    return null;
}

/**
 * Pure gate: check whether a user's `orgMemberships` allows access to
 * an `/org/:slug/...` or `/api/org/:slug/...` path. Same shape as
 * `checkTenantAccess` so the middleware can route both gates through
 * a parallel branch.
 *
 * Returns:
 *   'allow'           — pass through
 *   'no_org_access'   — authed user has no org memberships at all
 *   'cross_org'       — the URL slug is not in any of the user's org memberships
 *
 * Anti-enumeration: middleware MUST collapse both `no_org_access` and
 * `cross_org` to the SAME external response (404 / no-tenant). The
 * distinction exists for log/metric tagging, not for the user.
 *
 * `orgMembershipsTruncated` — same contract as `checkTenantAccess`'s
 * `membershipsTruncated`: a slug-miss against a capped list defers to
 * the authoritative server-side org gate instead of denying.
 */
export type OrgGateResult = 'allow' | 'no_org_access' | 'cross_org';

export function checkOrgAccess(
    pathname: string,
    orgMemberships: ReadonlyArray<{ slug: string }> | null | undefined,
    orgMembershipsTruncated = false,
): OrgGateResult {
    const urlSlug = extractOrgSlugFromPath(pathname);
    if (!urlSlug) return 'allow';

    if (isPublicPath(pathname)) return 'allow';

    if (!orgMemberships || orgMemberships.length === 0) return 'no_org_access';

    if (!orgMemberships.some((m) => m.slug === urlSlug)) {
        return orgMembershipsTruncated ? 'allow' : 'cross_org';
    }
    return 'allow';
}

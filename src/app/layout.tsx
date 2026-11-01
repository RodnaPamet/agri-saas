import type { Metadata, Viewport } from 'next';
import { auth } from '@/auth';
import { ClientDataRetentionSweep } from '@/components/offline/ClientDataRetentionSweep';
import { cookies, headers } from 'next/headers';
import {
    THEME_COOKIE,
    attributesFor,
    isThemeName,
    prePaintThemeScript,
} from '@/lib/theme/theme-cookie';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { preloadFaces } from '@/lib/fonts/preload';
import { Providers } from './providers';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { ServiceWorkerRegistrar } from '@/components/pwa/ServiceWorkerRegistrar';
import {
    PUBLIC_SURFACE_HEADER,
    publicSurfaceMessages,
} from '@/lib/i18n/public-surface';
import { AUTH_SURFACE_HEADER } from '@/lib/i18n/auth-surface';
import { WebVitalsReporter } from '@/components/pwa/WebVitalsReporter';
import { CSP_NONCE_HEADER } from '@/lib/security/csp';
import './globals.css';

export const metadata: Metadata = {
    title: 'Agrent — The agriculture agent',
    description: 'Agrent — the agriculture agent: spray prescriptions, parcel maps, and field operations for the farm.',
    // Operator PWA — installable field-ops client (queue-and-sync).
    manifest: '/manifest.webmanifest',
    appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Agrent' },
    // iOS ignores SVG manifest icons — it needs a PNG apple-touch-icon for the
    // home-screen. Rendered from the Agrent seedling mark (public/icon.svg).
    icons: {
        icon: '/icon.svg',
        apple: '/apple-touch-icon.png',
    },
};

/**
 * R11-PR9 — explicit viewport metadata. Next.js no longer emits a
 * default viewport meta starting in 14.x, so any layout that wants
 * sane mobile rendering must declare it. Locked here at the root so
 * every page inherits the same width=device-width + initial-scale=1
 * baseline. `maximumScale: 5` keeps user-pinch-zoom intact (an
 * accessibility requirement — never set 1 unless the design has
 * truly tested at every viewport).
 */
export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 5,
    viewportFit: 'cover',
    // Installed-PWA chrome (status bar) tracks the active theme so the
    // browser/OS chrome matches the app surface instead of a fixed accent.
    // The colours are the two `--bg-page` token values: warm off-white in
    // light, deepest forest green in dark (src/styles/tokens.css). `media`
    // lets the platform pick per the OS colour-scheme preference. Keep
    // these in lockstep with `--bg-page` — a stale value here paints the
    // OS status bar a colour the app no longer uses.
    themeColor: [
        { media: '(prefers-color-scheme: light)', color: '#F4F2ED' },
        { media: '(prefers-color-scheme: dark)', color: '#05231B' },
    ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
    const locale = await getLocale();
    const allMessages = await getMessages();
    const requestHeaders = await headers();
    const nonce = requestHeaders.get(CSP_NONCE_HEADER) ?? undefined;

    /**
     * P6.4 (#1813) — what an ANONYMOUS visitor is sent.
     *
     * `NextIntlClientProvider` serialises whatever `messages` it is given into
     * the RSC payload. Re-measured 2026-10-15: the full Bulgarian catalogue
     * SERIALISES to 272,298 bytes across 93 namespaces, and `/f/[handle]`
     * needs 314 of them — 0.12%. A stranger opening a farm page was
     * downloading every string of a product they have no account for, to
     * render three.
     *
     * Serialised, not the file's byte count — `messages/bg.json` is 491,803
     * bytes on disk with its 4-space indentation, and the indentation never
     * reaches the payload. The earlier figure here ("475 bytes instead of
     * 404,981") reproduced as neither, which is how a number measured one way
     * and compared another rots while the claim it supports stays true. The
     * ratio is now DERIVED by
     * `tests/guards/public-surface-i18n-complete.test.ts` rather than restated
     * here, so a namespace added to the public list fails a test instead of
     * making this comment wrong.
     *
     * On P6.5's budget of LCP <= 2.5s over rural mobile data, that payload is
     * the difference between the target being reachable and not.
     *
     * The flag comes from the middleware, because a layout cannot see the
     * pathname — the same request-header bridge the CSP nonce uses. An ABSENT
     * header means the operator app and the full catalogue, which is the safe
     * default: a missing header costs bytes, where a wrongly-set one would
     * strip copy from a real screen.
     *
     * NOT a file split. The phase's checklist says to split the catalogues and
     * this is deliberately not that — passing a subset buys the same bytes
     * without touching either file, so the pre-commit parity check that
     * compares them key-for-key keeps working. See
     * `src/lib/i18n/public-surface.ts`.
     */
    const isPublic = requestHeaders.get(PUBLIC_SURFACE_HEADER) === '1';
    /**
     * The SIGN-IN surface, from the header the middleware sets (#2099). Same
     * bridge as `isPublic` above, and for the same reason: only the middleware
     * config sees the pathname.
     *
     * Used to withhold the A2HS banner there — see `ServiceWorkerRegistrar`'s
     * prop for the two faults that caused. An ABSENT header means the operator
     * app, which is the safe default here too: the cost of being wrong is a
     * banner that does not appear, not one that appears mid sign-in.
     */
    const isAuthSurface = requestHeaders.get(AUTH_SURFACE_HEADER) === '1';
    const messages = isPublic ? publicSurfaceMessages(allMessages) : allMessages;

    /**
     * P2.4 — seed the theme attributes from a cookie so the FIRST paint is
     * already right.
     *
     * This was hard-coded `data-theme="dark"`, and `ThemeProvider` corrected it
     * from localStorage in a `useEffect` — which runs after the first paint. So
     * every `light` or `sunlight` user watched the dark palette render and then
     * flip. Not a race: a guaranteed flash on every shell render.
     *
     * The server cannot read localStorage, which is why this is a cookie. When
     * it is absent (a first visit) the inline script below settles it before
     * paint and writes the cookie, so the next request arrives server-correct.
     */
    const themeCookie = (await cookies()).get(THEME_COOKIE)?.value;
    const seeded = attributesFor(isThemeName(themeCookie) ? themeCookie : 'dark');

    // Resolve the signed-in user id for the SWR cache namespace.
    //
    // This layout is ALREADY dynamic (it awaits `headers()`), and `auth()`
    // here decodes the session cookie without a database round-trip — an
    // unauthenticated request has no cookie and returns null immediately.
    // Deliberately NOT a `<SessionProvider>`: that would add a client-side
    // `/api/auth/session` fetch on every page load, which is exactly what
    // the comment in `providers.tsx` explains was removed.
    //
    // The id only namespaces a cache key. It is not a credential and grants
    // nothing; the cost of getting it wrong is a cache miss, and the cost of
    // NOT having it is one operator's rows rendering for the next one on a
    // shared device.
    const sessionUserId = (await auth())?.user?.id ?? null;

    // #493 — the usage-telemetry switch, resolved HERE because there is no
    // client-side flags hook and adding one would be a second source of truth
    // for a kill switch. `isFeatureEnabled` is cohort-aware and an absent flag
    // row reads as false, so an un-provisioned deployment records nothing.
    const usageTelemetryEnabled = sessionUserId
        ? await isFeatureEnabled('usage.events', sessionUserId)
        : false;

    return (
        // Seeded from the theme cookie (see above), not pinned to dark. The
        // pre-paint script in <head> is what covers a first visit, where only
        // the browser knows `prefers-color-scheme`.
        <html
            lang={locale}
            data-theme={seeded.theme}
            {...(seeded.contrast ? { 'data-contrast': seeded.contrast } : {})}
            suppressHydrationWarning
        >
            <head>
                {/*
                    Preload the BODY face so first text paint does not wait for
                    the stylesheet to be parsed before the font request starts
                    (#796). Derived from `fonts.lock.json`, never hardcoded:
                    `vendor-fonts.mjs` names files from the css2 response, so an
                    upstream subset change RENAMES them and a stale href would
                    preload a 404 — costing a request, warming nothing, and
                    invisible on screen because `font-display: swap` paints the
                    fallback either way.

                    Only Inter, and only the subsets this locale can render:
                    the 17 vendored files are 431,792 B, so preloading them all
                    would be strictly worse than preloading none. Onest and Bricolage
                    fall back to Inter, which is preloaded.

                    NO nonce attribute HERE, deliberately. A font preload is
                    governed by `font-src`, not `script-src`, so it does not
                    need one — and adding one would shift the text window that
                    `tests/guards/csp-webpack-nonce-bridge-hydration.test.ts`
                    scans, reddening that guard for a reason unrelated to fonts.

                    (That guard finds its window by searching this file for two
                    literal tokens. An earlier draft of THIS COMMENT quoted both
                    verbatim to explain the hazard, which moved the window onto
                    the comment itself and failed the guard — prose and data
                    sharing one channel. They are described here, not quoted.)

                    `crossOrigin` is required even same-origin: fonts are
                    fetched in CORS mode, and a preload whose mode differs from
                    the real request is fetched twice.
                */}
                {preloadFaces(locale).map((face) => (
                    <link
                        key={face.href}
                        rel="preload"
                        as="font"
                        type="font/woff2"
                        href={face.href}
                        crossOrigin="anonymous"
                    />
                ))}
                {/*
                    2026-05-14 — CSP `strict-dynamic` + webpack chunk
                    loader bridge. Next.js auto-applies the request
                    nonce to its server-rendered `<script>` and
                    `<link>` tags, but DYNAMICALLY-loaded webpack
                    chunks (Next's `chunks/*.js` for code-split
                    components like the R16 visx/motion charts) are
                    injected at runtime via `document.createElement
                    ('script')`. Those don't inherit the nonce
                    automatically — they need webpack to set
                    `script.nonce` at injection time, which webpack
                    does only when `__webpack_nonce__` is defined.
                    Setting it on `window` (and `globalThis` for
                    completeness in stricter runtimes) BEFORE any
                    chunk loads kicks in is what unblocks
                    strict-dynamic for the chart code.

                    The script itself carries the nonce so CSP
                    allows it. Inline content is deterministic
                    (just `var __webpack_nonce__ = '<nonce>';`),
                    no user input — no XSS surface beyond the
                    nonce itself (which is per-request +
                    cryptographically random).
                */}
                {nonce && (
                    /*
                        2026-05-27 — `suppressHydrationWarning` is
                        LOAD-BEARING. Browsers strip the `nonce`
                        attribute from DOM elements AFTER CSP
                        processing (HTML spec — `nonce` is a one-
                        time secret that must never be readable
                        from JavaScript). React's hydration then
                        compares the SSR-emitted `nonce="…"` to the
                        client-visible `nonce=""` and emits a noisy
                        console error: "tree hydrated but some
                        attributes didn't match. This won't be
                        patched up."
                        Hydration itself succeeds (the bridge sets
                        `__webpack_nonce__` before any chunk
                        loads), but headless QA tools that abort on
                        the first console error misinterpret this
                        as a hard hydration failure — see the
                        2026-05-25 QA pass that marked Sidebar /
                        Forms / Mobile sections as BLOCKED due to
                        "JS hydration failure".
                        `suppressHydrationWarning` is the canonical
                        React fix (https://react.dev/link/
                        hydration-mismatch). It tells React: "this
                        attribute will legitimately differ between
                        server and client — don't warn." Zero CSP
                        change; nonce stays applied for browser
                        enforcement.
                    */
                    <script
                        nonce={nonce}
                        suppressHydrationWarning
                        dangerouslySetInnerHTML={{
                            __html: `window.__webpack_nonce__=${JSON.stringify(nonce)};globalThis.__webpack_nonce__=${JSON.stringify(nonce)};`,
                        }}
                    />
                )}
                {/*
                    P2.4 — theme, before the first paint.

                    Placed AFTER the bridge above on purpose. The guard at
                    `tests/guards/csp-webpack-nonce-bridge-hydration.test.ts`
                    finds that script by slicing between two literal markers in
                    this file, and anything carrying the same opening marker
                    earlier would move its window. This file already records a
                    case where a COMMENT quoting those markers moved it, so they
                    are described here rather than written out.

                    Still in <head>, so it runs before the body paints. It
                    agrees with the server's seed in the common case — same
                    cookie, same answer, no attribute change, no repaint — and
                    only does real work on a first visit.
                */}
                <script
                    nonce={nonce}
                    suppressHydrationWarning
                    dangerouslySetInnerHTML={{ __html: prePaintThemeScript() }}
                />
            </head>
            <body suppressHydrationWarning nonce={nonce}>
                <NextIntlClientProvider messages={messages} locale={locale}>
                    {/*
                        ── The public surface gets almost none of this (#1872) ──

                        `/f/{handle}` is a page a stranger opens from a shared
                        link. It is a pure server component rendering a heading
                        and five short text fields, and it was mounting the
                        entire app's client tree: a ⌘K command palette, the
                        shortcut help overlay, a toaster nothing emits into,
                        form telemetry with no forms, view transitions,
                        `SWRPersistenceProvider` handed a `userId` that is
                        undefined, a cache-retention sweep for a device with
                        nothing cached, and an offer to install a
                        farm-management PWA.

                        That is a correctness problem before it is a
                        performance one — ⌘K on a farm's public page opened the
                        application's search. It is also the measured lever for
                        P6.5's missed LCP target: #1866 put the page at 3635 ms
                        against a 2500 ms goal, with TBT 380 ms on output that
                        is a heading and five fields, so the cost was
                        JavaScript.

                        `isPublic` comes from the header middleware sets
                        (#1842) and already chose the slim message catalog
                        above; this is the same decision applied to the
                        component tree.

                        ThemeProvider is NOT needed here, which is worth
                        stating because it looks like it should be: the page
                        uses theme tokens, and `prePaintThemeScript()` in
                        <head> stamps `data-theme` on the documentElement
                        before first paint. The provider exists for runtime
                        toggling and localStorage sync, and the public page has
                        no theme control.

                        WebVitalsReporter STAYS. It needs no provider — a
                        `useEffect` and a dynamic `web-vitals` import that
                        never lands in the initial bundle — and dropping field
                        data from the one page with a performance budget would
                        be a strange trade while chasing that budget.
                    */}
                    <WebVitalsReporter />
                    {isPublic ? (
                        children
                    ) : (
                        <>
                            {/*
                                ServiceWorkerRegistrar renders <InstallPrompt
                                />, which must sit INSIDE
                                NextIntlClientProvider now that it calls
                                useTranslations. When it lived outside the
                                provider the T04 i18n migration 500'd every
                                page with "NextIntlClientProvider context not
                                found". Same provider-boundary rule as the
                                global overlays inside <Providers>.
                            */}
                            <ServiceWorkerRegistrar showInstallPrompt={!isAuthSurface} />
                            {/*
                                Bounds how long this device keeps cached farm
                                data — field snapshots and SWR buckets that
                                otherwise live forever, plus the tenant Cache
                                Storage buckets. Scoped to CACHES only: it
                                never touches the outbox, so it cannot lose
                                unsynced work or race the flush loop. See
                                src/lib/offline/client-data-retention.ts.
                            */}
                            <ClientDataRetentionSweep />
                            <Providers
                            userId={sessionUserId}
                            isAuthSurface={isAuthSurface}
                            usageTelemetryEnabled={usageTelemetryEnabled}
                        >
                                {children}
                            </Providers>
                        </>
                    )}
                </NextIntlClientProvider>
            </body>
        </html>
    );
}

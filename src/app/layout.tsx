import type { Metadata, Viewport } from 'next';
import { auth } from '@/auth';
import { ClientDataRetentionSweep } from '@/components/offline/ClientDataRetentionSweep';
import { headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { preloadFaces } from '@/lib/fonts/preload';
import { Providers } from './providers';
import { ServiceWorkerRegistrar } from '@/components/pwa/ServiceWorkerRegistrar';
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
    const messages = await getMessages();
    const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

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

    return (
        // `data-theme="dark"` seeds the SSR markup so the first paint matches
        // the baseline palette. ThemeProvider rehydrates from localStorage /
        // prefers-color-scheme on the client and flips the attribute if needed.
        <html lang={locale} data-theme="dark" suppressHydrationWarning>
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

                    Only Inter, and only the subsets this locale can render: all
                    72 faces are 1.9 MB, so preloading them all would be
                    strictly worse than preloading none. Onest and Bricolage
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
            </head>
            <body suppressHydrationWarning nonce={nonce}>
                <NextIntlClientProvider messages={messages} locale={locale}>
                    {/*
                        ServiceWorkerRegistrar renders <InstallPrompt />, and
                        WebVitalsReporter is a client component — both must sit
                        INSIDE NextIntlClientProvider now that InstallPrompt
                        (and any future PWA chrome) calls useTranslations. When
                        they lived outside the provider the T04 i18n migration
                        500'd every page with "NextIntlClientProvider context
                        not found" at InstallPrompt. Same provider-boundary
                        rule as the global overlays inside <Providers>.
                    */}
                    <ServiceWorkerRegistrar />
                    <WebVitalsReporter />
                    {/*
                        Bounds how long this device keeps cached farm data —
                        field snapshots and SWR buckets that otherwise live
                        forever, plus the tenant Cache Storage buckets. Scoped
                        to CACHES only: it never touches the outbox, so it
                        cannot lose unsynced work or race the flush loop. See
                        src/lib/offline/client-data-retention.ts.
                    */}
                    <ClientDataRetentionSweep />
                    <Providers userId={sessionUserId}>
                        {children}
                    </Providers>
                </NextIntlClientProvider>
            </body>
        </html>
    );
}

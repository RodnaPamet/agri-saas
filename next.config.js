const createNextIntlPlugin = require('next-intl/plugin');

// Bump EventEmitter cap before Next loads any HTTP/socket modules so the
// undici keep-alive socket pool doesn't trigger spurious
// MaxListenersExceededWarning lines for per-socket
// unpipe/error/close/finish listeners that accumulate across pooled
// requests. Set here (not in src/instrumentation.ts) because the dev
// server starts listening on the port before instrumentation.ts runs,
// so sockets created during early bootstrap miss the bump otherwise.
require('node:events').EventEmitter.defaultMaxListeners = Math.max(
    require('node:events').EventEmitter.defaultMaxListeners ?? 10,
    50,
);

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');

const defaultOptions = {
    // GAP-05 — Next 15 promoted `serverComponentsExternalPackages`
    // out of `experimental` and renamed it to `serverExternalPackages`.
    // The list itself is unchanged from the v14 era; these packages
    // use native deps (worker_threads, native HTTP clients, dynamic
    // require) that don't survive Next's webpack bundling.
    serverExternalPackages: [
        'pdfkit',
        // Pino & transports — use native worker_threads / dynamic require
        'pino',
        'pino-pretty',
        'thread-stream',
        // OpenTelemetry — heavy native instrumentation modules
        '@opentelemetry/api',
        '@opentelemetry/resources',
        '@opentelemetry/sdk-trace-node',
        '@opentelemetry/sdk-metrics',
        '@opentelemetry/exporter-trace-otlp-http',
        '@opentelemetry/exporter-metrics-otlp-http',
        '@opentelemetry/semantic-conventions',
        // Sentry — optional error reporting
        '@sentry/nextjs',
        '@sentry/node',
        // AWS SDK — native HTTP client, credential resolution
        '@aws-sdk/client-s3',
        '@aws-sdk/s3-request-presigner',
        // Google Earth Engine — server-only NDVI tile generation; the
        // client bundles a large XMLHttpRequest/auth runtime that must
        // never reach the browser bundle.
        '@google/earthengine',
    ],
    experimental: {
        // Client Router Cache stale times (Next 15+). The hot app routes are
        // `force-dynamic` (per-tenant auth + URL filters), so their default
        // client-cache stale time is 0 — every back/forward or re-navigation
        // re-runs the full server render (~0.5s "not instant" feel). Holding
        // the prefetched / visited dynamic RSC in the client router cache for
        // 30s lets a re-navigation render from cache (instant), while the
        // Epic-69 SWR layer still revalidates the DATA on mount/focus so the
        // list is never more than one fetch stale. Paired with `prefetch` on
        // the sidebar nav links (nav-item.tsx) so the first click is served
        // from cache too, not just repeat visits.
        staleTimes: {
            dynamic: 30,
            static: 180,
        },
        // optimizePackageImports remains experimental in Next 15.
        optimizePackageImports: [
            'lucide-react',
            '@tanstack/react-query',
        ],
    },
    async headers() {
        return [
            {
                // Self-hosted web fonts (#779). Content-hashed by the vendor
                // script's lock rather than by filename, so `immutable` is a
                // claim about the FILE not the URL — a font swap changes the
                // lock, which changes the bytes under the same path. That is
                // acceptable because a swap is a deliberate, reviewed act (the
                // lock refuses to move without `--write-lock`) and a stale
                // cached face renders correctly, just as the previous version.
                //
                // Cross-origin Google Fonts got their caching from Google.
                // Same-origin means we own it — and it is what makes the files
                // cacheable by `public/sw.js` at all, which is the offline win
                // this change is really for.
                source: '/fonts/:path*',
                headers: [
                    {
                        key: 'Cache-Control',
                        value: 'public, max-age=31536000, immutable',
                    },
                ],
            },
            {
                // Apply these headers to all routes globally.
                // NOTE: Content-Security-Policy is set dynamically in middleware.ts
                // (per-request nonce) and is NOT included here.
                source: '/(.*)',
                headers: [
                    {
                        key: 'X-Content-Type-Options',
                        value: 'nosniff',
                    },
                    {
                        key: 'Referrer-Policy',
                        value: 'strict-origin-when-cross-origin',
                    },
                    {
                        key: 'X-Frame-Options',
                        value: 'DENY',
                    },
                    {
                        key: 'Permissions-Policy',
                        // geolocation=(self) so the operator parcel map's
                        // "locate me" / live-tracking (navigator.geolocation)
                        // works on our own origin; camera/microphone stay
                        // closed (photo capture uses file-input `capture`).
                        value: 'camera=(), microphone=(), geolocation=(self), browsing-topics=()',
                    },
                    {
                        key: 'Cross-Origin-Opener-Policy',
                        value: 'same-origin',
                    },
                    {
                        key: 'Cross-Origin-Resource-Policy',
                        value: 'same-origin',
                    },
                    {
                        // Note: Only add max-age and preload if you guarantee HTTPS.
                        key: 'Strict-Transport-Security',
                        value: process.env.NODE_ENV === 'production' 
                            ? 'max-age=31536000; includeSubDomains; preload' 
                            : 'max-age=0',
                    },
                ],
            },
        ];
    },
};

/** @type {import('next').NextConfig} */
const nextConfig = {
    ...defaultOptions,
    // Use a separate build directory for E2E tests to avoid .next cache
    // contention when multiple dev servers run concurrently.
    ...(process.env.NEXT_TEST_MODE ? { distDir: '.next-test' } : {}),
    eslint: {
        // Lint runs separately in CI (npm run lint). Don't block builds.
        ignoreDuringBuilds: true,
    },
    typescript: {
        // TS errors are checked separately. Don't block production builds.
        ignoreBuildErrors: true,
    },
};
module.exports = withNextIntl(nextConfig);

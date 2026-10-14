import type { MetadataRoute } from 'next';

import { getAppBaseUrl } from '@/lib/auth/app-base-url';

/**
 * `robots.txt` (P6.5, #1814).
 *
 * The first one this deployment has had. Until now there was no public surface
 * to crawl, so its absence meant "crawl whatever you can reach" — which was
 * harmless only because everything worth reaching required a session.
 * `/f/[handle]` changes that, so the file now has something to say.
 *
 * ## It DISALLOWS rather than allows, and the list is the authenticated app
 *
 * A crawler that reaches `/t/{slug}/dashboard` gets a redirect to the login
 * page, so nothing leaks either way. The reason to disallow it anyway is
 * budget and noise: a crawler following links into the authenticated tree
 * spends its allowance on redirects and fills the server's logs with requests
 * that can never succeed.
 *
 * `/api/` is disallowed for the same reason plus one more — an API answering
 * JSON to a crawler is a page in nobody's index and an entry in everybody's
 * rate limit.
 *
 * ## It does NOT say `noindex`, and could not
 *
 * `robots.txt` controls CRAWLING, not indexing. A URL disallowed here can
 * still appear in an index if something links to it, which is the classic
 * misunderstanding — the directive that keeps a page out of an index is the
 * `noindex` header or meta, which `/f/[handle]` emits per profile from its own
 * `indexable` flag. The two are complementary and neither substitutes.
 *
 * So `/f/` is deliberately NOT disallowed here: every profile currently sends
 * `noindex` anyway, and disallowing the path would stop a crawler from ever
 * seeing that header — which is how a page ends up indexed with no snippet
 * rather than not indexed at all.
 */
export default function robots(): MetadataRoute.Robots {
    // The sanctioned resolver, not a hardcoded origin. It prefers `APP_URL`
    // and falls back to `NEXTAUTH_URL`, which the env schema requires off
    // Vercel — so the app cannot boot without knowing its own origin, and a
    // literal here would have been a second source of truth that drifts on
    // the day the domain changes.
    const base = getAppBaseUrl();
    return {
        rules: [
            {
                userAgent: '*',
                // Crawl the public profile surface; the per-page `noindex`
                // decides what may be INDEXED.
                allow: ['/f/'],
                disallow: [
                    '/api/',
                    '/t/',
                    '/org/',
                    '/login',
                    '/register',
                    '/reset-password',
                    '/forgot-password',
                    '/invite/',
                    '/no-tenant',
                    '/tenants',
                    '/accept-terms',
                    '/suspended',
                    '/account',
                ],
            },
        ],
        sitemap: `${base}/sitemap.xml`,
    };
}

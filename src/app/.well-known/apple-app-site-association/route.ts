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
 *     307 -> /login?next=%2F.well-known%2Fapple-app-site-association
 *
 * Measured on production on 2026-10-14. Apple fetches this unauthenticated
 * from its own CDN and a redirect is a hard failure — so NO link to this
 * origin could open the app, and every shared link fell back to Safari
 * silently, while the iOS side was already built and waiting on
 * `applinks:app.agrent.bg`.
 *
 * ## The Edge half is not optional
 *
 * `src/lib/auth/guard.ts` carries this path in `PUBLIC_PATH_EXACT`. Without it
 * the handler never runs and the 307 is unchanged — the shape that hit SCIM,
 * the `iflk_` key, all three signed webhooks, the platform-admin key, and the
 * Art 16 notice form that answered 401 for seven weeks (#1745). A closed door
 * and an empty queue look identical from inside.
 *
 * ## A route handler, not a static file
 *
 * Apple asks for `application/json`, and an extensionless file under `public/`
 * is served as `application/octet-stream`. `NextResponse.json` sets the type.
 *
 * The document's content lives in `@/lib/ios/app-site-association` rather than
 * here: a `route.ts` may export only handlers and route-segment config, which
 * `tests/guards/app-router-module-exports.test.ts` enforces because `tsc`
 * cannot see the violation without a prior build.
 */
import { NextResponse } from 'next/server';

import { buildAppSiteAssociation } from '@/lib/ios/app-site-association';

/** Nothing here depends on a request. */
export const dynamic = 'force-static';

export async function GET() {
    return NextResponse.json(buildAppSiteAssociation(), {
        headers: { 'cache-control': 'public, max-age=3600' },
    });
}

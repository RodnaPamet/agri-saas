/**
 * Edge-compatible auth guard helpers.
 * Pure functions — no Node.js or Prisma imports.
 * Used by middleware.ts for path classification and redirect building.
 */
import { NextResponse } from 'next/server';
import { CSP_REPORT_PATH } from '@/lib/security/csp';

// ─── Public path allowlist ───

const PUBLIC_PATH_PREFIXES = [
    '/login',
    '/register',
    '/forgot-password',  // Password-reset request page — unauthenticated users must reach it
    '/reset-password',   // Password-reset confirm page — reached from an emailed token link
    '/no-tenant',        // Landing page for uninvited users — must not gate-loop
    '/tenants',          // R-1: tenant picker — must be reachable before active-tenant is set
    '/invite/',          // Invite preview page (tenant + org) — public so unauthenticated users can see invite details
    '/api/auth',         // Auth.js callbacks, session, csrf, providers
    '/api/invites/',     // Tenant invite redemption API (public) + start-signin cookie setter
    '/api/org/invite/',  // Org invite API (public) — start-signin cookie setter + accept-redirect, mirrors /api/invites/
    '/api/health',       // Health check (no auth) — deprecated alias
    '/api/livez',        // Liveness probe (no auth)
    '/api/readyz',       // Readiness probe (no auth)
    '/api/metrics',      // web-vitals telemetry sink (no auth — anonymous RUM beacons)
    CSP_REPORT_PATH,     // CSP violation sink. Same class as /api/metrics: a browser
                         // posts violation reports with NO credentials, so `getToken()`
                         // returned null and the Edge 401'd every one of them — from the
                         // day the feature shipped (2026-03-21) until #704. The ring
                         // buffer was permanently empty, the admin summary permanently
                         // zero, and `csp.ts:16` told operators to "monitor" something
                         // that could not happen; five months of CSP tightening shipped
                         // with its safety net disconnected.
                         //
                         // Spelled as the CONSTANT, not a literal, and that is
                         // load-bearing. The same value goes into three response headers
                         // — `report-uri` (csp.ts:184), `Report-To` and
                         // `Reporting-Endpoints` (middleware.ts:515-522) — so a literal
                         // here could drift from what browsers are actually told. The
                         // duplicated-literal shape is exactly what produced this bug;
                         // `/api/metrics` still has it (three literals, no constant).
                         //
                         // Direction B of `public-routes-self-authenticate` applies: the
                         // POST is designed anonymous (per-IP rate limit, 16 KB cap,
                         // always 204, never leaks state), and the GET summary
                         // authenticates itself with `verifyPlatformApiKey` — it used to
                         // rely on this very gate, so opening the prefix without that
                         // would have published every reporter's IP and User-Agent.
    '/api/staging/seed', // Staging seed endpoint (token-gated internally)
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
    // Nine routes (tenant bootstrap, ownership transfer, agri-events,
    // news-derived-events review, support-scheme review) authenticate with
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
    '/api/stripe/webhook',
    '/api/storage/av-webhook',
    '/api/integrations/webhooks/',
    '/privacy',          // Privacy notice — MUST be readable without an account:
                         // the promotions consent box links to it before a
                         // request is submitted, and a prospective user has to
                         // be able to read it before signing up. It renders no
                         // tenant data, so there is nothing to gate.
    '/_next',            // Next.js internals
];

const PUBLIC_PATH_EXACT = new Set([
    '/favicon.ico',
    '/robots.txt',
    '/sitemap.xml',
]);

// `webmanifest` — the PWA manifest is fetched by the browser WITHOUT
// credentials (`<link rel="manifest">` default), so without this it hits the
// auth gate, 307-redirects to /login, and the browser parses the HTML login
// page as JSON → "Manifest: Line 1, column 1, Syntax error".
// `geojson` — bundled static map overlays under /public/geo (e.g. the Exchange
// map's oblast boundaries); same static-public-asset class as the rest.
const STATIC_EXTENSIONS = /\.(ico|png|jpg|jpeg|gif|svg|webp|css|js|woff|woff2|ttf|eot|map|json|webmanifest|geojson)$/;

/**
 * Check if a pathname is public (should bypass auth).
 */
export function isPublicPath(pathname: string): boolean {
    // Exact matches
    if (PUBLIC_PATH_EXACT.has(pathname)) return true;

    // Prefix matches
    if (PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p))) return true;

    // Static file extensions
    if (STATIC_EXTENSIONS.test(pathname)) return true;

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
    // Auth callbacks (sign-out, etc.)
    if (pathname.startsWith('/api/auth/')) return true;
    return false;
}

/**
 * Sanitize a redirect path to prevent open-redirect attacks.
 * Only allows relative paths starting with '/'.
 * Strips protocol, host, and any absolute URL to return '/'.
 */
export function sanitizeRedirectPath(next: string | null | undefined): string {
    if (!next) return '/';

    // Decode if URL-encoded
    let decoded: string;
    try {
        decoded = decodeURIComponent(next);
    } catch {
        return '/';
    }

    // Strip any protocol + host (prevents https://evil.com)
    // Reject anything that looks like an absolute URL
    if (
        decoded.startsWith('//') ||
        decoded.includes('://') ||
        decoded.startsWith('\\')
    ) {
        return '/';
    }

    // Must start with /
    if (!decoded.startsWith('/')) {
        return '/';
    }

    // Drop any authority component (//evil.com/path)
    const cleaned = decoded.replace(/^\/\/+/, '/');

    return cleaned;
}

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
 * Return a 403 Forbidden JSON response.
 */
export function forbiddenJson(reason?: string): NextResponse {
    return NextResponse.json(
        { error: reason || 'Forbidden' },
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

import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { checkAuthRateLimit } from '@/lib/rate-limit/authRateLimit';
import {
    checkApiReadRateLimit,
    extractTenantSlug,
    isApiReadRateLimited,
} from '@/lib/rate-limit/apiReadRateLimit';
import { env } from '@/env';
import {
    CLIENT_VERSION_HEADER,
    checkClientVersion,
    clientTooOldBody,
} from '@/lib/api/contract-version';
import {
    isPublicPath,
    isApiRoute,
    isAdminPath,
    isTenantPath,
    isOrgPath,
    isMfaAllowedPath,
    buildLoginRedirect,
    unauthorizedJson,
    forbiddenJson,
    checkTenantAccess,
    checkOrgAccess,
    isOperatorAllowedPath,
} from '@/lib/auth/guard';
import { generateNonce, buildCspHeader, CSP_NONCE_HEADER, CSP_REPORT_PATH, CSP_REPORT_GROUP, getCspHeaderName, isCspReportOnly } from '@/lib/security/csp';
import { applySecurityHeaders } from '@/lib/security/headers';
import { resolveCorsConfig, isOriginAllowed, applyCorsHeaders, CORS_PREFLIGHT_HEADERS } from '@/lib/security/cors';
import { shouldBlockAdminRequest } from '@/lib/security/admin-session-guard';
import { LOCALE_COOKIE, DEFAULT_LOCALE, isLocale } from '@/lib/i18n/locales';

/** One year, in seconds — the locale-cookie lifetime. */
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * T00 — seed the `NEXT_LOCALE` cookie from the authenticated user's
 * persisted `uiLanguage` claim so a returning user's device renders in
 * their chosen locale on the very first request, with no DB hit.
 *
 * Non-destructive: if the cookie is already present (the user switched
 * languages this session, or a prior request already seeded it) we
 * leave it untouched. Client-readable (httpOnly:false) so the switcher
 * can reason about the active value; `sameSite: lax` matches the auth
 * cookie posture.
 */
function seedLocaleCookie(
    req: NextRequest,
    res: NextResponse,
    uiLanguage: unknown,
): void {
    if (req.cookies.get(LOCALE_COOKIE)) return;
    const pref = isLocale(uiLanguage) ? uiLanguage : DEFAULT_LOCALE;
    res.cookies.set(LOCALE_COOKIE, pref, {
        path: '/',
        maxAge: LOCALE_COOKIE_MAX_AGE,
        sameSite: 'lax',
        httpOnly: false,
    });
}

/**
 * GAP-04 — Edge middleware: centralized auth guard + CSP for ALL routes.
 *
 * v4 migration: switched from the v5 `auth(async (req) => …)` async
 * wrapper (which bundled the full NextAuth config into the Edge
 * runtime) to the v4 `getToken()` direct JWT verification path. This
 * has three benefits:
 *
 *   1. The Edge bundle no longer needs the `auth.config.ts`
 *      edge/node split — middleware just verifies the JWT cookie,
 *      same as in v5 but without the wrapper indirection.
 *   2. Token fields are typed via the `next-auth/jwt` module
 *      augmentation in `src/auth.ts`. The 4 `as any` casts that v5's
 *      loose `req.auth` typing required are now typed accesses.
 *   3. `getToken()` is sync-callable from Edge functions and avoids
 *      v5-beta-specific runtime issues with the `auth()` wrapper.
 *
 * CSP flow:
 *   1. Generate cryptographic nonce per request
 *   2. Pass nonce to server components via x-csp-nonce request header
 *   3. Set Content-Security-Policy response header with nonce
 *
 * Auth behavior:
 *   ┌──────────────────┬───────────────┬──────────────────────────┐
 *   │ Route type       │ Unauthed      │ Authed but wrong role    │
 *   ├──────────────────┼───────────────┼──────────────────────────┤
 *   │ /api/*           │ 401 JSON      │ 403 JSON                 │
 *   │ App pages        │ redirect →    │ 403 redirect to /login   │
 *   │                  │  /login?next= │                          │
 *   │ Public paths     │ allowed       │ allowed                  │
 *   └──────────────────┴───────────────┴──────────────────────────┘
 */

async function authMiddleware(req: NextRequest): Promise<NextResponse> {
    const { pathname } = req.nextUrl;

    // ── 1. Allow public paths (login, auth callbacks, static, etc.) ──
    if (isPublicPath(pathname)) {
        return NextResponse.next();
    }

    // ── 2. Verify JWT cookie ──
    // v4 — `getToken()` reads + verifies the JWT cookie set by NextAuth.
    // Returns null if no cookie / bad signature / expired.
    const token = await getToken({
        req,
        secret: env.AUTH_SECRET,
    });

    if (!token) {
        if (isApiRoute(pathname)) {
            return unauthorizedJson();
        }
        const proto = req.headers.get('x-forwarded-proto') || 'http';
        const host = req.headers.get('host') || req.nextUrl.host;
        const origin = `${proto}://${host}`;
        return NextResponse.redirect(
            buildLoginRedirect(origin, pathname),
        );
    }

    // ── 2b. Reject a token whose session is no longer valid ──
    //
    // The `jwt` callback signals four distinct failure modes by setting
    // `token.error`, and until this check existed NOTHING READ ANY OF THEM:
    //
    //   SessionRevoked        admin revoke, expiry, maxConcurrentSessions
    //                         eviction, or a User.sessionVersion bump
    //                         (auth.ts:637, :727)
    //   MfaDependencyFailure  a FAIL-CLOSED MFA check could not complete
    //                         (auth.ts:591, :708) — so it was failing OPEN
    //   RefreshTokenError     OAuth refresh failed; its own log line says
    //                         "forcing reauth" (auth.ts:681) — nothing forced
    //   EntraGroupGateDenied  Entra group gate refused
    //                         (lib/auth/entra-group-sync.ts:182)
    //
    // The flag was written in five places and read in none, so the
    // /admin/members "revoke session" button, the concurrency cap, session
    // expiry, and the sessionVersion backstop that password change/reset
    // relies on were all inert. `session: { strategy: 'jwt' }` sets no
    // maxAge (30-day default) and NextAuth re-issues on each request, so an
    // actively-used revoked session was effectively unbounded.
    //
    // This is the ONLY enforcement point on purpose. `getToken()` reads the
    // cookie AND an `Authorization: Bearer` header (next-auth/jwt/index.js:83),
    // so a bearer credential is denied by exactly the same code — there is no
    // second, looser path to keep in sync.
    //
    // Placed AFTER `isPublicPath` (which covers `/login` and `/api/auth`), so
    // a denial cannot redirect-loop. A successful refresh clears the flag
    // (`delete token.error`, auth.ts:664), so a set value is always current.
    //
    // NOT changed here: `verifyAndTouchSession` still fails OPEN on a
    // transient DB error. Failing closed there would turn a database blip
    // into a fleet-wide sign-out of every operator mid-field. The bug was
    // never the fail-open on an UNKNOWN answer — it was ignoring a DEFINITE
    // one.
    if (typeof token.error === 'string' && token.error.length > 0) {
        if (isApiRoute(pathname)) {
            return unauthorizedJson();
        }
        const proto = req.headers.get('x-forwarded-proto') || 'http';
        const host = req.headers.get('host') || req.nextUrl.host;
        const origin = `${proto}://${host}`;
        const res = NextResponse.redirect(
            buildLoginRedirect(origin, pathname),
        );
        // Clear the stale session cookie so the browser stops re-presenting a
        // credential we have just refused; otherwise every subsequent
        // protected navigation bounces through this same denial. Both names
        // are cleared because the `__Secure-` prefix is used over HTTPS only.
        for (const name of [
            'next-auth.session-token',
            '__Secure-next-auth.session-token',
        ]) {
            res.cookies.set(name, '', { maxAge: 0, path: '/' });
        }
        return res;
    }

    // ── 2c. Client contract version ──
    //
    // A native binary cannot be rolled back the way an image can — an App Store
    // release is out of our hands once installed — so a server that has moved
    // past what an old app understands must say so in a way the app can ACT on.
    //
    // The refusal is a distinct machine-readable code, never a generic 400:
    // an app receiving `{"error":"Bad Request"}` shows the operator a bug; one
    // receiving `client_version_unsupported` shows "please update".
    //
    // Absent header = compatible, deliberately. The web client ships with the
    // server and cannot be stale, and refusing unversioned requests would break
    // every existing integration on the day this lands. Only a client that
    // DECLARES a version older than the floor is refused.
    if (isApiRoute(pathname)) {
        const verdict = checkClientVersion(req.headers.get(CLIENT_VERSION_HEADER));
        if (!verdict.ok) {
            return NextResponse.json(clientTooOldBody(), { status: 426 });
        }
    }

    // ── 3. Admin-only paths ──
    if (isAdminPath(pathname)) {
        const role = token.role;
        // OWNER is strictly superior to ADMIN (see CLAUDE.md RBAC section).
        const ADMIN_ROLES = new Set(['ADMIN', 'OWNER']);
        if (!role || !ADMIN_ROLES.has(role)) {
            if (isApiRoute(pathname)) {
                return forbiddenJson('Admin access required');
            }

            // Allow the request to proceed to the App Router.
            // The Server Component guard in `admin/layout.tsx` will
            // safely capture this and render the `<ForbiddenPage>`.
            // (Avoiding NextResponse.redirect(dashboardUrl) here prevents a known Next.js 14 dev server crash
            // where 307-redirecting an HTML request back to the browser's currently active URL causes an Edge Runtime panic).
            return NextResponse.next();
        }

        // Admin role confirmed — enforce stricter session posture.
        // Block cross-site requests to admin API routes (Sec-Fetch-Site check).
        // This provides equivalent protection to SameSite=strict cookies
        // without breaking OAuth redirect flows that require SameSite=lax.
        if (isApiRoute(pathname)) {
            const secFetchSite = req.headers.get('sec-fetch-site');
            const method = req.method || 'GET';
            if (shouldBlockAdminRequest(secFetchSite, method)) {
                return forbiddenJson('Cross-site admin requests are not allowed');
            }
        }
    }

    // ── 4. MFA enforcement ──
    if (isTenantPath(pathname) && !isMfaAllowedPath(pathname)) {
        const mfaPending = token.mfaPending === true;

        if (mfaPending) {
            // Extract tenant slug from path: /t/:slug/... or /api/t/:slug/...
            const segments = pathname.split('/');
            const tIndex = segments.indexOf('t');
            const tenantSlug = tIndex >= 0 ? segments[tIndex + 1] : null;

            if (isApiRoute(pathname)) {
                return forbiddenJson('MFA verification required');
            }

            if (tenantSlug) {
                const mfaUrl = new URL(`/t/${tenantSlug}/auth/mfa`, req.nextUrl.origin);
                mfaUrl.searchParams.set('next', pathname);
                return NextResponse.redirect(mfaUrl);
            }
        }
    }

    // ── 5. Tenant-access gate ──
    // R-1: check whether the URL slug appears in the user's memberships
    // array. No DB hit — the JWT claim is the early-rejection layer. If
    // the membership list was capped at sign-in (membershipsTruncated),
    // a slug-miss defers to the authoritative server-side gate
    // (TenantLayout / getTenantCtx) instead of a definitive denial.
    if (isTenantPath(pathname)) {
        const memberships = token.memberships;
        const gateResult = checkTenantAccess(
            pathname,
            memberships,
            token.membershipsTruncated === true,
        );

        if (gateResult === 'no_tenant_access') {
            if (isApiRoute(pathname)) {
                return NextResponse.json(
                    { error: 'no_tenant_access' },
                    { status: 403 },
                );
            }
            return NextResponse.redirect(new URL('/no-tenant', req.nextUrl.origin));
        }

        if (gateResult === 'cross_tenant') {
            if (isApiRoute(pathname)) {
                return NextResponse.json(
                    { error: 'cross_tenant_access_denied' },
                    { status: 403 },
                );
            }
            return NextResponse.redirect(new URL('/no-tenant', req.nextUrl.origin));
        }

        // ── MECHANISATOR operator lockdown ──
        // A machine-operator persona is confined to its "My work" screen +
        // the field-operation completion flow. Resolve the membership for
        // THIS URL's slug (token.role is the PRIMARY membership only — it may
        // not match the tenant being visited) and, if it's MECHANISATOR,
        // redirect any other page to /my-work and 403 any non-task API. This
        // is the load-bearing lockdown; the stripped app shell + minimal
        // permissions are defence-in-depth. (If the JWT membership list was
        // truncated the entry may be absent — the operator then has just one
        // tenant in practice, and the authoritative server layout + minimal
        // permissions still confine them.)
        const slugMatch = pathname.match(/^\/(?:api\/)?t\/([^/]+)/);
        const slug = slugMatch?.[1];
        const membership = slug
            ? memberships?.find((m) => m.slug === slug)
            : undefined;
        if (membership?.role === 'MECHANISATOR' && slug && !isOperatorAllowedPath(pathname, slug)) {
            if (isApiRoute(pathname)) {
                return NextResponse.json({ error: 'operator_scope' }, { status: 403 });
            }
            return NextResponse.redirect(
                new URL(`/t/${slug}/my-work`, req.nextUrl.origin),
            );
        }
    }

    // ── 5b. Org-access gate (GAP O4-1) ──
    // Mirror of the tenant gate, keyed on `token.orgMemberships`.
    // Same anti-enumeration posture as `getOrgCtx` / `getOrgServerContext`:
    // both `no_org_access` and `cross_org` collapse to a single
    // external response (notFound for pages, 404 JSON for API). The
    // gate-result string distinguishes them for ops via the standard
    // request-id correlation; nothing leaks to the caller.
    //
    // No DB hit — the JWT claim is the authority. The `orgMemberships`
    // array is populated by the JWT callback in `src/auth.ts` at
    // sign-in time. Page-level (`getOrgServerContext`) and API-level
    // (`getOrgCtx`) checks remain in place as defense-in-depth — this
    // is the early-rejection layer, not a replacement.
    if (isOrgPath(pathname)) {
        const gateResult = checkOrgAccess(
            pathname,
            token.orgMemberships,
            token.orgMembershipsTruncated === true,
        );
        if (gateResult !== 'allow') {
            if (isApiRoute(pathname)) {
                return NextResponse.json(
                    { error: 'not_found' },
                    { status: 404 },
                );
            }
            // 404 surface — route to the same landing page non-members
            // see today via the layout's `notFound()` collapse, so a
            // probing user can't tell whether the slug exists.
            return NextResponse.redirect(new URL('/no-tenant', req.nextUrl.origin));
        }
    }

    // ── 5c. API read rate limit (GAP-17) ──
    // Tenant-scoped GETs go through a dedicated read-tier limiter
    // before reaching the route handler. Sits AFTER the tenant-access
    // gate so unauthorized cross-tenant reads still 403 (cheaper) and
    // BEFORE the route runs (so we don't burn a DB query when the
    // budget is exhausted). Health probes (`/api/health`, `/api/livez`,
    // `/api/readyz`) and `/api/docs` are excluded by
    // `isApiReadRateLimited`. Mutations + non-tenant routes are
    // unaffected — they have their own tiers.
    if (isApiReadRateLimited(req.method, pathname)) {
        const tenantSlug = extractTenantSlug(pathname);
        const userId = (token.sub as string | undefined) ?? null;
        const rl = await checkApiReadRateLimit(req, userId, tenantSlug);
        if (!rl.ok && rl.response) {
            return rl.response;
        }
    }

    // ── 6. Authenticated and authorized → proceed ──
    const res = NextResponse.next();
    seedLocaleCookie(req, res, token.uiLanguage);
    return res;
}

export default async function middleware(
    req: NextRequest,
    // Optional 2nd arg kept for back-compat with the v5 wrapper signature
    // and existing test fixtures that call `middleware(req, {})`. Unused
    // by the v4 implementation — the JWT is read via `getToken({ req })`.
    _ctx?: unknown,
): Promise<NextResponse> {
    void _ctx;
    const { pathname } = req.nextUrl;

    // ── CSP Nonce — generated once per request ──
    const nonce = generateNonce();
    const isDev = env.NODE_ENV === 'development';
    const cspHeader = buildCspHeader(nonce, isDev);
    const cspReportOnly = isCspReportOnly(process.env.CSP_REPORT_ONLY);
    const cspHeaderName = getCspHeaderName(cspReportOnly);

    // ── Request ID (reuse from upstream or generate) ──
    const requestId = req.headers.get('x-request-id') || crypto.randomUUID();

    // ── Pass nonce to server components via request header ──
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set(CSP_NONCE_HEADER, nonce);
    requestHeaders.set('x-request-id', requestId);
    // 2026-05-14 — Next.js 15 reads the FULL CSP policy from the
    // request headers (NOT just our `x-csp-nonce` request header)
    // to drive its internal auto-nonce-application. Specifically,
    // Next's chunk-preload `<link>` tags and the webpack runtime's
    // chunk-loader `<script>` tags get stamped with the nonce only
    // when the framework can extract it from a `Content-Security-
    // Policy` request header at SSR time.
    //
    // Without this, `strict-dynamic` blocks every chunk that
    // wasn't statically server-rendered with the matching nonce
    // — the failure mode that R16's visx + motion dynamic imports
    // surfaced.
    //
    // The canonical Next.js CSP-middleware pattern in the official
    // docs sets the policy as a request header for exactly this
    // reason; our middleware was setting it only on the response.
    // Add both — response for browser enforcement, request for
    // Next's auto-nonce machinery.
    requestHeaders.set(cspHeaderName, cspHeader);

    const origin = req.headers.get('origin') ?? '';

    // ── CORS Policy — environment-aware, fail-closed in production ──
    const corsConfig = resolveCorsConfig(env.CORS_ALLOWED_ORIGINS, env.NODE_ENV);
    const isAllowedOrigin = isOriginAllowed(origin, corsConfig);
    const isProduction = env.NODE_ENV === 'production';

    // ── CORS Preflight for APIs ──
    if (pathname.startsWith('/api/') && req.method === 'OPTIONS') {
        const preflightHeaders = new Headers();
        if (isAllowedOrigin && origin) {
            applyCorsHeaders(preflightHeaders, origin);
        }
        for (const [key, value] of Object.entries(CORS_PREFLIGHT_HEADERS)) {
            preflightHeaders.set(key, value);
        }
        preflightHeaders.set('x-request-id', requestId);
        preflightHeaders.set(cspHeaderName, cspHeader);
        applySecurityHeaders(preflightHeaders, isProduction);
        return new NextResponse(null, { status: 204, headers: preflightHeaders });
    }

    // ── Rate Limit Auth Endpoints ──
    if (pathname.startsWith('/api/auth/')) {
        const rlResult = await checkAuthRateLimit(req);
        if (!rlResult.ok && rlResult.response) {
            return rlResult.response;
        }
    }

    // ── Auth API routes bypass ──
    // /api/auth/* routes are public and self-authenticating (they manage their
    // own session/CSRF handling). Skip the JWT-checking middleware path
    // entirely so the request body stream isn't disturbed.
    let authRes: NextResponse | undefined;
    if (pathname.startsWith('/api/auth/')) {
        authRes = NextResponse.next();
    } else {
        authRes = await authMiddleware(req);
    }

    // If auth returned a redirect (3xx) or error (4xx/5xx), use it directly.
    // Otherwise create a NextResponse.next() that forwards the modified request
    // headers — critically including x-csp-nonce, which Next.js reads to stamp
    // its <script> tags with the matching nonce.
    //
    // For /api/auth/ routes we must NOT pass { request: { headers } } because
    // Next.js re-creates the Request to apply header overrides, which can
    // interfere with NextAuth's body-parsing path. API routes don't need the
    // x-csp-nonce request header anyway.
    const isAuthApi = pathname.startsWith('/api/auth/');
    const isPassThrough = !authRes
        || (authRes.status === 200 && !authRes.headers.get('location'));

    let res: NextResponse;
    if (!isPassThrough && authRes) {
        res = authRes;
    } else if (isAuthApi) {
        res = NextResponse.next();
    } else {
        res = NextResponse.next({ request: { headers: requestHeaders } });
    }

    // The pass-through branch re-creates `res` from scratch, which would
    // drop any cookies `authMiddleware` set on its own NextResponse
    // (notably the T00 `NEXT_LOCALE` seed). Copy them across so the seed
    // survives. Skipped when `res` IS `authRes` (nothing to copy).
    if (authRes && authRes !== res) {
        for (const cookie of authRes.cookies.getAll()) {
            res.cookies.set(cookie);
        }
    }

    // ── Security Headers — applied to ALL responses ──
    applySecurityHeaders(res.headers, isProduction);

    // ── Inject CSP + Report-To + request ID on every response ──
    res.headers.set(cspHeaderName, cspHeader);
    res.headers.set('x-request-id', requestId);

    // Report-To header for the modern Reporting API (report-to CSP directive)
    res.headers.set('Report-To', JSON.stringify({
        group: CSP_REPORT_GROUP,
        max_age: 86400,
        endpoints: [{ url: CSP_REPORT_PATH }],
    }));

    // Reporting-Endpoints header (newer alternative, Chrome 96+)
    res.headers.set('Reporting-Endpoints', `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);

    // ── Apply CORS Headers to API responses (environment-locked) ──
    if (pathname.startsWith('/api/') && isAllowedOrigin && origin) {
        applyCorsHeaders(res.headers, origin);
    }

    return res;
}

/**
 * Matcher: run middleware on all routes EXCEPT static assets.
 * The public path check inside the middleware handles /login, /api/auth, etc.
 */
export const config = {
    matcher: [
        '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)',
    ],
};

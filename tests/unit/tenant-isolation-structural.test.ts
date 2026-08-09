/**
 * Structural guardrails for tenant/scope isolation.
 *
 * These tests scan the codebase and FAIL if:
 * 1. session.tenantId is used outside allowlisted files
 * 2. Protected pages exist outside /t/[tenantSlug]
 * 3. Business API routes exist outside /api/t/[tenantSlug] (auth routes excluded)
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../src');

function walkDir(dir: string, ext = '.ts'): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkDir(fullPath, ext));
        } else if (entry.name.endsWith(ext) || entry.name.endsWith('.tsx')) {
            results.push(fullPath);
        }
    }
    return results;
}

describe('Structural Guard: Tenant Isolation Conventions', () => {
    // ─── 1. Forbid session.tenantId usage ───
    describe('session.tenantId must not be used outside allowlisted files', () => {
        // These files are allowed to use session.tenantId:
        // - context.ts: builds RequestContext from session for legacy routes
        // - audit-log.ts: legacy wrapper (no routes call it, but kept for backward compat)
        const ALLOWLIST = new Set([
            path.join(SRC_ROOT, 'app-layer', 'context.ts'),
            path.join(SRC_ROOT, 'lib', 'audit-log.ts'),
        ]);

        const allTsFiles = walkDir(SRC_ROOT);

        for (const filePath of allTsFiles) {
            if (ALLOWLIST.has(filePath)) continue;
            // Skip test files and declaration files
            if (filePath.includes('__tests__') || filePath.endsWith('.d.ts')) continue;

            const relPath = filePath.replace(SRC_ROOT + path.sep, '');

            it(`${relPath} must NOT use session.tenantId`, () => {
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.split('\n');
                const violations = lines.filter((line) => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
                    return /session\.tenantId/.test(trimmed);
                });
                expect(violations).toEqual([]);
            });
        }
    });

    // ─── 2. Forbid protected pages outside /t/[tenantSlug] ───
    describe('protected pages must live under /t/[tenantSlug]', () => {
        const appDir = path.join(SRC_ROOT, 'app');

        // These root-level pages are allowed (they're redirectors/public):
        const ALLOWED_ROOT_PAGES = new Set([
            'page.tsx',          // Root redirector → /t/<slug>/dashboard
            'login',             // Public login page
            'register',          // Public register page
            'forgot-password',   // Public password-reset request page (credentials flow)
            'reset-password',    // Public password-reset confirm page (emailed token link)
            'account',           // Identity-level account settings (e.g. /account/security
                                 // change-password). Not tenant-scoped — a user's
                                 // password is one identity, shared across every tenant.
            'dashboard',         // Legacy redirect shim → /t/<slug>/dashboard
            'not-found.tsx',     // 404 page
            'error.tsx',         // Error boundary
            'layout.tsx',        // Root layout
            'global-error.tsx',  // Global error boundary
            'audit',             // Public auditor share view (/audit/shared/[token])
            // Privacy notice. Deliberately public and tenant-LESS: the
            // promotions consent box links to it before a farmer submits a
            // request, and a prospective user must be able to read it without
            // an account. It renders no tenant data — only a description of
            // how the software handles data — so it has nothing to isolate.
            'privacy',
            // Epic 1, PR 3 — invite preview page (sign-in gated, any tenant).
            // User is not yet a member of the target tenant — cannot go under /t/.
            'invite',
            // Epic 1, PR 3 — landing for authenticated users with no active membership.
            // PR 4 wires middleware to redirect here when JWT has no tenantId.
            'no-tenant',
            // Epic 1, R-1 — tenant picker: user selects which of their memberships to enter.
            // Must be root-level (not under /t/) because the user hasn't chosen a tenant yet.
            'tenants',
            // Epic O-4 — hub-and-spoke org layer. Pages under /org/[orgSlug]
            // resolve OrgContext (NOT RequestContext) and operate above the
            // tenant scope. Drill-down navigations from the portfolio still
            // route into /t/{tenantSlug}/... where standard tenant
            // isolation applies.
            'org',
            // Epic G-3 — public token-gated vendor questionnaire response
            // page. The external respondent has no session and no tenant
            // membership; the page is reached via the email's
            // ?t=<rawToken> link. Token verification matches against the
            // assessment row's tenantId; the page lives outside /t/ by
            // design. Mirrors the audit/shared shape.
            'vendor-assessment',
        ]);

        // Get immediate children of app/ that are page directories
        if (fs.existsSync(appDir)) {
            const entries = fs.readdirSync(appDir, { withFileTypes: true });
            for (const entry of entries) {
                // Skip t/ (tenant-scoped), api/ (API routes), and allowed items
                if (entry.name === 't' || entry.name === 'api') continue;
                if (ALLOWED_ROOT_PAGES.has(entry.name)) continue;

                // Skip Next.js template files and parenthesized route groups
                if (entry.name.startsWith('(') || entry.name.startsWith('_')) continue;

                if (entry.isDirectory()) {
                    // Check if this directory contains any page.tsx
                    const pagesInDir = walkDir(path.join(appDir, entry.name))
                        .filter((f) => f.endsWith('page.tsx'));

                    for (const pageFile of pagesInDir) {
                        const relPath = pageFile.replace(SRC_ROOT + path.sep, '');
                        it(`DISALLOWED: ${relPath} — protected page outside /t/[tenantSlug]`, () => {
                            // If this test runs, the page exists outside /t/ and isn't allowlisted
                            throw new Error(`Page file ${relPath} exists outside /t/[tenantSlug]. Move it or add to allowlist.`);
                        });
                    }
                }
            }
        }

        it('all tenant-scoped pages are under /t/[tenantSlug]', () => {
            // Verify /t/ directory exists and has pages
            const tenantPagesDir = path.join(appDir, 't');
            expect(fs.existsSync(tenantPagesDir)).toBe(true);

            const tenantPages = walkDir(tenantPagesDir)
                .filter((f) => f.endsWith('page.tsx'));
            expect(tenantPages.length).toBeGreaterThan(0);
        });
    });

    // ─── 3. Forbid API routes outside /api/t/[tenantSlug] (except auth) ───
    describe('business API routes must live under /api/t/[tenantSlug]', () => {
        const apiDir = path.join(SRC_ROOT, 'app', 'api');

        // Auth routes are allowed at the root level
        const ALLOWED_API_DIRS = new Set([
            'admin', 'auth', 't', 'risk-templates', 'audit', 'staging',
            'health', 'livez', 'readyz', 'stripe', 'security', 'csp-report',
            'storage', 'integrations', 'scim',
            // PWA web-vitals RUM sink — anonymous, public, no tenant scope
            // (mirrors the health/livez probes). See src/app/api/metrics.
            'metrics',
            // SP-4 — external webhook receivers (MS Graph change notifications).
            // Caller is Graph, not a tenant member; the receiver verifies
            // clientState + resolves the tenant itself.
            'webhooks',
            // Epic 1, PR 3 — public invite preview + redemption endpoints.
            // These routes are intentionally outside /api/t/[tenantSlug] because
            // the caller is not yet a tenant member and has no tenantId in scope.
            'invites',
            // Epic O-1/O-2 — hub-and-spoke organization layer. Org
            // routes resolve `OrgContext` (NOT `RequestContext`) and
            // operate above the tenant scope. The cross-tenant drill-
            // down inside these routes still goes through
            // `withTenantDb(tid, …)` per-tenant — RLS is preserved.
            // See `src/app-layer/usecases/portfolio.ts` security
            // invariant comment for the full argument.
            'org',
            // GAP-10 — Swagger UI route. HARD 404 in production
            // (`isDocsEnabled()` in src/app/api/docs/route.ts), so it
            // never serves a request in a tenant-data context. The
            // tenant-scoping invariant doesn't apply to dev-only docs.
            'docs',
            // Epic G-3 — public token-gated vendor questionnaire
            // response surface. The external respondent has no
            // session and no tenant-membership; tenant resolution
            // happens through the assessment row's tenantId after
            // the SHA-256 access-token verifier matches. The path
            // is also in PUBLIC_PATH_PREFIXES so middleware skips
            // JWT verification. See
            // src/lib/security/external-assessment-access.ts and
            // src/lib/errors/route-exemptions.ts (anti_enumeration).
            'vendor-assessment',
            // Agro-intel — public token-gated data-stream ingestion
            // (`/api/agro/data-streams/[streamId]/ingest`). The caller is
            // a sensor/device with NO session and no tenant membership;
            // tenant resolution happens through the DataStream row's
            // tenantId after the SHA-256 ingest-token verifier matches.
            // Feature-flagged (AGRO_DATASTREAMS_ENABLED) + anti-enumeration
            // 401. The tenant-scoped data-stream CRUD lives under
            // /api/t/[tenantSlug]/agro/. See data-stream.ts (ingestReadings)
            // and route-exemptions.ts (anti_enumeration).
            'agro',
            // Avatar roadmap P3 — account-level (session-scoped)
            // routes. A user's profile/avatar is theirs across every
            // tenant, so `/api/account/*` resolves the session user,
            // never a `RequestContext` — the same reason `/api/auth/*`
            // sits outside `/api/t/`. The avatar upload/delete acts
            // only on `session.user.id`; the serve route is read-only.
            'account',
            // Promotions #12 — artwork for the GLOBAL promotions catalogue
            // (`/api/promotions/[id]/image`). `Promotion` has no tenantId and
            // the SAME image is rendered in every tenant's offers feed, so a
            // tenant-scoped URL would be a lie — it would break the moment a
            // second tenant rendered the same card, and would imply a
            // per-tenant asset that does not exist. Read-only and
            // session-gated (any authenticated user, never a RequestContext),
            // exactly like the `account` avatar serve route above; anonymous
            // access stays closed. The WRITE path is NOT here: uploads live at
            // /api/t/[tenantSlug]/admin/promotions/[id]/image, behind
            // requirePermission + assertPlatformSupport.
            'promotions',
        ]);

        // Legacy routes are allowed as documented thin wrappers
        // that delegate to getLegacyCtx → usecases (kept for backward compat)
        const ALLOWED_LEGACY_ROUTES = new Set([
            'assets', 'audit-log', 'audits', 'clauses', 'practices',
            'dashboard', 'evidence', 'files', 'findings', 'mapping',
            'notifications', 'policies', 'reports', 'risks', 'sso', 'tasks',
        ]);

        if (fs.existsSync(apiDir)) {
            const entries = fs.readdirSync(apiDir, { withFileTypes: true });

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (ALLOWED_API_DIRS.has(entry.name)) continue;
                if (ALLOWED_LEGACY_ROUTES.has(entry.name)) continue;

                // Any NEW route directory that isn't in the allowlists is a violation
                const routeFiles = walkDir(path.join(apiDir, entry.name))
                    .filter((f) => f.endsWith('route.ts'));

                for (const routeFile of routeFiles) {
                    const relPath = routeFile.replace(SRC_ROOT + path.sep, '');
                    it(`DISALLOWED: ${relPath} — new API route outside /api/t/[tenantSlug]`, () => {
                        throw new Error(`Route ${relPath} exists outside /api/t/. New routes MUST go under /api/t/[tenantSlug]/.`);
                    });
                }
            }
        }

        it('all legacy API routes use getLegacyCtx (not direct prisma)', () => {
            // Verify that each allowed legacy route uses getLegacyCtx
            for (const dir of ALLOWED_LEGACY_ROUTES) {
                const routeFile = path.join(apiDir, dir, 'route.ts');
                if (!fs.existsSync(routeFile)) continue;

                const content = fs.readFileSync(routeFile, 'utf8');
                const usesLegacyCtx = content.includes('getLegacyCtx');
                const usesUsecase = /import.*from.*usecases/.test(content);

                // Legacy routes must use getLegacyCtx OR import from usecases
                expect(usesLegacyCtx || usesUsecase).toBe(true);
            }
        });

        it('tenant-scoped API routes exist and outnumber legacy', () => {
            const tenantRouteDir = path.join(apiDir, 't');
            expect(fs.existsSync(tenantRouteDir)).toBe(true);

            const tenantRoutes = walkDir(tenantRouteDir)
                .filter((f) => f.endsWith('route.ts'));

            // We have 32 tenant routes vs 28 legacy — tenant should be >= legacy
            expect(tenantRoutes.length).toBeGreaterThanOrEqual(28);
        });
    });

    // ─── 4. Forbid flat fetch('/api/...') in tenant-scoped pages ───
    describe('tenant-scoped pages must use apiUrl() for all fetch calls', () => {
        const tenantPagesDir = path.join(SRC_ROOT, 'app', 't');

        if (fs.existsSync(tenantPagesDir)) {
            const pageFiles = walkDir(tenantPagesDir)
                .filter((f) => f.endsWith('page.tsx'));

            for (const filePath of pageFiles) {
                const relPath = filePath.replace(SRC_ROOT + path.sep, '');

                it(`${relPath} must NOT use flat fetch('/api/...')`, () => {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const lines = content.split('\n');
                    // Global (non-tenant-scoped) API routes are allowed
                    const GLOBAL_APIS = ['/api/risk-templates', '/api/auth/'];
                    const violations = lines.filter((line) => {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
                        // Match fetch('/api/... or fetch(`/api/...
                        if (!/fetch\s*\(\s*[`'"]\/api\//.test(trimmed)) return false;
                        return !GLOBAL_APIS.some(p => trimmed.includes(p));
                    });
                    expect(violations).toEqual([]);
                });
            }
        }
    });
});

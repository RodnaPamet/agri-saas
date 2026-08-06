/**
 * CI Regression Guard: Prevents accidental direct prisma/logAudit usage in route handlers.
 *
 * This test scans source files and FAILS if:
 * - Repositories import global prisma (except allowlisted)
 * - Usecases import global prisma (except allowlisted)
 * - ANY route handler (tenant-scoped or legacy) contains direct prisma usage
 * - ANY route handler contains logAudit calls (should be in usecases/events)
 * - ANY business route handler contains requireRole calls (should be in policies)
 *
 * RUN: npx jest tests/unit/no-direct-prisma.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../src');

function readFilesInDir(dir: string, ext = '.ts'): { name: string; content: string; relPath: string }[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith(ext))
        .map((f) => ({
            name: f,
            content: fs.readFileSync(path.join(dir, f), 'utf8'),
            relPath: path.join(dir, f).replace(SRC_ROOT, 'src'),
        }));
}

function walkDir(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkDir(fullPath));
        } else if (entry.name.endsWith('.ts')) {
            results.push(fullPath);
        }
    }
    return results;
}

function getNonCommentLines(content: string): string[] {
    return content.split('\n').filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
}

describe('CI Guard: No direct prisma in tenant-scoped code', () => {
    // ─── Repositories ───
    const REPO_ALLOWLIST = ['ClauseRepository.ts', 'RiskTemplateRepository.ts', 'SsoConfigRepository.ts', 'IdentityLinkRepository.ts'];

    const repos = readFilesInDir(path.join(SRC_ROOT, 'app-layer/repositories'));

    for (const file of repos) {
        if (REPO_ALLOWLIST.includes(file.name)) continue;

        it(`${file.name} must NOT import global prisma`, () => {
            const hasPrismaImport =
                file.content.includes("from '@/lib/prisma'") ||
                file.content.includes('from "@/lib/prisma"') ||
                file.content.includes("from '../../lib/prisma'") ||
                file.content.includes('from "../../lib/prisma"');

            expect(hasPrismaImport).toBe(false);
        });
    }

    // ─── Usecases ───
    const USECASE_ALLOWLIST: string[] = [
        // #15 — `AgriEvent` is a GLOBAL catalogue (no tenantId / no RLS, like
        // `Unit` / `Promotion` / `Framework`). The tenant-facing READ still goes
        // through `runInTenantContext`; the global handle is used by exactly two
        // kinds of caller that have no tenant transaction to borrow:
        //   - `hasUpcomingAgriEvents`, the ctx-free existence check the tenant
        //     layout uses to hide the Events nav entry on an empty catalogue;
        //   - the platform-admin curation writes, invoked from
        //     PLATFORM_ADMIN_API_KEY-gated routes where no user session and
        //     therefore no RequestContext exists (the `tenant-lifecycle.ts`
        //     pattern).
        // There is no tenantId to filter on, so the global handle carries no
        // RLS risk.
        'agri-events.ts',
        // Calendar roadmap PR 3 — `NewsDerivedEvent` is the identical GLOBAL-
        // catalogue shape as `AgriEvent` above (no tenantId / no RLS). Every
        // caller here is the PLATFORM_ADMIN_API_KEY-gated review surface
        // (list/approve/reject), invoked with no user session and therefore
        // no RequestContext — same rationale as agri-events.ts.
        'news-derived-events.ts',
        'sso.ts', 'mfa.ts', 'mfa-enrollment.ts', 'mfa-challenge.ts',
        'session-security.ts', 'webhook-processor.ts', 'scim-users.ts',
        // EI-3 — scim-groups resolves SCIM externalIds → IC users via a global
        // userIdentityLink lookup (cross-context, like scim-users); group
        // mutations themselves run inside runInTenantContext.
        'scim-groups.ts',
        'framework.ts', 'audit-hardening.ts',
        // Phase 7 — certification schemes ARE global `Framework` rows
        // (kind=AG_SCHEME); `certification-scheme.ts` is a thin facade over
        // the framework catalog. listSchemes/createScheme query the global
        // `Framework` / `FrameworkRequirement` tables, which have no
        // `tenantId` to filter on — identical rationale to `framework.ts`
        // and the Epic-47 `search.ts` entry below. Reads gate with
        // `assertCanViewFrameworks`, the create with `assertCanAdmin`; the
        // audit write routes through `appendAuditEntry(ctx.tenantId)`, so
        // the global prisma handle carries no RLS risk.
        'certification-scheme.ts',
        // Epic 1, PR 3 — redeemInvite and previewInviteByToken operate without
        // a tenant-scoped RequestContext (the caller is not yet a tenant member),
        // so they use the global prisma client directly. RLS policies are
        // bypassed intentionally here since the user has no tenant session.
        'tenant-invites.ts',
        // Epic 1, PR 2 — createTenantWithOwner + transferTenantOwnership run
        // under platform-admin auth with NO user RequestContext. Tenant is
        // being created or its ownership is changing; RLS doesn't apply
        // (Tenant itself is not in TENANT_SCOPED_MODELS).
        'tenant-lifecycle.ts',
        // Epic O-2 — org-layer usecases. Organization + OrgMembership are
        // user-scoped (org_isolation policy keyed on app.user_id), NOT
        // tenant-scoped — they're not in TENANT_SCOPED_MODELS. The
        // provisioning service crosses tenant boundaries by design (one
        // ORG_ADMIN add fans out to N tenants); cross-tenant fan-out goes
        // through createMany/deleteMany under the postgres role. The
        // tenant-scoped portion of `org-tenants.ts` (the OWNER membership
        // for the new tenant) runs in the same transaction as the tenant
        // creation itself — there's no pre-existing tenant ctx to switch
        // into, same pattern as `tenant-lifecycle.ts` above.
        'org-members.ts',
        'org-provisioning.ts',
        'org-tenants.ts',
        // Epic B — org audit ledger is org-scoped (not tenant-scoped).
        // The `OrgAuditLog` table has no `tenantId`; reads filter on
        // `organizationId` against the global prisma instance. Same
        // shape as the other org-level usecases above.
        'org-audit.ts',
        // Epic D — org invitation lifecycle. Same org-scoped shape:
        // OrgInvite/OrgMembership are user-scoped not tenant-scoped,
        // and redeemOrgInvite specifically operates pre-membership
        // (the redeemer is not yet a member, mirroring tenant-invites).
        'org-invites.ts',
        // Epic 41 — configurable dashboard widget CRUD. OrgDashboardWidget
        // is org-scoped, NOT tenant-scoped (not in TENANT_SCOPED_MODELS).
        // Same access shape as org-members.ts / org-invites.ts: global
        // prisma + getOrgCtx for isolation. Read gated by canViewPortfolio,
        // write gated by canConfigureDashboard (ORG_ADMIN only).
        'org-dashboard-widgets.ts',
        // Epic E.3 — request-scoped portfolio data helper. Memoises
        // tenants + snapshots reads via the AsyncLocalStorage
        // RequestContext + WeakMap. The repository methods it calls
        // are themselves org-scoped (not tenant-scoped), so the
        // helper proxies them at the global prisma layer.
        'portfolio-data.ts',
        // Epic O-3 — portfolio aggregation uses `runInGlobalContext` for
        // ComplianceSnapshot reads (org-wide aggregates, no business data)
        // and switches to per-tenant `withTenantDb(tid, ...)` for drill-
        // downs. The cross-tenant fan-out can't fit `runInTenantContext`'s
        // single-tenant RequestContext shape — the WITH_TENANT_DB_ALLOWLIST
        // entry below covers that side.
        'portfolio.ts',
        // Epic 47 — global search reads cross-tenant `Framework` rows
        // (frameworks are not tenant-scoped: they're shared catalogue
        // data). The tenant-scoped portion of the search runs through
        // `runInTenantContext` already; the framework lookup uses the
        // global prisma client because Framework has no `tenantId`
        // column to filter on. Authorization gate: the route's
        // `getTenantCtx` already enforces tenant membership; framework
        // metadata leaks no business data.
        'search.ts',
        // Epic G-3 — public token-gated vendor questionnaire response
        // surface. Token verification (SHA-256 hash compare) precedes
        // tenant resolution: the external respondent has no session
        // and no tenantId until after the token matches an assessment
        // row. `loadResponseByToken` and `submitResponse` therefore
        // use the global prisma client to look up the assessment by
        // hash, then continue under that row's tenantId. RLS bypass
        // is intentional and bounded — every subsequent write goes
        // through `runWithAuditContext` bound to the matched
        // assessment's tenantId. See
        // src/lib/security/external-assessment-access.ts for the
        // verifier and src/lib/errors/route-exemptions.ts for the
        // route-level anti-enumeration shape.
        'vendor-assessment-response.ts',
        // Audit S3 (2026-05-22) — daily cron that sweeps APPROVED
        // evidence past its `nextReviewDate` to NEEDS_REVIEW. Runs
        // either tenant-scoped (one tenant) OR sweep-all (all tenants
        // in one query). The sweep-all mode can't fit
        // `runInTenantContext`'s single-tenant shape; the global
        // prisma + tenantId-optional updateMany is the right call.
        // Pure write-only transition (no business data read), bounded
        // by the WHERE clause.
        'evidence-stale-review-sweep.ts',
        // Audit S6 (2026-05-22) — `notifyAssessmentReviewed` runs
        // post-commit, after `runInTenantContext` has returned, so
        // it needs a non-tenant-bound prisma client to look up the
        // recipient's email and tenant slug. Pre-this-allowlist the
        // file used `require('@/lib/prisma')` inline; the static
        // import is honest about the dependency and the audit
        // confirms it's correctly scoped (email lookup only).
        'vendor-assessment-review.ts',
        // Audit S6 (2026-05-22) — vendor re-assessment reminder cron.
        // Same shape as the evidence-stale-review-sweep above: sweeps
        // all tenants OR scopes to one; bounded WHERE clause; writes
        // a Notification row per overdue vendor + bumps the vendor's
        // nextReviewAt to silence the reminder until next cycle.
        'vendor-reassessment-reminder.ts',
        // Agro-intel — public token-gated data-stream ingestion. Same
        // shape as vendor-assessment-response.ts: the device-facing
        // `ingestReadings` path has NO user RequestContext — token
        // verification (SHA-256 hash compare) precedes tenant
        // resolution, so it looks up the DataStream by id with the
        // global prisma client, then `createMany`s readings under
        // `runWithAuditContext` bound to the matched stream's tenantId.
        // RLS bypass is intentional + bounded (writes scoped to that
        // tenant). The tenant-scoped CRUD in the same file
        // (createDataStream / listDataStreams / listReadings) uses
        // runInTenantContext. See route-exemptions.ts for the
        // anti-enumeration route shape.
        'data-stream.ts',
        // Cadastre ownership — `CadastreOwner` is a GLOBAL open-data cache
        // (no tenantId / no RLS, like CadastreArchive / SoilSample), keyed by
        // cadastral identifier and shared across tenants. `fetchAndStore-
        // CadastreOwners` upserts it with the global prisma client (the same
        // shape the cadastre-import job uses for `cadastreArchive`); there is
        // no tenant to bind and no business data — physical persons are dropped
        // by lib/cadastre/ownership.ts before any write.
        'cadastre-owners.ts',
        // Trends (feat/trends-data-backbone) — `MarketPriceSeries` /
        // `MarketPricePoint` are GLOBAL market-price cache tables (no tenantId
        // / no RLS, like SoilSample / CadastreArchive / Framework), shared
        // identically across every tenant. `getPriceTrends` reads them with the
        // global prisma client because there is no tenantId to filter on — the
        // global handle carries no RLS risk. The read is still access-gated:
        // the route (src/app/api/t/[tenantSlug]/trends/prices/route.ts) calls
        // getTenantCtx to enforce tenant membership before serving; the payload
        // is public reference data (no business data leak).
        'trends.ts',
        // Farm-record traceability — `Framework` / `FrameworkRequirement` are
        // GLOBAL catalog tables (no tenantId / no RLS, like Clause and
        // ControlTemplate): the scheme definition is identical for every
        // tenant. The two reads against the global client resolve the
        // framework and its requirement codes; EVERY tenant-scoped read in the
        // file (controlRequirementLink / evidence / logEntry) runs inside
        // `runInTenantContext` and filters on ctx.tenantId. Access is gated by
        // `assertCanViewFrameworks` before either read.
        'farm-record-traceability.ts',
        // Support schemes — `SupportScheme` is a GLOBAL table (no tenantId / no
        // RLS, like MarketNewsItem / AgriEvent / NewsDerivedEvent): a national
        // ДФЗ or EC measure is the same fact for every tenant, so there is no
        // tenantId to bind. The read is still access-gated — the tenant route
        // calls getTenantCtx before serving — and the payload is public
        // reference data. The review queue is PLATFORM_ADMIN_API_KEY-gated.
        'support-schemes.ts',
    ];

    const usecases = readFilesInDir(path.join(SRC_ROOT, 'app-layer/usecases'));

    for (const file of usecases) {
        if (USECASE_ALLOWLIST.includes(file.name)) continue;

        it(`${file.name} must NOT import global prisma`, () => {
            const hasPrismaImport =
                file.content.includes("from '@/lib/prisma'") ||
                file.content.includes('from "@/lib/prisma"');

            expect(hasPrismaImport).toBe(false);
        });
    }

    // ─── Usecases must use runInTenantContext, not raw withTenantDb ───
    // Exception: background-job modules that accept raw tenantId (no RequestContext)
    // legitimately use the lower-level withTenantDb wrapper. RLS is still enforced.
    const WITH_TENANT_DB_ALLOWLIST = [
        'evidence-maintenance.ts',
        // Epic O-3 — cross-tenant drill-down loops over the org's tenants,
        // running each per-tenant query inside `withTenantDb(tid, ...)`.
        // RLS is preserved per-call (the CISO's auto-provisioned AUDITOR
        // membership is what grants read access). Can't use
        // `runInTenantContext` because that expects a single tenant id
        // on the RequestContext — drill-down is many tenants.
        'portfolio.ts',
        // Enterprise-grain — org portfolio grain aggregation. Same
        // cross-tenant fan-out shape as `portfolio.ts`: walks the org's
        // child tenants and runs each per-tenant grain aggregate inside
        // `withTenantDb(tid, ...)` (RLS-bound, app_user role). Does NOT
        // import the global prisma client — the tenant list comes from
        // the org-scoped `getPortfolioData` helper. Single-tenant
        // `runInTenantContext` can't express the many-tenant fan-out.
        'portfolio-grain.ts',
        // Exchange — cross-tenant P2P marketplace. `createInquiry` commits the
        // inquiry in the INQUIRER's context, then notifies the SELLER's
        // admins/owners. That fanout reads the seller's `TenantMembership`
        // rows and writes `Notification` rows — both RLS-forced tables under a
        // DIFFERENT tenant than `ctx.tenantId`, so it must bind the seller's
        // context via `withTenantDb(listing.sellerTenantId, …)`. Single-tenant
        // `runInTenantContext` can't switch to the seller's tenant. Best-effort
        // + fail-open — the inquiry never rolls back on notify failure.
        'exchange.ts',
    ];

    for (const file of usecases) {
        if (WITH_TENANT_DB_ALLOWLIST.includes(file.name)) continue;

        it(`${file.name} must use runInTenantContext (not raw withTenantDb)`, () => {
            const hasWithTenantDb = file.content.includes('withTenantDb(');
            expect(hasWithTenantDb).toBe(false);
        });
    }

    // ─── ALL route handlers (tenant-scoped + legacy) ───
    // Auth routes are explicitly excluded — they handle registration/login with global tables
    const ROUTE_DIR_ALLOWLIST = [
        'auth', 'health', 'staging', 'scim', 'integrations',
        // SP-4 — the MS Graph change-notification receiver verifies clientState
        // against policy.spSubscriptionId + enqueues a pull job. Caller is Graph
        // (no tenant context); the cross-tenant policy lookup is by id + the
        // verified clientState, not a tenant filter.
        'webhooks',
        // Epic O-1/O-2 — org routes operate at the org-management plane,
        // above tenant scope. They legitimately query the global prisma
        // for Organization + OrgMembership rows (user-scoped, not
        // tenant-scoped — see org_isolation policy). Cross-tenant
        // drill-down INSIDE these routes still uses withTenantDb per-
        // tenant — see `src/app-layer/usecases/portfolio.ts` security-
        // invariant block.
        'org',
        // System-level callbacks invoked by external services without
        // a tenant context. The AV webhook in particular is called by
        // ClamAV / Defender ATP after a scan — it looks up a
        // FileRecord by id (cross-tenant) and updates scan status.
        // The Epic C cast removal exposed this previously-hidden
        // direct-prisma usage; the access pattern is correct, the
        // allowlist entry codifies it.
        'storage',
    ];

    const apiDir = path.join(SRC_ROOT, 'app/api');
    const allRouteFiles = walkDir(apiDir).filter((f) => f.endsWith('route.ts'));

    for (const filePath of allRouteFiles) {
        const relPath = filePath.replace(SRC_ROOT + path.sep, '');

        // Skip allowlisted auth routes
        const pathParts = relPath.split(path.sep);
        const isAllowlisted = ROUTE_DIR_ALLOWLIST.some((dir) =>
            pathParts.includes(dir)
        );
        if (isAllowlisted) continue;

        const content = fs.readFileSync(filePath, 'utf8');
        const nonCommentLines = getNonCommentLines(content);

        it(`route ${relPath} must NOT call prisma directly`, () => {
            const violations = nonCommentLines.filter((line) =>
                /\bprisma\.\w+\b/.test(line) &&
                !line.includes('customPrisma') &&
                !line.includes('globalPrisma')
            );
            expect(violations).toEqual([]);
        });

        it(`route ${relPath} must NOT call logAudit directly`, () => {
            const violations = nonCommentLines.filter((line) =>
                /\blogAudit\s*\(/.test(line)
            );
            expect(violations).toEqual([]);
        });

        it(`route ${relPath} must NOT call requireRole directly`, () => {
            const violations = nonCommentLines.filter((line) =>
                /\brequireRole\s*\(/.test(line)
            );
            expect(violations).toEqual([]);
        });
    }
});

/**
 * Smart-nav — page/subpage segregation source of truth (ported from IC RQ4-1).
 *
 * Every tenant-scoped route is classified as either:
 *
 *   - MAIN     — a top-level sidebar destination. NO back affordance.
 *   - SUBPAGE  — every other route. Eligible for a back affordance.
 *
 * Routes are stored without the /t/[tenantSlug] prefix — written as the
 * user sees them in the address bar (e.g. /locations,
 * /locations/[locationId]). Dynamic segments use the Next.js [param]
 * form verbatim so normalizePathname can map a runtime path back to its
 * pattern (/t/acme/locations/l1 → /locations/[locationId]).
 */

export type RouteClass = 'main' | 'subpage' | 'unknown';

/**
 * Subpages that intentionally DO NOT render <BackAffordance>:
 *   - redirect shims (the .../new create paths) — no UI to attach to;
 *   - auth / onboarding flow pages — a back link would let the user
 *     bypass a required gating step;
 *   - print views — chrome-less by design.
 */
export const BACK_AFFORDANCE_EXEMPT_SUBPAGES: readonly string[] = [
    '/assets/new',          // redirect shim
    '/audits/new',          // redirect shim
    '/auth/mfa',            // auth flow — back would bypass MFA challenge
    '/controls/new',        // redirect shim
    '/issues/[issueId]',    // legacy redirect → /farm-tasks/[taskId]
    '/issues/dashboard',    // legacy redirect
    '/issues/new',          // legacy redirect
    '/onboarding',          // forced flow — back would skip a required step
    '/policies/new',        // redirect shim
    '/risks/new',           // redirect shim
    '/security/mfa',        // self-service security flow
    '/vendors/new',         // redirect shim
] as const;

/**
 * Top-level sidebar destinations. Reached from the primary navigation;
 * they have no parent within the tenant scope, so no back affordance.
 * The Grain module links straight to its sub-routes (there is no /grain
 * index), so those count as top-level destinations too.
 */
export const MAIN_PAGES: readonly string[] = [
    '/access-reviews',
    '/admin',
    '/assets',
    '/audits',
    '/calendar',
    '/clauses',
    '/controls',
    '/coverage',
    '/dashboard',
    '/evidence',
    '/farm-tasks',
    '/findings',
    '/grain/bins',
    '/grain/contracts',
    '/grain/costs',
    '/grain/yield',
    '/inventory',
    '/issues',
    '/journal',
    '/knowledge',
    '/locations',
    '/mapping',
    '/notifications',
    '/planning',
    '/policies',
    '/processes',
    '/risks',
    '/tests',
    '/vendors',
] as const;

/**
 * Every other tenant-scoped route. Dynamic segments are written as
 * [param] and matched by normalizePathname before lookup.
 */
export const SUBPAGES: readonly string[] = [
    // Access reviews
    '/access-reviews/[reviewId]',

    // Admin subpages
    '/admin/api-keys',
    '/admin/audit-log',
    '/admin/billing',
    '/admin/entra',
    '/admin/integrations',
    '/admin/integrations/sharepoint-health',
    '/admin/ledger-integrity',
    '/admin/members',
    '/admin/modules',
    '/admin/notifications',
    '/admin/rbac',
    '/admin/roles',
    '/admin/scim',
    '/admin/security',
    '/admin/sso',
    '/admin/vendor-assessment-reviews/[assessmentId]',
    '/admin/vendor-templates',
    '/admin/vendor-templates/[templateId]',

    // Assets
    '/assets/[id]',
    '/assets/new',

    // Audits
    '/audits/auditor',
    '/audits/cycles',
    '/audits/cycles/[cycleId]',
    '/audits/cycles/[cycleId]/readiness',
    '/audits/new',
    '/audits/packs/[packId]',
    '/audits/readiness',

    // Auth (in-app)
    '/auth/mfa',

    // Controls
    '/controls/[controlId]',
    '/controls/[controlId]/tests/[planId]',
    '/controls/dashboard',
    '/controls/new',
    '/controls/sankey',
    '/controls/templates',

    // Field operator view
    '/field/[taskId]',

    // Frameworks

    // Issues (legacy → tasks)
    '/issues/[issueId]',
    '/issues/dashboard',
    '/issues/new',

    // Journal
    '/journal/[id]',

    // Knowledge
    '/knowledge/[id]',

    // Locations
    '/locations/[locationId]',

    // Onboarding
    '/onboarding',

    // Planning
    '/planning/[cropPlanId]',
    '/planning/seasons',

    // Policies
    '/policies/[policyId]',
    '/policies/new',
    '/policies/templates',

    // Processes
    '/processes/governance',

    // Reports

    // Risks
    '/risks/[riskId]',
    '/risks/ai',
    '/risks/board',
    '/risks/correlations',
    '/risks/dashboard',
    '/risks/hierarchy',
    '/risks/import',
    '/risks/kri',
    '/risks/loss-events',
    '/risks/new',
    '/risks/reports',
    '/risks/scenarios',

    // Security (self-service)
    '/security/mfa',

    // Farm tasks (the single task detail — reached from /farm-tasks)
    '/farm-tasks/[taskId]',

    // Tests
    '/tests/dashboard',
    '/tests/due',
    '/tests/runs/[runId]',

    // Vendors
    '/vendors/[vendorId]',
    '/vendors/[vendorId]/assessment/[assessmentId]',
    '/vendors/dashboard',
    '/vendors/new',
] as const;

/**
 * Normalise a runtime pathname (with the tenant prefix and concrete
 * dynamic-segment values) to the canonical form used in MAIN_PAGES /
 * SUBPAGES.
 *
 *   /t/acme/locations/l1  →  /locations/[locationId]
 *   /t/acme/dashboard     →  /dashboard
 *
 * Returns the matched pattern, or null if the path doesn't fit the
 * tenant-scoped shape / isn't a known route.
 */
export function normalizePathname(pathname: string): string | null {
    const stripped = pathname.replace(/^\/t\/[^/]+/, '');
    if (!stripped.startsWith('/')) return null;

    // Longest (most-segmented) patterns first so a nested route wins over
    // a shorter prefix match.
    const sorted = [...MAIN_PAGES, ...SUBPAGES].sort(
        (a, b) => b.split('/').length - a.split('/').length,
    );

    for (const pattern of sorted) {
        if (matchesPattern(stripped, pattern)) return pattern;
    }
    return null;
}

function matchesPattern(pathname: string, pattern: string): boolean {
    const pathSegs = pathname.split('/').filter(Boolean);
    const patternSegs = pattern.split('/').filter(Boolean);
    if (pathSegs.length !== patternSegs.length) return false;
    for (let i = 0; i < patternSegs.length; i++) {
        const p = patternSegs[i];
        if (p.startsWith('[') && p.endsWith(']')) continue;
        if (p !== pathSegs[i]) return false;
    }
    return true;
}

/**
 * Classify a runtime pathname:
 *   - 'main'    — the route is in MAIN_PAGES (no back affordance)
 *   - 'subpage' — the route is in SUBPAGES
 *   - 'unknown' — outside the tenant scope or not classified
 */
export function classifyRoute(pathname: string): RouteClass {
    const normalized = normalizePathname(pathname);
    if (!normalized) return 'unknown';
    if ((MAIN_PAGES as readonly string[]).includes(normalized)) return 'main';
    if ((SUBPAGES as readonly string[]).includes(normalized)) return 'subpage';
    return 'unknown';
}

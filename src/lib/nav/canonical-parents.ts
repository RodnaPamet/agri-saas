/**
 * Smart-nav — canonical parent resolver (ported from IC RQ4-4).
 *
 * Maps each subpage to the page the back affordance should fall back to
 * when no in-tab referrer is available (cold load, fresh tab, deep link).
 *
 * Convention: the canonical parent is the route one structural step up in
 * the information architecture — NOT necessarily the URL parent. A nested
 * subpage like `/vendors/[vendorId]/assessment/[assessmentId]` falls back
 * to `/vendors/[vendorId]` (its parent entity), not `/vendors`.
 *
 * Patterns are written in the `[param]` form; `normalizePathname` maps a
 * runtime pathname to a pattern before lookup, and `expandDynamicSegments`
 * carries concrete segment values from the child into the parent href.
 */
import { normalizePathname } from './page-segregation';

export interface CanonicalParent {
    /** Pattern relative to `/t/[tenantSlug]` — joined at render time. */
    href: string;
    /** Trailing portion of the affordance label: "← <label>". */
    label: string;
}

const PARENT_MAP: Record<string, CanonicalParent> = {
    // ── Farm ──────────────────────────────────────────────────────────
    '/assets/[id]': { href: '/assets', label: 'assets' },
    '/assets/new': { href: '/assets', label: 'assets' },
    '/locations/[locationId]': { href: '/locations', label: 'locations' },
    '/journal/[id]': { href: '/journal', label: 'journal' },
    '/knowledge/[id]': { href: '/knowledge', label: 'knowledge' },
    '/planning/[cropPlanId]': { href: '/planning', label: 'planning' },
    '/planning/seasons': { href: '/planning', label: 'planning' },
    // Field-operator view + task detail both hang off the Farm Tasks list.
    '/field/[taskId]': { href: '/farm-tasks', label: 'farmTasks' },
    '/farm-tasks/[taskId]': { href: '/farm-tasks', label: 'farmTasks' },

    // ── Access reviews ────────────────────────────────────────────────
    '/access-reviews/[reviewId]': { href: '/access-reviews', label: 'accessReviews' },

    // ── Admin subpages ────────────────────────────────────────────────
    '/admin/api-keys': { href: '/admin', label: 'admin' },
    '/admin/audit-log': { href: '/admin', label: 'admin' },
    '/admin/billing': { href: '/admin', label: 'admin' },
    '/admin/entra': { href: '/admin', label: 'admin' },
    '/admin/integrations': { href: '/admin', label: 'admin' },
    '/admin/integrations/sharepoint-health': { href: '/admin/integrations', label: 'integrations' },
    '/admin/ledger-integrity': { href: '/admin', label: 'admin' },
    '/admin/members': { href: '/admin', label: 'admin' },
    '/admin/modules': { href: '/admin', label: 'admin' },
    '/admin/notifications': { href: '/admin', label: 'admin' },
    '/admin/rbac': { href: '/admin', label: 'admin' },
    '/admin/roles': { href: '/admin', label: 'admin' },
    '/admin/scim': { href: '/admin', label: 'admin' },
    '/admin/security': { href: '/admin', label: 'admin' },
    '/admin/sso': { href: '/admin', label: 'admin' },
    '/admin/vendor-assessment-reviews/[assessmentId]': { href: '/admin', label: 'admin' },
    '/admin/vendor-templates': { href: '/admin', label: 'admin' },
    '/admin/vendor-templates/[templateId]': { href: '/admin/vendor-templates', label: 'vendorTemplates' },

    // ── Audits ────────────────────────────────────────────────────────
    '/audits/auditor': { href: '/audits', label: 'audits' },
    '/audits/cycles': { href: '/audits', label: 'audits' },
    '/audits/cycles/[cycleId]': { href: '/audits/cycles', label: 'auditCycles' },
    '/audits/cycles/[cycleId]/readiness': { href: '/audits/cycles/[cycleId]', label: 'auditCycle' },
    '/audits/new': { href: '/audits', label: 'audits' },
    '/audits/packs/[packId]': { href: '/audits', label: 'audits' },
    '/audits/readiness': { href: '/audits', label: 'audits' },

    // ── Controls ──────────────────────────────────────────────────────
    '/controls/[controlId]': { href: '/controls', label: 'controls' },
    // Test-plan detail lives URL-wise under a control, but the mental
    // model is "I'm working on a test"; canonical parent is the Tests list
    // (the in-tab referrer still wins when drilling in from a control).
    '/controls/[controlId]/tests/[planId]': { href: '/tests', label: 'tests' },
    '/controls/dashboard': { href: '/controls', label: 'controls' },
    '/controls/new': { href: '/controls', label: 'controls' },
    '/controls/sankey': { href: '/controls', label: 'controls' },
    '/controls/templates': { href: '/controls', label: 'controls' },

    // ── Frameworks ────────────────────────────────────────────────────

    // ── Issues (legacy) ───────────────────────────────────────────────
    '/issues/[issueId]': { href: '/issues', label: 'issues' },
    '/issues/dashboard': { href: '/issues', label: 'issues' },
    '/issues/new': { href: '/issues', label: 'issues' },

    // ── Policies ──────────────────────────────────────────────────────
    '/policies/[policyId]': { href: '/policies', label: 'policies' },
    '/policies/new': { href: '/policies', label: 'policies' },
    '/policies/templates': { href: '/policies', label: 'policies' },

    // ── Processes ─────────────────────────────────────────────────────
    '/processes/governance': { href: '/processes', label: 'processes' },

    // ── Reports ───────────────────────────────────────────────────────
    '/reports/soa/print': { href: '/reports/soa', label: 'soa' },

    // ── Risks ─────────────────────────────────────────────────────────
    '/risks/[riskId]': { href: '/risks', label: 'risks' },
    '/risks/ai': { href: '/risks', label: 'risks' },
    '/risks/board': { href: '/risks', label: 'risks' },
    '/risks/correlations': { href: '/risks', label: 'risks' },
    '/risks/dashboard': { href: '/risks', label: 'risks' },
    '/risks/hierarchy': { href: '/risks', label: 'risks' },
    '/risks/import': { href: '/risks', label: 'risks' },
    '/risks/kri': { href: '/risks', label: 'risks' },
    '/risks/loss-events': { href: '/risks', label: 'risks' },
    '/risks/new': { href: '/risks', label: 'risks' },
    '/risks/reports': { href: '/risks', label: 'risks' },
    '/risks/scenarios': { href: '/risks', label: 'risks' },

    // ── Tests ─────────────────────────────────────────────────────────
    '/tests/dashboard': { href: '/tests', label: 'tests' },
    '/tests/due': { href: '/tests', label: 'tests' },
    '/tests/runs/[runId]': { href: '/tests', label: 'tests' },

    // ── Vendors ───────────────────────────────────────────────────────
    '/vendors/[vendorId]': { href: '/vendors', label: 'vendors' },
    '/vendors/[vendorId]/assessment/[assessmentId]': { href: '/vendors/[vendorId]', label: 'vendor' },
    '/vendors/dashboard': { href: '/vendors', label: 'vendors' },
    '/vendors/new': { href: '/vendors', label: 'vendors' },
};

/**
 * Resolve the canonical parent for a runtime pathname. Returns `null` for
 * a route that is not a known subpage (main pages and unknown routes).
 *
 * `tenantSlug` expands `/t/[tenantSlug]` into the returned href. Dynamic-
 * segment values in the child's pattern are inherited into the parent href
 * when the parent references the SAME segment — so
 * `/t/acme/vendors/v1/assessment/a1` → `/t/acme/vendors/v1`.
 */
export function resolveCanonicalParent(
    pathname: string,
    tenantSlug: string,
): CanonicalParent | null {
    const pattern = normalizePathname(pathname);
    if (!pattern) return null;
    const parent = PARENT_MAP[pattern];
    if (!parent) return null;

    const expandedHref = expandDynamicSegments(parent.href, pattern, pathname);
    return {
        href: `/t/${tenantSlug}${expandedHref}`,
        label: parent.label,
    };
}

/**
 * Substitute `[param]` placeholders in the parent's href with concrete
 * values from the child's pathname. Only segments that appear in BOTH the
 * child pattern and the parent href are substituted.
 */
function expandDynamicSegments(
    parentHref: string,
    childPattern: string,
    childPathname: string,
): string {
    const childPath = childPathname.replace(/^\/t\/[^/]+/, '');
    const childPatSegs = childPattern.split('/').filter(Boolean);
    const childPathSegs = childPath.split('/').filter(Boolean);
    const dynamicValues = new Map<string, string>();
    for (let i = 0; i < childPatSegs.length; i++) {
        const seg = childPatSegs[i];
        if (seg.startsWith('[') && seg.endsWith(']') && childPathSegs[i]) {
            dynamicValues.set(seg, childPathSegs[i]);
        }
    }
    return parentHref
        .split('/')
        .map((seg) => dynamicValues.get(seg) ?? seg)
        .join('/');
}

export const CANONICAL_PARENT_MAP_INTERNAL = PARENT_MAP;

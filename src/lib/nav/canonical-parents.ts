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

    // ── Practices ──────────────────────────────────────────────────────
    // Test-plan detail lives URL-wise under a practice, but the mental
    // model is "I'm working on a test"; canonical parent is the Tests list
    // (the in-tab referrer still wins when drilling in from a practice).

    // ── Frameworks ────────────────────────────────────────────────────

    // ── Issues (legacy) ───────────────────────────────────────────────
    '/issues/[issueId]': { href: '/issues', label: 'issues' },
    '/issues/dashboard': { href: '/issues', label: 'issues' },
    '/issues/new': { href: '/issues', label: 'issues' },

    // ── Processes ─────────────────────────────────────────────────────
    '/processes/governance': { href: '/processes', label: 'processes' },

    // ── Risks ─────────────────────────────────────────────────────────

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
 *
 * EXPORTED FOR TESTING. No route in the app currently has a dynamic
 * PARENT — `/vendors/[vendorId]/assessment/[assessmentId]` was the only
 * two-level dynamic route and left with the GRC teardown, so today every
 * parent href is static and this function is an identity map in practice.
 * It is kept because the capability is real (e.g. a future
 * `/locations/[locationId]/parcels/[parcelId]`), and exported so the
 * behaviour stays covered directly rather than depending on some route
 * happening to exercise it — testing it only through `resolveCanonicalParent`
 * would have silently lost the coverage when that route was deleted.
 */
export function expandDynamicSegments(
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

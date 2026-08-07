'use client';

/**
 * Smart-nav — back affordance primitive (ported from IC RQ4-4).
 *
 * The thin "← <Destination>" row above a subpage title. Two-tier
 * resolution:
 *
 *   1. Referrer (smart) — the in-tenant pathname the user just navigated
 *      from, read from per-tab sessionStorage via `usePreviousPath`.
 *   2. Canonical fallback — when no referrer is available (cold load,
 *      deep link, fresh tab), the IA-canonical parent from
 *      `resolveCanonicalParent`.
 *
 * `<PageHeader>` accepts `back={{ smart: true }}` to mount this primitive;
 * the existing static `{ href, label }` form keeps working unchanged. The
 * rendered markup (arrow + label, `data-testid="page-header-back"`)
 * matches the static form so both look identical.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
    usePreviousPath,
    tenantSlugFromPath,
} from '@/lib/nav/usePreviousPath';
import {
    resolveCanonicalParent,
    type CanonicalParent,
} from '@/lib/nav/canonical-parents';

/**
 * In-tenant section paths → canonical display name for the REFERRER label
 * ("← Locations" when you came from the Locations list). An unmapped
 * section falls back to capitalising the first segment.
 */
const SECTION_LABELS: Record<string, string> = {
    '/access-reviews': 'accessReviews',
    '/admin': 'admin',
    '/assets': 'assets',
    '/audits': 'audits',
    '/calendar': 'calendar',
    '/clauses': 'clauses',
    '/controls': 'controls',
    '/coverage': 'coverage',
    '/dashboard': 'dashboard',
    '/evidence': 'evidence',
    '/farm-tasks': 'farmTasks',
    '/field': 'farmTasks',
    '/findings': 'findings',
    '/grain': 'grain',
    '/inventory': 'inventory',
    '/issues': 'issues',
    '/journal': 'journal',
    '/knowledge': 'knowledge',
    '/locations': 'locations',
    '/mapping': 'mapping',
    '/notifications': 'notifications',
    '/planning': 'planning',
    '/policies': 'policies',
    '/processes': 'processes',
    '/risks': 'risks',
    '/schemes': 'schemes',
    '/tests': 'tests',
    '/vendors': 'vendors',
};

/** Derive the "where you came from" label from an in-tenant pathname. */
function labelFromPathname(pathname: string): string {
    const stripped = pathname.replace(/^\/t\/[^/]+/, '');
    const seg = stripped.split('/').filter(Boolean)[0];
    if (!seg) return 'previousPage';
    const sectionKey = `/${seg}`;
    if (SECTION_LABELS[sectionKey]) return SECTION_LABELS[sectionKey];
    return seg.charAt(0).toUpperCase() + seg.slice(1);
}

export interface BackAffordanceProps {
    /** Optional override — used by tests + the static `back` form. */
    override?: CanonicalParent;
    /**
     * When true, render ONLY when an in-tab referrer exists (no canonical
     * fallback). Use on MAIN pages that are sometimes deep-linked FROM
     * elsewhere so the back link appears only when the user actually
     * arrived from somewhere in the app.
     */
    noFallback?: boolean;
}

export function BackAffordance({ override, noFallback }: BackAffordanceProps) {
    const t = useTranslations('backNav');
    const pathname = usePathname() ?? '';
    const tenantSlug = tenantSlugFromPath(pathname);
    const referrer = usePreviousPath(tenantSlug);

    let destination: CanonicalParent | null = null;
    if (override) {
        destination = override;
    } else if (tenantSlug) {
        const canonical = noFallback
            ? null
            : resolveCanonicalParent(pathname, tenantSlug);
        // Sibling-detail guard: when the referrer is a SIBLING of the
        // current page (both resolve to the same canonical parent — e.g.
        // stepping /assets/A → /assets/B via prev/next), "back" must NOT
        // return to the sibling (the circular back-to-back bug). Skip the
        // referrer and go to the shared canonical parent (the list).
        const referrerIsSibling =
            referrer != null &&
            canonical != null &&
            resolveCanonicalParent(referrer, tenantSlug)?.href === canonical.href;
        if (referrer && referrer !== pathname && !referrerIsSibling) {
            destination = { href: referrer, label: labelFromPathname(referrer) };
        } else {
            destination = canonical;
        }
    }

    if (!destination) return null;

    // `destination.label` is an i18n KEY for known sections (canonical parents +
    // SECTION_LABELS); resolve it. Dynamic fallbacks (a capitalised unknown
    // segment) and explicit `override` labels aren't keys — pass them through.
    const label = t.has(destination.label) ? t(destination.label) : destination.label;

    return (
        <Link
            href={destination.href}
            className="text-content-muted text-xs hover:text-content-emphasis transition-colors duration-150 ease-out"
            data-testid="page-header-back"
            aria-label={t('backTo', { label })}
        >
            ← {label}
        </Link>
    );
}

export default BackAffordance;

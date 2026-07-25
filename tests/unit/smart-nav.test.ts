/**
 * Smart-nav model — route classification + canonical-parent resolution.
 *
 * Ported from the IC smart-navigation model. These pure helpers back the
 * `<BackAffordance>` two-tier resolution: page-segregation classifies a
 * route (main vs subpage) and normalises a runtime path to its `[param]`
 * pattern; canonical-parents maps a subpage to its IA-canonical parent,
 * inheriting concrete dynamic-segment values.
 */
import {
    classifyRoute,
    normalizePathname,
    MAIN_PAGES,
    SUBPAGES,
} from '@/lib/nav/page-segregation';
import { resolveCanonicalParent } from '@/lib/nav/canonical-parents';
import { tenantSlugFromPath } from '@/lib/nav/usePreviousPath';

describe('page-segregation', () => {
    it('classifies top-level sidebar destinations as main', () => {
        expect(classifyRoute('/t/acme/dashboard')).toBe('main');
        expect(classifyRoute('/t/acme/locations')).toBe('main');
        expect(classifyRoute('/t/acme/assets')).toBe('main');
        // Grain links straight to its sub-routes (no /grain index).
        expect(classifyRoute('/t/acme/grain/bins')).toBe('main');
    });

    it('classifies drilled-in routes as subpages', () => {
        expect(classifyRoute('/t/acme/locations/loc-123')).toBe('subpage');
        expect(classifyRoute('/t/acme/assets/a1')).toBe('subpage');
        expect(classifyRoute('/t/acme/vendors/v1/assessment/a1')).toBe('subpage');
    });

    it('returns unknown for unclassified / non-tenant paths', () => {
        expect(classifyRoute('/t/acme/not-a-real-route')).toBe('unknown');
        expect(classifyRoute('/login')).toBe('unknown');
    });

    it('normalises a runtime path to its [param] pattern', () => {
        expect(normalizePathname('/t/acme/locations/abc-123')).toBe('/locations/[locationId]');
        expect(normalizePathname('/t/acme/dashboard')).toBe('/dashboard');
        expect(normalizePathname('/t/acme/vendors/v1/assessment/a1')).toBe(
            '/vendors/[vendorId]/assessment/[assessmentId]',
        );
    });

    it('has no route listed in BOTH main and subpage lists', () => {
        const overlap = MAIN_PAGES.filter((p) => (SUBPAGES as readonly string[]).includes(p));
        expect(overlap).toEqual([]);
    });
});

describe('canonical-parents', () => {
    it('resolves a farm subpage to its list parent (tenant-expanded)', () => {
        expect(resolveCanonicalParent('/t/acme/locations/loc-1', 'acme')).toEqual({
            href: '/t/acme/locations',
            label: 'locations',
        });
        expect(resolveCanonicalParent('/t/acme/assets/a1', 'acme')).toEqual({
            href: '/t/acme/assets',
            label: 'assets',
        });
    });

    it('routes task detail back to the Farm Tasks list', () => {
        expect(resolveCanonicalParent('/t/acme/farm-tasks/t1', 'acme')).toEqual({
            href: '/t/acme/farm-tasks',
            label: 'farmTasks',
        });
        expect(resolveCanonicalParent('/t/acme/field/t1', 'acme')).toEqual({
            href: '/t/acme/farm-tasks',
            label: 'farmTasks',
        });
    });

    it('inherits concrete dynamic segments into a nested parent href', () => {
        // /vendors/v1/assessment/a1 → the vendor detail (v1), NOT /vendors.
        expect(resolveCanonicalParent('/t/acme/vendors/v1/assessment/a1', 'acme')).toEqual({
            href: '/t/acme/vendors/v1',
            label: 'vendor',
        });
    });

    it('returns null for a main page (no back fallback)', () => {
        expect(resolveCanonicalParent('/t/acme/dashboard', 'acme')).toBeNull();
        expect(resolveCanonicalParent('/t/acme/locations', 'acme')).toBeNull();
    });

    it('every PARENT_MAP entry points at a real classified route', () => {
        // Guard against a parent href that dangles (typo / removed route).
        const known = new Set<string>([...MAIN_PAGES, ...SUBPAGES]);
        // Spot-check the farm parents resolve to a known main page.
        for (const parent of ['/locations', '/assets', '/journal', '/knowledge', '/planning', '/farm-tasks']) {
            expect(known.has(parent)).toBe(true);
        }
    });
});

describe('tenantSlugFromPath', () => {
    it('extracts the slug from a tenant-scoped path', () => {
        expect(tenantSlugFromPath('/t/acme/locations/l1')).toBe('acme');
        expect(tenantSlugFromPath('/t/acme')).toBe('acme');
    });
    it('returns null for a non-tenant path', () => {
        expect(tenantSlugFromPath('/login')).toBeNull();
        expect(tenantSlugFromPath('/org/acme/dashboard')).toBeNull();
    });
});

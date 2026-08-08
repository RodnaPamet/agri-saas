/**
 * Epic 53 — filter-system standardisation guardrails.
 *
 * Pins the rollout invariants so regressions in a future PR are caught at
 * CI time rather than by a bug report from a page that silently fell back
 * to the legacy filter stack.
 *
 * Guarded invariants:
 *   1. Every DataTable-backed list page ships a `filter-defs.ts` colocated
 *      with the page.
 *   2. Those pages import from the shared `@/components/ui/filter` stack
 *      and the shared `FilterToolbar`.
 *   3. They do NOT import `CompactFilterBar` / `useUrlFilters` (the legacy
 *      system) — exception: Evidence's retention tab, which reserves
 *      `useUrlFilters(['tab'])` for a view selector and is not a filter.
 *   4. Each filter-defs module imports from concrete sub-modules
 *      (`filter-definitions`, `types`) rather than the barrel, so jest's
 *      node env can load them without pulling in tsx components.
 *   5. The shared `FilterToolbar` primitive exists and exports its component.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
const PAGES_ROOT = path.join(ROOT, 'src/app/t/[tenantSlug]/(app)');

/**
 * DataTable-backed list pages that must be on the shared filter system.
 * Add new pages here as they land — the rest of the guardrail runs against
 * this single list so the rollout expectation is legible.
 */
const MIGRATED_PAGES: Array<{
    dir: string;
    client: string;
    /** Set when the page uses useUrlFilters for a non-filter view slot. */
    allowLegacyUrlFilterScope?: string[];
}> = [
    { dir: 'controls', client: 'ControlsClient.tsx' },
    { dir: 'evidence', client: 'EvidenceClient.tsx', allowLegacyUrlFilterScope: ['tab', 'view'] },
    { dir: 'policies', client: 'PoliciesClient.tsx' },
    { dir: 'farm-tasks', client: 'FarmTasksClient.tsx' },
    { dir: 'vendors', client: 'VendorsClient.tsx' },
    { dir: 'assets', client: 'AssetsClient.tsx' },
];

function read(p: string) {
    return fs.readFileSync(p, 'utf-8');
}

// ─── 1. filter-defs.ts exists and is colocated ──────────────────────

describe('Every migrated list page colocates a filter-defs.ts', () => {
    it.each(MIGRATED_PAGES)('%s has filter-defs.ts', (page) => {
        const defsPath = path.join(PAGES_ROOT, page.dir, 'filter-defs.ts');
        expect(fs.existsSync(defsPath)).toBe(true);
    });
});

// ─── 2. Client imports the shared stack + FilterToolbar ────────────

describe('Every migrated client imports the shared filter stack', () => {
    it.each(MIGRATED_PAGES)('%s imports useFilterContext + a FilterToolbar host', (page) => {
        const src = read(path.join(PAGES_ROOT, page.dir, page.client));
        expect(src).toMatch(/from ['"]@\/components\/ui\/filter['"]/);
        expect(src).toMatch(/useFilterContext/);
        // FilterToolbar may be imported + rendered DIRECTLY (the
        // original Epic 53 pattern), OR mounted via <EntityListPage>
        // (the Epic 91 layout shell that hosts FilterToolbar
        // internally — see EntityListPage.tsx). Both shapes deliver
        // the same shared filter stack to the user.
        const usesFilterToolbarDirectly =
            /from ['"]@\/components\/filters\/FilterToolbar['"]/.test(src) &&
            /<FilterToolbar\b/.test(src);
        const usesEntityListPage =
            /from ['"]@\/components\/layout\/EntityListPage['"]/.test(src) &&
            /<EntityListPage\b/.test(src);
        expect(usesFilterToolbarDirectly || usesEntityListPage).toBe(true);
    });
});

// ─── 3. No legacy imports on migrated pages ─────────────────────────

describe('Migrated pages do not import the legacy filter stack', () => {
    it.each(MIGRATED_PAGES)('%s does not import CompactFilterBar', (page) => {
        const src = read(path.join(PAGES_ROOT, page.dir, page.client));
        expect(src).not.toMatch(/CompactFilterBar/);
        expect(src).not.toMatch(/components\/filters\/configs['"]/);
    });

    it.each(MIGRATED_PAGES)('%s bounds useUrlFilters to an allowlisted view slot', (page) => {
        const src = read(path.join(PAGES_ROOT, page.dir, page.client));
        const matches = src.match(/useUrlFilters\(\[([^\]]*)\]/g) ?? [];
        for (const m of matches) {
            const keys = (m.match(/['"][^'"]+['"]/g) ?? []).map((k) => k.replace(/['"]/g, ''));
            // Strip any keys the page is explicitly allowed to keep on useUrlFilters.
            const leftover = keys.filter((k) => !(page.allowLegacyUrlFilterScope ?? []).includes(k));
            expect(leftover).toEqual([]);
        }
    });
});

// ─── 4. filter-defs import hygiene (jest-loadable) ──────────────────

describe('filter-defs.ts uses sub-module imports (not the barrel)', () => {
    it.each(MIGRATED_PAGES)('%s/filter-defs.ts imports from concrete sub-modules (not the barrel)', (page) => {
        const src = read(path.join(PAGES_ROOT, page.dir, 'filter-defs.ts'));
        // Must reach the pure layer directly — never the barrel, since the
        // barrel imports tsx files that the node-env jest can't load.
        expect(src).toMatch(/from ['"]@\/components\/ui\/filter\/filter-definitions['"]/);
        expect(src).not.toMatch(/from ['"]@\/components\/ui\/filter['"]/);
        // If this filter-defs references FilterOption at all, it should pull
        // that type from the concrete `./types` path. Pages with only enum
        // filters legitimately skip this import.
        if (src.includes('FilterOption')) {
            expect(src).toMatch(/from ['"]@\/components\/ui\/filter\/types['"]/);
        }
    });

    it.each(MIGRATED_PAGES)('%s/filter-defs.ts uses createTypedFilterDefs', (page) => {
        const src = read(path.join(PAGES_ROOT, page.dir, 'filter-defs.ts'));
        expect(src).toMatch(/createTypedFilterDefs/);
    });

    it.each(MIGRATED_PAGES)('%s/filter-defs.ts exports a build*Filters helper', (page) => {
        const src = read(path.join(PAGES_ROOT, page.dir, 'filter-defs.ts'));
        expect(src).toMatch(/export function build\w+Filters\b/);
    });
});

// ─── 5. Shared toolbar primitive exists ─────────────────────────────

describe('FilterToolbar shared primitive contract', () => {
    const toolbarPath = path.join(ROOT, 'src/components/filters/FilterToolbar.tsx');

    it('exists at the canonical path', () => {
        expect(fs.existsSync(toolbarPath)).toBe(true);
    });

    it('is a client component exporting the documented prop surface', () => {
        const src = read(toolbarPath);
        expect(src).toMatch(/^'use client'/);
        expect(src).toMatch(/export function FilterToolbar\b/);
        for (const prop of ['filters', 'searchId', 'searchPlaceholder', 'triggerLabel', 'className']) {
            expect(src).toContain(prop);
        }
    });

    it('consumes the shared FilterProvider via useFilters (no local state duplication)', () => {
        const src = read(toolbarPath);
        expect(src).toMatch(/useFilters\(\)/);
        expect(src).toMatch(/<FilterUI\.Select\b/);
        expect(src).toMatch(/<FilterUI\.List\b/);
    });
});

// ─── 6. No undocumented list page silently uses the legacy stack ─────

describe('No DataTable-backed page uses CompactFilterBar outside the allowlist', () => {
    it('scans all *Client.tsx files and fails on unregistered CompactFilterBar usage', () => {
        const allowed = new Set(MIGRATED_PAGES.map((p) => path.join(PAGES_ROOT, p.dir, p.client)));
        const offenders: string[] = [];

        function walk(dir: string) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.isFile() && /Client\.tsx$/.test(entry.name)) {
                    const src = read(full);
                    if (src.includes('CompactFilterBar') && !allowed.has(full)) {
                        offenders.push(path.relative(ROOT, full));
                    }
                }
            }
        }

        walk(PAGES_ROOT);

        // Any page using CompactFilterBar that isn't in MIGRATED_PAGES is a
        // drift: either migrate it or extend the allowlist consciously.
        expect(offenders).toEqual([]);
    });
});

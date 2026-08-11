/**
 * A grain surface has to be registered in THREE places, and only one of
 * them is visible while you are building the page.
 *
 * ── The regression this exists for ──────────────────────────────────
 *
 * The calculator (`/grain/calculator`) shipped its page, its tests, its
 * copy in both locales — and an entry in `GrainSectionNav` only. That
 * nav is the in-page link row, so it renders on the very page you are
 * staring at while you work, which is exactly why it is the one you
 * remember. The SIDEBAR is the nav a user actually navigates FROM, and
 * it had no calculator entry at all: the page was reachable by typing
 * the URL, or by first landing on one of the other five grain pages.
 * From the sidebar the surface did not exist.
 *
 * Payroll (#524) missed a different one of the three — it is in the
 * sidebar but never landed in `MAIN_PAGES`, so `classifyRoute` answers
 * `'unknown'` for it and the smart-nav back affordance is deciding by
 * fallback rather than by classification.
 *
 * Two surfaces, two different halves forgotten, nothing red. The three
 * registries have no structural link between them, so this test is it.
 *
 * ── Why not just "remember" ─────────────────────────────────────────
 *
 * `tests/unit/smart-nav.test.ts` spot-checks a handful of routes by
 * hand (`/grain/bins` is `'main'`), which is a fine assertion and a
 * useless ratchet: it can only ever cover the routes someone thought to
 * type into it. This derives the expected set from `GrainSectionNav`'s
 * own `SECTIONS` array, so a seventh grain surface is covered the
 * moment it is added there — the one place a new surface is guaranteed
 * to be registered, because it is the one the author is looking at.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const SECTION_NAV = path.join(
    ROOT,
    'src/app/t/[tenantSlug]/(app)/grain/GrainSectionNav.tsx',
);
const SIDEBAR = path.join(ROOT, 'src/components/layout/SidebarNav.tsx');
const SEGREGATION = path.join(ROOT, 'src/lib/nav/page-segregation.ts');

const read = (p: string) => fs.readFileSync(p, 'utf-8');

/**
 * The grain surfaces, derived from `GrainSectionNav`'s SECTIONS rather
 * than hand-listed here. Each entry is `{ key, path }` — the same pair
 * the other two registries need.
 */
function grainSections(): Array<{ key: string; routePath: string }> {
    const src = read(SECTION_NAV);
    const block = src.slice(
        src.indexOf('const SECTIONS'),
        src.indexOf('export function GrainSectionNav'),
    );
    const found = [...block.matchAll(/key:\s*'([a-z]+)'\s*,\s*path:\s*'([^']+)'/g)];
    return found.map((m) => ({ key: m[1], routePath: m[2] }));
}

describe('grain surfaces are registered in every nav registry', () => {
    const sections = grainSections();

    it('finds the grain surfaces (guard is not vacuously passing)', () => {
        // If the SECTIONS shape is ever refactored the regex above stops
        // matching, and every assertion below would pass over an empty
        // array. Fail loudly instead of silently covering nothing.
        expect(sections.length).toBeGreaterThanOrEqual(6);
        expect(sections.map((s) => s.key)).toContain('calculator');
    });

    it.each(grainSections())(
        'the sidebar links to $routePath — the nav a user navigates FROM',
        ({ routePath }) => {
            expect(read(SIDEBAR)).toContain(`tenantHref('${routePath}')`);
        },
    );

    it.each(grainSections())(
        '$routePath is classified in MAIN_PAGES (no back affordance on a top-level destination)',
        ({ routePath }) => {
            const mainBlock = read(SEGREGATION).slice(
                read(SEGREGATION).indexOf('export const MAIN_PAGES'),
                read(SEGREGATION).indexOf('export const SUBPAGES'),
            );
            expect(mainBlock).toContain(`'${routePath}'`);
        },
    );

    it.each(grainSections())(
        '$key has a sidebarNav label in BOTH locales',
        ({ key }) => {
            // The sidebar renders `t(key)` from the `sidebarNav` namespace,
            // which is a DIFFERENT namespace from the in-page row's
            // `grain.nav` — having one is no evidence of the other.
            const en = JSON.parse(read(path.join(ROOT, 'messages/en.json')));
            const bg = JSON.parse(read(path.join(ROOT, 'messages/bg.json')));
            expect(typeof en.sidebarNav[key]).toBe('string');
            expect(typeof bg.sidebarNav[key]).toBe('string');
        },
    );
});

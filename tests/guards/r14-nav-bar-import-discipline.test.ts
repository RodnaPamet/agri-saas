/**
 * Roadmap-14 PR-1 — `<NavBar>` primitive extraction discipline.
 *
 * Until R14-PR1, `<TopChrome>` hand-rolled the entire `<header
 * role="banner">` element — slot layout, sticky positioning, glass
 * blur, breakpoint behaviour — inline alongside its breadcrumbs +
 * identity-pill content. That coupling meant every later R14 PR
 * (brand mark, env badge, switcher, search, notifications, user
 * menu, living-chrome polish, mobile parity) would have to touch
 * one large file mixing structural concerns with content.
 *
 * R14-PR1 extracts the structural shell into `<NavBar>` (a new
 * `src/components/layout/nav-bar.tsx`) and migrates `<TopChrome>`
 * to be a thin consumer that fills three named slots. This ratchet
 * locks the boundary:
 *
 *   1. `nav-bar.tsx` exists and exports `NavBar`.
 *   2. The shell `<header role="banner">` lives ONLY inside that
 *      file — no other file in `src/components/layout/` may render
 *      a `<header>` with the chrome's load-bearing class string.
 *   3. `<TopChrome>` consumes `NavBar` (named import) rather than
 *      rendering its own `<header>`.
 *   4. The three slot recipes (LEFT / CENTER / RIGHT) are
 *      exported as named consts so later PRs can compose them
 *      without re-deriving the geometry.
 *   5. `NavBar`'s JSX maps every slot prop to a slot div — no
 *      slot is silently dropped.
 *
 * What this ratchet does NOT police:
 *
 *   - The slot contents. PR-3..PR-12 each fill specific slots;
 *     each PR ships its own discipline ratchet.
 *   - Geometry values (h-14, gap-default, px-4 md:px-6). R14-PR2
 *     extracts them into named tokens; the lock moves there.
 *   - The mobile-hidden behaviour (`hidden md:flex`). That's
 *     covered by `top-chrome-discipline.test.ts` (R2-era ratchet,
 *     pointed at nav-bar.tsx by R14-PR1).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');
const NAV_BAR_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-bar.tsx'),
    'utf8',
);
const TOP_CHROME_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/TopChrome.tsx'),
    'utf8',
);

/**
 * Every file in `layout/` except the one that legitimately owns the banner.
 *
 * Was a NON-RECURSIVE `readdirSync` inside the `it()` below, so
 * `selector-teeth` had nothing at module scope to mutate while
 * `expect(offenders).toEqual([])` is satisfied for free by an empty read
 * (#2483 class A).
 *
 * This migration WIDENS the population from flat to recursive, which is a
 * judgement rather than a translation — so, the reasoning: the `describe` is
 * "no parallel `<header>` chrome ELSEWHERE IN layout/", and a subdirectory of
 * `layout/` is in `layout/`. A nested layout component rendering a second
 * `<header role="banner">` is exactly what this guard exists to forbid, and the
 * flat read could not see it. Measured 2026-10-31: 29 files either way, and
 * `layout/` has 0 subdirectories — so the widening changes nothing today and
 * closes the hole for the first one added.
 *
 * `skipDirs` is explicit because the extensions include `.ts`:
 * `DEFAULT_SKIP_DIRS` excludes any directory named `coverage` or `dist` BY
 * NAME, which cost a real API route its place in the inventory once (#2421,
 * #2517).
 */
/**
 * Does this source render a `<header role="banner">` shell?
 *
 * Extracted from the `it()` below so the detector can be aimed at a file
 * KNOWN to satisfy it — see the positive control at the bottom of this file.
 * Comments are blanked first, so a docblock mentioning `<header
 * role="banner">` does not count as rendering one.
 */
function rendersBanner(source: string): boolean {
    const stripped = blankNonCode(source);
    return (
        /<header\b[^>]*role="banner"/.test(stripped) ||
        /<header[\s\S]{0,80}role="banner"/.test(stripped)
    );
}

const LAYOUT_FILES = collectSourceFiles({
    roots: ['src/components/layout'],
    extensions: ['.ts', '.tsx'],
    skipDirs: ['node_modules', '.next'],
    exclude: (rel) => path.basename(rel) === 'nav-bar.tsx',
    // 29 today. The helper throws below this, so an emptied population fails
    // instead of reporting no parallel chrome having read nothing.
    floor: 15,
});

describe('Roadmap-14 PR-1 — NavBar primitive extraction discipline', () => {
    describe('primitive file', () => {
        it('exports `NavBar` from `nav-bar.tsx`', () => {
            expect(NAV_BAR_SRC).toMatch(/export\s+function\s+NavBar\b/);
        });

        it('exports the slot recipes as named consts', () => {
            // Named exports anchor the ratchets to come. Renaming
            // any of these is a deliberate diff, not a silent
            // refactor.
            expect(NAV_BAR_SRC).toMatch(/export\s+const\s+NAV_BAR_SHELL\b/);
            expect(NAV_BAR_SRC).toMatch(
                /export\s+const\s+NAV_BAR_SLOT_LEFT\b/,
            );
            expect(NAV_BAR_SRC).toMatch(
                /export\s+const\s+NAV_BAR_SLOT_CENTER\b/,
            );
            expect(NAV_BAR_SRC).toMatch(
                /export\s+const\s+NAV_BAR_SLOT_RIGHT\b/,
            );
        });

        it('renders the `<header role="banner">` shell', () => {
            // The shell IS the topbar's `<header>` — semantic
            // landmark for screen readers + the structural mount
            // point. The role must stay `banner`.
            expect(NAV_BAR_SRC).toMatch(/<header\b/);
            expect(NAV_BAR_SRC).toMatch(/role="banner"/);
        });

        it('emits a slot div for each slot prop', () => {
            // The three slot divs MUST exist regardless of slot
            // content. Layout stability relies on the divs being
            // present even when their slot prop is undefined — a
            // future PR that conditionally renders the divs would
            // collapse the centre/right slots into the left slot
            // on pages that haven't filled them yet.
            expect(NAV_BAR_SRC).toMatch(/data-slot="left"/);
            expect(NAV_BAR_SRC).toMatch(/data-slot="center"/);
            expect(NAV_BAR_SRC).toMatch(/data-slot="right"/);
        });
    });

    describe('TopChrome consumes the primitive', () => {
        it('imports NavBar from `./nav-bar`', () => {
            // The import path is locked — moving the primitive (or
            // re-exporting via a barrel) needs an explicit diff
            // here. Multiple named imports from `./nav-bar` are
            // allowed (R14-PR3 adds `NavBarBrand`; later PRs add
            // more); the only requirement is that `NavBar` itself
            // is one of them.
            expect(TOP_CHROME_SRC).toMatch(
                /import\s+\{[^}]*\bNavBar\b[^}]*\}\s+from\s+['"]\.\/nav-bar['"]/,
            );
        });

        it('mounts NavBar rather than its own `<header>`', () => {
            // The whole point of R14-PR1: TopChrome is now a thin
            // consumer. If a future PR puts the `<header>` back
            // inline, the import-discipline boundary collapses.
            expect(TOP_CHROME_SRC).toMatch(/<NavBar\b/);
            // The old hand-rolled `<header role="banner">` is gone.
            // (Both the open tag and the role attribute must be
            // absent from TopChrome.tsx — the role only lives in
            // nav-bar.tsx now.)
            expect(TOP_CHROME_SRC).not.toMatch(/<header\b/);
            expect(TOP_CHROME_SRC).not.toMatch(/role="banner"/);
        });

        it('still fills the left + right slots (PR-1 preserves R2 behaviour)', () => {
            // R14-PR1 is purely structural — every R2 behaviour
            // stays. The left slot mounts breadcrumbs; the right
            // slot mounts some identity affordance (R14-PR4 made
            // it TenantSwitcher for tenant variant; the R14 hotfix
            // moved the variant ternary into a `renderIdentity()`
            // helper). Both forms satisfy the structural
            // contract.
            expect(TOP_CHROME_SRC).toMatch(/<Breadcrumbs\b/);
            // Identity is now mounted via either <Identity /> (R14-PR1
            // shape, pre-R14-PR4) or renderIdentity() helper (post-
            // hotfix). At least one must exist.
            const hasIdentityComponent =
                /<Identity\s*\/>/.test(TOP_CHROME_SRC) ||
                /renderIdentity\(\)/.test(TOP_CHROME_SRC) ||
                /<TenantSwitcher\b/.test(TOP_CHROME_SRC) ||
                /<OrgIdentityPill\b/.test(TOP_CHROME_SRC);
            expect(hasIdentityComponent).toBe(true);
            // The slot prop names are part of the contract.
            expect(TOP_CHROME_SRC).toMatch(/\bleft=\{/);
            expect(TOP_CHROME_SRC).toMatch(/\bright=\{/);
        });
    });

    describe('no parallel `<header>` chrome elsewhere in layout/', () => {
        it('no other file in src/components/layout renders <header role="banner">', () => {
            const offenders = LAYOUT_FILES.filter((abs) =>
                rendersBanner(fs.readFileSync(abs, 'utf8')),
            ).map((abs) => path.basename(abs));
            console.log(
                `[r14-nav-bar] scanned ${LAYOUT_FILES.length} file(s) in layout/ (excluding nav-bar.tsx); ${offenders.length} render a parallel banner`,
            );
            expect(offenders).toEqual([]);
        });

        /**
         * The positive control, and the reason `nav-bar.tsx` is the right
         * subject for it rather than a synthetic string.
         *
         * The assertion above is an ABSENCE over a population that is healthy
         * today, so a detector that can no longer match anything satisfies it
         * perfectly — measured, by replacing both patterns with one that
         * cannot match: 8 of 8 still green (#2483 class B / #2507). The floor
         * on `LAYOUT_FILES` catches an empty POPULATION; nothing in the file
         * caught an empty DETECTOR.
         *
         * `nav-bar.tsx` is excluded from the population precisely because it
         * is the one file that legitimately renders the banner, which makes it
         * a control that cannot drift out of agreement with the thing it
         * controls: a markup change there fails this test rather than silently
         * disarming the one above it.
         */
        it('the detector matches the file that DOES render the banner', () => {
            const navBar = path.join(ROOT, 'src/components/layout/nav-bar.tsx');
            expect(fs.existsSync(navBar)).toBe(true);
            expect(rendersBanner(fs.readFileSync(navBar, 'utf8'))).toBe(true);
        });
    });
});

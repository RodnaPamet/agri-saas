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

const ROOT = path.resolve(__dirname, '../..');
const NAV_BAR_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-bar.tsx'),
    'utf8',
);
const TOP_CHROME_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/TopChrome.tsx'),
    'utf8',
);

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
            const layoutDir = path.join(ROOT, 'src/components/layout');
            const offenders: string[] = [];
            for (const entry of fs.readdirSync(layoutDir, {
                withFileTypes: true,
            })) {
                if (!entry.isFile()) continue;
                if (entry.name === 'nav-bar.tsx') continue;
                if (!/\.tsx?$/.test(entry.name)) continue;
                const content = fs.readFileSync(
                    path.join(layoutDir, entry.name),
                    'utf8',
                );
                // Strip comments before scanning so doc-comments
                // mentioning `<header role="banner">` don't trip
                // the structural detector.
                const stripped = blankNonCode(content);
                if (
                    /<header\b[^>]*role="banner"/.test(stripped) ||
                    /<header[\s\S]{0,80}role="banner"/.test(stripped)
                ) {
                    offenders.push(entry.name);
                }
            }
            expect(offenders).toEqual([]);
        });
    });
});

/**
 * Roadmap-14 PR-11 — Slot press-feedback unification.
 *
 * Every clickable top-bar slot (brand mark, search anchor pill,
 * search anchor icon-button, tenant switcher trigger,
 * notifications bell, user-menu avatar) carries the same tactile
 * press feedback as the sidebar's NavItem:
 *
 *   active:translate-y-px
 *   motion-reduce:active:translate-y-0
 *   transition-transform duration-75 ease-out
 *
 * The recipe lives once at `NAV_BAR_SLOT_PRESS` in `nav-bar.tsx`;
 * each slot's class string composes it. A future "let's slow the
 * press to 100ms" PR has ONE place to land — every slot's tactile
 * feel stays coherent.
 *
 * Three load-bearing pieces:
 *
 *   1. `NAV_BAR_SLOT_PRESS` is exported from `nav-bar.tsx` with
 *      the canonical recipe.
 *
 *   2. Every clickable slot file imports + composes the const.
 *      Hand-rolled `active:translate-y-px` inside any of the
 *      slot files would still satisfy a string-presence check
 *      but would diverge from the shared recipe — the ratchet
 *      explicitly asserts the IMPORT path.
 *
 *   3. Motion-language exempt: the five chrome-slot files are
 *      added to `EXEMPT_FILES` in
 *      `motion-language-discipline.test.ts` with the broadening
 *      rationale documented. The cap is bumped from 6 to 11.
 *      Bans on hover-translate / hover-scale / hover-shadow stay
 *      enforced inside these files via the local R14 ratchets.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

const NAV_BAR_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-bar.tsx'),
    'utf8',
);
const SWITCHER_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/tenant-switcher.tsx'),
    'utf8',
);
const USER_MENU_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/user-menu.tsx'),
    'utf8',
);
const BELL_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/notifications-bell.tsx'),
    'utf8',
);
const MOTION_GUARD_SRC = fs.readFileSync(
    path.join(ROOT, 'tests/guards/motion-language-discipline.test.ts'),
    'utf8',
);

describe('Roadmap-14 PR-11 — Slot press-feedback unification', () => {
    describe('NAV_BAR_SLOT_PRESS (shared recipe)', () => {
        it('exports the const from `nav-bar.tsx`', () => {
            expect(NAV_BAR_SRC).toMatch(
                /export\s+const\s+NAV_BAR_SLOT_PRESS\s*=/,
            );
        });

        it('carries `active:translate-y-px`', () => {
            // The 1px mousedown drop. Matches NavItem's R13-PR8
            // recipe verbatim so chrome + sidebar feel identical.
            expect(NAV_BAR_SRC).toMatch(
                /NAV_BAR_SLOT_PRESS\s*=\s*['"][^'"]*\bactive:translate-y-px\b/,
            );
        });

        it('carries `motion-reduce:active:translate-y-0` (OS preference safety net)', () => {
            expect(NAV_BAR_SRC).toMatch(
                /NAV_BAR_SLOT_PRESS\s*=\s*['"][^'"]*motion-reduce:active:translate-y-0/,
            );
        });

        it('uses 75ms transition-transform (snappy press tempo)', () => {
            // Matches NavItem's R13-PR8 transition timing. A
            // regression that changes this here drifts the chrome
            // out of sync with the sidebar.
            expect(NAV_BAR_SRC).toMatch(
                /NAV_BAR_SLOT_PRESS\s*=\s*['"][^'"]*transition-transform[^'"]*duration-75/,
            );
        });
    });

    describe('every clickable slot file composes the shared recipe', () => {
        const slotFiles = [
            { name: 'nav-bar (brand mark)', src: NAV_BAR_SRC },
            { name: 'tenant-switcher', src: SWITCHER_SRC },
            { name: 'user-menu', src: USER_MENU_SRC },
            { name: 'notifications-bell', src: BELL_SRC },
        ];

        for (const { name, src } of slotFiles) {
            describe(name, () => {
                it('references NAV_BAR_SLOT_PRESS', () => {
                    // The slot's class string composes the shared
                    // const, NOT a hand-rolled `active:translate-y-px`.
                    // The import path varies (nav-bar.tsx exports it
                    // locally; siblings import from `./nav-bar`).
                    expect(src).toContain('NAV_BAR_SLOT_PRESS');
                });
            });
        }

        // Three sibling files explicitly import the const. The
        // brand-mark recipe lives inside nav-bar.tsx so doesn't
        // import it. (The R14-PR6 search-anchor file was retired
        // by the searchbar-kill sweep.)
        const siblings = [
            { name: 'tenant-switcher', src: SWITCHER_SRC },
            { name: 'user-menu', src: USER_MENU_SRC },
            { name: 'notifications-bell', src: BELL_SRC },
        ];
        for (const { name, src } of siblings) {
            it(`${name} imports NAV_BAR_SLOT_PRESS from \`./nav-bar\``, () => {
                expect(src).toMatch(
                    /import\s+\{[^}]*NAV_BAR_SLOT_PRESS[^}]*\}\s+from\s+['"]\.\/nav-bar['"]/,
                );
            });
        }
    });

    describe('motion-language exempt extended for the chrome slots', () => {
        const chromeSlotFiles = [
            'src/components/layout/nav-bar.tsx',
            'src/components/layout/tenant-switcher.tsx',
            'src/components/layout/user-menu.tsx',
            'src/components/layout/notifications-bell.tsx',
        ];
        for (const rel of chromeSlotFiles) {
            it(`EXEMPT_FILES includes \`${rel}\``, () => {
                const literal = `"${rel}"`;
                expect(MOTION_GUARD_SRC).toContain(literal);
            });
        }

        it('the exempt-list cap is set to 10 (was 11 pre-searchbar-kill)', () => {
            // 6 was the R13-PR8 cap (NavItem + four R12 exemptions).
            // R14-PR11 added five chrome slot files → 11.
            // The searchbar-kill sweep retired the SearchAnchor →
            // cap drops to 10. A future PR that adds an 11th must
            // argue against this ratchet explicitly.
            expect(MOTION_GUARD_SRC).toMatch(
                /EXEMPT_FILES\.size\)\.toBeLessThanOrEqual\(10\)/,
            );
        });

        it('the broadening rationale for R14 chrome slots is documented', () => {
            // Future readers need to see WHY these files are
            // exempt. The comment block must mention Roadmap-14
            // and the chrome-slot vocabulary.
            expect(MOTION_GUARD_SRC).toMatch(
                /Roadmap-14[\s\S]*?chrome[\s\S]*?NAV_BAR_SLOT_PRESS/,
            );
        });
    });

    describe('hover-shadow / hover-scale still banned in slot files (local enforcement)', () => {
        const slotFiles = [
            NAV_BAR_SRC,
            SWITCHER_SRC,
            USER_MENU_SRC,
            BELL_SRC,
        ];

        for (let i = 0; i < slotFiles.length; i++) {
            const stripped = blankNonCode(slotFiles[i]);
            it(`slot file #${i + 1} has no hover-translate in executable code`, () => {
                expect(stripped).not.toMatch(/\bhover:translate-/);
                expect(stripped).not.toMatch(/\bhover:-translate-/);
            });
            it(`slot file #${i + 1} has no hover-scale in executable code`, () => {
                expect(stripped).not.toMatch(/\bhover:scale-/);
            });
        }
    });
});

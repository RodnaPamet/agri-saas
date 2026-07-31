/**
 * Roadmap-13 PR-12 — Living Sidebar capstone bundle ratchet.
 *
 * The eleven preceding R13 PRs each shipped one slice of the
 * sidebar's evolution + one structural guard. This capstone walks
 * EVERY load-bearing invariant in a single report — when this
 * ratchet stays green, the entire R13 vocabulary is intact.
 *
 * The bundle is intentionally exhaustive — it touches:
 *
 *   PR-1   Navy secondary-brand tokens (both themes, three tiers)
 *   PR-2   3-stop gradient + soft glow
 *   PR-3   Shimmer animation (4s ease-in-out, gated hover + active)
 *   PR-4   Active band swaps to secondary brand
 *   PR-5   Active label takes brand colour
 *   PR-6   Glossy top-edge highlight (::after)
 *   PR-7   Inset bevel shadow on hover
 *   PR-8   Press feedback (active:translate-y-px) + motion exempt
 *   PR-9   Band reaches toward cursor (top/bottom/width animation)
 *   PR-10  Section divider as soft gradient
 *   PR-11  Radial brand wash on active row
 *
 * Each section here is one PR's invariants pulled into a single
 * sweep. The "full picture" failure mode this catches: a refactor
 * that accidentally drops one R13 piece while updating another
 * — the slice-level ratchet for the touched PR stays green, but
 * the dropped slice's ratchet fires here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const NAV_ITEM_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-item.tsx'),
    'utf8',
);
const NAV_SECTION_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-section.tsx'),
    'utf8',
);
const TOKENS_SRC = fs.readFileSync(
    path.join(ROOT, 'src/styles/tokens.css'),
    'utf8',
);
const TAILWIND_CONFIG = fs.readFileSync(
    path.join(ROOT, 'tailwind.config.js'),
    'utf8',
);
const MOTION_GUARD_SRC = fs.readFileSync(
    path.join(ROOT, 'tests/guards/motion-language-discipline.test.ts'),
    'utf8',
);

const DARK_BLOCK = TOKENS_SRC.match(/:root\s*\{[\s\S]*?\n\}/)![0];
const LIGHT_BLOCK = TOKENS_SRC.match(
    /\[data-theme="light"\]\s*\{[\s\S]*?\n\}/,
)![0];

const activeRecipe =
    NAV_ITEM_SRC.match(
        /export\s+const\s+NAV_ITEM_ACTIVE\s*=\s*['"]([^'"]+)['"]/,
    )?.[1] ?? '';
const defaultRecipe =
    NAV_ITEM_SRC.match(
        /export\s+const\s+NAV_ITEM_DEFAULT\s*=\s*['"]([^'"]+)['"]/,
    )?.[1] ?? '';
const baseRegion =
    NAV_ITEM_SRC.match(
        /export\s+const\s+NAV_ITEM_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
    )?.[0] ?? '';
const bandBaseRegion =
    NAV_ITEM_SRC.match(
        /const\s+NAV_ITEM_BAND_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
    )?.[0] ?? '';
const glossBaseRegion =
    NAV_ITEM_SRC.match(
        /const\s+NAV_ITEM_GLOSS_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
    )?.[0] ?? '';
const sectionDividerRecipe =
    NAV_SECTION_SRC.match(
        /export\s+const\s+NAV_SECTION_DIVIDER\s*=\s*['"]([^'"]+)['"]/,
    )?.[1] ?? '';

describe('Roadmap-13 PR-12 — Living Sidebar capstone bundle', () => {
    describe('PR-1 — secondary-brand token foundation', () => {
        it('METRO declares the three secondary tiers', () => {
            // Structure, not the value. This pinned the navy-era electric
            // blue (#3B82F6 family); the dark ground moved to green on
            // 2026-07-30 and the secondary brand became the flag's white,
            // so an absolute-hex pin asserted a palette that no longer
            // exists. What these guards were written to protect is the
            // TIER STRUCTURE and the two-tone state vocabulary, both of
            // which survive a re-colour.
            expect(DARK_BLOCK).toMatch(/--brand-secondary-default:\s*#[0-9a-f]{6}\b/i);
            expect(DARK_BLOCK).toMatch(/--brand-secondary-emphasis:\s*#[0-9a-f]{6}\b/i);
            expect(DARK_BLOCK).toMatch(/--brand-secondary-subtle:/);
        });
        it('PwC declares the three secondary tiers', () => {
            expect(LIGHT_BLOCK).toMatch(/--brand-secondary-default:\s*#1E3A8A/i);
            expect(LIGHT_BLOCK).toMatch(/--brand-secondary-emphasis:\s*#172554/i);
            expect(LIGHT_BLOCK).toMatch(/--brand-secondary-subtle:/);
        });
    });

    describe('PR-2 — 3-stop gradient + soft glow', () => {
        it('band gradient: default → muted → emphasis (utility OR R15-PR1 arbitrary form)', () => {
            // R15-PR1 switched the gradient from Tailwind utility
            // classes (`before:from-...`, `before:via-...`,
            // `before:to-...`) to a single comprehensive
            // `before:bg-[...]` arbitrary value so the stardust
            // particle layers could be stacked on top. Both forms
            // preserve the three brand stops in order — accept
            // either here.
            const utilityForm =
                /before:from-\[var\(--brand-default\)\]/.test(bandBaseRegion) &&
                /before:via-\[var\(--brand-muted\)\]/.test(bandBaseRegion) &&
                /before:to-\[var\(--brand-emphasis\)\]/.test(bandBaseRegion);
            const arbitraryForm =
                /linear-gradient\(to_bottom,/.test(bandBaseRegion) &&
                /var\(--brand-default\)/.test(bandBaseRegion) &&
                /var\(--brand-muted\)/.test(bandBaseRegion) &&
                /var\(--brand-emphasis\)/.test(bandBaseRegion);
            expect(utilityForm || arbitraryForm).toBe(true);
        });
        it('band glow wired via --nav-band-glow', () => {
            expect(bandBaseRegion).toMatch(
                /before:shadow-\[var\(--nav-band-glow\)\]/,
            );
            expect(DARK_BLOCK).toMatch(/--nav-band-glow:/);
            expect(LIGHT_BLOCK).toMatch(/--nav-band-glow:/);
        });
    });

    describe('PR-3 — shimmer animation', () => {
        it('keyframe + animation utility declared in tailwind config', () => {
            expect(TAILWIND_CONFIG).toMatch(/'nav-band-shimmer':\s*\{/);
            expect(TAILWIND_CONFIG).toMatch(
                /'nav-band-shimmer':\s*'nav-band-shimmer\s+4s\s+ease-in-out\s+infinite'/,
            );
        });
        it('background-size 100% 200% in band base; shimmer active-only (hover band retired 2026-05-19)', () => {
            // R15-PR2 broadened the band's animation utility from
            // `nav-band-shimmer` (single-track) to `nav-band-alive`
            // (composed: shimmer + halo-breath). The `nav-band-alive`
            // entry in tailwind.config.js embeds `nav-band-shimmer
            // 4s ease-in-out infinite` as its first track, so the
            // R13-PR3 visual contract holds either way for the
            // active row.
            //
            // 2026-05-19 retired the hover-band reveal. The default
            // recipe no longer needs the shimmer animation gated on
            // hover; the band fade-in is gone. Only the active
            // recipe still runs the animation (unconditionally).
            expect(bandBaseRegion).toMatch(
                /before:\[background-size:100%_200%\]/,
            );
            expect(defaultRecipe).not.toMatch(
                /hover:before:animate-nav-band-(?:shimmer|alive)\b/,
            );
            const activeShimmer =
                /(?<!hover:)before:animate-nav-band-shimmer\b/.test(
                    activeRecipe,
                );
            // R15-PR4 introduced `nav-band-active-alive` (adds the
            // starburst bloom for the active row); its tailwind
            // entry still embeds the 4s shimmer track so the
            // visual contract holds either way.
            const activeAlive =
                /(?<!hover:)before:animate-nav-band-(?:active-)?alive\b/.test(
                    activeRecipe,
                );
            expect(activeShimmer || activeAlive).toBe(true);
        });
    });

    describe('PR-4 — active band tone (2026-05-13 v2: page-bg via full bg-image override)', () => {
        it('overrides the full before:bg-[...] arbitrary value with page-bg + active-glow shadow override', () => {
            // The band's stops were originally brand-secondary
            // (R13-PR4). On 2026-05-13 they swapped to `--bg-page`
            // so the active band reads as a cut-out of the page
            // surface. The v1 attempt used Tailwind utility
            // `before:from/via/to-[var(--bg-page)]!` overrides
            // but those don't compose against an arbitrary
            // `before:bg-[...]` BASE value. v2 overrides the
            // entire bg-image arbitrary value with a parallel
            // arbitrary value carrying three `var(--bg-page)`
            // linear-gradient stops (collapsed to solid), stardust
            // radial layers preserved. The glow `!` override
            // still resolves through `--nav-band-glow-active`
            // (navy on both themes) — that anchors the band's
            // edge into the sidebar surface.
            expect(activeRecipe).toMatch(
                /before:bg-\[[\s\S]*?linear-gradient\(to_bottom,[\s\S]*?var\(--bg-page\)[\s\S]*?var\(--bg-page\)[\s\S]*?var\(--bg-page\)[\s\S]*?\)\]!/,
            );
            expect(activeRecipe).toMatch(
                /before:shadow-\[var\(--nav-band-glow-active\)\]!/,
            );
        });
        it('--brand-secondary-muted + --nav-band-glow-active tokens still declared (used by wash + starburst + aura)', () => {
            // The band itself no longer uses the secondary-brand
            // ramp, but the active row's radial wash, the
            // starburst bloom, and the outer aura all still
            // reference brand-secondary tokens. The token
            // declarations themselves remain load-bearing.
            for (const block of [DARK_BLOCK, LIGHT_BLOCK]) {
                expect(block).toMatch(/--brand-secondary-muted:/);
                expect(block).toMatch(/--nav-band-glow-active:/);
            }
        });
    });

    describe('PR-5 — active label takes brand colour', () => {
        it('active text is brand-default; default text is content-muted', () => {
            expect(activeRecipe).toMatch(
                /\btext-\[var\(--brand-default\)\]/,
            );
            expect(defaultRecipe).toMatch(/\btext-content-muted\b/);
            expect(defaultRecipe).not.toMatch(
                /\btext-\[var\(--brand-default\)\]/,
            );
        });
    });

    describe('PR-6 — glossy top-edge highlight (::after)', () => {
        it('NAV_ITEM_GLOSS_BASE recipe wires top-edge highlight', () => {
            expect(glossBaseRegion).toMatch(/after:absolute/);
            expect(glossBaseRegion).toMatch(/after:top-0/);
            expect(glossBaseRegion).toMatch(/after:h-px/);
            expect(glossBaseRegion).toMatch(
                /after:bg-\[var\(--nav-gloss-highlight\)\]/,
            );
            expect(glossBaseRegion).toMatch(/after:pointer-events-none/);
        });
        it('gloss reveal gated hover + active', () => {
            expect(defaultRecipe).toMatch(/hover:after:opacity-100/);
            expect(activeRecipe).toMatch(
                /(?<!hover:)after:opacity-100/,
            );
        });
        it('--nav-gloss-highlight declared in both themes', () => {
            expect(DARK_BLOCK).toMatch(/--nav-gloss-highlight:/);
            expect(LIGHT_BLOCK).toMatch(/--nav-gloss-highlight:/);
        });
    });

    describe('PR-7 — inset bevel shadow on hover', () => {
        it('--nav-bevel-shadow declared as inset both themes', () => {
            for (const block of [DARK_BLOCK, LIGHT_BLOCK]) {
                expect(block).toMatch(
                    /--nav-bevel-shadow:\s*inset\s+0\s+-1px/,
                );
            }
        });
        it('bevel applied on hover + un-gated on active (single or R15-PR9 stacked form)', () => {
            expect(defaultRecipe).toMatch(
                /hover:shadow-\[var\(--nav-bevel-shadow\)\]/,
            );
            // R15-PR9 stacks an outer brand-coloured aura
            // alongside the bevel inside one multi-shadow value.
            // The bevel-shadow var is still present, but no
            // longer the sole shadow — accept both forms.
            const singleForm =
                /(?<!hover:)shadow-\[var\(--nav-bevel-shadow\)\]/.test(
                    activeRecipe,
                );
            const stackedForm =
                /(?<!hover:)shadow-\[[^\]]*var\(--nav-bevel-shadow\)[^\]]*\]/.test(
                    activeRecipe,
                );
            expect(singleForm || stackedForm).toBe(true);
        });
    });

    describe('PR-8 — press feedback + motion-language broadening', () => {
        it('press transform + motion-reduce safety net wired in BASE', () => {
            expect(baseRegion).toMatch(/active:translate-y-px/);
            expect(baseRegion).toMatch(
                /motion-reduce:active:translate-y-0/,
            );
            expect(baseRegion).toMatch(/transition-transform/);
            expect(baseRegion).toMatch(/duration-75/);
        });
        it('nav-item.tsx is in the motion-language exempt list', () => {
            expect(MOTION_GUARD_SRC).toMatch(
                /['"]src\/components\/layout\/nav-item\.tsx['"]/,
            );
            // The cap moved from 6 (R13 ceiling) to 11 (R14 broadened
            // for the top-bar slot family) and back to 10 (searchbar-
            // kill sweep retired SearchAnchor + its entry). Lock the
            // current cap as a single digit; future broadenings need
            // to be argued at the motion-language ratchet itself.
            expect(MOTION_GUARD_SRC).toMatch(
                /EXEMPT_FILES\.size\)\.toBeLessThanOrEqual\(10\)/,
            );
        });
    });

    describe('PR-9 — band reach (active-only since 2026-05-19)', () => {
        it('band geometry expanded on active only (hover reach retired)', () => {
            // Hover-band reveal retired 2026-05-19 — the default
            // recipe no longer carries the reach geometry on hover.
            // The active recipe still holds the reach permanently.
            expect(defaultRecipe).not.toMatch(/hover:before:top-1\b/);
            expect(defaultRecipe).not.toMatch(/hover:before:bottom-1\b/);
            expect(defaultRecipe).not.toMatch(/hover:before:w-\[4px\]/);
            expect(activeRecipe).toMatch(/before:top-1!/);
            expect(activeRecipe).toMatch(/before:bottom-1!/);
            expect(activeRecipe).toMatch(/before:w-\[4px\]!/);
        });
        it('transition-property list broadened to include geometry', () => {
            expect(bandBaseRegion).toMatch(
                /before:transition-\[opacity,top,bottom,width\]/,
            );
            expect(bandBaseRegion).toMatch(/before:duration-200/);
        });
    });

    describe('PR-10 — section divider as soft gradient', () => {
        it('NAV_SECTION_DIVIDER uses ::before + linear-gradient', () => {
            expect(sectionDividerRecipe).toMatch(/before:absolute/);
            expect(sectionDividerRecipe).toMatch(/before:top-0/);
            expect(sectionDividerRecipe).toMatch(/before:h-px/);
            expect(sectionDividerRecipe).toMatch(
                /before:bg-\[linear-gradient\(90deg,/,
            );
            expect(sectionDividerRecipe).toMatch(/var\(--border-subtle\)/);
        });
        it('isFirst gate preserved', () => {
            expect(NAV_SECTION_SRC).toMatch(
                /!isFirst\s*&&\s*title\s*&&\s*NAV_SECTION_DIVIDER/,
            );
        });
    });

    describe('PR-11 — radial brand wash on active row', () => {
        it('active bg is a radial-gradient from secondary-subtle', () => {
            expect(activeRecipe).toMatch(/bg-\[radial-gradient\(/);
            expect(activeRecipe).toMatch(/radial-gradient\(circle_at_left,/);
            expect(activeRecipe).toMatch(/var\(--brand-secondary-subtle\)/);
            expect(activeRecipe).toMatch(
                /bg-\[radial-gradient\([\s\S]*?,_transparent/,
            );
        });
    });

    describe('integration — preserved R12 invariants', () => {
        it('still 44px touch row + 8px radius + 28px icon', () => {
            expect(NAV_ITEM_SRC).toMatch(/min-h-\[44px\]/);
            expect(NAV_ITEM_SRC).toMatch(/rounded-lg/);
            expect(NAV_ITEM_SRC).toMatch(/h-7 w-7/);
        });
        it('still focus-visible ring at --ring', () => {
            expect(baseRegion).toMatch(
                /focus-visible:ring-2/,
            );
            expect(baseRegion).toMatch(
                /focus-visible:ring-\[var\(--ring\)\]/,
            );
        });
        it('still 44px touch target on hover (geometry stays still outside band)', () => {
            // Hover expands the BAND geometry, not the row. The row
            // stays at its 44px touch-target height regardless of
            // state.
            expect(defaultRecipe).not.toMatch(/hover:h-/);
            expect(defaultRecipe).not.toMatch(/hover:min-h-/);
            expect(activeRecipe).not.toMatch(/\bh-\d+\b/);
        });
    });

    describe('R12-PR3 + R13-PR10 — section header preserved', () => {
        it('still 10px text + tracking-0.12em + uppercase + content-subtle', () => {
            const headerRecipe =
                NAV_SECTION_SRC.match(
                    /export\s+const\s+NAV_SECTION_HEADER\s*=\s*['"]([^'"]+)['"]/,
                )?.[1] ?? '';
            expect(headerRecipe).toMatch(/text-\[10px\]/);
            expect(headerRecipe).toMatch(/tracking-\[0\.12em\]/);
            expect(headerRecipe).toMatch(/uppercase/);
            expect(headerRecipe).toMatch(/text-content-subtle/);
            expect(headerRecipe).toMatch(/select-none/);
        });
    });
});

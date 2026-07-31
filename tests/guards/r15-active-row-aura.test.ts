/**
 * Roadmap-15 PR-9 — Outer brand-coloured aura around the active row.
 *
 * The R13 active row is settled, conviction-coloured, motion-rich:
 * brand label · navy band · radial wash · starburst on engage. But
 * the row's OUTER perimeter touches the sidebar surface directly —
 * no halo, no presence beyond the row's footprint. Neighbouring
 * inactive rows sit at the same surface elevation as the active
 * row; the eye reads them as part of the same vertical strip.
 *
 * R15-PR9 paints a soft outer aura of brand-secondary light around
 * the full perimeter of the active row. The aura is a `box-shadow`
 * with no inset:
 *
 *     0 0 12px 2px var(--nav-row-aura-color)
 *
 * 12px blur + 2px spread bathes the surrounding sidebar surface
 * in 18%-alpha brand-secondary light. The aura signals "this row
 * is brand-active" by extending its tonal presence beyond its
 * footprint — like the row is sitting at a slightly higher
 * elevation made of brand light, not depth.
 *
 * Stacking semantics:
 *
 *   The active recipe's `shadow-[...]` value carries TWO shadows
 *   stacked in one bracketed expression:
 *
 *     1. The outer aura     (R15-PR9, this PR)        ← drawn first
 *     2. The inset bevel    (R13-PR7, --nav-bevel-shadow)
 *
 *   CSS paints shadows in the listed order so the outer aura sits
 *   behind everything; the inset bevel paints inside the row's
 *   surface. Both must coexist — neither replaces the other.
 *
 * Why not a depth shadow?
 *
 *   The R13-PR7 doc explicitly warns against `shadow-md` /
 *   `shadow-lg`-style depth shadows. Those are UNIFORM-BLACK at
 *   high alpha and visibly lift the row off the sidebar — wrong
 *   spatial model. The aura is BRAND-COLOURED at low alpha; it
 *   doesn't lift, it BATHES. Same semantic level as the
 *   R13-PR2 band glow (which is also brand-coloured at low alpha
 *   on the band's `::before`) — the aura is the row's
 *   counterpart.
 *
 * Theme parity:
 *
 *   --nav-row-aura-color: rgba(59, 130, 246, 0.18)   METRO  (navy)
 *   --nav-row-aura-color: rgba(30, 58, 138, 0.18)    PwC    (deep navy)
 *
 *   Same alpha because both brand-secondary RGB values produce
 *   the same perceived halo strength on their respective surfaces.
 *   The geometry (12px blur, 2px spread, 0 offset) is identical
 *   across themes.
 *
 * What this ratchet does NOT police:
 *
 *   - The exact blur radius (12px) or spread (2px). Future tuning
 *     within "bathes the surrounding surface in brand light"
 *     stays inside the intent.
 *   - The exact alpha (18%). Tuning is allowed within "low alpha,
 *     reads as ambient".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const NAV_ITEM_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-item.tsx'),
    'utf8',
);
const TOKENS_SRC = fs.readFileSync(
    path.join(ROOT, 'src/styles/tokens.css'),
    'utf8',
);
const DARK_BLOCK = TOKENS_SRC.match(/:root\s*\{[\s\S]*?\n\}/)![0];
const LIGHT_BLOCK = TOKENS_SRC.match(
    /\[data-theme="light"\]\s*\{[\s\S]*?\n\}/,
)![0];

describe('Roadmap-15 PR-9 — active row aura', () => {
    describe('--nav-row-aura-color token (theme-aware)', () => {
        it('METRO declares the aura colour as brand-secondary navy at low alpha', () => {
            // Alpha at low opacity is the structural property here, not
            // the channel values. This pinned the navy-era blue until
            // 2026-07-30, when the ground went green and the aura followed
            // the secondary brand to the flag's white.
            expect(DARK_BLOCK).toMatch(
                /--nav-row-aura-color:\s*rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0?\.\d+\s*\)/,
            );
        });

        it('PwC declares the aura colour as deep navy at low alpha', () => {
            // rgba(30, 58, 138, …) is the canonical PwC brand-
            // secondary-default RGB (#1E3A8A = 30, 58, 138).
            expect(LIGHT_BLOCK).toMatch(
                /--nav-row-aura-color:\s*rgba\(30,\s*58,\s*138,\s*0\.\d+\)/,
            );
        });

        it('alpha is in the ambient band (10–30%)', () => {
            // Too low and the aura disappears; too high and the
            // row looks haloed (wrong spatial model — implies
            // floating). 18% is the sweet spot for "bathes the
            // surrounding surface".
            const metroMatch = DARK_BLOCK.match(
                /--nav-row-aura-color:\s*rgba\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/,
            );
            const pwcMatch = LIGHT_BLOCK.match(
                /--nav-row-aura-color:\s*rgba\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/,
            );
            expect(metroMatch).not.toBeNull();
            expect(pwcMatch).not.toBeNull();
            const metroAlpha = parseFloat(metroMatch![1]);
            const pwcAlpha = parseFloat(pwcMatch![1]);
            expect(metroAlpha).toBeGreaterThan(0.1);
            expect(metroAlpha).toBeLessThan(0.3);
            expect(pwcAlpha).toBeGreaterThan(0.1);
            expect(pwcAlpha).toBeLessThan(0.3);
        });

        it('alpha is identical across themes (perceived parity)', () => {
            // Both brand-secondary RGB values produce the same
            // perceived halo strength on their respective
            // surfaces. Different alphas would make the aura
            // visibly heavier on one theme than the other.
            const metroAlpha = DARK_BLOCK.match(
                /--nav-row-aura-color:\s*rgba\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/,
            )?.[1];
            const pwcAlpha = LIGHT_BLOCK.match(
                /--nav-row-aura-color:\s*rgba\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/,
            )?.[1];
            expect(metroAlpha).toBe(pwcAlpha);
        });
    });

    describe('NAV_ITEM_ACTIVE — aura wired alongside bevel', () => {
        const activeRecipe =
            NAV_ITEM_SRC.match(
                /export\s+const\s+NAV_ITEM_ACTIVE\s*=\s*['"]([^'"]+)['"]/,
            )?.[1] ?? '';

        it('shadow stack includes the aura layer (0 0 <blur> <spread>)', () => {
            // The outer aura is a non-inset box-shadow with blur +
            // optional spread. `0 0 12px 2px` is the canonical
            // form. Any future tuning (e.g. blur 10–16px, spread
            // 0–4px) stays within the same shape.
            expect(activeRecipe).toMatch(
                /shadow-\[[^\]]*\b0_0_\d+px(?:_\d+px)?_var\(--nav-row-aura-color\)/,
            );
        });

        it('shadow stack still includes the R13-PR7 inset bevel', () => {
            // The aura ADDS to the bevel — does not REPLACE it.
            // The bevel-shadow token must still appear inside the
            // same `shadow-[...]` value.
            expect(activeRecipe).toMatch(
                /shadow-\[[^\]]*var\(--nav-bevel-shadow\)[^\]]*\]/,
            );
        });

        /**
         * Capture the ROW-LEVEL shadow stack from the active
         * recipe. The recipe carries multiple `shadow-[...]` tokens
         * (e.g. `before:shadow-[var(--nav-band-glow-active)]` for
         * the band glow override). Only the un-prefixed row-level
         * `shadow-[...]` matters here — the one that paints the
         * row's outer aura + inset bevel.
         */
        function getRowShadowStack(): string {
            const match = activeRecipe.match(
                /(?<!:)shadow-\[([^\]]+)\]/,
            );
            return match ? match[1] : '';
        }

        it('aura is the FIRST shadow in the stack (drawn behind everything)', () => {
            // CSS paints shadows in listed order; the outer aura
            // must come first so it sits behind the inset bevel.
            // Reversed order would paint the bevel first, then
            // the aura would overlay it and the bevel's tactile
            // depth cue would be muddied by the brand light.
            const stack = getRowShadowStack();
            expect(stack.length).toBeGreaterThan(0);
            const auraIdx = stack.indexOf('var(--nav-row-aura-color)');
            const bevelIdx = stack.indexOf('var(--nav-bevel-shadow)');
            expect(auraIdx).toBeGreaterThan(-1);
            expect(bevelIdx).toBeGreaterThan(auraIdx);
        });

        it('aura is OUTER (not inset)', () => {
            // The aura's geometry must NOT carry the `inset`
            // keyword. An inset aura would paint inside the row
            // and overlap with the bevel — visually equivalent
            // to a heavier bevel, defeating the "halo of brand
            // light" intent.
            const stack = getRowShadowStack();
            expect(stack.length).toBeGreaterThan(0);
            // Bound the aura's segment from its start to the first
            // comma (which separates shadow layers in CSS).
            const auraStart = stack.indexOf('0_0_');
            expect(auraStart).toBeGreaterThan(-1);
            const firstComma = stack.indexOf(',', auraStart);
            const auraSegment = stack.slice(auraStart, firstComma);
            expect(auraSegment).not.toContain('inset');
        });
    });

    describe('default state — no aura on inactive rows', () => {
        it('NAV_ITEM_DEFAULT does NOT carry the aura token', () => {
            // The aura is reserved for the active row. A hover
            // aura on inactive rows would dilute the "this is
            // where you are" signal.
            const defaultRecipe =
                NAV_ITEM_SRC.match(
                    /export\s+const\s+NAV_ITEM_DEFAULT\s*=\s*['"]([^'"]+)['"]/,
                )?.[1] ?? '';
            expect(defaultRecipe).not.toMatch(/--nav-row-aura-color/);
        });
    });
});

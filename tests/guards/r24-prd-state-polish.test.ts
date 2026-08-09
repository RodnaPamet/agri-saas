/**
 * R24-PR-D — State + interaction polish ratchet.
 *
 * Locks four state-related invariants on the new liquid-glass
 * primitive:
 *   1. Disabled state preserves the R22-PR-D two-channel mute
 *      (opacity-50 + saturate-50). Glass alone doesn't read as
 *      "inert" on a coloured primary tile; the saturation drain
 *      stays load-bearing across the carbon → glass swap.
 *   2. `prefers-reduced-transparency: reduce` strips the
 *      backdrop-blur (WCAG 1.4.11). Users who opt out of
 *      transparency at the OS level see a flat opaque surface,
 *      not a noisy translucent one.
 *   3. `prefers-reduced-transparency: reduce` also forces the
 *      `::before` depth overlay to full opacity so the surface
 *      reads as a flat panel rather than a half-transparent one.
 *   4. R20-PR-D's state-conditional ambient elevation pattern
 *      (active = collapsed ambient; focus = brand-tinted halo)
 *      survives the material swap — preserved by the R24-PR-B
 *      glassSurface recipe.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const VARIANTS_PATH = path.resolve(
    __dirname,
    '../../src/components/ui/button-variants.ts',
);

const SRC = fs.readFileSync(VARIANTS_PATH, 'utf8');

describe('R24-PR-D — State + interaction polish', () => {
    describe('Disabled state', () => {
        it('preserves the two-channel mute (opacity-50 + saturate-50)', () => {
            // R22-PR-D added saturate-50 because opacity-50 alone
            // wasn't enough on the carbon palette. Same holds for
            // glass — a translucent coloured tile at opacity-50
            // still reads "active but dimmed", not "inert".
            expect(SRC).toMatch(/disabled:opacity-50/);
            expect(SRC).toMatch(/disabled:saturate-50/);
        });

        it('disables pointer events so the inert state is also un-clickable', () => {
            expect(SRC).toMatch(/disabled:pointer-events-none/);
        });
    });

    describe('Reduced-transparency accessibility', () => {
        it('strips backdrop-blur under prefers-reduced-transparency: reduce', () => {
            // The OS-level "reduce transparency" setting must turn
            // off the glass blur entirely. WCAG 1.4.11; matches the
            // behaviour macOS users expect from native practices when
            // they enable "Reduce Transparency".
            expect(SRC).toMatch(
                /\[@media\(prefers-reduced-transparency:reduce\)\]:backdrop-blur-none/,
            );
        });

        it('forces the ::before depth overlay to full opacity under reduced-transparency', () => {
            // With backdrop-blur off, the ::before half-transparent
            // glass tint would read as "broken state" rather than
            // "intentional flat panel". Forcing opacity-100 lifts
            // the panel to a single opaque surface.
            expect(SRC).toMatch(
                /\[@media\(prefers-reduced-transparency:reduce\)\]:before:opacity-100/,
            );
        });
    });

    describe('R20-PR-D ambient elevation pattern survives the swap', () => {
        // The state-conditional ambient elevation (active = collapsed,
        // focus = brand-tinted halo) is the R20-PR-D contract. R24-PR-B
        // preserved it on the glass recipe; ratchet here so a future
        // PR that "simplifies" the glassSurface shadow chain has to
        // explicitly retire the contract.
        it('glassSurface uses --btn-ambient-press on active state', () => {
            expect(SRC).toMatch(
                /active:shadow-\[var\(--btn-glass-inner\),var\(--btn-ambient-press\)\]/,
            );
        });

        it('glassSurface uses --btn-ambient-focus on focus-visible', () => {
            expect(SRC).toMatch(
                /focus-visible:shadow-\[var\(--btn-glass-inner\),var\(--btn-ambient-focus\)\]/,
            );
        });
    });

    describe('Tactile press behaviours preserved (motion-language compatible)', () => {
        it('active:scale-[0.97] + active:translate-y-px both present', () => {
            // R11-PR4's scale + R20-PR-D's translateY. Both are
            // active-driven (motion-language compliant — no
            // hover-driven scale/translate).
            expect(SRC).toMatch(/active:scale-\[0\.97\]/);
            expect(SRC).toMatch(/active:translate-y-px/);
        });

        it('motion-reduce fallbacks present for both press behaviours', () => {
            expect(SRC).toMatch(/motion-reduce:active:scale-100/);
            expect(SRC).toMatch(/motion-reduce:active:translate-y-0/);
        });
    });
});

/**
 * R22-PR-D — Disabled state + loading spinner polish ratchet.
 *
 * Two small polishes the R22 prompts flagged:
 *
 *   1. **Blanket `opacity-50` was too blunt for disabled.** On
 *      the carbon palette a 50%-opaque coloured button reads as
 *      "half-visible coloured button" — the brand identity bleeds
 *      through even when the user can't act on it. PR-D adds
 *      `disabled:saturate-50` on top of the opacity mute, so the
 *      colour channel ALSO drops 50%. A disabled primary reads
 *      as muted graphite rather than washed orange. R19's carbon
 *      `::before` already goes to opacity-0 on disabled — three
 *      channels mute in concert now.
 *
 *   2. **`LoadingSpinner` was hardcoded `background: "gray"`** on
 *      every segment. A primary loading button (white text on
 *      brand) showed a grey spinner — visual mismatch. Switching
 *      to `background: "currentColor"` makes the spinner inherit
 *      the parent's text colour: primary spins white, secondary
 *      spins in content-emphasis, destructive spins white on red,
 *      ghost spins in its muted tone. One token,
 *      variant-aware automatically.
 *
 * Not in scope: distinct disabled vs loading announce-to-AT
 * (would need ARIA work beyond the cva), motion-reduce audit of
 * the spinner itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const VARIANTS = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/button-variants.ts'),
    'utf8',
);
const SPINNER = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/icons/loading-spinner.tsx'),
    'utf8',
);

describe('R22-PR-D — Disabled + loading polish', () => {
    describe('disabled mute is graded (opacity + saturate)', () => {
        it('cva base carries both `disabled:opacity-50` and `disabled:saturate-50`', () => {
            const base =
                VARIANTS.match(/cva\(\s*\[([\s\S]*?)\]\s*,/)?.[1] ?? '';
            expect(base).toMatch(/disabled:opacity-50/);
            expect(base).toMatch(/disabled:saturate-50/);
        });

        it('disabled-state also clamps `pointer-events-none`', () => {
            const base =
                VARIANTS.match(/cva\(\s*\[([\s\S]*?)\]\s*,/)?.[1] ?? '';
            expect(base).toMatch(/disabled:pointer-events-none/);
        });

        it('R19 carbon ::before still drops to opacity-0 on disabled (third mute channel)', () => {
            // PR-D adds the SATURATE channel; the carbon-depth
            // OPACITY channel from R19-PR-D (`disabled:before:
            // opacity-0`) must survive. Three channels muted in
            // concert.
            const recipe =
                VARIANTS.match(/const\s+carbonStates\s*=\s*\[([\s\S]*?)\];/)?.[1] ??
                '';
            expect(recipe).toMatch(/disabled:before:opacity-0/);
        });
    });

    describe('LoadingSpinner uses currentColor (variant-aware)', () => {
        it('every segment background is "currentColor", not a hardcoded grey', () => {
            // The spinner now inherits the parent's text colour.
            // Asserted structurally so a future "simplify" PR
            // that hardcodes a colour again trips the test.
            expect(SPINNER).toMatch(/background:\s*["']currentColor["']/);
        });

        it('no hardcoded `gray` background remains', () => {
            const stripped = blankNonCode(SPINNER);
            expect(stripped).not.toMatch(/background:\s*["']gray["']/);
        });
    });
});

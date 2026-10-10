/**
 * R24-PR-F — Liquid-glass hardening + capstone meta-ratchet.
 *
 * Locks the R24 contract surface so a future PR can't silently
 * strip a piece. Three layers:
 *
 *   1. All 6 R24 ratchet files exist.
 *   2. The glass-token namespace stays sealed — no carbon-token
 *      regression in button-variants.ts.
 *   3. The cva base carries the reduced-transparency accessibility
 *      fallback (re-asserted here so PR-F survives even if PR-D
 *      gets reverted).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

const ALL_R24_RATCHETS = [
    'tests/guards/r24-pra-glass-token-foundation.test.ts',
    'tests/guards/r24-prb-primitive-redesign.test.ts',
    'tests/guards/r24-prc-slim-density.test.ts',
    'tests/guards/r24-prd-state-polish.test.ts',
    'tests/guards/r24-pre-rollout.test.ts',
    'tests/guards/r24-prf-hardening-capstone.test.ts',
] as const;

const BUTTON_VARIANTS = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/button-variants.ts'),
    'utf8',
);

describe('R24-PR-F — Hardening + capstone', () => {
    describe('Meta-lock — all 6 R24 ratchet files exist', () => {
        for (const ratchet of ALL_R24_RATCHETS) {
            it(`${ratchet} exists`, () => {
                expect(fs.existsSync(path.join(ROOT, ratchet))).toBe(true);
            });
        }
    });

    describe('Token namespace seal — no carbon regression in cva variants', () => {
        it('the cva variant block contains zero `--btn-carbon-` references', () => {
            // The R24 material swap pulled carbon out of the cva
            // variants. A future PR that re-introduces a carbon
            // token (even just inside a variant) means the swap is
            // half-undone.
            const variantsStart = BUTTON_VARIANTS.indexOf('variant: {');
            const variantsEnd = BUTTON_VARIANTS.indexOf('size: {', variantsStart);
            expect(variantsStart).toBeGreaterThan(-1);
            const block = BUTTON_VARIANTS.slice(variantsStart, variantsEnd);
            expect(block).not.toMatch(/--btn-carbon-/);
        });

        it('the cva variant block contains the glass token suite', () => {
            const variantsStart = BUTTON_VARIANTS.indexOf('variant: {');
            const variantsEnd = BUTTON_VARIANTS.indexOf('size: {', variantsStart);
            const block = BUTTON_VARIANTS.slice(variantsStart, variantsEnd);
            // Positive contract: glass spreads exist.
            expect(block).toMatch(/\.\.\.glassSurface/);
            expect(block).toMatch(/\.\.\.glassOnHover/);
        });
    });

    describe('Reduced-transparency a11y survives PR-D revert', () => {
        // Re-asserted here so the contract is locked at TWO points:
        // PR-D's own ratchet AND the capstone. Defense in depth.
        it('cva base has `prefers-reduced-transparency: reduce` fallback for backdrop-blur', () => {
            expect(BUTTON_VARIANTS).toMatch(
                /\[@media\(prefers-reduced-transparency:reduce\)\]:backdrop-blur-none/,
            );
        });
    });

    describe('Slim radius survives PR-C revert', () => {
        // Same defense-in-depth pattern. R24's "carved + slim"
        // commitment is the 8px corner. Capstone locks it.
        it('cva base uses `rounded-[8px]` (the R24 slim shape)', () => {
            expect(BUTTON_VARIANTS).toMatch(/rounded-\[8px\]/);
            // Comments stripped to allow the historical references
            // ("R22-PR-A took it from rounded-lg to rounded-[10px]").
            const stripped = blankNonCode(BUTTON_VARIANTS);
            expect(stripped).not.toMatch(/rounded-\[10px\]/);
            expect(stripped).not.toMatch(/\brounded-lg\b/);
        });
    });
});

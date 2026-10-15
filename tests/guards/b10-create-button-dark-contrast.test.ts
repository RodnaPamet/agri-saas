/**
 * B10 (2026-06-07) — dark-theme create-button contrast.
 *
 * The primary (create) button rendered WHITE text on the bright METRO-yellow
 * dark-theme fill — a low-contrast wash. Two fixes:
 *   1. label → `text-content-inverted` (deep navy "metro" blue in dark,
 *      off-white in light) instead of `text-white`.
 *   2. the dark `--btn-glass-fill-primary` deepened from the pale 0.55 yellow
 *      to a richer, more saturated gold at higher alpha.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
// Comments blanked before matching (#1774). Comments only, NOT strings:
// an assertion about a string LITERAL would pass vacuously under
// `{ strings: true }`, which is why this stays a per-file decision.
const read = (p: string) =>
    blankNonCode(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const BV = read('src/components/ui/button-variants.ts');
const TOKENS = read('src/styles/tokens.css');

describe('B10 — dark create-button contrast', () => {
    it('the primary label uses the inverted (metro-navy) token, not white', () => {
        expect(BV).toMatch(
            /var\(--btn-gradient-primary\)\]\s+text-content-inverted/,
        );
        expect(BV).not.toMatch(/var\(--btn-gradient-primary\)\]\s+text-white/);
    });

    it('the dark primary fill is deepened (not the pale 0.55 wash)', () => {
        expect(TOKENS).toMatch(
            /--btn-glass-fill-primary:\s*rgba\(232,\s*185,\s*4,\s*0\.85\)/,
        );
        expect(TOKENS).not.toMatch(
            /--btn-glass-fill-primary:\s*rgba\(255,\s*205,\s*17,\s*0\.55\)/,
        );
    });
});

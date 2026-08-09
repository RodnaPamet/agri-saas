/**
 * PR-B — Table & button hygiene ratchet.
 *
 *   1. Tests rollup table splits Name + Status into separate
 *      columns (no longer stacked inside one cell).
 *
 *   2. Risk gains a `key` column ('RSK-N') generated atomically
 *      via `RiskKeySequence.upsert`. The Risk list page leads
 *      with the new Code column.
 *
 *   3. The shared `<Button>` centres its content unit
 *      `[icon][gap][label]` (justify-center + hug-content) so
 *      "+ Create X" reads as a tidy, balanced control. (The original
 *      "icon-balance ghost" was reverted 2026-05-31 — see the
 *      describe block below.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('PR-B — table & button hygiene', () => {

    describe('"+ Create X" button alignment — centred content unit', () => {
        // 2026-05-31: the original PR-B "icon-balance ghost" (an
        // invisible mirror of the icon on the trailing edge that
        // centred the LABEL alone) was reverted on user feedback. The
        // ghost widened buttons with one-sided blank space and the
        // `+ word` unit didn't read as centred. The button now centres
        // the WHOLE content unit `[icon][gap][label]` via
        // justify-center + hug-content, so `+ Asset` reads as a tidy
        // centred unit. The canonical lock now lives in
        // tests/guards/button-label-centering.test.ts +
        // tests/rendered/button-label-centering.test.tsx.
        const src = read('src/components/ui/button.tsx');

        it('no longer renders a balance ghost (centres the content unit instead)', () => {
            expect(src).not.toMatch(/data-icon-balance-ghost/);
            expect(src).not.toMatch(/data-right-balance-ghost/);
        });

        it('centres the content unit via justify-center', () => {
            const variants = read('src/components/ui/button-variants.ts');
            expect(variants).toMatch(/inline-flex items-center justify-center/);
        });
    });

});

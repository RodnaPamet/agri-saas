/**
 * R21-PR-C — Heatmap rebuild ratchet (RiskHeatmap).
 *
 * Both heatmaps move onto R21-PR-A's `useHeatScale` + `<ChartLegend
 * variant="gradient">` foundation. Same hook, two heatmaps, one
 * vocabulary.
 *
 * Eight load-bearing invariants this ratchet locks:
 *
 *   RiskHeatmap (5×5 likelihood × impact):
 *     1. Wires useHeatScale with the score domain [1, scale²] and
 *        series 4 (pink — the closest "severity" ramp in R16).
 *     2. Cell backgrounds paint via `heat.colorFor(score)`, not via
 *        the previous bespoke `getCellColor` hex palette.
 *     3. Hover crosshair: hovered cell highlights its row AND
 *        column (the canonical matrix-heatmap affordance).
 *     4. `onSelectCell` callback wires the click-drill — count=0
 *        cells are disabled.
 *     5. Empty-cell muted via opacity 0.4 (still part of the
 *        gradient vocabulary, just at the floor).
 *     6. <ChartLegend variant="gradient"> replaces the 4-swatch
 *        legend.
 *
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const RISK = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/RiskHeatmap.tsx'),
    'utf8',
);

describe('R21-PR-C — Heatmap rebuild on R21-PR-A foundation', () => {
    describe('RiskHeatmap', () => {
        it('imports useHeatScale + ChartLegend from the charts barrel', () => {
            expect(RISK).toMatch(/from\s+['"]@\/components\/ui\/charts['"]/);
            expect(RISK).toMatch(/useHeatScale/);
            expect(RISK).toMatch(/ChartLegend/);
        });

        it('wires useHeatScale with the score domain [1, scale²] + series 4', () => {
            // The score domain is `likelihood × impact` — for a 5×5
            // matrix that's [1, 25]. The domain is parametric on
            // `scale` so a future 10×10 use case scales cleanly.
            expect(RISK).toMatch(/domain:\s*\[1,\s*scoreMax\]/);
            expect(RISK).toMatch(/scoreMax\s*=\s*scale\s*\*\s*scale/);
            expect(RISK).toMatch(/series:\s*4/);
        });

        it('cell background paints via heat.colorFor(score)', () => {
            expect(RISK).toMatch(/background:\s*heat\.colorFor\(score\)/);
        });

        it('the bespoke getCellColor hex palette is gone', () => {
            // Stripping comments so historical doc-block references
            // don't trip the check.
            const stripped = RISK.replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(stripped).not.toMatch(/getCellColor/);
            expect(stripped).not.toMatch(/bg-red-500/);
            expect(stripped).not.toMatch(/bg-emerald-500/);
        });

        it('hover crosshair highlights row + column', () => {
            // The crosshair state carries `likelihood` + `impact`;
            // a cell is on the crosshair if EITHER matches the
            // hovered cell's coords.
            expect(RISK).toMatch(/setHovered\(\{\s*likelihood,\s*impact\s*\}\)/);
            expect(RISK).toMatch(
                /hovered\.likelihood\s*===\s*likelihood\s*\|\|\s*hovered\.impact\s*===\s*impact/,
            );
            expect(RISK).toMatch(/data-cell-crosshair/);
        });

        it('row + column axis labels also light up on crosshair', () => {
            // Subtle affordance — the eye scans up to the row
            // number + across to the column number; lighting both
            // up reinforces the matrix coordinate read.
            expect(RISK).toMatch(
                /hovered\?\.likelihood\s*===\s*likelihood/,
            );
            expect(RISK).toMatch(/hovered\?\.impact\s*===\s*impact/);
        });

        it('onSelectCell fires only when count > 0', () => {
            // count=0 cells are not clickable (nothing to drill
            // into). The `disabled` + `clickable` gates prevent
            // spurious callbacks.
            expect(RISK).toMatch(/clickable\s*=\s*count\s*>\s*0\s*&&\s*Boolean\(onSelectCell\)/);
            expect(RISK).toMatch(/disabled=\{!clickable\}/);
            expect(RISK).toMatch(/onSelectCell\?\.\(\{[\s\S]*?likelihood[\s\S]*?impact[\s\S]*?count[\s\S]*?\}\)/);
        });

        it('empty cells paint at heat-scale floor opacity 0.4 (still part of vocabulary)', () => {
            expect(RISK).toMatch(/count\s*===\s*0\s*\?\s*0\.4\s*:\s*1/);
        });

        it('<ChartLegend variant="gradient"> replaces the 4-swatch legend', () => {
            expect(RISK).toMatch(/<ChartLegend/);
            expect(RISK).toMatch(/variant="gradient"/);
            expect(RISK).toMatch(/heatScale=\{heat\}/);
            // And the old 4-swatch legend block is gone.
            const stripped = RISK.replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(stripped).not.toMatch(/{\s*label:\s*['"]Critical['"]/);
        });
    });

    describe('Shared vocabulary — the R21-PR-A foundation', () => {
        it('both files import useHeatScale + ChartLegend', () => {
            for (const src of [RISK]) {
                expect(src).toMatch(/useHeatScale/);
                expect(src).toMatch(/ChartLegend/);
            }
        });

        it('both files paint cells via heat.colorFor (no bespoke palettes)', () => {
            for (const src of [RISK]) {
                expect(src).toMatch(/heat\.colorFor/);
            }
        });
    });
});

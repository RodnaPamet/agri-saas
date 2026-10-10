/**
 * R21-PR-D — Funnel polish ratchet.
 *
 * Five refinements applied to the legacy FunnelChart, each locked
 * structurally below:
 *
 *   1. curveBasis → curveCatmullRom (centripetal). Same vocabulary
 *      as the R16 LineChart.
 *   2. Optional `seriesIndex` field per step → `<ChartLinearGradient>`
 *      def + `fill="url(#id)"` path. Backward-compat with the
 *      legacy `colorClassName` field.
 *   3. Conversion-rate annotation between adjacent stages
 *      (small tabular-nums % at the stage boundary).
 *   4. Hover-isolate sibling fade — focused stage stays bright,
 *      others drop to 0.3 of their full opacity family.
 *   5. ChartTooltipContainer replaces the legacy hard-coded
 *      `bg-white` / `border-neutral-200` tooltip surface.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const FUNNEL = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/charts/funnel-chart.tsx'),
    'utf8',
);

describe('R21-PR-D — Funnel polish', () => {
    describe('curve swap — curveBasis → curveCatmullRom', () => {
        it('imports curveCatmullRom from @visx/curve', () => {
            expect(FUNNEL).toMatch(
                /import\s+\{\s*curveCatmullRom\s*\}\s+from\s+['"]@visx\/curve['"]/,
            );
        });
        it('no longer imports the legacy curveBasis', () => {
            const stripped = blankNonCode(FUNNEL);
            expect(stripped).not.toMatch(/curveBasis/);
        });
        it('the Area component receives curveCatmullRom as its curve prop', () => {
            expect(FUNNEL).toMatch(/curve=\{curveCatmullRom\}/);
        });
    });

    describe('gradient fills via R16 ChartLinearGradient', () => {
        it('imports ChartLinearGradient + ChartSeriesIndex from ./chart-gradient', () => {
            expect(FUNNEL).toMatch(/ChartLinearGradient/);
            expect(FUNNEL).toMatch(/ChartSeriesIndex/);
        });

        it('step type carries an optional `seriesIndex` field', () => {
            expect(FUNNEL).toMatch(/seriesIndex\?\:\s*ChartSeriesIndex/);
        });

        it('mints one gradient def per series in use (deduped)', () => {
            expect(FUNNEL).toMatch(/seriesIndicesInUse/);
            expect(FUNNEL).toMatch(/<ChartLinearGradient/);
            // `direction="vertical"` matches the funnel's stage
            // orientation (taller-on-the-sides, narrower-in-the-middle).
            expect(FUNNEL).toMatch(/direction="vertical"/);
        });

        it('Area fills via url(#...) when seriesIndex is set, falls back to currentColor', () => {
            expect(FUNNEL).toMatch(
                /fill=\{[\s\S]*?seriesIndex[\s\S]*?\?\s*`url\(#\$\{chartId\}-series-\$\{seriesIndex\}\)`[\s\S]*?:\s*['"]currentColor['"]/,
            );
        });

        it('backward-compat — colourClassName still applies when seriesIndex is omitted', () => {
            // The legacy path is preserved with a falsy-guarded
            // class-application: `!seriesIndex && colorClassName`.
            expect(FUNNEL).toMatch(/!seriesIndex\s*&&\s*colorClassName/);
        });
    });

    describe('between-stage conversion-rate annotation', () => {
        it('computes deltaPct relative to the previous step', () => {
            expect(FUNNEL).toMatch(
                /prev\s*=\s*idx\s*>\s*0\s*\?\s*steps\[idx\s*-\s*1\]\.value\s*:\s*null/,
            );
            expect(FUNNEL).toMatch(
                /deltaPct\s*=\s*[\s\S]*?\(value\s*\/\s*prev\)\s*\*\s*100/,
            );
        });

        it('renders the delta at the stage boundary, skipping stage 0', () => {
            expect(FUNNEL).toMatch(/deltaPct\s*!==\s*null\s*&&\s*idx\s*>\s*0/);
        });

        it('annotation uses tabular-nums + font-mono for legible numbers', () => {
            expect(FUNNEL).toMatch(/font-mono\s+tabular-nums/);
        });

        it('annotation lights up brand-default on the hovered stage', () => {
            expect(FUNNEL).toMatch(
                /isHoveredStage\s*&&\s*['"]fill-\[var\(--brand-default\)\]['"]/,
            );
        });
    });

    describe('hover-isolate sibling fade', () => {
        it('the focused stage stays at 1.0 opacity multiplier', () => {
            // hasOtherTooltip = the *other* tooltip is the one set —
            // this stage isn't the focused one.
            expect(FUNNEL).toMatch(
                /hasOtherTooltip\s*=\s*tooltip\s*!==\s*null\s*&&\s*tooltip\s*!==\s*id/,
            );
        });

        it('siblings drop to 0.3 of their opacity family on hover', () => {
            expect(FUNNEL).toMatch(
                /isolationMultiplier\s*=\s*hasOtherTooltip\s*\?\s*0\.3\s*:\s*1/,
            );
            expect(FUNNEL).toMatch(/effectiveOpacity\s*=\s*opacity\s*\*\s*isolationMultiplier/);
        });

        it('motion-on-opacity uses a 150ms duration consistent with R16 hover-pop', () => {
            expect(FUNNEL).toMatch(
                /transition=\{\{\s*opacity:\s*\{\s*duration:\s*0\.15\s*\}\s*\}\}/,
            );
        });
    });

    describe('tooltip surface on the R16 token vocabulary', () => {
        it('uses ChartTooltipContainer from ./interaction', () => {
            expect(FUNNEL).toMatch(/ChartTooltipContainer/);
            expect(FUNNEL).toMatch(/from\s+['"]\.\/interaction['"]/);
        });

        it('the legacy hard-coded bg-white / border-neutral-200 surface is gone', () => {
            // Token-themed surface drives dark/light parity. The
            // legacy bg-white literal must NOT be present in the
            // tooltip render path.
            const stripped = blankNonCode(FUNNEL);
            expect(stripped).not.toMatch(/border-neutral-200\s+bg-white/);
        });

        it('tooltip swatch uses the same chart-series gradient as the chart fill', () => {
            // The tiny colour dot inside the tooltip body should
            // match the stage's gradient — same series, same stops
            // — so the legend↔chart visual continuity holds inside
            // the tooltip too.
            expect(FUNNEL).toMatch(
                /linear-gradient\(135deg,\s*var\(--chart-series-\$\{tooltipStep\.seriesIndex\}-start\),\s*var\(--chart-series-\$\{tooltipStep\.seriesIndex\}-end\)\)/,
            );
        });
    });
});

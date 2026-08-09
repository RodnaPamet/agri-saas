/**
 * R18 visible-uplift A — glossify the charts the dashboard
 * actually shows.
 *
 * Roadmap-18 (Charts II) built a solid gloss primitive layer but
 * wired the visible treatments into `LineChart` + `Bars` — chart
 * primitives that AREN'T on the executive dashboard. The dashboard
 * renders `ProgressCard`, `DonutChart`, `TrendCard` ×4 (built on
 * `Areas`), and `RiskMatrix` — and only `DonutChart` got touched,
 * with a gloss tuned so subtle it was imperceptible.
 *
 * Uplift-A hits the three most-looked-at dashboard surfaces:
 *
 *   1. DonutChart — gloss intensity `default → bright`. The
 *      0.32-peak sheen was too quiet; `bright` (0.48) makes the
 *      glass read at a glance.
 *   2. Areas — the primitive behind all 4 TrendCards. Gets the
 *      two-layer paint (ChartGloss def + a gloss overlay
 *      motion.path tracking the colour layer's `d` morph).
 *   3. ProgressCard — the Practice Coverage bar. Its HTML-div
 *      track gets an `::after` gloss sheen (a CSS white→
 *      transparent ramp).
 *
 * Five load-bearing invariants:
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const DONUT = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/DonutChart.tsx'),
    'utf8',
);
const AREAS = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/charts/areas.tsx'),
    'utf8',
);
const PROGRESS = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/ProgressCard.tsx'),
    'utf8',
);

describe('R18 visible-uplift A — dashboard chart gloss', () => {
    it('DonutChart gloss intensity is `bright` (was `default` — too quiet)', () => {
        expect(DONUT).toMatch(
            /<ChartGloss[\s\S]*?intensity="bright"/,
        );
        // And the quiet default is gone from the ChartGloss def.
        expect(DONUT).not.toMatch(
            /<ChartGloss[\s\S]*?intensity="default"/,
        );
    });

    it('Areas imports ChartGloss + renders a gloss def', () => {
        expect(AREAS).toMatch(
            /import\s*\{\s*ChartGloss,\s*chartGlossId,?\s*\}\s*from\s*['"]\.\/chart-gloss['"]/,
        );
        expect(AREAS).toMatch(
            /<ChartGloss\s+id=\{chartGlossId\(s\.id\)\}/,
        );
    });

    it('Areas paints a gloss overlay motion.path tracking the colour layer d-morph', () => {
        // The two-layer paint: a second motion.path inside the
        // AreaClosed render-prop, same `d` morph, filled with the
        // gloss def, inert.
        expect(AREAS).toMatch(
            /fill=\{`url\(#\$\{chartGlossId\(s\.id\)\}\)`\}/,
        );
        // Both the colour layer and the gloss layer animate `d`
        // from zeroedData → data — the sheen rises with the fill.
        const zeroedInits = AREAS.match(
            /initial=\{\{\s*d:\s*path\(zeroedData\)/g,
        );
        expect(zeroedInits).not.toBeNull();
        expect(zeroedInits!.length).toBeGreaterThanOrEqual(2);
    });

    it('Areas gloss overlay is inert (aria-hidden + pointerEvents none)', () => {
        expect(AREAS).toMatch(
            /fill=\{`url\(#\$\{chartGlossId\(s\.id\)\}\)`\}[\s\S]*?aria-hidden="true"[\s\S]*?pointerEvents:\s*["']none["']/,
        );
    });

    it('ProgressCard track is `relative` + carries an ::after gloss sheen', () => {
        // The track div: relative (positioning context) + an
        // ::after white→transparent ramp, rounded-full to track
        // the pill shape, pointer-events-none.
        expect(PROGRESS).toMatch(/relative\s+flex-1\s+bg-bg-subtle/);
        expect(PROGRESS).toMatch(
            /after:content-\[''\][\s\S]*?after:absolute[\s\S]*?after:inset-0[\s\S]*?after:rounded-full[\s\S]*?after:pointer-events-none/,
        );
        expect(PROGRESS).toMatch(
            /after:bg-\[linear-gradient\(180deg,rgba\(255,255,255,0\.28\)/,
        );
    });
});

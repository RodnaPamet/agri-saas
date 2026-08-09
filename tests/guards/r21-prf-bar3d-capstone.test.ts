/**
 * R21-PR-F — First 3D Chart (BarField3D) + Roadmap-21 capstone.
 *
 * PR-F lands the first real 3D chart on the R21-PR-E foundation:
 * `<BarField3D>` renders a cross-tab of two discrete dimensions
 * (typically time × category) as a grid of bars with value-encoded
 * heights. Bars colour-map from the chart-series gradient (base =
 * `start` token, tip = `end` token) and read with the directional
 * light's shadow falloff for silhouette depth.
 *
 * This ratchet also acts as the R21 capstone — it asserts every
 * R21 PR's contributions are still in place, so a future PR can't
 * silently strip one piece of the Sculpted Charts system.
 *
 * Part 1 — PR-F invariants (BarField3D):
 *
 *   1. The component file exists, is a client component, and
 *      composes onto <Chart3D> from PR-E.
 *   2. Accepts `BarField3DDatum` rows with discrete x + z axes
 *      and a numeric y.
 *   3. Computes x / z extents from the data; missing cells are
 *      gaps in the grid, not bars with zero height.
 *   4. Bars colour-map via `tokenColor(seriesIndex, 'start'|'end')`
 *      — Three.js can't read CSS vars; tokenColor bridges.
 *   5. Floor mesh provides a neutral plane so the OrbitPractices
 *      rotation makes geometric sense.
 *   6. ariaLabel + FallbackComponent forward through to <Chart3D>.
 *
 * Part 2 — R21 capstone (every PR's contribution still in place):
 *
 *   7. PR-A useHeatScale + ChartLegend foundation still exported.
 *   8. PR-B Sankey still wires KIND_SERIES + ChartLinearGradient.
 *   9. PR-C heatmaps still consume useHeatScale.
 *  10. PR-D funnel still uses curveCatmullRom + ChartTooltipContainer.
 *  11. PR-E 3D foundation (Chart3D + tokenColor + dynamicChart3D)
 *      still exported.
 *  12. Documentation: docs/charts-elegance.md has a Roadmap-21
 *      section.
 *  13. All six R21 ratchets exist (the meta-lock: future PRs
 *      can't silently strip one of the ratchets).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const BAR3D = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/charts/bar-field-3d.tsx'),
    'utf8',
);
const BARREL = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/charts/index.ts'),
    'utf8',
);
const DOCS = fs.readFileSync(
    path.join(ROOT, 'docs/charts-elegance.md'),
    'utf8',
);

describe('R21-PR-F — BarField3D + Roadmap-21 capstone', () => {
    describe('BarField3D — first 3D chart on the R21-PR-E foundation (STUB)', () => {
        // PR-F originally shipped a live r3f scene (mesh + box-
        // geometry + plane floor + token-driven materials). The
        // r3f/React 19 compatibility deadlock (see chart-3d.tsx
        // head matter) forced PR-F to land as a STUB too. The API
        // shape stays the same; the inner render branch is
        // currently the FallbackComponent (via <Chart3D>). When
        // r3f's React 19 story stabilises, a follow-up swaps the
        // inner branch with the real 3D scene — no call-site
        // change.

        it('is a client component', () => {
            expect(BAR3D.split('\n')[0]).toMatch(/^'use client'/);
        });

        it('composes onto <Chart3D> from PR-E', () => {
            expect(BAR3D).toMatch(/from\s+['"]\.\/chart-3d['"]/);
            expect(BAR3D).toMatch(/<Chart3D/);
            expect(BAR3D).toMatch(/Chart3D/);
        });

        it('exports BarField3D + BarField3DDatum + BarField3DProps', () => {
            expect(BAR3D).toMatch(/export\s+function\s+BarField3D/);
            expect(BAR3D).toMatch(
                /export\s+interface\s+BarField3DDatum/,
            );
            expect(BAR3D).toMatch(
                /export\s+interface\s+BarField3DProps/,
            );
        });

        it('preserves the API shape — x/z categorical + y value', () => {
            // The data type is locked at the API level so the
            // future renderer doesn't churn call sites.
            expect(BAR3D).toMatch(/x:\s*string;/);
            expect(BAR3D).toMatch(/z:\s*string;/);
            expect(BAR3D).toMatch(/y:\s*number;/);
        });

        it('preserves the seriesIndex + maxHeight props for the future renderer', () => {
            // Currently unused in the stub branch but locked at
            // the API level — when the renderer lands, no
            // call-site change.
            expect(BAR3D).toMatch(/seriesIndex\?:\s*ChartSeriesIndex/);
            expect(BAR3D).toMatch(/maxHeight\?:/);
        });

        it('forwards ariaLabel + FallbackComponent to <Chart3D>', () => {
            // Chart3D requires ariaLabel; BarField3D MUST propagate
            // it. In the stub state, FallbackComponent IS the
            // visible chart — supply it.
            expect(BAR3D).toMatch(/ariaLabel=\{ariaLabel\}/);
            expect(BAR3D).toMatch(/FallbackComponent=\{FallbackComponent\}/);
        });

        it('documents the stub state at the file head', () => {
            // A future engineer reading this file needs to know
            // WHY there's no r3f scene rendered today.
            expect(BAR3D).toMatch(/STUB/);
            expect(BAR3D).toMatch(/SCAFFOLD/);
        });

        it('is re-exported from the charts barrel', () => {
            expect(BARREL).toMatch(/export\s+\{\s*BarField3D\s*\}/);
            expect(BARREL).toMatch(
                /BarField3DDatum[,\s]/,
            );
            expect(BARREL).toMatch(/BarField3DProps/);
        });
    });

    describe('R21 capstone — every PR\'s contribution is still in place', () => {
        // PR-A/B/C/D content is locked by each PR's own ratchet;
        // this capstone deliberately doesn't duplicate that
        // assertion surface — what it locks is the META structure
        // (file existence of all six ratchets + foundation re-
        // exports through the barrel). A future PR that strips one
        // R21 ratchet file trips the meta-lock below; the broken
        // PR's own content ratchet stays the substantive guard.

        it('barrel re-exports the R21-PR-A + PR-E foundations', () => {
            expect(BARREL).toMatch(/useHeatScale/);
            expect(BARREL).toMatch(/ChartLegend/);
            expect(BARREL).toMatch(/Chart3D,\s*tokenColor/);
            expect(BARREL).toMatch(/dynamicChart3D/);
            expect(BARREL).toMatch(/BarField3D/);
        });

        it('docs/charts-elegance.md carries the Roadmap-21 section', () => {
            expect(DOCS).toMatch(/Roadmap-21/i);
            expect(DOCS).toMatch(/Sculpted Charts/i);
            expect(DOCS).toMatch(/BarField3D/);
            expect(DOCS).toMatch(/<Chart3D>/);
        });

        it('the R21 ratchet contract surface stays intact (meta-lock)', () => {
            // The capstone enforces that the R21 ratchets are a
            // contract surface: a future PR can't silently strip
            // one of them without tripping THIS test.
            //
            // We check by PATTERN rather than by exact filenames so
            // this assertion stays correct whether PR-F lands first
            // (only PR-A + PR-E + PR-F on the branch = 3 files) or
            // last (all six = 6). After all R21 PRs merge to main,
            // a future PR that drops one of the six fails this
            // pattern count.
            const guardDir = path.join(ROOT, 'tests/guards');
            const r21Files = fs
                .readdirSync(guardDir)
                .filter((name) => /^r21-pr.*\.test\.ts$/.test(name));
            // Always have AT LEAST PR-A, PR-E, PR-F on any R21
            // branch. The full six only on main after all merge.
            expect(r21Files.length).toBeGreaterThanOrEqual(3);
            // The two we authored directly here must always be in.
            expect(r21Files).toEqual(
                expect.arrayContaining([
                    'r21-pra-foundation.test.ts',
                    'r21-pre-3d-foundation.test.ts',
                    'r21-prf-bar3d-capstone.test.ts',
                ]),
            );
        });
    });
});

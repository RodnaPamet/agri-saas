/**
 * The gap contract in `Areas`, held structurally.
 *
 * WHY A GUARD AND NOT A RENDERED TEST. CLAUDE.md is right that a guard proves
 * a pattern is present and never runs the subject, and the pure half of this
 * fix IS executed — `tests/unit/chart-missing-values.test.ts` runs the
 * accessor and the y-domain composition. What that cannot reach is the `d`
 * attribute: both shapes are `motion.path`, whose `d` framer-motion animates
 * from `path(zeroedData)` to `path(data)`, and jsdom neither runs the
 * animation nor settles it. Asserting on `d` would either read the zeroed
 * initial frame or flake. So the executable test covers the value contract and
 * this covers the wiring, and the split is stated rather than left implied.
 *
 * WHAT BREAKS WITHOUT IT. `buildMergedData` omits a series' key outside its own
 * reporting span so a dead feed stops. `y` still resolves undefined with
 * `?? 0`, because d3 calls it for every point and it must return a number.
 * `defined` is the only thing deciding the point is not DRAWN. Delete it and
 * the `?? 0` becomes visible again: production on 2026-08-13 showed two EC
 * wheat series plunging from ~190 to the floor, with the y-axis stretched to
 * 0-200 for data spanning 175-200.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AREAS = readFileSync(
    join(process.cwd(), 'src/components/ui/charts/areas.tsx'),
    'utf8',
);

describe('Areas draws gaps, not zeroes', () => {
    it('passes `defined` to both the fill and the line', () => {
        // Two shapes, two call sites: AreaClosed paints the fill, Area paints
        // the stroke. Wiring only one leaves a filled region under a broken
        // line, or a continuous line over a broken fill.
        const defined = AREAS.match(/defined=\{\(d\)\s*=>\s*s\.valueAccessor\(d\)\s*!=\s*null\}/g);
        expect(defined).not.toBeNull();
        expect(defined).toHaveLength(2);
    });

    it('keeps the `?? 0` coordinate fallback alongside it', () => {
        // Removing the fallback in favour of `defined` alone looks tidier and
        // breaks: d3 invokes `y` for undefined points regardless of `defined`,
        // and yScale(undefined) is NaN, which poisons the whole path.
        const yFallbacks = AREAS.match(/y=\{\(d\)\s*=>\s*yScale\(s\.valueAccessor\(d\)\s*\?\?\s*0\)\}/g);
        expect(yFallbacks).toHaveLength(2);
    });

    it('places the latest-value dot on the series own last reported point', () => {
        // `data.at(-1)` is the last row of the DATASET, which belongs to
        // whichever series is still reporting. Reading a stopped series there
        // yields undefined and puts its dot at NaN.
        expect(AREAS).toMatch(/\.reverse\(\)\s*\.find\(\(d\) => s\.valueAccessor\(d\) != null\)/);
        expect(AREAS).not.toMatch(/cy=\{yScale\(s\.valueAccessor\(data\.at\(-1\)!\)\)\}/);
    });
});

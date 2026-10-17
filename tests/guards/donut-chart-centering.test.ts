/**
 * DonutChart centering — visx `<Pie>` children render-prop trap.
 *
 * Real-world bug (caught 2026-05-14, present since the R16-PR5
 * rebuild): the dashboard's Risk Distribution donut rendered as
 * a thin crescent in the top-left corner of its SVG box. All
 * three arcs were in the DOM with correct `d` geometry and
 * fills — they were just drawn around SVG (0,0) instead of the
 * box centre.
 *
 * Root cause: visx's `<Pie>` only honours its `top` / `left`
 * props in the DEFAULT render path. When a `children` render-
 * prop is supplied:
 *
 *   // node_modules/@visx/shape/lib/shapes/Pie.js
 *   if (children) return <>{children({ arcs, path, pie })}</>;
 *   return <Group top={top} left={left}>...</Group>;
 *
 * the component returns a bare Fragment and DROPS top/left.
 * d3-shape's arc generator emits origin-centred coordinates, so
 * without an explicit centring transform the whole pie sits at
 * the SVG corner.
 *
 * DonutChart uses the children render-prop form (it needs per-
 * arc hover-pop wrappers + gradient fills). So it MUST supply
 * its own centring `<g transform="translate(center,center)">`
 * around the `<Pie>`.
 *
 * Three load-bearing invariants:
 *
 *   1. A `<g transform={`translate(${center},${center})`}>`
 *      wraps the `<Pie>`. This is the centring transform visx
 *      would have applied itself in the non-children path.
 *
 *   2. The `<Pie>` does NOT receive `top` / `left` props. They
 *      are silently ignored in the children form — passing them
 *      only misleads the next reader into thinking centring is
 *      handled. (If a future visx upgrade DOES honour them in
 *      the children path, the explicit `<g>` + the prop would
 *      double-translate — so the prop must stay absent.)
 *
 *   3. The `<Pie>` is invoked with the children render-prop
 *      form (`<Pie ...>{(pie) => ...}</Pie>`). This is the whole
 *      reason the trap applies — the ratchet documents WHY the
 *      manual `<g>` is load-bearing rather than dead wrapping.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const SRC = blankNonCode(fs.readFileSync(
    path.join(ROOT, 'src/components/ui/DonutChart.tsx'),
    'utf8',
));

describe('DonutChart centering — visx Pie children render-prop trap', () => {
    it('wraps <Pie> in a translate(center,center) <g>', () => {
        // The centring transform. Without it, every arc renders
        // around SVG (0,0) and only a corner sliver is visible.
        //
        // R18-PR5 composed `scale(${entranceProgress})` ONTO this
        // transform for the bubble-entrance. The assertion checks
        // the `translate(${center},${center})` half is still
        // present at the start of the `<g transform>` — that's
        // the load-bearing centring piece. The exact full string
        // (with or without the trailing scale) is locked by
        // `r18-donut-bubble-entrance.test.ts`.
        expect(SRC).toMatch(
            /<g\s*\n?\s*transform=\{`translate\(\$\{center\},\$\{center\}\)/,
        );
    });

    it('does NOT pass top / left props to <Pie> (silently ignored in children form)', () => {
        // visx drops top/left when `children` is supplied. Keeping
        // them would mislead — and would double-translate if a
        // future visx upgrade honoured them. The centring lives
        // in the explicit wrapper <g>, nowhere else.
        const pieBlock = SRC.slice(
            SRC.indexOf('<Pie'),
            SRC.indexOf('</Pie>'),
        );
        expect(pieBlock).not.toMatch(/\btop=\{/);
        expect(pieBlock).not.toMatch(/\bleft=\{/);
    });

    it('uses the children render-prop form (the reason the trap applies)', () => {
        // `<Pie ...>{(pie) => pie.arcs.map(...)}</Pie>` — the
        // children form is what makes visx drop top/left. If a
        // future refactor drops back to the default render path,
        // this assertion failing is the signal to also remove
        // the manual centring <g> (visx would handle it again).
        expect(SRC).toMatch(/<Pie[\s\S]*?>\s*\{\s*\(pie\)\s*=>/);
    });
});

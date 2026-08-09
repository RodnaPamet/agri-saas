/**
 * R17-PR12 — dashboard first-paint rise-in choreography.
 *
 * Before R17, DashboardLayout's outer wrapper carried a bare
 * 150ms `animate-fadeIn`. The eye barely registered it — felt
 * like "the page just appeared." PR-12 swaps it for a 600ms
 * ease-out animation that combines a 0→1 opacity ramp with an
 * 8px translateY-from-below. The dashboard now reads as
 * "composing itself" on first paint rather than "popping in."
 *
 * Three load-bearing invariants:
 *
 *   1. The `dashboard-rise-in` keyframe is registered with the
 *      exact opacity + translateY shape. 8px is the smallest
 *      distance the eye still registers as motion at 600ms;
 *      larger reads as jumpy on a content-heavy page.
 *
 *   2. The animation utility runs at 600ms ease-out (one-shot,
 *      no `infinite`). Slow enough for the eye to register;
 *      fast enough that an impatient user doesn't wait.
 *      ease-out makes the motion DECELERATE into its final
 *      position — feels like landing, not stopping.
 *
 *   3. `<DashboardLayout>` uses the new animation. The 7 pages
 *      that consume DashboardLayout (executive dashboard, tests
 *      / risks / practices / tasks / vendors / coverage dashboards)
 *      all get the polished first-paint feel for free.
 *
 * The global `prefers-reduced-motion: reduce` rule in
 * `tokens.css` flattens the duration to 1ms automatically — no
 * per-component opt-in.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const TW_CONFIG = fs.readFileSync(
    path.join(ROOT, 'tailwind.config.js'),
    'utf8',
);
const LAYOUT = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/DashboardLayout.tsx'),
    'utf8',
);

describe('R17-PR12 — dashboard first-paint rise-in', () => {
    it('keyframe combines 0→1 opacity with 8px translateY-from-below', () => {
        // The shape is load-bearing. Larger Y would feel jumpy;
        // bare opacity (no translateY) is the old `fade-in` we're
        // replacing.
        expect(TW_CONFIG).toMatch(
            /'dashboard-rise-in':\s*\{\s*['"]0%['"]:\s*\{\s*opacity:\s*'0',\s*transform:\s*'translateY\(8px\)'\s*\}\s*,\s*['"]100%['"]:\s*\{\s*opacity:\s*'1',\s*transform:\s*'translateY\(0\)'\s*\}/,
        );
    });

    it('animation utility runs the rise-in at 600ms ease-out (one-shot)', () => {
        // Tempo + curve are load-bearing. `infinite` would loop
        // the rise-in forever — would be hypnotic. ease-out makes
        // the motion land softly.
        expect(TW_CONFIG).toMatch(
            /'dashboard-rise-in':\s*\n?\s*'dashboard-rise-in\s+600ms\s+ease-out'/,
        );
        // NOT infinite.
        expect(TW_CONFIG).not.toMatch(
            /'dashboard-rise-in':\s*\n?\s*'dashboard-rise-in[^']*infinite'/,
        );
    });

    it('DashboardLayout wrapper uses the new animation class', () => {
        // The class swap is what propagates the polish to every
        // DashboardLayout consumer. A regression here that flips
        // back to `animate-fadeIn` would silently revert the
        // first-paint feel — locked here.
        expect(LAYOUT).toMatch(/animate-dashboard-rise-in/);
        // And the old class is gone from the actual className
        // (the docstring may still mention it for historical
        // context — that's fine; locked here against a className
        // regression by scoping the regex to the className= site).
        expect(LAYOUT).not.toMatch(/className=\{cn\([^)]*animate-fadeIn/);
    });
});

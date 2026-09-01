/**
 * R20-PR-F — Density correction ratchet.
 *
 * R20-PR-C had pushed md/lg button padding UP for an "airy density"
 * feel (md px-3.5 → px-4; lg px-5 → px-6; lg gap-tight → gap-2.5).
 * In practice, on dense toolbars (gear-trigger + text buttons +
 * primary CTA) the air read as "idle space around the label" —
 * the text inside each button felt small relative to the chrome.
 *
 * PR-F tightened md/lg BELOW pre-PR-C levels (md px-4 → px-3, lg
 * px-6 → px-4, lg gap-2.5 → gap-tight), and a second pass
 * (button-density-tighter, 2026-05-15) took every rung one step
 * further again (xs px-2, sm/md px-2.5, lg px-3).
 *
 * ── #776: the graded ladder is GONE, the direction is not ────────
 *
 * The ladder those four passes tuned no longer exists. #776 adopted
 * the sibling compliance product's SINGLE-RUNG ladder: `xs`, `sm`,
 * `md` and `lg` all resolve to one identical class string
 *
 *     h-7 px-[0.7rem] text-[0.76rem] gap-tight
 *     tracking-[0.005em] font-[560] [&_svg]:size-[15px]
 *
 * so there is no per-size padding, gap, tracking or weight scale
 * left to assert. The `size` prop is deliberately KEPT — call sites
 * still record intent, and a reversal is a one-file edit — but it
 * no longer selects a rung.
 *
 * What survives of PR-F is its DIRECTION, and this file now guards
 * that instead of the scale:
 *
 *   • the rung declares exactly ONE horizontal padding, and it is
 *     11.2px — tighter than every value PR-C, PR-F or the
 *     button-density-tighter pass ever shipped;
 *   • the icon↔label gap is `gap-tight`, never PR-C's `gap-2.5`
 *     (that 10px gap was a compensation for airy padding, and the
 *     compensation outlived its cause once);
 *   • the two disabled-branch mirrors in `button.tsx` — which do
 *     NOT route through cva and therefore have to restate the rung
 *     by hand — still say the same thing the cva rung says.
 *
 * The superseded assertions are recorded in place below rather than
 * deleted silently: the graded ladder was a deliberate four-pass
 * design decision, and its reversal was deliberate too.
 *
 * Like every file under `tests/guards/`, this one matches source
 * TEXT. It proves the class strings say what they should; it runs
 * no component and contributes no runtime coverage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const VARIANTS = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/button-variants.ts'),
    'utf8',
);
const BUTTON_TSX = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/button.tsx'),
    'utf8',
);

type TextSize = 'xs' | 'sm' | 'md' | 'lg';
const TEXT_SIZES: readonly TextSize[] = ['xs', 'sm', 'md', 'lg'];

function sizeBlock(): string {
    return VARIANTS.match(/size:\s*\{([\s\S]*?)\},?\s*\}/)?.[1] ?? '';
}
function sizeClasses(size: TextSize): string {
    const re = new RegExp(`${size}:\\s*["']([^"']+)["']`);
    return sizeBlock().match(re)?.[1] ?? '';
}

/** The one rung every text size resolves to. */
const RUNG = sizeClasses('md');

/**
 * The geometry a class string has to restate when it bypasses the
 * cva size variant: height, horizontal padding, type size, weight.
 * Tracking is deliberately NOT in this set — the disabled mirrors
 * have never carried a `tracking-*` class (it lives only on the cva
 * size variant), a divergence that predates #776 and is unchanged
 * by it.
 */
const GEOMETRY = /(?:h-\S+|px-\S+|text-\[[^\]\s]+\]|font-\[[^\]\s]+\])/g;
const geometryOf = (classes: string): string[] =>
    (classes.match(GEOMETRY) ?? []).sort();

/**
 * The class strings in `button.tsx` that paint a button WITHOUT
 * going through `buttonVariants(...)` — the `disabledTooltip` shell
 * and the `disabled || loading` fallback. Matched on "starts with a
 * height AND carries a bracketed horizontal padding" so the
 * unrelated `h-4 w-4` spinner literal is not swept in.
 */
const MIRRORS = BUTTON_TSX.match(/"h-\d[^"]*px-\[[^"]*"/g) ?? [];

describe('R20-PR-F — button density correction', () => {
    describe('the size scale is one rung (#776)', () => {
        it('xs / sm / md / lg are byte-identical', () => {
            const rungs = TEXT_SIZES.map(sizeClasses);
            // Extraction sanity, not a design claim: a broken parser
            // returns '' for every size, which would satisfy the
            // identity check below for the wrong reason.
            expect(RUNG).toMatch(/\S/);
            expect(new Set(rungs).size).toBe(1);
        });

        it('the rung declares exactly one horizontal padding, `px-[0.7rem]`', () => {
            // An exact list, not a presence check: it fails on a
            // re-widening (`px-4` back), on a re-grading (a second
            // padding appearing at one size, which the identity test
            // above would then also catch), and on a silent drop.
            expect(RUNG.match(/\bpx-\S+/g)).toEqual(['px-[0.7rem]']);
        });

        it('the rung declares exactly one gap, `gap-tight`', () => {
            // PR-F's own decision, and the one that outlived the
            // ladder: PR-C's `gap-2.5` existed only to compensate for
            // lg's airy padding. Tighter padding wants the tighter
            // icon↔label rhythm back, at every size.
            expect(RUNG.match(/\bgap-\S+/g)).toEqual(['gap-tight']);
        });
    });

    /**
     * ── SUPERSEDED by #776 ───────────────────────────────────────
     *
     * Three describe blocks stood here and are gone. What they said,
     * so a future reader can tell the ladder was real and its removal
     * was chosen:
     *
     *   1. "the corrected md/lg padding scale" — asserted md `px-2.5`
     *      and lg `px-3` as distinct values, plus the absence of
     *      `px-4` / `px-6` / `gap-2.5` at the sizes that had carried
     *      them. Superseded: md and lg are the same string as xs and
     *      sm now, so "md differs from lg" is unstatable, and the
     *      absence half is strictly weaker than the exact-list
     *      padding assertion above, which bans every other value
     *      rather than four enumerated ones.
     *
     *   2. "xs/sm tightened too in button-density-tighter pass" —
     *      asserted xs at `h-7 px-2 gap-1` and sm at `h-8 px-2.5
     *      gap-1.5`. Superseded: sm's `h-8` was the last surviving
     *      height difference in the ladder and #776 flattened it to
     *      `h-7`; restating the four rungs one by one would be four
     *      copies of one fact.
     *
     *   3. "PR-C / PR-E refinements survive the correction" —
     *      asserted the per-size tracking ladder (xs +0.005em, sm
     *      +0.01em, md -0.005em, lg -0.01em) and the per-size weight
     *      ladder (xs/sm `font-medium`, md `font-semibold`, lg
     *      `font-bold`). Its point was that PR-F was scoped to
     *      spatial chrome and left the typographic axis alone.
     *      Superseded: #776 flattened that axis too — the rung sits
     *      at `tracking-[0.005em]` (the old xs value) and `font-[560]`
     *      (between medium and semibold) at every size — so "PR-F did
     *      not disturb the ladder" no longer describes anything. The
     *      rung's tracking and weight are the R20-PR-C / R20-PR-E
     *      suites' subject, not this file's.
     */

    describe('the cva-bypassing mirrors in button.tsx track the rung', () => {
        // The `disabledTooltip` shell and the `disabled || loading`
        // fallback render a non-interactive shape with `cn(...)` only
        // — they never call `buttonVariants(...)`, so nothing but this
        // ratchet keeps them on the same geometry as the rung. That
        // was true of the graded ladder and is true of the single one.
        it('there are exactly two of them', () => {
            // A third hand-rolled shape has to be registered here, not
            // discovered later as a button that is a different size
            // once it is disabled.
            expect(MIRRORS).toHaveLength(2);
        });

        it('each repeats the rung geometry', () => {
            const expected = geometryOf(RUNG);
            // Extraction sanity: an empty expectation would pass
            // against any mirror at all.
            expect(expected).toEqual([
                'font-[560]',
                'h-7',
                'px-[0.7rem]',
                'text-[0.76rem]',
            ]);
            for (const mirror of MIRRORS) {
                expect(geometryOf(mirror)).toEqual(expected);
            }
        });
    });
});

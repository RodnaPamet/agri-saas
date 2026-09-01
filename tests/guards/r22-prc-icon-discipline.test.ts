/**
 * R22-PR-C — Icon discipline ratchet.
 *
 * PR-C shipped two small moves. One survived the #776 single-rung
 * collapse intact; the other was reversed by it. Both are recorded
 * here, because the second was a deliberate design decision across
 * four roadmap passes and a future reader has to be able to tell
 * that it existed.
 *
 *   1. The BUTTON sizes its icons, not the caller. Icons used to be
 *      caller-sized (typically `h-4 w-4` regardless of button size).
 *      `[&_svg]:size-N` on the size variant OVERRIDES any svg
 *      child's own h-N/w-N — the descendant selector wins on
 *      specificity — so the default glyph is a property of the
 *      button rather than of whoever passed the icon. A caller that
 *      genuinely wants a smaller glyph can still say so explicitly.
 *      STILL TRUE: the size variant is the sole owner of the default
 *      icon size, and the cva base declares none.
 *
 *   2. `[&_svg]:shrink-0` on the cva base. Defensive Tailwind
 *      pattern that keeps icons from being squished in dense flex
 *      contexts (e.g. a filter-toolbar row tight on horizontal
 *      space). STILL TRUE — orthogonal to the ladder.
 *
 * SUPERSEDED BY #776 — the per-size icon SCALE. PR-C graded the
 * glyph against the (then graded) height ladder, on the reasoning
 * that at xs (h-7 = 28px) a 16px icon dominates the row while at lg
 * (h-10 = 40px) it disappears against headline-weight text:
 *
 *      xs/sm  size-3.5  (14px) — quiet in dense rows
 *      md     size-4    (16px) — confident default
 *      lg     size-[18px]      — featured CTA, headline weight
 *
 * #776 adopted the sibling compliance product's SINGLE-RUNG ladder:
 * every `size` now resolves to the same 28px rung, so there is no
 * height ladder left for a glyph scale to track, and all four sizes
 * carry `[&_svg]:size-[15px]`. The `size` prop is deliberately kept
 * (call sites still record intent; reversal stays a one-file edit),
 * which is exactly why this file still has work to do: the prop
 * still ACCEPTS four values, so "all four resolve to one rung" is a
 * live claim that a well-meaning re-grade would break.
 *
 * Not in scope, then or now: gap progression refinement (PR-D /
 * iteration material) and right-icon micro-shift on hover
 * (motion-language banned `group-hover:translate-*`).
 *
 * This is a GUARD: it reads the source TEXT of `button-variants.ts`
 * and contributes no runtime coverage. It proves the classes are
 * written; it never renders a button.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const VARIANTS = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/button-variants.ts'),
    'utf8',
);

/**
 * The one glyph size every button rung resolves to post-#776.
 * 15px in a 28px rung — the sibling product's value, adopted whole
 * rather than re-derived, so the two products stay comparable.
 */
const RUNG_ICON_SIZE = '[15px]';

const TEXT_SIZES = ['xs', 'sm', 'md', 'lg'] as const;
type SizeName = (typeof TEXT_SIZES)[number] | 'icon';

function cvaBase(): string {
    return VARIANTS.match(/cva\(\s*\[([\s\S]*?)\]\s*,/)?.[1] ?? '';
}
function sizeBlock(): string {
    return VARIANTS.match(/size:\s*\{([\s\S]*?)\},?\s*\}/)?.[1] ?? '';
}
function sizeClasses(size: SizeName): string {
    const re = new RegExp(`${size}:\\s*["']([^"']+)["']`);
    return sizeBlock().match(re)?.[1] ?? '';
}
/** Every `[&_svg]:size-…` value declared in a class string, in order. */
function iconSizes(classes: string): string[] {
    return (classes.match(/\[&_svg\]:size-\S+/g) ?? []).map((c) =>
        c.replace('[&_svg]:size-', ''),
    );
}

describe('R22-PR-C — Icon discipline', () => {
    describe('cva base — defensive shrink-0 on svg children', () => {
        it('the cva base carries `[&_svg]:shrink-0`', () => {
            expect(cvaBase()).toMatch(/\[&_svg\]:shrink-0/);
        });
    });

    describe('the size variant owns the default glyph size', () => {
        it('the cva base declares no `[&_svg]:size-*`', () => {
            // Move 1's mechanism, and the reason every assertion below
            // is read off the size block. A base-level glyph size would
            // compete with the per-size one through tailwind-merge, and
            // "the button sizes its icons" would quietly become
            // "whichever class won this time".
            expect(iconSizes(cvaBase())).toEqual([]);
        });

        it('the four text sizes resolve to ONE identical rung', () => {
            // #776 — this replaces four per-size assertions (xs/sm →
            // size-3.5, md → size-4, lg → size-[18px]) which, over four
            // now-identical strings, could no longer fail independently.
            // IDENTITY is the stronger claim: it breaks the moment
            // anyone re-grades a single size, which is the regression
            // this file now exists to catch.
            const rungs = TEXT_SIZES.map((s) => sizeClasses(s));
            TEXT_SIZES.forEach((name, i) => {
                // Named so a parse miss reports WHICH size vanished
                // rather than an empty-string mismatch.
                expect(`${name}=${rungs[i]}`).not.toBe(`${name}=`);
            });
            expect(new Set(rungs).size).toBe(1);
        });

        it('the rung declares exactly one glyph size, and it is `size-[15px]`', () => {
            // Read off `md` (the defaultVariant); the identity assertion
            // above is what extends this to the other three. "Exactly
            // one" matters because tailwind-merge would silently pick a
            // winner from two competing `[&_svg]:size-*` classes.
            expect(iconSizes(sizeClasses('md'))).toEqual([RUNG_ICON_SIZE]);
        });

        it('the icon-only variant sizes its glyph like the text rung', () => {
            // `icon` is square chrome around a bare glyph, so drift here
            // is the drift that shows: an icon-only button beside a text
            // button in the same header row would carry a visibly
            // different glyph. Compared against `md` rather than against
            // the constant so the two can only ever move together.
            expect(iconSizes(sizeClasses('icon'))).toEqual(
                iconSizes(sizeClasses('md')),
            );
        });

        /**
         * REMOVED by #776 — "the four sizes form a monotonically-
         * increasing icon scale".
         *
         * It asserted `xs === sm === '3.5'`, `md === '4'`,
         * `lg === '[18px]'` — that the glyph scale rose with the height
         * ladder and never went down. The single-rung collapse removed
         * the height ladder, so there is no scale left for a glyph to
         * track: under #776 the assertion's only surviving content is
         * "the four values are equal", which the identity assertion
         * above states directly and more honestly. Retargeting it would
         * have left a second, weaker copy of that same check.
         *
         * If the graded ladder is ever restored, restore this too — the
         * values above are the ones it asserted.
         */
    });
});

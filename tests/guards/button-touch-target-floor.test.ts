/**
 * Every button clears 44px for a finger, whatever the density ladder says.
 *
 * ## The gap this closes
 *
 * The size ladder is tuned for a mouse — 28 / 32 / 36 / 40px across
 * xs / sm / md / lg, refined across R20-PR-C, R20-PR-E, R20-PR-F and
 * R24-PR-C. Every rung of it is UNDER the 44px minimum that WCAG 2.5.5 and
 * the Apple HIG set for a touch target, and `sm` alone is ~361 call sites at
 * 32px.
 *
 * This is a mobile-first product. The operator is in a field, on a phone,
 * frequently wearing gloves — `tests/rendered/setup.ts` stubs `matchMedia` to
 * answer `matches: false` to every query precisely because a phone is the
 * real device here. A ladder that never reaches 44px is the wrong default for
 * that user, and there was no coarse-pointer accommodation at all.
 *
 * `min-h` only RAISES, so this does not disturb the desktop ladder: fine
 * pointers keep the graded density those roadmap passes tuned, coarse
 * pointers get a thumb-sized target. The idiom is borrowed from the sibling
 * compliance product, where it is what makes a flat 28px ladder safe on
 * touch.
 *
 * ## Why a guard and not a rendered test
 *
 * `pointer: coarse` is a media query, and the jsdom stub answers `false` to
 * every query — the branch is unreachable in a rendered test, which is the
 * documented hazard in CLAUDE.md ("any component branching on a coarse-pointer
 * or hover media query has that branch dead under jsdom"). Tailwind resolves
 * the variant at build time, so the honest check is that the class is present
 * on the primitive every button routes through.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const VARIANTS = fs.readFileSync(path.join(ROOT, 'src/components/ui/button-variants.ts'), 'utf8');
const TOGGLE_GROUP = fs.readFileSync(path.join(ROOT, 'src/components/ui/toggle-group.tsx'), 'utf8');

/**
 * Strip comments before asserting on source text.
 *
 * Learned the hard way while writing the ToggleGroup block below: the comment
 * EXPLAINING the floor also contains `pointer-coarse:min-h-11`, so deleting the
 * real class left the guard green — satisfied by the prose describing the thing
 * it was meant to protect. Masking at the read seam is the fix; asserting on a
 * longer anchor only moves the problem.
 */
function codeOf(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The base class list — everything before the `variants:` block. */
const BASE = VARIANTS.slice(0, VARIANTS.indexOf('variants:'));

describe('the OTHER primitive a finger presses — ToggleGroup', () => {
    /**
     * `Button` is not the only tappable control. `ToggleGroup` renders its own
     * `<button>` per option and so never inherited the #765 floor: its ladder is
     * `px-3 py-1 text-sm`, about 30px tall against the 44px minimum. The
     * insurance calculator (#1122) put three of them on a phone screen — cover
     * type, total vs per-dca, and the instalment count — which is what surfaced
     * it.
     *
     * Checked as source text for the same reason as the buttons above: Tailwind
     * resolves `pointer-coarse:` at build time and jsdom answers `false` to
     * every media query, so a rendered test cannot reach the branch.
     */
    const OPTION_BASE = (() => {
        const code = codeOf(TOGGLE_GROUP);
        const i = code.indexOf('toggleOptionVariants');
        expect(i).toBeGreaterThan(-1);
        const rest = code.slice(i);
        return rest.slice(0, rest.indexOf('variants:'));
    })();

    it('applies the 44px floor on the option BASE, so both sizes inherit it', () => {
        expect(OPTION_BASE).toContain('pointer-coarse:min-h-11');
    });

    it('is not vacuous — the slice really is the option base', () => {
        // If the extraction silently returned '' the assertion above would fail
        // rather than pass, but pin the shape anyway so a rename is loud.
        expect(OPTION_BASE).toContain('text-content-emphasis');
        expect(OPTION_BASE.length).toBeGreaterThan(80);
    });

    it('reads CODE, not comments — a comment naming the class cannot satisfy it', () => {
        // The positive control for `codeOf`. Without it this whole block is
        // satisfied by its own explanatory comment.
        expect(codeOf('// pointer-coarse:min-h-11\nconst x = 1;')).not.toContain('min-h-11');
        expect(codeOf('/* pointer-coarse:min-h-11 */ const x = 1;')).not.toContain('min-h-11');
        expect(codeOf('const c = "pointer-coarse:min-h-11";')).toContain('min-h-11');
    });
});

describe('buttons meet the touch-target minimum on coarse pointers', () => {
    it('the BASE applies a 44px floor, so every variant inherits it', () => {
        // On the base, not per-size: a floor that has to be repeated on each
        // rung is one a future rung will be added without. Comments masked, so
        // prose about the floor can never stand in for the floor.
        expect(codeOf(BASE)).toContain('pointer-coarse:min-h-11');
    });

    it('icon-only buttons raise WIDTH too — square targets need both', () => {
        // `min-h` alone leaves a 44x28 target, which is still a miss for a
        // thumb and looks compliant in a diff.
        const icon = /icon:\s*"([^"]*)"/.exec(VARIANTS)?.[1] ?? '';
        expect(icon).not.toBe('');
        expect(icon).toContain('pointer-coarse:min-w-11');
    });

    it('the desktop ladder is UNCHANGED — this raises, it does not flatten', () => {
        // The point of `min-h` over `h`. If a future edit swapped these for
        // fixed heights, fine-pointer density would collapse silently and the
        // roadmap passes that tuned it would be undone without a decision.
        const sizes = /size:\s*\{([\s\S]*?)\n\s{6}\}/.exec(VARIANTS)?.[1] ?? '';
        expect(sizes).toContain('h-7');
        expect(sizes).toContain('h-8');
        expect(sizes).toContain('h-9');
        expect(sizes).toContain('h-10');
    });

    it('uses min-h, never a fixed height, for the floor', () => {
        // `h-11` would force 44px on the DESKTOP too — the failure mode that
        // looks identical in a grep for "11".
        expect(BASE).not.toMatch(/pointer-coarse:h-11\b/);
    });
});

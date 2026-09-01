/**
 * R20-PR-E — button font-weight ratchet.
 *
 * ── What R20-PR-E built, and why it was deliberate ──────────────────
 *
 * R20-PR-C landed per-size tracking. R20-PR-E added per-size
 * font-WEIGHT — the "section header" weight (`font-semibold`) was the
 * typographic confidence the button family was missing. The graded
 * ladder mirrored the tracking ladder:
 *
 *   xs  font-medium    (500)  ← dense UI, quiet
 *   sm  font-medium    (500)  ← dense UI, quiet
 *   md  font-semibold  (600)  ← confident default
 *   lg  font-bold      (700)  ← magazine-bold CTA
 *
 * The GRADE was the point, not the weights: xs/sm live in filter
 * toolbars and dense action menus, where a bold xs button shouts; md is
 * the default, where the section-header weight reads as editorial
 * confidence; lg is the featured CTA, where bold is the headline weight.
 *
 * ── What #776 reversed, and why this file still exists ──────────────
 *
 * #776 adopted the sibling product's SINGLE-RUNG ladder: every `size`
 * resolves to the same 28px rung, weight included — one `font-[560]`
 * across xs / sm / md / lg AND `icon`. 560 is not a Tailwind step; it
 * sits between medium (500) and semibold (600), so the rung is a chosen
 * weight, not a fall-back to the browser default. The `size` prop is
 * kept so call sites still record intent and a re-grade stays a
 * one-file edit.
 *
 * There is therefore no grade left to ratchet. What survives is the
 * pair of invariants the grade was riding on, and both matter MORE
 * under one rung, not less:
 *
 *   1. weight is owned by the SIZE VARIANT and never pinned in the cva
 *      base — which is what keeps the re-grade a one-file edit;
 *   2. the two hand-rolled fallback mirrors in `button.tsx` (the
 *      `disabledTooltip` shell and the disabled/loading branch, neither
 *      of which routes through the cva variant) carry the SAME weight
 *      as the rung, so a button does not change weight when disabled.
 *
 * The assertions #776 made false are recorded in place below rather
 * than dropped silently — the graded ladder happened, and it was
 * reversed on purpose.
 *
 * Like everything under `tests/guards/`, this file matches source TEXT.
 * It proves the classes are written where they are claimed to be; it
 * renders no button and contributes no runtime coverage.
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

/**
 * Any Tailwind font-WEIGHT utility — a named step OR an arbitrary
 * value. The arbitrary branch is load-bearing since #776: the rung's
 * weight is `font-[560]`, which a named-token-only pattern (the
 * pre-#776 shape of this file) would not see at all, so a weight
 * hoisted into the base would have slipped past the base check.
 * No trailing `\b` on the arbitrary branch — `]` and the following
 * space are both non-word characters, so there is no boundary there.
 */
const WEIGHT_SOURCE =
    'font-(?:\\[[^\\]]+\\]|(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\\b)';
const WEIGHT_RE = new RegExp(`\\b${WEIGHT_SOURCE}`);
const weightsIn = (s: string): string[] | null =>
    s.match(new RegExp(`\\b${WEIGHT_SOURCE}`, 'g'));

function sizeBlock(): string {
    return VARIANTS.match(/size:\s*\{([\s\S]*?)\},?\s*\}/)?.[1] ?? '';
}
function sizeClasses(size: 'xs' | 'sm' | 'md' | 'lg' | 'icon'): string {
    const re = new RegExp(`${size}:\\s*["']([^"']+)["']`);
    return sizeBlock().match(re)?.[1] ?? '';
}

const TEXT_SIZES = ['xs', 'sm', 'md', 'lg'] as const;

/**
 * The two hand-rolled fallback class strings in `button.tsx`: the
 * `disabledTooltip` <div> shell and the disabled/loading <button>
 * branch. Both are `cn`-only — they never reach `buttonVariants` — so
 * they are the drift surface this file has always watched. Matched by
 * SHAPE (a height class plus a `font-` utility in one literal) rather
 * than by their exact text, so the extractor survives a padding or
 * radius edit and only breaks when the mirrors genuinely move.
 */
const MIRRORS = BUTTON_TSX.match(/"[^"]*\bh-\d[^"]*\bfont-[^"]*"/g) ?? [];

describe('R20-PR-E — button font-weight (single rung since #776)', () => {
    describe('the cva BASE does not pin a font-weight — the size variant owns it', () => {
        it('the base declares no font-weight utility, named or arbitrary', () => {
            const base =
                VARIANTS.match(/cva\(\s*\[([\s\S]*?)\]\s*,/)?.[1] ?? '';
            // Strip comments so the prose about the weight ladder
            // doesn't count as a violation.
            const stripped = base
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(stripped.length).toBeGreaterThan(0);
            expect(stripped).not.toMatch(WEIGHT_RE);
        });
    });

    describe('the single rung', () => {
        // Collapsed from the four per-size assertions this block used
        // to carry (xs/sm `font-medium`, md `font-semibold`, lg
        // `font-bold`). Against four byte-identical strings those four
        // could not fail independently; the identity check below is
        // the honest form of the same question.
        it('all four text sizes resolve to ONE identical class string', () => {
            const rungs = TEXT_SIZES.map(sizeClasses);
            // Four empty strings are also "identical" — so fail loudly
            // if the size-block parser stops resolving.
            expect(rungs.every((r) => r.length > 0)).toBe(true);
            expect(new Set(rungs).size).toBe(1);
        });

        it('the rung declares exactly one weight, and it is font-[560]', () => {
            expect(weightsIn(sizeClasses('md'))).toEqual(['font-[560]']);
        });

        it('the icon size carries the same weight as the text rung', () => {
            const icon = weightsIn(sizeClasses('icon'));
            expect(icon).not.toBeNull();
            expect(icon).toEqual(weightsIn(sizeClasses('md')));
        });
    });

    /*
     * ── SUPERSEDED by #776 ─────────────────────────────────────────
     *
     * `it('the ladder is graded (different weights at different
     * sizes)')` asserted that xs/sm/md/lg carried at least THREE
     * distinct `font-*` weights, and its comment named its purpose:
     * "a future PR that 'simplifies' to uniform weight would strip the
     * grade. This assertion fires first."
     *
     * It fired. #776 is that PR, and the uniformity is now the chosen
     * design — the collapse was adopted from the sibling product, not
     * slipped in. Retargeting the assertion to `weights.size === 1`
     * would restate "all four sizes are identical", which the identity
     * check above already makes at full strength, so it is removed
     * rather than inverted.
     *
     * Reinstating a graded ladder means reinstating this assertion in
     * the same diff — the identity check above is what will stop a
     * half-done re-grade in the meantime.
     */

    describe('disabled-state fallback mirrors in button.tsx', () => {
        // The `disabledTooltip` shell and the disabled/loading branch
        // render a hand-rolled shape that does NOT route through the
        // cva variant, so the weight has to be repeated by hand there.
        // The lockstep rule is unchanged by #776 — only its shape is:
        // the three per-size mirror assertions (xs/sm `font-medium`,
        // `!size` `font-semibold`, lg `font-bold`) described a
        // size-conditional cascade that no longer exists, and are
        // replaced by deriving the expected weight FROM the rung so
        // the two can never be pinned apart.
        it('both fallback mirrors are still located', () => {
            expect(MIRRORS).toHaveLength(2);
        });

        it('each mirror carries exactly the weight the cva rung carries', () => {
            const rungWeight = sizeClasses('md').match(WEIGHT_RE)?.[0];
            for (const mirror of MIRRORS) {
                expect(weightsIn(mirror)).toEqual([rungWeight]);
            }
        });

        it('the mirrors are size-agnostic — no per-size weight cascade survives', () => {
            // The superseded shape, banned so it cannot return on one
            // side of the lockstep only: a `size === "…" && "…font-…"`
            // arm in the fallback with a flat rung in the cva variant
            // is exactly the drift that makes a button change weight
            // when it is disabled.
            expect(BUTTON_TSX).not.toMatch(
                /size === "(?:xs|sm|md|lg)" && "[^"]*\bfont-/,
            );
            expect(BUTTON_TSX).not.toMatch(/!size && "[^"]*\bfont-/);
        });
    });
});

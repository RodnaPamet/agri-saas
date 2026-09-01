/**
 * R20-PR-C — density + typography ratchet.
 *
 * ── WHAT THIS FILE USED TO LOCK (2026-05) ───────────────────────
 * PR-A laid the language; PR-B applied liquid edges. PR-C was the
 * typographic-rhythm round, and this ratchet held a GRADED ladder
 * across four axes at once, each axis a separate product decision:
 *
 *   1. Padding — md/lg gained horizontal breathing room; xs/sm
 *      stayed compact by intent (small buttons want density, large
 *      buttons want air). R20-PR-F then REVERSED that half of it
 *      (md px-4→px-3, lg px-6→px-4) because on dense toolbars the
 *      air read as idle space around the label, and
 *      button-density-tighter took a second pass on top
 *      (xs px-2 / sm px-2.5 / md px-2.5 / lg px-3).
 *   2. Heights — xs/sm/md/lg = h-7/h-8/h-9/h-10, deliberately
 *      LOCKED out of the padding work so a density tweak could
 *      never silently break filter-toolbar alignment with <Input>.
 *   3. Per-size tracking — the R19 flat `tracking-[-0.01em]`
 *      baseline replaced by a size-conditional scale (xs +0.005em,
 *      sm +0.01em, md -0.005em, lg -0.01em): small text opens up to
 *      stay legible, large text tightens to feel deliberate.
 *   4. Gap rhythm — xs gap-1, sm gap-1.5, md/lg gap-tight.
 *
 * Plus R20-PR-E's graded weight ladder (medium → semibold → bold)
 * riding the same size variant, and form-control parity: <Label>
 * carried button-md's tracking so a focused input and its label
 * shared one typographic rhythm.
 *
 * ── WHAT #776 DID (2026-09-01) ──────────────────────────────────
 * The graded ladder was ADOPTED AWAY. Every button size now
 * resolves to ONE 28px rung — identical padding, type size,
 * tracking, weight, gap and icon size at xs/sm/md/lg — matching the
 * sibling compliance product's flat scale. `controlSize` in
 * `control-variants.ts` collapsed with it. The `size` prop is kept
 * on purpose so call sites still record INTENT and a reversal stays
 * a one-file edit.
 *
 * So axes 1-4 no longer describe the code: there is no scale left
 * to be monotonic about, and an assertion per size over four
 * byte-identical strings is four checks that cannot fail
 * independently. Each of those describe blocks is replaced below by
 * a note recording what it asserted and why it went, and the whole
 * of it collapses into two relational assertions: the four sizes
 * are IDENTICAL, and the rung they share is the expected shape.
 *
 * What survives unchanged is the LOCKSTEP claim, which is the half
 * that was never about grading: the loading + disabled fallback
 * paths in `button.tsx` render a hand-rolled <button>/<div> that
 * does NOT route through the cva variant, so their geometry has to
 * track the rung by hand. Drift there manifests as a button that
 * changes dimensions on disable. Those assertions are now DERIVED
 * from the live cva rung rather than pinned to literals, so editing
 * `button-variants.ts` alone fails them.
 *
 * This is a guard: it reads source TEXT and executes none of the
 * button code, so it contributes zero runtime coverage. It proves
 * the classes are written, never that a button renders at 28px.
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
const LABEL_TSX = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/label.tsx'),
    'utf8',
);

const SIZES = ['xs', 'sm', 'md', 'lg'] as const;
type Size = (typeof SIZES)[number];

/**
 * The single rung every text size resolves to after #776. Pinned as
 * a literal so a change to any one axis — padding, type size,
 * tracking, weight, icon size — has to be written down here too.
 */
const EXPECTED_RUNG =
    'h-7 px-[0.7rem] text-[0.76rem] gap-tight tracking-[0.005em] font-[560] [&_svg]:size-[15px]';

/** Slice the size: { ... } object from the cva config. */
function sizeBlock(): string {
    return VARIANTS.match(/size:\s*\{([\s\S]*?)\},?\s*\}/)?.[1] ?? '';
}

/**
 * Pull the class string assigned to one size key. Tolerates either
 * `xs: "..."` or `xs: ["...", "..."]` shape, though today the
 * sizes are plain strings.
 */
function sizeClasses(size: Size): string {
    const re = new RegExp(`${size}:\\s*["']([^"']+)["']`);
    return sizeBlock().match(re)?.[1] ?? '';
}

/**
 * Split a class string (or a slice of JSX) into bare class tokens.
 * Quotes and commas are delimiters so `"h-7 px-[0.7rem]",` yields
 * `h-7` and `px-[0.7rem]` rather than quote-glued neighbours.
 */
function classTokens(source: string): Set<string> {
    return new Set(source.split(/[\s"'`,]+/).filter(Boolean));
}

/**
 * The rung's token for one axis, read from the LIVE cva source.
 * Deriving instead of hard-coding is what makes the `button.tsx`
 * mirror assertions relational: change the rung in
 * `button-variants.ts` and forget the mirrors, and they fail.
 */
function rungToken(prefix: string): string {
    const token = [...classTokens(sizeClasses('md'))].find((c) =>
        c.startsWith(prefix),
    );
    if (!token) {
        throw new Error(
            `no \`${prefix}…\` token in the button size rung — the rung shape moved`,
        );
    }
    return token;
}

/** The `if (disabledTooltip)` early-return branch of button.tsx. */
function disabledTooltipBranch(): string {
    const start = BUTTON_TSX.indexOf('if (disabledTooltip)');
    const end = BUTTON_TSX.indexOf('</Tooltip>', start);
    return start === -1 || end === -1 ? '' : BUTTON_TSX.slice(start, end);
}

/** The `props.disabled || loading ? cn(...)` fallback branch. */
function disabledFallbackBranch(): string {
    const start = BUTTON_TSX.indexOf('props.disabled || loading');
    const end = BUTTON_TSX.indexOf('buttonVariants({', start);
    return start === -1 || end === -1 ? '' : BUTTON_TSX.slice(start, end);
}

describe('R20-PR-C — density + typography (single-rung ladder, #776)', () => {
    describe('the four text sizes are ONE rung', () => {
        it('xs / sm / md / lg resolve to a byte-identical class string', () => {
            const [xs, ...rest] = SIZES.map(sizeClasses);
            // Fail-open guard: an empty parse would make every size
            // "equal" and turn the comparison below into a no-op.
            expect(xs).toMatch(/\S/);
            expect(rest).toEqual([xs, xs, xs]);
        });

        it('the shared rung carries the expected 28px density shape', () => {
            // Exact equality, not a bag of `toContain`s: every axis the
            // graded ladder used to grade (height, padding, type size,
            // gap, tracking, weight, icon size) is present here, and a
            // change to any one of them has to be written down.
            expect(sizeClasses('md')).toBe(EXPECTED_RUNG);
        });
    });

    // ── SUPERSEDED (#776) — `padding scale — tightened (PR-F +
    // button-density-tighter)`. Asserted a four-step horizontal scale
    // (xs px-2, sm px-2.5, md px-2.5, lg px-3), with md/lg carrying
    // inverted assertions (`not.toMatch(px-4)` / `not.toMatch(px-6)`)
    // so a revert to PR-C's airy padding would fire here first. There
    // is no scale to step through any more — all four sizes share
    // `px-[0.7rem]`, which the rung-shape assertion above pins
    // exactly. Retargeting it per size would have produced four
    // checks over one string that cannot fail independently.

    // ── SUPERSEDED (#776) — `heights stay — the input-parity lockstep
    // from PR-A holds`. Asserted xs/sm/md/lg = h-7/h-8/h-9/h-10, the
    // ladder R20-PR-A deliberately held still while PR-C/E/F moved
    // padding, tracking and weight around it. All four are h-7 now,
    // and `controlSize` collapsed in the same change, so the pairing
    // this block protected no longer has two sides. The height is
    // still pinned — as the `h-7` inside the rung-shape assertion.

    // ── SUPERSEDED (#776) — the per-size half of `per-size tracking`.
    // Asserted a monotonic tracking scale (xs +0.005em, sm +0.01em,
    // md -0.005em, lg -0.01em): small labels open up, large labels
    // tighten. The rung holds ONE value (+0.005em, the old xs
    // setting), so there is no direction left to assert. The base-level
    // assertion from that block survives immediately below — it was
    // never about grading.

    // ── SUPERSEDED (#776) — `gap rhythm — uniform gap-tight at md and
    // lg after PR-F`. Asserted xs gap-1 / sm gap-1.5 / md,lg gap-tight,
    // and that lg had NOT drifted back to PR-C's gap-2.5. Every size is
    // `gap-tight` now; the rung-shape assertion pins it once.

    describe('tracking stays off the cva base', () => {
        // Kept verbatim from PR-C, and it is not trivially true: the
        // base is a separate class array that could re-acquire a flat
        // letter-spacing at any time. It records that the R19 flat
        // `-0.01em` baseline was replaced by a value declared on the
        // size variant — which is still where the rung declares it,
        // even though there is now only one rung to declare it for.
        it('the cva base carries no flat `tracking-[-0.01em]`', () => {
            const base =
                VARIANTS.match(/cva\(\s*\[([\s\S]*?)\]\s*,/)?.[1] ?? '';
            expect(base).toMatch(/\S/);
            expect(base).not.toMatch(/tracking-\[-0\.01em\]/);
        });
    });

    describe('disabled-state mirrors in button.tsx move in lockstep', () => {
        // The loading + disabled fallback paths render hand-rolled
        // classes, NOT the cva variant, so they do not pick up a rung
        // change for free. Both assertions read the required tokens out
        // of the live cva rung, so editing `button-variants.ts` without
        // touching `button.tsx` fails here — which is the whole point
        // of the mirror. (Before #776 these pinned `h-9 px-2.5` and
        // `h-10 px-3` as literals, one `it` per size arm; the arms are
        // identical now, so the pinning moved to the relational form.)
        it('the disabledTooltip branch mirrors the rung geometry', () => {
            const branch = disabledTooltipBranch();
            expect(branch).toContain('cn(');
            const present = classTokens(branch);
            const required = ['h-', 'px-', 'text-[', 'font-'].map(rungToken);
            expect(required.filter((t) => !present.has(t))).toEqual([]);
        });

        it('the disabled/loading fallback branch mirrors the rung geometry', () => {
            const branch = disabledFallbackBranch();
            expect(branch).toContain('cn(');
            const present = classTokens(branch);
            // This branch renders a real <button> with icon + label, so
            // it mirrors the rung's gap as well as its box geometry.
            const required = ['h-', 'px-', 'text-[', 'font-', 'gap-'].map(
                rungToken,
            );
            expect(required.filter((t) => !present.has(t))).toEqual([]);
        });
    });

    describe('<Label> keeps its own tracking', () => {
        // RETARGETED (#776). This assertion used to mean "Label rhymes
        // with button-md" — both sat at `-0.005em`, so a focused input
        // and its label shared the button family's typographic rhythm.
        // That rhyme is GONE: the rung tracks +0.005em, the opposite
        // direction. The pin stays because the VALUE is still a
        // deliberate choice on a form-control surface that the button
        // collapse deliberately did not touch; what it no longer
        // claims is parity. If Label is ever re-aligned to the rung,
        // that is a decision to make on purpose, not a drift.
        it('<Label> declares `tracking-[-0.005em]`, independent of the button rung', () => {
            expect(LABEL_TSX).toMatch(/tracking-\[-0\.005em\]/);
            expect(sizeClasses('md')).not.toMatch(/tracking-\[-0\.005em\]/);
        });
    });
});

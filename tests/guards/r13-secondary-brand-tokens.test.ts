/**
 * Roadmap-13 PR-1 — Secondary brand-token foundation.
 *
 * Roadmap-12's `<NavItem>` recipe expresses HOVER and ACTIVE with the
 * SAME hue family — both states paint the band with the primary brand
 * gradient (`--brand-default` → `--brand-emphasis`). That single-tone
 * vocabulary served its purpose, but it caps the sidebar's expressive
 * range: the eye reads HOVER and ACTIVE as "more or less the same
 * yellow", just at different opacities.
 *
 * R13 introduces a SECONDARY brand colour so the state vocabulary can
 * be two-tone:
 *
 *   HOVER  → primary brand (warm — yellow / orange)
 *   ACTIVE → secondary brand (cool — blue / navy)
 *
 * The active row becomes visually distinct from every hovered-but-
 * not-current row at a glance. This ratchet locks the foundation
 * — the tokens MUST exist in both themes, MUST live next to the
 * primary brand tokens, MUST follow the same default/emphasis/subtle
 * tier vocabulary, and MUST carry inline doc-comments explaining the
 * hue choice (so a future "let's just use navy on both themes" PR
 * has to argue against the documented reason for the per-theme
 * adaptation).
 *
 * What this ratchet does NOT police:
 *
 *   - Where the tokens are consumed. Later R13 PRs wire them into
 *     `nav-item.tsx`; those have their own ratchets.
 *   - The exact hex values. Future palette tuning is allowed —
 *     the structure (three-tier, two-theme, complementary to primary)
 *     is what's locked here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const TOKENS = fs.readFileSync(
    path.join(ROOT, 'src/styles/tokens.css'),
    'utf8',
);

/**
 * Split the file into the two theme blocks. The METRO theme lives
 * under `:root { ... }`, the PwC theme under
 * `[data-theme="light"] { ... }`. We extract each block and assert
 * the tokens land inside the right one — a token declared at
 * file-top-level wouldn't be theme-scoped and the parity guarantee
 * collapses.
 */
function extractBlock(src: string, selector: RegExp): string {
    const m = src.match(selector);
    expect(m).not.toBeNull();
    return m![0];
}

const DARK_BLOCK = extractBlock(TOKENS, /:root\s*\{[\s\S]*?\n\}/);
const LIGHT_BLOCK = extractBlock(
    TOKENS,
    /\[data-theme="light"\]\s*\{[\s\S]*?\n\}/,
);

describe('Roadmap-13 PR-1 — secondary-brand token foundation', () => {
    describe('METRO (dark) theme — :root block', () => {
        // These three assertions used to pin the EXACT hexes (#3B82F6,
        // #2563EB, rgba(59,130,246,0.18)) — directly contradicting this
        // file's own docstring, which says the ratchet "does NOT police
        // the exact hex values. Future palette tuning is allowed — the
        // structure (three-tier, two-theme, complementary to primary) is
        // what's locked here."
        //
        // The contradiction became load-bearing on 2026-07-30, when the
        // dark ground moved from navy to green. The pinned blue-500
        // measures 3.70:1 on the new `--bg-default` and 4.40:1 on
        // `--bg-page` — both under WCAG AA — so honouring the pin meant
        // shipping an accessibility failure to satisfy a check that
        // claimed not to care. The tones were lifted a rung; the pin is
        // now the STRUCTURE the docstring describes.
        it('declares --brand-secondary-default as a hex', () => {
            // The DEFAULT tier is the canonical token — the one a band's
            // top gradient stop or a piece of active-state chrome reaches
            // for. Must be a cool counterpoint to the warm primary and
            // legible on the dark ground, whatever that ground currently is.
            expect(DARK_BLOCK).toMatch(
                /--brand-secondary-default:\s*#[0-9a-f]{6}\b/i,
            );
        });

        it('declares --brand-secondary-emphasis as a hex', () => {
            // The EMPHASIS tier is one rung deeper than default —
            // mirrors how `--brand-emphasis` deepens `--brand-default`.
            // Used as the bottom gradient stop on bands and as the
            // active surface tint on solid buttons.
            expect(DARK_BLOCK).toMatch(
                /--brand-secondary-emphasis:\s*#[0-9a-f]{6}\b/i,
            );
        });

        it('declares --brand-secondary-subtle as a translucent tint', () => {
            // The SUBTLE tier MUST be an rgba() with low alpha — the
            // tint vocabulary across the codebase is consistently
            // alpha-blended (see `--brand-subtle`, `--bg-success`).
            // A solid colour here would defeat the layering with the
            // surface beneath.
            // Alpha is the structural property here, not the channel
            // values — a solid colour is the regression this catches.
            expect(DARK_BLOCK).toMatch(
                /--brand-secondary-subtle:\s*rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0?\.\d+\s*\)/,
            );
        });
    });

    describe('PwC (light) theme — [data-theme="light"] block', () => {
        it('declares --brand-secondary-default', () => {
            // On PwC the cream surface lets navy land at its natural
            // depth. `#1E3A8A` is the cool counterpoint to the warm
            // orange `--brand-default`. WCAG 12+:1 on `--bg-default`.
            expect(LIGHT_BLOCK).toMatch(
                /--brand-secondary-default:\s*#1E3A8A\b/i,
            );
        });

        it('declares --brand-secondary-emphasis', () => {
            // Deeper navy — bottom band stop / active button surface.
            expect(LIGHT_BLOCK).toMatch(
                /--brand-secondary-emphasis:\s*#172554\b/i,
            );
        });

        it('declares --brand-secondary-subtle at 0.09 alpha', () => {
            // 0.09 matches `--brand-subtle` (orange @ 9%) — the light
            // theme uses a flatter tint than dark (which uses 0.18)
            // because the bg is cream rather than navy; less alpha
            // needed to read.
            expect(LIGHT_BLOCK).toMatch(
                /--brand-secondary-subtle:\s*rgba\(30,\s*58,\s*138,\s*0\.09\)/,
            );
        });
    });

    describe('structural — three-tier vocabulary', () => {
        it('METRO declares default + emphasis + subtle in order', () => {
            // The three tiers must appear in the same order as the
            // primary brand tokens, immediately after the
            // primary-brand block. This co-location is what tells
            // future readers "these are partner tokens". An out-of-
            // order or floating declaration breaks the visual parse.
            const idxDefault = DARK_BLOCK.search(
                /--brand-secondary-default:/,
            );
            const idxEmphasis = DARK_BLOCK.search(
                /--brand-secondary-emphasis:/,
            );
            const idxSubtle = DARK_BLOCK.search(
                /--brand-secondary-subtle:/,
            );
            expect(idxDefault).toBeGreaterThan(-1);
            expect(idxEmphasis).toBeGreaterThan(idxDefault);
            expect(idxSubtle).toBeGreaterThan(idxEmphasis);
        });

        it('PwC declares default + emphasis + subtle in order', () => {
            const idxDefault = LIGHT_BLOCK.search(
                /--brand-secondary-default:/,
            );
            const idxEmphasis = LIGHT_BLOCK.search(
                /--brand-secondary-emphasis:/,
            );
            const idxSubtle = LIGHT_BLOCK.search(
                /--brand-secondary-subtle:/,
            );
            expect(idxDefault).toBeGreaterThan(-1);
            expect(idxEmphasis).toBeGreaterThan(idxDefault);
            expect(idxSubtle).toBeGreaterThan(idxEmphasis);
        });

        it('METRO secondary tokens sit immediately after primary brand block', () => {
            // The secondary tokens MUST be co-located with the
            // primary brand block, not scattered in the file. A
            // future "let's move these to the bottom" PR breaks the
            // visual parse — both brand families should read as one
            // section.
            const primaryIdx = DARK_BLOCK.search(/--brand-default:/);
            const secondaryIdx = DARK_BLOCK.search(
                /--brand-secondary-default:/,
            );
            expect(primaryIdx).toBeGreaterThan(-1);
            expect(secondaryIdx).toBeGreaterThan(primaryIdx);
            // Distance check: no other brand block (no `Brand /` header)
            // should appear between them.
            const between = DARK_BLOCK.slice(primaryIdx, secondaryIdx);
            expect(between).not.toMatch(/\/\*\s*──\s*Status/);
            expect(between).not.toMatch(/\/\*\s*──\s*Content/);
        });

        it('PwC secondary tokens sit immediately after primary brand block', () => {
            const primaryIdx = LIGHT_BLOCK.search(/--brand-default:/);
            const secondaryIdx = LIGHT_BLOCK.search(
                /--brand-secondary-default:/,
            );
            expect(primaryIdx).toBeGreaterThan(-1);
            expect(secondaryIdx).toBeGreaterThan(primaryIdx);
            const between = LIGHT_BLOCK.slice(primaryIdx, secondaryIdx);
            expect(between).not.toMatch(/\/\*\s*──\s*Status/);
            expect(between).not.toMatch(/\/\*\s*──\s*Content/);
        });
    });

    describe('documentation — rationale lives next to the value', () => {
        it('METRO carries a "complementary" / "counterpoint" rationale comment', () => {
            // The "why electric blue, not navy?" reasoning lives in
            // an inline comment block above the tokens. A future PR
            // that drops the doc-comment also has to argue against
            // this assertion.
            const primaryIdx = DARK_BLOCK.search(/--brand-default:/);
            const secondaryIdx = DARK_BLOCK.search(
                /--brand-secondary-default:/,
            );
            const between = DARK_BLOCK.slice(primaryIdx, secondaryIdx);
            expect(between).toMatch(
                /complementary|counterpoint|cool/i,
            );
        });

        it('PwC carries a "complementary" / "counterpoint" rationale comment', () => {
            const primaryIdx = LIGHT_BLOCK.search(/--brand-default:/);
            const secondaryIdx = LIGHT_BLOCK.search(
                /--brand-secondary-default:/,
            );
            const between = LIGHT_BLOCK.slice(primaryIdx, secondaryIdx);
            expect(between).toMatch(
                /complementary|counterpoint|cool/i,
            );
        });
    });

    describe('hue independence — the two themes are NOT the same colour', () => {
        it('METRO and PwC pick different secondary hues', () => {
            // Both themes need a colour that pops against THEIR
            // surface. METRO (deep navy bg) gets bright electric blue;
            // PwC (cream bg) gets deep navy. If a future PR collapses
            // them to the same hex, the visual contrast on one theme
            // will quietly collapse.
            const metroDefault =
                DARK_BLOCK.match(
                    /--brand-secondary-default:\s*(#[0-9A-Fa-f]{6})/,
                )?.[1];
            const pwcDefault =
                LIGHT_BLOCK.match(
                    /--brand-secondary-default:\s*(#[0-9A-Fa-f]{6})/,
                )?.[1];
            expect(metroDefault).toBeDefined();
            expect(pwcDefault).toBeDefined();
            expect(metroDefault!.toLowerCase()).not.toBe(
                pwcDefault!.toLowerCase(),
            );
        });
    });
});

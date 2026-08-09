/**
 * R20-PR-D — Tactile press + the Roadmap-20 capstone.
 *
 * PR-A laid the language. PR-B applied liquid edges. PR-C tightened
 * typography and density. PR-D closes the round with the final
 * tactile-material work AND locks the four PRs together as a
 * unified system.
 *
 * Part 1 — PR-D invariants:
 *
 *   1. Sub-pixel press translate composes with the R11-PR4 scale.
 *      `active:translate-y-px motion-reduce:active:translate-y-0`
 *      lives in the cva BASE so every variant inherits the
 *      tactile direction (the press shrinks AND descends).
 *
 *   2. State-conditional ambient elevation in `glassSurface`:
 *      - REST stays bevel-only (R19 contract — locked by
 *        r19-pra-carbon-surface.test.ts).
 *      - press composes `bevel,ambient-press` so the surface
 *        depresses.
 *      - focus composes `bevel,ambient-focus` so the surface
 *        lifts with the brand-tinted ring.
 *      - hover stays unannotated (PR-B's aura wash on `::after`
 *        is the hover indicator).
 *
 *   3. Disabled iridescent dust-out — the `::after` iridescent
 *      meniscus drops to 30% opacity on disabled. NOT zero
 *      (would make disabled primary read structurally different);
 *      NOT a transition (the `::after` already carries the aura's
 *      `transition-shadow` and CSS allows only one
 *      `transition-property` per element-rule).
 *
 *   4. Enriched `--ctrl-edge-focus` carries a 3-stop shadow: the
 *      brand-tinted 3px ring PLUS a 2-stop ambient drop, so a
 *      focused practice reads "warm AND raised" the way a focused
 *      button does. Form-practice parity.
 *
 * Part 2 — the R20 capstone:
 *
 *   5. All R20 tokens still present, in both themes.
 *   6. All R20 recipes still present (`iridescentEdge`,
 *      `auraPrimary`, `auraNeutral`, `ghostGlass`).
 *   7. The R19 system is undisturbed (R19 ratchets stay the
 *      substantive lock; this is a structural co-presence check).
 *   8. Documentation: `docs/ui-buttons.md` carries the R20
 *      section so future contributors can find the system from
 *      the buttons guide.
 *   9. The four R20 ratchets exist as a contract surface.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const VARIANTS = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/button-variants.ts'),
    'utf8',
);
const TOKENS = fs.readFileSync(
    path.join(ROOT, 'src/styles/tokens.css'),
    'utf8',
);
const UI_BUTTONS_DOC = fs.readFileSync(
    path.join(ROOT, 'docs/ui-buttons.md'),
    'utf8',
);

/**
 * Strip block + line comments before matching so the assertions
 * fire only on REAL classnames, not on prose that quotes a banned
 * pattern (e.g. a comment that documents why we DON'T use a form
 * — the documentation referring to `hover:translate-` shouldn't
 * count as a violation).
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}
function recipeBlock(name: string): string {
    const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`);
    return stripComments(VARIANTS.match(re)?.[1] ?? '');
}
function cvaBase(): string {
    return stripComments(
        VARIANTS.match(/cva\(\s*\[([\s\S]*?)\]\s*,/)?.[1] ?? '',
    );
}

describe('R20-PR-D — Tactile press', () => {
    describe('sub-pixel press translate composes with R11-PR4 scale', () => {
        it('the cva base carries `active:translate-y-px`', () => {
            expect(cvaBase()).toMatch(/active:translate-y-px/);
        });

        it('reduced-motion drops the press translate', () => {
            expect(cvaBase()).toMatch(/motion-reduce:active:translate-y-0/);
        });

        it('the R11-PR4 press scale is preserved (composes, does not replace)', () => {
            expect(cvaBase()).toMatch(/active:scale-\[0\.97\]/);
            expect(cvaBase()).toMatch(/motion-reduce:active:scale-100/);
        });

        it('the translate is NEVER applied via the motion-language-banned hover form', () => {
            // The whole point of routing press through `active:` is
            // to leave the v2-PR-4 ratchet's hover-translate ban
            // alone. If a future PR moves this to hover, this fires.
            expect(cvaBase()).not.toMatch(/[^:]hover:translate-/);
        });
    });

    describe('state-conditional ambient elevation in `glassSurface`', () => {
        it('REST shadow is bevel-only — R19 contract preserved', () => {
            // The R19-PR-A ratchet asserts this directly; we
            // assert it again from R20's vantage so a future PR
            // that adds rest ambient breaks BOTH ratchets and the
            // intent of either is unmissable.
            expect(recipeBlock('glassSurface')).toMatch(
                /shadow-\[var\(--btn-glass-inner\),var\(--btn-glass-shadow\)\]/,
            );
        });

        it('press composes bevel,ambient-press — the surface depresses', () => {
            expect(recipeBlock('glassSurface')).toMatch(
                /active:shadow-\[var\(--btn-glass-inner\),var\(--btn-ambient-press\)\]/,
            );
        });

        it('focus composes bevel,ambient-focus — the surface lifts with the brand ring', () => {
            expect(recipeBlock('glassSurface')).toMatch(
                /focus-visible:shadow-\[var\(--btn-glass-inner\),var\(--btn-ambient-focus\)\]/,
            );
        });

        it('hover is NOT annotated in glassSurface — PR-B aura is the hover indicator', () => {
            // Adding a hover shadow here would compete with the
            // aura wash painted on `::after` by PR-B. Two hover
            // signals would over-claim the moment.
            expect(recipeBlock('glassSurface')).not.toMatch(
                /hover:shadow-/,
            );
        });

        it('the ambient state shadows are NOT applied via the motion-language-banned hover form', () => {
            // Same defensive guard as for translate — if a future
            // PR moves ambient to hover (e.g. for a "lift on hover"
            // effect), this fires first.
            for (const recipe of ['glassSurface', 'iridescentEdge', 'auraPrimary', 'auraNeutral', 'ghostGlass']) {
                const body = recipeBlock(recipe);
                // Allow `hover:after:shadow-*` (the PR-B aura
                // route — `after:` between `hover:` and `shadow-`).
                // Forbid the bare `hover:shadow-*` element form.
                expect(body).not.toMatch(/\bhover:shadow-/);
            }
        });
    });

    describe('disabled iridescent dust-out', () => {
        it('`iridescentEdge` drops `::after` opacity to 30% on disabled', () => {
            expect(recipeBlock('iridescentEdge')).toMatch(
                /disabled:after:opacity-30/,
            );
        });

        it('does NOT add a transition-opacity on ::after (would override aura transition-shadow)', () => {
            // The `::after` already carries `transition-shadow`
            // from the aura recipe. CSS allows ONE
            // `transition-property` per element-rule. A
            // `transition-opacity` here would override the aura's
            // shadow transition, which would snap the aura on
            // hover. The disabled dust-out is a steady state, so
            // a snap on disable is acceptable.
            expect(recipeBlock('iridescentEdge')).not.toMatch(
                /after:transition-opacity/,
            );
        });
    });

    describe('enriched `--ctrl-edge-focus` — 3-stop form-practice focus', () => {
        it('dark theme: 3 stops (brand ring + 2-stop ambient drop)', () => {
            const m = TOKENS.match(/:root \{[\s\S]*?--ctrl-edge-focus:\s*([^;]+);/);
            expect(m).toBeTruthy();
            expect((m![1].match(/rgba\(/g) ?? []).length).toBe(3);
            // First stop is the brand ring at 3px.
            expect(m![1]).toMatch(/0 0 0 3px/);
        });

        it('light theme: 3 stops (brand ring + 2-stop ambient drop)', () => {
            const m = TOKENS.match(
                /\[data-theme="light"\] \{[\s\S]*?--ctrl-edge-focus:\s*([^;]+);/,
            );
            expect(m).toBeTruthy();
            expect((m![1].match(/rgba\(/g) ?? []).length).toBe(3);
            expect(m![1]).toMatch(/0 0 0 3px/);
        });
    });
});

describe('R20 capstone — the Liquid Elegance system is whole', () => {
    describe('all R20 tokens present in both themes', () => {
        const TOKENS_TO_CHECK = [
            '--btn-ambient-rest',
            '--btn-ambient-hover',
            '--btn-ambient-press',
            '--btn-ambient-focus',
            '--btn-iridescent-gradient',
            '--btn-aura-primary',
            '--btn-aura-neutral',
            '--ctrl-edge-rest',
            '--ctrl-edge-hover',
            '--ctrl-edge-focus',
        ];
        for (const token of TOKENS_TO_CHECK) {
            it(`${token} exists`, () => {
                expect(TOKENS).toMatch(new RegExp(`${token}:`));
            });
        }
    });

    describe('all R20 recipes still present', () => {
        for (const name of ['iridescentEdge', 'auraPrimary', 'auraNeutral', 'ghostGlass']) {
            it(`${name} exists`, () => {
                expect(VARIANTS).toMatch(
                    new RegExp(`const\\s+${name}\\s*=\\s*\\[`),
                );
            });
        }
    });

    describe('the R19 system is undisturbed', () => {
        // Co-presence assertions — the R19 ratchets are still the
        // substantive lock for each piece. We just check from R20's
        // vantage that R20 didn't accidentally strip anything.
        for (const name of ['glassSurface', 'glassOnHover', 'carbonStates']) {
            it(`${name} still exists`, () => {
                expect(VARIANTS).toMatch(
                    new RegExp(`const\\s+${name}\\s*=\\s*\\[`),
                );
            });
        }
        for (const token of [
            '--btn-carbon-overlay',
            '--btn-glass-inner',
            '--btn-glass-edge',
            '--btn-carbon-grain',
        ]) {
            it(`${token} still exists`, () => {
                expect(TOKENS).toMatch(new RegExp(`${token}:`));
            });
        }
    });

    describe('documentation — docs/ui-buttons.md carries the R20 section', () => {
        it('mentions "Liquid Elegance" (Roadmap-20)', () => {
            expect(UI_BUTTONS_DOC).toMatch(/Liquid Elegance/i);
            expect(UI_BUTTONS_DOC).toMatch(/Roadmap-20/i);
        });

        it('references each R20 recipe by name', () => {
            // A future PR that adds a recipe but forgets the doc
            // breaks this assertion. Doc-as-table-of-contents
            // discipline.
            for (const name of ['iridescentEdge', 'auraPrimary', 'auraNeutral', 'ghostGlass']) {
                expect(UI_BUTTONS_DOC).toMatch(new RegExp(name));
            }
        });

        it('references each R20 token category', () => {
            expect(UI_BUTTONS_DOC).toMatch(/--btn-ambient-/);
            expect(UI_BUTTONS_DOC).toMatch(/--btn-iridescent-gradient/);
            expect(UI_BUTTONS_DOC).toMatch(/--btn-aura-/);
            expect(UI_BUTTONS_DOC).toMatch(/--ctrl-edge-/);
        });
    });

    describe('the four R20 ratchets exist as a contract surface', () => {
        // This is the meta-lock: a future PR can't delete an R20
        // ratchet without breaking THIS one too. The four ratchets
        // form a contract surface — none of them can be silently
        // stripped.
        for (const ratchet of [
            'tests/guards/r20-pra-foundation.test.ts',
            'tests/guards/r20-prb-liquid-edges.test.ts',
            'tests/guards/r20-prc-airy-density.test.ts',
            'tests/guards/r20-prd-tactile-and-capstone.test.ts',
        ]) {
            it(`${ratchet} exists`, () => {
                expect(fs.existsSync(path.join(ROOT, ratchet))).toBe(true);
            });
        }
    });
});

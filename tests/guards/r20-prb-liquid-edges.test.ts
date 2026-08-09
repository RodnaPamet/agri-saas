/**
 * R20-PR-B — Liquid edges ratchet.
 *
 * PR-A laid the language (tokens + control-variants scaffold). PR-B
 * is the first APPLICATION of that language:
 *
 *   • PRIMARY gains a permanent iridescent meniscus via `::after`
 *     — `border-image` would be cleaner but doesn't follow
 *     `border-radius`, so we use the canonical mask-composite
 *     gradient-border recipe. Always visible: the iridescence is
 *     a MATERIAL property, not a state.
 *
 *   • PRIMARY + SECONDARY gain a brand-tinted / neutral aura halo
 *     on hover, painted via `::after`'s box-shadow. Routed through
 *     `hover:after:shadow-*` rather than `hover:shadow-*` so the
 *     v2-PR-4 motion-language ratchet (which bans the latter)
 *     stays satisfied — by design, not by accident.
 *
 *   • GHOST gains a frosted-glass hover: the hover fill drops to
 *     75% opacity and `backdrop-blur-sm` is applied so the
 *     underlying surface peeks through softly.
 *
 *   • FORM-PRACTICE PARITY: `<Input>` migrates onto the
 *     `--ctrl-edge-*` tokens from PR-A — same border / hover /
 *     focus vocabulary as the controlEdge recipe. The date-picker
 *     trigger gets the same treatment so all three practices
 *     (button, input, date-picker trigger) share one focus
 *     vocabulary.
 *
 * Each invariant below is the line a future "simplify" PR would
 * cross to remove an R20 element — the ratchet's job is to make
 * those changes loud.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const VARIANTS = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/button-variants.ts'),
    'utf8',
);
const INPUT = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/input.tsx'),
    'utf8',
);
const DATE_TRIGGER = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/date-picker/trigger.tsx'),
    'utf8',
);

/** Slice a single variant's class array from the cva config. */
function variantBlock(name: string): string {
    const re = new RegExp(`["']?${name}["']?:\\s*\\[([\\s\\S]*?)\\],`);
    return VARIANTS.match(re)?.[1] ?? '';
}
function recipeBlock(name: string): string {
    const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`);
    return VARIANTS.match(re)?.[1] ?? '';
}

describe('R20-PR-B — Liquid edges', () => {
    describe('iridescent edge recipe — `iridescentEdge`', () => {
        it('a module-level `iridescentEdge` const exists', () => {
            expect(VARIANTS).toMatch(/const\s+iridescentEdge\s*=\s*\[/);
        });

        it('rides the `::after` pseudo with absolute inset-0 + rounded-[inherit]', () => {
            const body = recipeBlock('iridescentEdge');
            expect(body).toMatch(/after:absolute/);
            expect(body).toMatch(/after:inset-0/);
            expect(body).toMatch(/after:rounded-\[inherit\]/);
        });

        it('paints the iridescent gradient as the pseudo background', () => {
            expect(recipeBlock('iridescentEdge')).toMatch(
                /after:bg-\[image:var\(--btn-iridescent-gradient\)\]/,
            );
        });

        it('uses the mask-composite recipe to clip to a 1px ring', () => {
            const body = recipeBlock('iridescentEdge');
            // 2026-05-31: the mask must be driven by LONGHANDS
            // (mask-image + mask-clip), NOT the `mask` shorthand. The
            // shorthand resets mask-composite to its initial `add`, and
            // Tailwind emitted it after the exclude utility, so the 1px
            // exclusion was lost and the gradient filled the whole
            // button. The longhands never touch mask-composite, so
            // `exclude` survives. content-box on the first layer is
            // what carves out the interior; border-box on the second
            // is the full footprint.
            expect(body).toMatch(/after:p-px/);
            // No `mask` SHORTHAND class — it resets composite. (Match
            // the class form, not prose, so the explanatory comment
            // above the recipe doesn't trip this.)
            expect(body).not.toMatch(/"after:\[mask:linear-gradient/);
            expect(body).toMatch(
                /after:\[mask-image:linear-gradient\(white,white\),linear-gradient\(white,white\)\]/,
            );
            expect(body).toMatch(/after:\[mask-clip:content-box,border-box\]/);
            expect(body).toMatch(
                /after:\[-webkit-mask-clip:content-box,border-box\]/,
            );
            // Modern syntax + Safari prefix both required — Safari
            // hadn't shipped `mask-composite: exclude` at the time
            // of writing.
            expect(body).toMatch(/after:\[mask-composite:exclude\]/);
            expect(body).toMatch(/after:\[-webkit-mask-composite:xor\]/);
        });

        it('is pointer-events-none — the iridescent layer is decorative', () => {
            expect(recipeBlock('iridescentEdge')).toMatch(/after:pointer-events-none/);
        });
    });

    describe('aura recipes — `auraPrimary` + `auraNeutral`', () => {
        it('both recipes exist', () => {
            expect(VARIANTS).toMatch(/const\s+auraPrimary\s*=\s*\[/);
            expect(VARIANTS).toMatch(/const\s+auraNeutral\s*=\s*\[/);
        });

        it('auraPrimary fires the primary aura on hover via `::after`', () => {
            expect(recipeBlock('auraPrimary')).toMatch(
                /hover:after:shadow-\[var\(--btn-aura-primary\)\]/,
            );
        });

        it('auraNeutral fires the neutral aura on hover via `::after`', () => {
            expect(recipeBlock('auraNeutral')).toMatch(
                /hover:after:shadow-\[var\(--btn-aura-neutral\)\]/,
            );
        });

        it('both auras transition smoothly + drop under reduced-motion', () => {
            for (const recipe of ['auraPrimary', 'auraNeutral']) {
                const body = recipeBlock(recipe);
                expect(body).toMatch(/after:transition-shadow/);
                expect(body).toMatch(/motion-reduce:after:transition-none/);
            }
        });

        it('aura is NEVER applied via the motion-language-banned `hover:shadow-*` form', () => {
            // The whole point of routing through `::after` is to
            // keep the v2-PR-4 ratchet's regex (`\bhover:shadow-`)
            // unsatisfied. If a future PR "simplifies" the aura
            // back onto the element, this assertion fires first.
            expect(recipeBlock('auraPrimary')).not.toMatch(/[^:]hover:shadow-/);
            expect(recipeBlock('auraNeutral')).not.toMatch(/[^:]hover:shadow-/);
        });
    });

    describe('ghost-glass recipe — `ghostGlass`', () => {
        it('the recipe exists', () => {
            expect(VARIANTS).toMatch(/const\s+ghostGlass\s*=\s*\[/);
        });

        it('applies backdrop-blur-sm on hover', () => {
            expect(recipeBlock('ghostGlass')).toMatch(/hover:backdrop-blur-sm/);
        });
    });

    describe('variant wiring', () => {
        it('primary carries iridescentEdge + auraPrimary on top of glassSurface', () => {
            const body = variantBlock('primary');
            expect(body).toMatch(/\.\.\.glassSurface/);
            expect(body).toMatch(/\.\.\.iridescentEdge/);
            expect(body).toMatch(/\.\.\.auraPrimary/);
        });

        it('secondary carries auraNeutral but NOT iridescentEdge', () => {
            // Secondary is the quiet variant — iridescent on a
            // muted fill would over-claim attention. Aura yes,
            // edge no.
            const body = variantBlock('secondary');
            expect(body).toMatch(/\.\.\.auraNeutral/);
            expect(body).not.toMatch(/\.\.\.iridescentEdge/);
            expect(body).not.toMatch(/\.\.\.auraPrimary/);
        });

        it('ghost drops to 75% hover fill + applies ghostGlass', () => {
            const body = variantBlock('ghost');
            expect(body).toMatch(/hover:bg-bg-muted\/75/);
            expect(body).toMatch(/\.\.\.ghostGlass/);
        });

        it('destructive + destructive-outline stay restrained (no R20 R20 edges)', () => {
            // Destructive variants are warnings, not seductions —
            // R20's edge work is deliberately scoped to the
            // non-destructive CTAs.
            for (const v of ['destructive', 'destructive-outline']) {
                const body = variantBlock(v);
                expect(body).not.toMatch(/\.\.\.iridescentEdge/);
                expect(body).not.toMatch(/\.\.\.auraPrimary/);
                expect(body).not.toMatch(/\.\.\.auraNeutral/);
            }
        });

        it('the R19 carbon scaffolding is undisturbed in every variant', () => {
            // The interaction-state material (carbonStates) stays
            // in the base; the surface recipes still ride their
            // existing variants.
            expect(variantBlock('primary')).toMatch(/\.\.\.glassSurface/);
            expect(variantBlock('secondary')).toMatch(/\.\.\.glassSurface/);
            expect(variantBlock('destructive')).toMatch(/\.\.\.glassSurface/);
            expect(variantBlock('ghost')).toMatch(/\.\.\.glassOnHover/);
            expect(variantBlock('destructive-outline')).toMatch(
                /\.\.\.glassOnHover/,
            );
        });
    });

    describe('form-practice parity — Input wired to controlEdge tokens', () => {
        it('Input uses `--ctrl-edge-rest` for the rest border', () => {
            expect(INPUT).toMatch(/border-\[var\(--ctrl-edge-rest\)\]/);
        });
        it('Input uses `--ctrl-edge-hover` on hover', () => {
            expect(INPUT).toMatch(/hover:border-\[var\(--ctrl-edge-hover\)\]/);
        });
        it('Input uses `--ctrl-edge-focus` as the focus halo (box-shadow, not ring)', () => {
            expect(INPUT).toMatch(
                /focus-visible:shadow-\[var\(--ctrl-edge-focus\)\]/,
            );
        });
        it('Input no longer carries the legacy `border-border-subtle` rest token', () => {
            // Rest border now rides the new R20 token. If a future
            // simplify PR puts the legacy token back, this fires.
            const re = /border-border-subtle/;
            // Allow it only inside comment lines (legitimate
            // documentation references).
            for (const line of INPUT.split('\n')) {
                if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
                expect(line).not.toMatch(re);
            }
        });
    });

    describe('form-practice parity — date-picker trigger wired to controlEdge tokens', () => {
        it('rest border uses `--ctrl-edge-rest`', () => {
            expect(DATE_TRIGGER).toMatch(/border-\[var\(--ctrl-edge-rest\)\]/);
        });
        it('hover border uses `--ctrl-edge-hover`', () => {
            expect(DATE_TRIGGER).toMatch(
                /hover:border-\[var\(--ctrl-edge-hover\)\]/,
            );
        });
        it('focus halo uses `--ctrl-edge-focus`', () => {
            expect(DATE_TRIGGER).toMatch(
                /focus-visible:shadow-\[var\(--ctrl-edge-focus\)\]/,
            );
        });
        it('open state also uses `--ctrl-edge-focus` so it reads as a sustained focus', () => {
            // The open state is conceptually "focus held" — applying
            // the same halo keeps the visual vocabulary coherent
            // (one focus tone, two trigger states).
            expect(DATE_TRIGGER).toMatch(
                /data-\[state=open\]:shadow-\[var\(--ctrl-edge-focus\)\]/,
            );
        });
    });
});

/**
 * Roadmap-4 PR-6 — truncation max-width tokens.
 *
 * Truncated copy ALWAYS needs a ceiling. The codebase had drifted
 * to 6 different max-widths across 7 callsites with three units:
 *
 *   • IdentityPill (×2)           max-w-[14ch]
 *   • FrameworkExplorer code chip max-w-[8rem]   (≈16ch)
 *   • copy-text                   max-w-[28ch]
 *   • breadcrumbs link            max-w-[16rem]  (≈32ch)
 *   • breadcrumbs current         max-w-[20rem]  (≈40ch)
 *   • SoA justification           max-w-[200px]  (≈25ch)
 *
 * Six values, three units, every truncated surface inventing its
 * own ceiling. The visible width drift across the product was
 * subtle but consistent — every page had at least one truncate
 * site that didn't match the rest.
 *
 * What lands
 *
 *   Three semantic tokens in `tailwind.config.js`:
 *
 *     max-w-trunc-tight    14 ch — identity labels (tenant /
 *                                  org name), code chips, badges.
 *     max-w-trunc-default  28 ch — typical truncated copy
 *                                  (justification cells, copy-text
 *                                  values).
 *     max-w-trunc-loose    40 ch — breadcrumb crumbs, long-prose
 *                                  fields where the ceiling
 *                                  should still allow most full
 *                                  values to render.
 *
 *   `ch` units (character widths) keep visible character count
 *   stable across font weight / size variants — the same
 *   14-character tenant name reads the same in the sidebar
 *   identity pill (text-sm) and in a sheet header (text-base).
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` may pair an arbitrary
 *   `max-w-[…]` Tailwind utility with a `truncate` class on the
 *   same element. Truncated surfaces must reach for one of the
 *   three semantic tokens. Stand-alone `max-w-[…]` (without
 *   truncate) stays free — those are layout caps, not text
 *   ceilings.
 *
 * What this ratchet does NOT police
 *
 *   - Layout `max-w-[…]` without truncate (popover widths,
 *     modal caps, command-palette frame). Those are container
 *     ceilings, not text ceilings.
 *
 *   - Truncate without ANY max-width — the parent flex/grid
 *     constrains the width through `min-w-0` + `flex-1`. The
 *     ratchet only fires when both `max-w-[…]` AND `truncate`
 *     are on the same element.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');

// Match a `className="…"` attribute that contains BOTH an
// arbitrary `max-w-[<value>]` and a `truncate` token. We allow
// any order between them — Tailwind class order is stylistic.
const ARBITRARY_TRUNC_RE =
    /className\s*=\s*["'`][^"'`]*\bmax-w-\[[^\]]+\][^"'`]*\btruncate\b[^"'`]*["'`]|className\s*=\s*["'`][^"'`]*\btruncate\b[^"'`]*\bmax-w-\[[^\]]+\][^"'`]*["'`]/;

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

/**
 * The scanned population, via the SANCTIONED collector — #2483 class A.
 *
 * Was an inline recursive `walk` inside the `it()` below, so `selector-teeth`
 * found nothing at module scope to mutate, while the assertion
 * `expect(offenders).toEqual([])` is satisfied for free by an emptied walk.
 * `collectSourceFiles` REFUSES an empty result, so the population cannot be
 * empty rather than being emptied and caught (#865).
 *
 * Parity measured BEFORE the change: 872 files both ways, zero difference,
 * with no exclusions applied identically.
 */
const SCANNED = collectSourceFiles({
    roots: ['src'],
    extensions: ['.tsx'],
    floor: 600,
});

describe('Truncation max-width tokens (Roadmap-4 PR-6)', () => {
    it('tailwind config exposes the three trunc-* tokens', () => {
        const config = fs.readFileSync(
            path.join(ROOT, 'tailwind.config.js'),
            'utf-8',
        );
        expect(config).toMatch(/'trunc-tight':\s*'14ch'/);
        expect(config).toMatch(/'trunc-default':\s*'28ch'/);
        expect(config).toMatch(/'trunc-loose':\s*'40ch'/);
    });

    it('no .tsx file under src/ pairs an arbitrary max-w-[…] with truncate', () => {
        const offenders: Offence[] = [];
        for (const full of SCANNED) {
            const rel = path.relative(ROOT, full);
            const lines = fs.readFileSync(full, 'utf-8').split('\n');
            lines.forEach((line, i) => {
                if (ARBITRARY_TRUNC_RE.test(line)) {
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        snippet: line.trim(),
                    });
                }
            });
        }
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `Truncated surfaces must reach for max-w-trunc-tight | max-w-trunc-default | max-w-trunc-loose. Drop the arbitrary max-w-[…]:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

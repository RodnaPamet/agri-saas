/**
 * Roadmap-5 PR-2 — Card padding lockdown.
 *
 * Card surfaces had drifted to six padding values: p-4 (canonical),
 * p-6 (canonical), p-2, p-3, p-10, p-12. The ladder was binary on
 * paper; the codebase had six rungs.
 *
 * What lands
 *
 *   • The Card primitive's `density` axis grows by ONE rung:
 *       comfortable (p-6, default) — content cards, panels.
 *       compact     (p-4)          — stat cards, dense rows.
 *       spacious    (p-12)         — empty / loading / permission
 *                                    states. The inner content is
 *                                    a short message; the breathing
 *                                    room IS the affordance.
 *       none        (p-0)          — children own padding.
 *
 *     Three rungs covers every legitimate case in the product;
 *     `none` is the escape valve when a wrapper genuinely owns its
 *     own padding.
 *
 *   • All 21 outlier sites (p-2 / p-3 / p-10 / p-12 with explicit
 *     className padding) migrated to the matching rung. p-12 sites
 *     went to `spacious`; p-10 sites went to `spacious` too (closer
 *     than `comfortable` p-6); p-3 sites went to `compact`.
 *
 * What this ratchet locks
 *
 *   No `cardVariants(...)` callsite may ship a uniform `p-N`
 *   override in its className arguments. The density axis is the
 *   only legal way to set Card padding. Per-side directional
 *   padding (`pt-N`, `pb-N`, `pl-N`, `pr-N`, `px-N`, `py-N`) stays
 *   permitted — those are content-spacing helpers inside a Card,
 *   not Card-padding overrides.
 *
 * What this ratchet does NOT police
 *
 *   - The cardVariants definition itself in `card.tsx` (where the
 *     density values live).
 *   - Card consumers using only the default (no className override)
 *     or only directional padding.
 *   - Non-Card consumers — `p-N` on regular `<div>`s is fine.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');
const VARIANTS = 'src/components/ui/card-variants.ts';
const PRIMITIVE = 'src/components/ui/card.tsx';

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

// Match a `cardVariants(...)` call followed (within ~120 chars) by a
// className-arg string containing a uniform `p-N` token. The detector
// is line-based for clarity; multi-line `cn(cardVariants(...), ...)`
// blocks are normalised before scanning.
const VIOLATION_RE = /cardVariants\([^)]*\)[^']*'[^']*\bp-\d+\b[^']*'/;

/**
 * The scanned population, via the SANCTIONED collector — #2483 class A.
 *
 * Was an inline recursive `walk` inside the `it()` below, so `selector-teeth`
 * found nothing at module scope to mutate. The assertion is
 * `expect(offenders).toEqual([])`, which an emptied walk satisfies for free.
 * `collectSourceFiles` REFUSES an empty result, so the population cannot be
 * empty rather than being emptied and caught (#865).
 *
 * Parity measured BEFORE the change: 872 files both ways, zero difference.
 */
const SCANNED = collectSourceFiles({
    roots: ['src'],
    extensions: ['.tsx'],
    floor: 600,
});

describe('Card padding lockdown (Roadmap-5 PR-2)', () => {
    it('the primitive exposes the four-rung density axis', () => {
        // Roadmap-5 hotfix — the cva definition lives in
        // `card-variants.ts` (server-safe sibling).
        const src = fs.readFileSync(path.join(ROOT, VARIANTS), 'utf-8');
        expect(src).toMatch(/density:\s*\{[\s\S]*?comfortable:\s*"p-6"/);
        expect(src).toMatch(/compact:\s*"p-4"/);
        expect(src).toMatch(/spacious:\s*"p-12"/);
        expect(src).toMatch(/none:\s*""/);
    });

    it('no consumer pairs cardVariants with a uniform p-N className override', () => {
        const offenders: Offence[] = [];
        for (const full of SCANNED) {
            const rel = path.relative(ROOT, full);
            if (rel === PRIMITIVE) continue;
            const raw = fs.readFileSync(full, 'utf-8');
            if (!/cardVariants\(/.test(raw)) continue;
            // Normalise newlines around `cn(cardVariants(...), ...)`
            // so multi-line compositions read on one logical line.
            const lines = raw.split('\n');
            lines.forEach((line, i) => {
                if (VIOLATION_RE.test(line)) {
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        snippet: line.trim().slice(0, 200),
                    });
                }
            });
        }
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `These callsites pair cardVariants(...) with a uniform p-N override. Use the density axis (comfortable / compact / spacious / none) — directional padding (py-N / px-N / pt-N / pb-N) stays permitted:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

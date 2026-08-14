/**
 * Nothing divides net worth, or grain on hand, by an area.
 *
 * ── The claim this defends ──────────────────────────────────────────
 *
 * Net worth is `standing + onHand − rentInGrain − cost`. Two of those
 * terms have no area at all:
 *
 *   • `grainOnHandValue` is tonnes in a store, harvested off land that may
 *     not even be this season's;
 *   • `cashCostTotal` carries rent and payroll, which are farm-wide.
 *
 * So `netWorth / area` mixes scopes and produces a confident, wrong
 * number — the exact failure mode the calculator spent five PRs
 * eliminating. `lib/grain/per-area.ts` divides only terms attributable to
 * the standing crop's own plantings, and this keeps it that way.
 *
 * ── Why a structural guard and not a behavioural test ───────────────
 *
 * A behavioural test can only prove the figures that EXIST are right. It
 * cannot prove that no future line introduces the division — and the
 * division is attractive precisely because it looks like the obvious next
 * per-dca figure to add. This asserts on source text, contributes no
 * runtime coverage, and is paired with `tests/unit/grain/per-area.test.ts`,
 * which executes the arithmetic it protects.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = [
    'src/lib/grain/per-area.ts',
    'src/app-layer/usecases/grain-net-worth.ts',
    'src/app/t/[tenantSlug]/(app)/grain/calculator/CalculatorClient.tsx',
    'src/app/t/[tenantSlug]/(app)/grain/calculator/components.tsx',
    'src/app/t/[tenantSlug]/(app)/grain/calculator/page.tsx',
];

/** `X / <something area-ish>`, for the numerators that have no area. */
const FORBIDDEN = [
    /netWorth\s*\/\s*\w*[Aa]rea/,
    /netWorth\s*\/\s*\w*[Dd]ca/,
    /netWorth\s*\/\s*\w*[Hh]a\b/,
    /grainOnHandValue\s*\/\s*\w*[Aa]rea/,
    /grainOnHandValue\s*\/\s*\w*[Dd]ca/,
    /grainOnHandValue\s*\/\s*\w*[Hh]a\b/,
    /netAssetPosition\s*\/\s*\w*[Aa]rea/,
    /netAssetPosition\s*\/\s*\w*[Dd]ca/,
];

describe('per-dca denominators', () => {
    it.each(FILES)('%s never divides an area-less numerator by an area', (rel) => {
        const src = readFileSync(join(process.cwd(), rel), 'utf8');
        // Comments are stripped first: this file's own subjects DESCRIBE the
        // banned expression in prose, and so do their docblocks. A scanner
        // that cannot tell a warning from the thing it warns about fails the
        // build for explaining itself — the trap two other guards in this
        // repo already document.
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');

        for (const pattern of FORBIDDEN) {
            expect({ file: rel, matched: pattern.test(code) }).toEqual({
                file: rel,
                matched: false,
            });
        }
    });

    it('the scanner actually catches the division it bans', () => {
        // Mutation proof, in memory. Without this the six patterns above
        // could be quietly wrong and the suite would stay green forever.
        const offending = 'const perDca = row.netWorth / areaDca;';
        expect(FORBIDDEN.some((p) => p.test(offending))).toBe(true);

        const alsoOffending = 'const x = grainOnHandValue / standingCropAreaHa;';
        expect(FORBIDDEN.some((p) => p.test(alsoOffending))).toBe(true);

        // And does NOT catch the legitimate one.
        const allowed = 'marginPerDca: round2((value - input.attributableCost) / areaDca)';
        expect(FORBIDDEN.some((p) => p.test(allowed))).toBe(false);
    });
});

/**
 * R22-PR-B — Border tone + focus-ring refinement ratchet.
 *
 * Two micro-detail moves the four R22 prompts converged on:
 *
 *   1. `--btn-carbon-border` was reading LOUD against the carbon
 *      surface — at α 0.30 the meniscus competed with the
 *      iridescent edge instead of supporting it. PR-B softens to
 *      α 0.18 (dark) / α 0.16 (light, warm-graphite preserved).
 *
 *   2. The focus ring was Tailwind `ring-2 ring-offset-2 ring-ring`
 *      — the default-feel "this is focused" shape every other
 *      Tailwind app uses. PR-B drops the ring entirely and routes
 *      focus through the brand-tinted box-shadow halo already
 *      established by `--ctrl-edge-focus`. A focused button and a
 *      focused Input now wear the EXACT same halo. The
 *      `--btn-ambient-focus` token also tightens its inner ring
 *      stop from 4px → 3px to match.
 *
 * Five surfaces:
 *   - `--btn-carbon-border` dark theme (0.30 → 0.18)
 *   - `--btn-carbon-border` light theme (0.24 → 0.16)
 *   - `--btn-ambient-focus` dark theme (4px → 3px)
 *   - `--btn-ambient-focus` light theme (4px → 3px)
 *   - cva base focus-visible: shadow halo (replaces Tailwind ring)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const TOKENS = fs.readFileSync(
    path.join(ROOT, 'src/styles/tokens.css'),
    'utf8',
);
const BUTTON_VARIANTS = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/button-variants.ts'),
    'utf8',
);

/**
 * Slice the content of a CSS theme block. The first occurrence of
 * the selector might be inside a doc-block comment; pin to the
 * actual rule by requiring the selector to start a line and be
 * followed by `{` on the same line.
 */
function themeBlock(selector: string): string {
    // Strip comments first so a `:root` mentioned in a comment
    // block doesn't trick the matcher. Then find the selector at
    // the START of a line (regex `^` with `m` flag).
    const stripped = TOKENS.replace(/\/\*[\s\S]*?\*\//g, '');
    // Locate the selector occurrence that's at line-start. Use
    // indexOf + a newline check rather than regex-escaping the
    // selector (the bracket/quote escape is error-prone).
    let idx = -1;
    let from = 0;
    while ((from = stripped.indexOf(selector, from)) !== -1) {
        const lineStart = from === 0 || stripped[from - 1] === '\n';
        if (lineStart) {
            idx = from;
            break;
        }
        from += 1;
    }
    if (idx === -1) return '';
    const open = stripped.indexOf('{', idx);
    if (open === -1) return '';
    let depth = 1;
    let i = open + 1;
    while (i < stripped.length && depth > 0) {
        if (stripped[i] === '{') depth++;
        else if (stripped[i] === '}') depth--;
        i++;
    }
    return stripped.slice(open + 1, i - 1);
}

const DARK = themeBlock(':root');
const LIGHT = themeBlock('[data-theme="light"]');

describe('R22-PR-B — Border tone + focus-ring refinement', () => {
    describe('--btn-carbon-border softened α (R22 carving)', () => {
        it('dark theme uses α 0.18 (was 0.30)', () => {
            const m = DARK.match(
                /--btn-carbon-border:\s*rgba\([^)]+\);/,
            );
            expect(m).toBeTruthy();
            expect(m![0]).toMatch(/0\.18/);
            expect(m![0]).not.toMatch(/0\.30/);
        });

        it('light theme uses α 0.16 (was 0.24)', () => {
            const m = LIGHT.match(
                /--btn-carbon-border:\s*rgba\([^)]+\);/,
            );
            expect(m).toBeTruthy();
            expect(m![0]).toMatch(/0\.16/);
            expect(m![0]).not.toMatch(/0\.24/);
        });
    });

    describe('--btn-ambient-focus ring tightened 4px → 3px', () => {
        it('dark theme ring stop is 3px', () => {
            const m = DARK.match(
                /--btn-ambient-focus:\s*([^;]+);/,
            );
            expect(m).toBeTruthy();
            expect(m![1]).toMatch(/0 0 0 3px/);
            expect(m![1]).not.toMatch(/0 0 0 4px/);
        });

        it('light theme ring stop is 3px', () => {
            const m = LIGHT.match(
                /--btn-ambient-focus:\s*([^;]+);/,
            );
            expect(m).toBeTruthy();
            expect(m![1]).toMatch(/0 0 0 3px/);
            expect(m![1]).not.toMatch(/0 0 0 4px/);
        });

        it('the 3-stop shape (ring + 2 ambient drops) is preserved', () => {
            for (const block of [DARK, LIGHT]) {
                const m = block.match(/--btn-ambient-focus:\s*([^;]+);/);
                expect((m![1].match(/rgba\(/g) ?? []).length).toBe(3);
            }
        });
    });

    describe('cva base focus-visible: brand-tinted shadow halo (no Tailwind ring)', () => {
        it('drops Tailwind ring-2 / ring-offset-2 / ring-ring', () => {
            const base =
                BUTTON_VARIANTS.match(/cva\(\s*\[([\s\S]*?)\]\s*,/)?.[1] ?? '';
            const stripped = blankNonCode(base);
            expect(stripped).not.toMatch(/focus-visible:ring-2/);
            expect(stripped).not.toMatch(/focus-visible:ring-offset/);
            expect(stripped).not.toMatch(/focus-visible:ring-ring/);
        });

        it('keeps `focus-visible:outline-none` so the browser default doesn\'t leak through', () => {
            const base =
                BUTTON_VARIANTS.match(/cva\(\s*\[([\s\S]*?)\]\s*,/)?.[1] ?? '';
            expect(base).toMatch(/focus-visible:outline-none/);
        });

        it('uses `focus-visible:shadow-[var(--ctrl-edge-focus)]` as the halo', () => {
            // Same vocabulary as the form controls — focused
            // button and focused Input wear the same halo.
            const base =
                BUTTON_VARIANTS.match(/cva\(\s*\[([\s\S]*?)\]\s*,/)?.[1] ?? '';
            expect(base).toMatch(
                /focus-visible:shadow-\[var\(--ctrl-edge-focus\)\]/,
            );
        });
    });
});

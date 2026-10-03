/**
 * `src/styles/tokens.css` and `design/Tokens.swift` agree with
 * `design/tokens.json`.
 *
 * P2.3 made the JSON the source of token VALUES for both platforms. That only
 * buys anything while the two outputs are actually regenerated: a hand edit to
 * either, or a JSON change without running the generator, puts web and iOS out
 * of step silently — both files still parse and the app still builds.
 *
 * ── the generator owns values, not structure ──
 *
 * It rewrites the value on each declaration line and leaves every other byte
 * alone. That is not a stylistic preference; two earlier designs broke
 * contracts this repo holds:
 *
 *   · a separate `tokens.generated.css` that tokens.css imported — THIRTY
 *     guard files read `src/styles/tokens.css` directly to assert a token is
 *     declared in the canonical file;
 *   · generating whole theme blocks with the prose lifted out —
 *     `r13-secondary-brand-tokens` requires a rationale to sit BETWEEN two
 *     specific declarations inside the block, and five paragraphs on why white
 *     replaced electric blue lived exactly there.
 *
 * So this guard checks agreement, and deliberately does NOT check layout.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

interface Spec {
    themeSelectors: Record<string, string>;
    themes: Record<string, Record<string, { value: string; note?: string }>>;
}

const spec: Spec = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'design/tokens.json'), 'utf8'),
);

describe('tokens.css and Tokens.swift agree with design/tokens.json', () => {
    it('the inputs exist — a missing file must fail, not skip', () => {
        for (const rel of [
            'design/tokens.json',
            'design/Tokens.swift',
            'src/styles/tokens.css',
            'scripts/generate-tokens.mjs',
        ]) {
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
        }
        // Floors, so a truncated JSON cannot make the agreement check vacuous.
        expect(Object.keys(spec.themes)).toEqual(['dark', 'light', 'highContrast']);
        expect(Object.keys(spec.themes.dark).length).toBeGreaterThanOrEqual(120);
    });

    it('regenerating produces no change', () => {
        // `--check` writes nothing; it compares and exits 1 on drift. Running
        // the real generator rather than reimplementing it is the point — a
        // second implementation could agree with itself while both disagreed
        // with the committed files.
        let out = '';
        try {
            out = execFileSync('node', ['scripts/generate-tokens.mjs', '--check'], {
                cwd: ROOT,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            const e = err as { stdout?: string; stderr?: string };
            throw new Error(
                'design/tokens.json and its outputs disagree.\n' +
                    'Run `npm run tokens:generate` and commit the result.\n\n' +
                    `${e.stderr ?? ''}${e.stdout ?? ''}`,
            );
        }
        expect(out).toContain('in sync');
    });

    it('every token in the JSON is declared in tokens.css, in its own theme block', () => {
        // The direction that matters for the 30 guards reading this file: a
        // token added to the JSON must actually reach the CSS, or the JSON has
        // silently stopped being the source for it.
        const css = fs.readFileSync(path.join(ROOT, 'src/styles/tokens.css'), 'utf8');
        const lines = css.split('\n');
        const missing: string[] = [];
        for (const [theme, sel] of Object.entries(spec.themeSelectors)) {
            const start = lines.findIndex((l) => l.startsWith(sel) && l.includes('{'));
            expect(start).toBeGreaterThanOrEqual(0);
            let depth = 0;
            let end = start;
            for (let i = start; i < lines.length; i++) {
                depth += (lines[i].match(/\{/g) ?? []).length;
                depth -= (lines[i].match(/\}/g) ?? []).length;
                if (depth === 0 && i > start) { end = i; break; }
            }
            const block = lines.slice(start, end + 1).join('\n');
            for (const [name, tok] of Object.entries(spec.themes[theme])) {
                // Spacing after the colon is the AUTHOR's and the generator
                // preserves it — 135 declarations in this file are padded into
                // columns and 134 are single-spaced. That mixture is why five
                // other guards using an exact `toContain('--x: y;')` keep
                // working: the tokens they name were already single-spaced and
                // stay that way. So this matches the declaration, not a layout.
                const re = new RegExp(
                    `--${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*` +
                        `${tok.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`,
                );
                if (!re.test(block)) {
                    missing.push(`${theme}: --${name}: ${tok.value};`);
                }
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `${missing.length} token(s) from design/tokens.json are not declared ` +
                    `with that value in their theme block:\n  ${missing.join('\n  ')}`,
            );
        }
        expect(missing).toEqual([]);
    });

    it('Tokens.swift says it is generated and names its source', () => {
        // A generated file that does not say so gets hand-edited once and then
        // silently overwritten, losing the edit.
        const swift = fs.readFileSync(path.join(ROOT, 'design/Tokens.swift'), 'utf8');
        expect(swift).toContain('GENERATED by scripts/generate-tokens.mjs');
        expect(swift).toContain('design/tokens.json');
        // And it must actually carry the palette, not just a banner.
        expect(swift).toContain('public enum AgrentColor');
        expect((swift.match(/static func \w+\(_ theme: AgrentTheme\)/g) ?? []).length)
            .toBeGreaterThan(80);
    });
});

/**
 * Roadmap-6 PR-1 — animation vocabulary discipline.
 *
 * The product had drifted to FIVE animation tokens for variations
 * of "appearing":
 *
 *   animate-fadeIn         (CSS, 0.3s, opacity + translateY 8→0)  103×
 *   animate-fade-in        (Tailwind, 0.15s, pure opacity)          4×
 *   animate-slide-up-fade  (Tailwind, 0.2s, translateY 6→0+opacity) 3×
 *   animate-slideIn        (CSS, 0.3s, opacity + translateX -10→0)  2×
 *   animate-scale-in       (Tailwind, 0.15s, scale 0.95→1+opacity)  1×
 *
 * Five tokens for visually-similar effects produced two real
 * problems:
 *
 *   1. The eye registered the difference between sliding-from-left
 *      (`slideIn`) and rising-from-below (`fadeIn`) on master-detail
 *      panes — only two callsites used `slideIn`, so the product
 *      surface read as "almost coordinated, but moving."
 *
 *   2. `fadeIn` and `fade-in` are not aliases. They run at 0.3s vs
 *      0.15s with different transforms. Two near-identical names
 *      with different effects is a maintenance trap.
 *
 * What lands
 *
 *   `animate-slideIn` is retired. Two callsites (master-detail
 *   panes in `audits/AuditsClient` and `clauses/ClausesBrowser`)
 *   migrate to `animate-fadeIn`. The CSS `@keyframes slideIn` +
 *   `.animate-slideIn` rules are removed from `globals.css`.
 *
 * The surviving canonical set
 *
 *   - `animate-fadeIn`        — page-level + content enter (0.3s)
 *   - `animate-fade-in`       — overlay backdrop (opacity-only, 0.15s)
 *   - `animate-slide-up-fade` — popover / tooltip enter (0.2s)
 *   - `animate-scale-in`      — modal panel enter (0.15s)
 *   - `animate-pulse`         — skeletons (loading)
 *   - `animate-spin`          — spinners
 *
 *   `fadeIn` and `fade-in` survive as DISTINCT animations because
 *   they do different things — opacity-only (backdrop) vs
 *   opacity+translateY (content). The names are kept disambiguated
 *   by the dash convention (`fade-in` is Tailwind/lowercase-dashed,
 *   `fadeIn` is CSS/camelCase). Future contributors choose by
 *   intent: backdrop = `fade-in`; content = `fadeIn`.
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` may use `animate-slideIn`. The
 *   visual was redundant with `animate-fadeIn`; one of them had
 *   to go.
 *
 * What this ratchet does NOT police
 *
 *   - The remaining 5 named animations (each used legitimately).
 *   - Custom `transition-*` declarations on individual elements.
 *   - `motion/` library imports — those compose motion via JS
 *     instead of named CSS animations.
 */
import * as fs from 'fs';
import * as path from 'path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

describe('Animation vocabulary discipline (Roadmap-6 PR-1)', () => {
    it('animate-slideIn is retired (zero callsites)', () => {
        const offenders: Offence[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next')
                        continue;
                    walk(full);
                    continue;
                }
                if (!/\.(tsx?|css)$/.test(e.name)) continue;
                const rel = path.relative(ROOT, full);
                const raw = fs.readFileSync(full, 'utf-8');
                // Strip line comments + block comments first so the
                // documentation note in globals.css explaining the
                // retirement doesn't trip the scanner.
                const stripped = blankNonCode(raw);
                const lines = stripped.split('\n');
                lines.forEach((line, i) => {
                    if (/\banimate-slideIn\b/.test(line)) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            snippet: line.trim().slice(0, 200),
                        });
                    }
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `\`animate-slideIn\` is retired (Roadmap-6 PR-1). The translateX reveal was redundant with \`animate-fadeIn\`'s 8px translateY enter. Use \`animate-fadeIn\` for content reveal:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('globals.css does not redefine the retired keyframe', () => {
        const css = fs.readFileSync(
            path.join(ROOT, 'src/app/globals.css'),
            'utf-8',
        );
        // The @keyframes definition itself was removed; the
        // .animate-slideIn class definition was removed; only the
        // documentation comment remains. The comment uses
        // `slideIn` but isn't an executable rule.
        const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(stripped).not.toMatch(/@keyframes\s+slideIn\b/);
        expect(stripped).not.toMatch(/\.animate-slideIn\s*\{/);
    });
});

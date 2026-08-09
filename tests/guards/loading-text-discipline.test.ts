/**
 * Roadmap-6 PR-6 — loading-text typographic discipline.
 *
 * Eight callsites shipped "Loading X..." text with three-dot
 * ellipsis (`...`):
 *
 *   policies/templates  "Loading templates..."
 *   policies/[id]       "Loading activity..."
 *   practices/[id]       "Loading activity..."
 *   practices/templates  "Loading templates..."
 *   frameworks/[key]    "Loading tree..." × 2
 *   frameworks/.../diff "Loading diff..."
 *   TraceabilityPanel   "Loading traceability..."
 *
 * Two issues with the three-dot form:
 *
 *   1. Typographic. The unicode ellipsis (`…`, U+2026) is a
 *      single glyph; three periods is three glyphs with
 *      different kerning. Premium publications converged on
 *      the unicode glyph decades ago.
 *
 *   2. Wrap risk. `...` can break across line breaks (the third
 *      dot drops to a new line); `…` is one character and never
 *      wraps mid-glyph.
 *
 * What lands
 *
 *   All 8 callsites migrated `Loading X...` → `Loading X…`
 *   (unicode ellipsis).
 *
 *   Future contributors are expected to keep the noun (it gives
 *   the user useful context — "Loading evidence" tells them
 *   what's loading) and use the unicode glyph.
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` may render `Loading {word}...`
 *   (three-dot form). The unicode ellipsis is the canonical
 *   suffix.
 *
 * What this ratchet does NOT police
 *
 *   - "Loading…" (no noun, unicode glyph). Some sites
 *     legitimately don't have a meaningful noun.
 *   - Bare ellipsis in non-loading contexts (e.g.
 *     "Showing more…" pagination or "Type to search…"
 *     placeholders).
 *   - The 5 sites where loading-state SHOULD be a skeleton
 *     instead of text — that's a separate refactor.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

interface Offence {
    file: string;
    line: number;
    text: string;
}

const VIOLATION_RE = /Loading\s+[a-z][a-z]*\.\.\./;

describe('Loading-text typographic discipline (Roadmap-6 PR-6)', () => {
    it('no .tsx file uses "Loading X..." (three-dot ellipsis)', () => {
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
                if (!/\.tsx$/.test(e.name)) continue;
                const rel = path.relative(ROOT, full);
                const raw = fs.readFileSync(full, 'utf-8');
                const stripped = raw
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/\/\/[^\n]*/g, '');
                const lines = stripped.split('\n');
                lines.forEach((line, i) => {
                    if (VIOLATION_RE.test(line)) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            text: line.trim().slice(0, 200),
                        });
                    }
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `"Loading X..." (three-dot ellipsis) detected. Use the unicode ellipsis "…" (U+2026):\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

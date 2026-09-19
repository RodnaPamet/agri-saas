/**
 * Roadmap-5 PR-5 — hover recipe discipline.
 *
 * The cursor traversed the product across nine different hover
 * tones on muted backgrounds:
 *
 *   hover:bg-bg-muted        × 61 (canonical click-target)
 *   hover:bg-bg-muted/50     × 26 (canonical row/card)
 *   hover:bg-bg-muted/40     × 3
 *   hover:bg-bg-muted/30     × 2
 *   hover:bg-bg-elevated/50  × 2
 *   hover:bg-bg-elevated/80  × 1
 *   hover:bg-bg-elevated/20  × 1
 *   hover:bg-bg-elevated     × 1
 *   hover:bg-bg-subtle       × 1
 *
 * Nine textures for two intents — "this row reacts" vs "this is
 * clickable." Twelve drift sites migrated; two recipes survive.
 *
 * Two recipes
 *
 *   • Row / card hover (subtle background change indicating "this
 *     row is hoverable / selectable"):
 *
 *         hover:bg-bg-muted/50
 *
 *     ~50% opacity on the muted token. Quiet enough to not feel
 *     like a button, loud enough to confirm interactivity.
 *
 *   • Click-target hover (button-shaped element, menu item, ghost
 *     button, icon button, sidebar nav item):
 *
 *         hover:bg-bg-muted
 *
 *     Solid muted background. Says "this is clickable."
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` may ship a `hover:bg-bg-*` value
 *   outside the two canonical recipes above and the small set of
 *   semantic-state hovers (`hover:bg-bg-error`, `*-success`,
 *   `*-info`, `*-emphasis`, `*-attention`, `*-warning`, with or
 *   without an `/N` opacity).
 *
 *   Any other `hover:bg-bg-*` value is drift and fails CI.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

// The two canonical hover recipes on muted backgrounds.
const CANONICAL_MUTED = new Set([
    'hover:bg-bg-muted',
    'hover:bg-bg-muted/50',
]);

// Semantic-state hover tones legitimately differ from the muted
// ladder — they carry meaning (error, success, info, …).
const SEMANTIC_PREFIXES = [
    'hover:bg-bg-error',
    'hover:bg-bg-success',
    'hover:bg-bg-info',
    'hover:bg-bg-emphasis',
    'hover:bg-bg-attention',
    'hover:bg-bg-warning',
];

const HOVER_RE = /\bhover:bg-bg-[a-z]+(?:\/[0-9]+)?/g;

interface Offence {
    file: string;
    line: number;
    token: string;
    snippet: string;
}

function isAllowed(token: string): boolean {
    if (CANONICAL_MUTED.has(token)) return true;
    return SEMANTIC_PREFIXES.some((p) => token === p || token.startsWith(p + '/'));
}

describe('Hover recipe discipline (Roadmap-5 PR-5)', () => {
    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `isAllowed` is this file's ONLY module-level selector, and it is the
    // whole verdict: the scan pushes an offender exactly when
    // `!isAllowed(token)`. Gutted to any TRUTHY constant — `[]`, `{}`,
    // `new Set()`, `new Map()` — every token in the product is allowed,
    // `offenders` stays empty and `expect(offenders).toEqual([])` passes.
    // 837 files opened, 119 live `hover:bg-bg-*` tokens read, none
    // classified, green.
    //
    // Which filter kills what, because the three are not interchangeable:
    //   · TYPECHECK kills NOTHING. tsconfig.json sets `isolatedModules`, so
    //     ts-jest compiles via `transpileModule` with no semantic
    //     diagnostics — the `: boolean` annotation skips no gut.
    //   · THE SEAM kills NOTHING. `if (!isAllowed(token))` is a bare
    //     truthiness test: every gut is legal there, it only flips polarity.
    //   · THE ASSERTION kills the five FALSY guts (`''` / `0` / `null` /
    //     `undefined` / `false`) — they make all 119 tokens offenders and
    //     the throw fires. Nothing kills the four truthy ones.
    //
    // So the dangerous direction is ALLOW-EVERYTHING, and unusually the gut
    // set reaches it. The load-bearing half below is therefore the REFUSAL
    // half: a classifier that cannot say "no" is the vacuous pass.

    it('control: isAllowed accepts both canonical recipes and every semantic tone', () => {
        // The docblock promises TWO recipes; pin the count so a third one
        // cannot arrive without this file noticing.
        expect(CANONICAL_MUTED.size).toBe(2);
        for (const token of CANONICAL_MUTED) {
            expect(isAllowed(token)).toBe(true);
        }
        // Derived from the list rather than restated, so a semantic tone
        // added tomorrow is covered the moment it is added — in both
        // spellings the docblock promises (bare, and with an `/N` opacity).
        expect(SEMANTIC_PREFIXES.length).toBeGreaterThan(0);
        for (const prefix of SEMANTIC_PREFIXES) {
            expect(isAllowed(prefix)).toBe(true);
            expect(isAllowed(`${prefix}/80`)).toBe(true);
        }
    });

    it('control: isAllowed REFUSES every off-recipe tone, and near-misses with it', () => {
        // The seven drift tones the docblock records as migrated away. These
        // are the assertions the four TRUTHY guts cannot pass: without them
        // `isAllowed` can be a constant and this guard still reports "no
        // off-recipe hovers".
        for (const token of [
            'hover:bg-bg-muted/40',
            'hover:bg-bg-muted/30',
            'hover:bg-bg-elevated',
            'hover:bg-bg-elevated/20',
            'hover:bg-bg-elevated/50',
            'hover:bg-bg-elevated/80',
            'hover:bg-bg-subtle',
        ]) {
            expect(isAllowed(token)).toBe(false);
        }
        // Near-miss, and the one loosening a constant gut cannot express: a
        // semantic prefix is honoured on an EXACT match or an `/N` opacity,
        // never as a bare string prefix. HOVER_RE's `[a-z]+` means
        // `hover:bg-bg-errorx` is a token the scanner really can produce, so
        // the `p + '/'` boundary is what stops it riding in on
        // `hover:bg-bg-error`.
        for (const prefix of SEMANTIC_PREFIXES) {
            expect(isAllowed(`${prefix}x`)).toBe(false);
        }
    });

    it('control: the live population is non-empty, and a real token gone off-recipe is refused', () => {
        // The guard's own walk + HOVER_RE live INSIDE its `it()`, where
        // selector-teeth cannot reach them — and where "119 tokens
        // classified" and "zero files opened" are the same green. Re-derive
        // the population here so the main assertion has a denominator.
        const files: string[] = [];
        const collect = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next') continue;
                    collect(full);
                    continue;
                }
                if (/\.tsx$/.test(e.name)) files.push(full);
            }
        };
        collect(path.join(ROOT, 'src'));
        // Measured 2026-09-19: 837 `.tsx` files under `src/`, 69 carrying a
        // hover token after the same comment-strip the guard applies, 119
        // occurrences. The floors sit far below, so ordinary feature PRs
        // never move them.
        expect(files.length).toBeGreaterThan(400);

        const tokens: string[] = [];
        const carriers: string[] = [];
        for (const file of files) {
            const stripped = fs
                .readFileSync(file, 'utf-8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            const matches = stripped.match(HOVER_RE);
            if (!matches) continue;
            tokens.push(...matches);
            carriers.push(path.relative(ROOT, file).split(path.sep).join('/'));
        }
        expect(tokens.length).toBeGreaterThan(50);
        // RECURSION — the one behaviour a constant return cannot express.
        // Both trees the tokens live in must be reached (measured: 26
        // carriers under src/app, 43 under src/components), and the deepest
        // sit six segments down.
        expect(carriers.some((c) => c.startsWith('src/app/'))).toBe(true);
        expect(carriers.some((c) => c.startsWith('src/components/'))).toBe(true);
        // The call site the guard actually makes, over real input. A failure
        // here means the same thing as the main test failing.
        expect(tokens.every((t) => isAllowed(t))).toBe(true);

        // POSITIVE CONTROL, manufactured from real product source. No file
        // under `src/` matches the banned pattern today — that is what this
        // ratchet has achieved — and there is no exemption list to derive
        // one from, so the offending input is built by mutating a stem the
        // product genuinely ships: a live canonical muted token plus the
        // off-recipe `/40` opacity the docblock records (3 sites, migrated).
        // Derived, so it cannot go stale if that recipe is ever renamed.
        const liveStem = tokens.find(
            (t) => CANONICAL_MUTED.has(t) && !t.includes('/'),
        );
        expect(liveStem).toBe('hover:bg-bg-muted');
        const offRecipe = `${liveStem}/40`;
        // The scanner really would produce this token …
        expect(offRecipe.match(HOVER_RE)).toEqual([offRecipe]);
        // … and the classifier really does refuse it.
        expect(isAllowed(offRecipe)).toBe(false);
    });
    it('no .tsx file under src/ uses an off-recipe hover:bg-bg-* token', () => {
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
                    const matches = line.match(HOVER_RE);
                    if (!matches) return;
                    for (const token of matches) {
                        if (!isAllowed(token)) {
                            offenders.push({
                                file: rel,
                                line: i + 1,
                                token,
                                snippet: line.trim().slice(0, 200),
                            });
                        }
                    }
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line} — ${o.token}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `Off-recipe hover:bg-bg-* tones detected. The product converges on TWO recipes — hover:bg-bg-muted/50 (row/card) and hover:bg-bg-muted (click target) — plus semantic-state hovers (error / success / info / emphasis / warning / attention):\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

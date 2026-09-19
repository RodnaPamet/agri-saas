/**
 * Polish PR-3 — Card-pretender eradication ratchet.
 *
 * The Card primitive at `src/components/ui/card.tsx` defines a real
 * elevation model (flat / inset / raised / floating) and density
 * (comfortable / compact / none). Until this PR five components
 * hand-rolled `<div className="rounded-lg border border-border-
 * default bg-bg-subtle p-4">` — they're cards in everything but
 * type. Every drift is a small lie about design-system
 * completeness.
 *
 * What this ratchet detects
 *   The literal substring
 *     `rounded-lg border border-border-default bg-bg-subtle`
 *   anywhere in the codebase OUTSIDE `src/components/ui/card.tsx`
 *   (the primitive that owns this recipe) and the design-system
 *   docs file.
 *
 * Why this exact substring
 *   That's the recipe the primitive uses for `elevation="inset"`.
 *   Hand-rolling the same className proves a consumer should be
 *   reaching for `<Card elevation="inset">` instead.
 *
 * What this ratchet does NOT police
 *   - `rounded-md` / `rounded` (different radius — chips, banners).
 *   - `bg-bg-default` / `bg-bg-error/10` / `bg-bg-muted/20`
 *     (different surfaces — alerts, banners, filter chips).
 *   - Any combination missing the full `rounded-lg + border-default
 *     + bg-bg-subtle` triple. Surface treatments outside the inset
 *     plane are intentionally not card-pretenders.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/app', 'src/components'];

const EXEMPT_FILES = new Set<string>([
    // The primitive owns this recipe.
    'src/components/ui/card.tsx',
    // Roadmap-5 hotfix — the cva definition lives in a server-safe
    // sibling so non-`"use client"` callers (server components) can
    // import + call it. The recipe text moved from card.tsx to here.
    'src/components/ui/card-variants.ts',
]);

const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

const PATTERN_RE =
    /rounded-lg\s+border\s+border-border-default\s+bg-bg-subtle/;

interface Hit {
    file: string;
    line: number;
    text: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full);
        if (EXEMPT_FILES.has(rel)) continue;
        if (entry.name === 'node_modules') continue;
        if (entry.name.startsWith('__')) continue;
        if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe('Card-pretender eradication (Polish PR-3)', () => {
    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `walk` and every empty return SURVIVED —
    // `[]`, `''`, `new Set()` and `new Map()` are each zero-length or an
    // empty iterable, so the `for (const file of walk(...))` loop below
    // runs zero times, `offenders` stays empty, and
    // `expect(offenders).toHaveLength(0)` passes having opened no file.
    // "Scanned 1,270 files, found no pretender" and "scanned nothing"
    // were the same green.
    //
    // The `fs.existsSync` throw inside `walk` does not cover this: it
    // catches a RENAMED root (#875), never a real root that yields
    // nothing. Nor does the exempt-list test below — it never calls
    // `walk`, so it is green under all four guts too.
    //
    // Two controls, because the population and the detector fail
    // independently.

    it('control: `walk` returns the real tree, minus exactly what it exempts', () => {
        const walked = new Map<string, string[]>();
        for (const dir of SCAN_DIRS) {
            const files = walk(path.join(ROOT, dir));
            // Kills `''` / `new Set()` / `new Map()` at the seam rather
            // than letting them read as a zero-length scan.
            expect(Array.isArray(files)).toBe(true);
            // Measured 2026-09-19: src/app 584, src/components 686. The
            // floor sits far below both, so feature PRs never move it —
            // and it is PER ROOT, because one root going dark is
            // invisible in a combined total.
            expect(files.length).toBeGreaterThan(100);
            walked.set(dir, files);
        }

        const rels = SCAN_DIRS.flatMap((dir) => walked.get(dir) ?? []).map(
            (f) => path.relative(ROOT, f),
        );
        expect(rels.filter((r) => r.startsWith('..'))).toEqual([]);
        expect(rels.filter((r) => !/\.(tsx|ts|jsx|js)$/.test(r))).toEqual([]);
        expect(
            rels.filter((r) => r.split(path.sep).includes('node_modules')),
        ).toEqual([]);
        // `src/components/ui/hooks/__tests__/` exists, so this exclusion
        // is exercised by the real tree and not only by the probe below.
        expect(
            rels.filter((r) =>
                r.split(path.sep).some((s) => s.startsWith('__')),
            ),
        ).toEqual([]);

        // The exemptions must BITE, and `card-variants.ts` is why that
        // matters: it is the ONE file in the repo carrying the banned
        // recipe verbatim (`inset:` in the cva). So it doubles as the
        // positive control this guard otherwise lacks — the detector is
        // proved against real product source, and a `walk` that stopped
        // honouring EXEMPT_FILES would report the primitive itself.
        for (const rel of EXEMPT_FILES) {
            expect(fs.existsSync(path.resolve(ROOT, rel))).toBe(true);
            expect(rels).not.toContain(rel);
        }
        expect(
            PATTERN_RE.test(
                fs.readFileSync(
                    path.resolve(ROOT, 'src/components/ui/card-variants.ts'),
                    'utf8',
                ),
            ),
        ).toBe(true);
    });

    it('control: a planted pretender is found; the near-misses and skipped paths are not', () => {
        const RECIPE =
            '<div className="rounded-lg border border-border-default bg-bg-subtle p-4">';
        // The three shapes this ratchet's docblock says it does NOT
        // police. If any matched, the "not policed" contract is a lie.
        const NEAR_MISSES = [
            '<div className="rounded-md border border-border-default bg-bg-subtle p-4">',
            '<div className="rounded-lg border border-border-subtle bg-bg-subtle p-4">',
            '<div className="rounded-lg border border-border-default bg-bg-default p-4">',
        ].join('\n');

        const probeRoot = fs.mkdtempSync(
            path.join(
                fs.realpathSync(process.env.TMPDIR || '/tmp'),
                'card-pretender-probe-',
            ),
        );
        try {
            const write = (rel: string, body: string): void => {
                const full = path.join(probeRoot, rel);
                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, body, 'utf8');
            };
            // `nested/` is load-bearing: it requires RECURSION, which is
            // the plausible-but-partial mutation the gut set cannot express.
            write('nested/Pretender.tsx', RECIPE);
            write('nested/Clean.tsx', NEAR_MISSES);
            // The next four carry the SAME recipe and must be filtered
            // out — one per rule inside `walk`.
            write('Pretender.test.tsx', RECIPE); // EXEMPT_FILE_PATTERNS
            write('__mocks__/Pretender.tsx', RECIPE); // `__`-prefixed dir
            write('node_modules/dep/Pretender.tsx', RECIPE); // node_modules
            write('nested/notes.md', RECIPE); // not a scanned extension

            const found = walk(probeRoot)
                .map((f) => path.relative(probeRoot, f))
                .sort();
            expect(found).toEqual([
                path.join('nested', 'Clean.tsx'),
                path.join('nested', 'Pretender.tsx'),
            ]);

            // …and the detector separates those two: exactly one
            // offender, scanned the way the ratchet below scans.
            const offenders = walk(probeRoot).filter((f) =>
                fs
                    .readFileSync(f, 'utf8')
                    .split('\n')
                    .some((line) => PATTERN_RE.test(line)),
            );
            expect(offenders.map((f) => path.basename(f))).toEqual([
                'Pretender.tsx',
            ]);
        } finally {
            fs.rmSync(probeRoot, { recursive: true, force: true });
        }
    });

    it('zero hand-rolled `rounded-lg border border-border-default bg-bg-subtle` outside the Card primitive', () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, 'utf8');
                const lines = content.split('\n');
                lines.forEach((line, i) => {
                    const trimmed = line.trim();
                    if (
                        trimmed.startsWith('//') ||
                        trimmed.startsWith('*')
                    )
                        return;
                    if (PATTERN_RE.test(line)) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            line: i + 1,
                            text: trimmed.slice(0, 200),
                        });
                    }
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} card-pretender(s).\n\nThe pattern \`rounded-lg border border-border-default bg-bg-subtle\` is owned by \`<Card elevation="inset">\`. Replace the hand-rolled <div> with the primitive.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('exempt list is bounded and every entry exists', () => {
        for (const rel of EXEMPT_FILES) {
            const abs = path.resolve(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
        }
        expect(EXEMPT_FILES.size).toBeLessThanOrEqual(2);
    });
});

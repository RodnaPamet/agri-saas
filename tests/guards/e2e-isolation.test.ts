/**
 * E2E cross-test `let` cascade ratchet.
 *
 * The anti-pattern this guard bans:
 *
 *   ```ts
 *   let resourceId: string;           // ← module / describe-scoped `let`
 *
 *   test('A creates it', async () => {
 *       resourceId = await createThing();   // ← ASSIGNED inside one test()
 *   });
 *   test('B uses it', async () => {
 *       await page.goto(`/things/${resourceId}`);  // ← READ inside another test()
 *   });
 *   ```
 *
 * When test A fails, `resourceId` is left undefined and test B —
 * plus every later test that reads it — cascades into failure. The
 * file's serial mode makes this *look* ordered but it is NOT
 * isolation: one broken setup step poisons the rest of the file.
 *
 * The fix landed alongside this guard (PR `chore/e2e-isolation`):
 *   - read-only specs keep the shared seeded tenant;
 *   - mutating specs provision a per-test isolated tenant via the
 *     `isolatedTenant` fixture in `tests/e2e/fixtures.ts`;
 *   - a resource a test needs is created INSIDE that test (or in a
 *     `beforeEach`), or — when the steps are genuinely one
 *     scenario — collapsed into a single `test()` with
 *     `test.step(...)` sub-steps.
 *
 * This ratchet scans every `tests/e2e/*.spec.ts` and FAILS if a
 * top-level mutable binding is written inside one `test()` body and
 * read inside a different `test()` body. `BASELINE` carries any
 * file that legitimately still does this (empty today — the PR
 * cleared every known case); a future regression that re-introduces
 * the pattern fails CI. The list is a downward ratchet: when a file
 * is fixed it must be removed from `BASELINE` in the same diff.
 *
 * Modelled on `tests/guards/no-legacy-peer-deps.test.ts` — pure
 * static analysis, no DB, no Playwright runtime.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const E2E_DIR = path.resolve(__dirname, '..', 'e2e');

/**
 * Files that legitimately still carry a cross-test `let` cascade,
 * each with a written reason. EMPTY — the `chore/e2e-isolation` PR
 * cleared every known case. Adding an entry here is a downward
 * ratchet violation unless paired with a concrete, reviewed reason;
 * removing one when the file is fixed is mandatory.
 */
const BASELINE: ReadonlyArray<{ file: string; reason: string }> = [];

/** All E2E spec files. */
function specFiles(): string[] {
    return fs
        .readdirSync(E2E_DIR)
        .filter((f) => f.endsWith('.spec.ts'))
        .sort();
}

/**
 * Strip line + block comments and string/template literals so the
 * identifier scan never trips on text inside a comment or a string.
 * Crude but sufficient for the structural question being asked.
 */
function stripNoise(src: string): string {
    return src
        // block comments
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        // line comments
        .replace(/\/\/[^\n]*/g, ' ')
        // template literals (keep `${}` interpolations would be ideal,
        // but for this guard treating the whole literal as blank is
        // safe — we only care about top-level `let` identifiers, which
        // never live inside a template literal)
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
        // double / single quoted strings
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/**
 * Find the `{ … }` body span for each `test('…', …)` /
 * `test('…', …)` call (also `test.only` / `test.fixme`). Returns an
 * array of `[start, end]` index pairs into `src`. `test.describe`,
 * `test.step`, `beforeEach`, `beforeAll` are intentionally NOT
 * matched — assignment inside a `beforeEach`/`beforeAll` is the
 * CORRECT shared-setup pattern, and `test.step` runs inside its
 * parent `test()` so it shares that test's isolation.
 */
function testBodySpans(src: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    // Match `test(` or `test.only(` / `test.fixme(` — but NOT
    // `test.describe(` / `test.step(` / `test.beforeEach(` etc.
    const callRe = /\btest(?:\.(?:only|fixme|skip))?\s*\(/g;
    // The loop body uses `callRe.lastIndex` (cursor position) rather
    // than the match-result groups, so we don't bind the result.
    while (callRe.exec(src) !== null) {
        // Walk forward to the first `{` that opens the callback body,
        // then brace-match to its close.
        let i = callRe.lastIndex;
        // Find the `=> {` or `function … {` opening brace.
        let depthParen = 1; // we're inside the `test(` paren
        let openBrace = -1;
        for (; i < src.length; i++) {
            const c = src[i];
            if (c === '(') depthParen++;
            else if (c === ')') {
                depthParen--;
                if (depthParen === 0) break; // `test(...)` with no body brace
            } else if (c === '{' && depthParen === 1) {
                openBrace = i;
                break;
            }
        }
        if (openBrace === -1) continue;
        // Brace-match from openBrace.
        let depth = 0;
        let end = -1;
        for (let j = openBrace; j < src.length; j++) {
            const c = src[j];
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) {
                    end = j;
                    break;
                }
            }
        }
        if (end !== -1) spans.push([openBrace, end]);
    }
    return spans;
}

/**
 * Top-level (module- or describe-scoped) mutable bindings — every
 * `let`/`var` identifier that is NOT declared inside a `test()`
 * body. `const` is excluded: a `const` cannot be reassigned inside
 * a test, so it can never carry a cross-test cascade.
 */
function topLevelMutableBindings(
    src: string,
    spans: Array<[number, number]>,
): string[] {
    const inTest = (idx: number) =>
        spans.some(([s, e]) => idx > s && idx < e);
    const names = new Set<string>();
    const declRe = /\b(?:let|var)\s+([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(src)) !== null) {
        if (!inTest(m.index)) names.add(m[1]);
    }
    return [...names];
}

/**
 * For a given binding name, does ANY `test()` body ASSIGN it
 * (`name =`, `name +=`, …) and does a DIFFERENT `test()` body READ
 * it? Returns the cascade detail if so.
 */
function detectCascade(
    name: string,
    src: string,
    spans: Array<[number, number]>,
): { assignedIn: number; readIn: number } | null {
    // Word-boundaried identifier occurrences.
    const idRe = new RegExp(`\\b${name}\\b`, 'g');
    // An assignment is `name` followed by `=` that is NOT `==`,
    // `===`, `<=`, `>=`, `!=` and not part of `=>`.
    const assignSpans: number[] = [];
    const readSpans: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(src)) !== null) {
        const idx = m.index;
        const spanIdx = spans.findIndex(([s, e]) => idx > s && idx < e);
        if (spanIdx === -1) continue; // occurrence outside any test()
        // Look at what follows (skip whitespace).
        let k = idRe.lastIndex;
        while (k < src.length && /\s/.test(src[k])) k++;
        const next = src[k];
        const next2 = src.slice(k, k + 2);
        const isAssign =
            next === '=' &&
            next2 !== '==' &&
            src[k + 1] !== '=' &&
            // not `name =>` (param)
            true;
        const isCompound =
            next2 === '+=' ||
            next2 === '-=' ||
            next2 === '*=' ||
            next2 === '?=';
        if (isAssign || isCompound) {
            assignSpans.push(spanIdx);
        } else {
            readSpans.push(spanIdx);
        }
    }
    if (assignSpans.length === 0 || readSpans.length === 0) return null;
    // Cascade = assigned in one test span, read in a DIFFERENT span.
    for (const a of assignSpans) {
        for (const r of readSpans) {
            if (a !== r) return { assignedIn: a, readIn: r };
        }
    }
    return null;
}

interface Offender {
    file: string;
    binding: string;
}

function scan(): Offender[] {
    const offenders: Offender[] = [];
    for (const file of specFiles()) {
        const raw = fs.readFileSync(path.join(E2E_DIR, file), 'utf8');
        const src = stripNoise(raw);
        const spans = testBodySpans(src);
        if (spans.length < 2) continue; // need ≥2 tests to cascade
        for (const binding of topLevelMutableBindings(src, spans)) {
            if (detectCascade(binding, src, spans)) {
                offenders.push({ file, binding });
            }
        }
    }
    return offenders;
}

describe('E2E test isolation — no cross-test `let` cascade', () => {
    const offenders = scan();
    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `specFiles()` and nothing went red. The seam
    // is `for (const file of specFiles())` inside `scan()`: the five
    // non-iterable guts (0, false, null, undefined, {}) throw at the
    // for-of — and since `scan()` runs in the describe BODY that throw
    // takes the whole file down, loudly. The four that survive — [], '',
    // new Set(), new Map() — all iterate zero times, and an empty corpus
    // yields exactly the `offenders: []` the real 47-file corpus yields.
    // Nothing here measured the population, so "scanned 47 specs, found
    // nothing" and "scanned nothing" were the same green.
    //
    // That is the #865 empty-selection defect. This file is still listed in
    // HAND_ROLLED_COLLECTORS in
    // tests/guards/file-collection-is-not-silently-empty.test.ts, which
    // RECORDS the class rather than asserting on it, and specFiles() has
    // not moved onto the shared collector helper (which refuses an empty
    // result). Until it does, these two assert it here.
    it('control: specFiles() selects the whole real top-level spec corpus (#971)', () => {
        const scanned = specFiles();

        // Derived independently of the helper, so a gutted specFiles() has a
        // contradicting number standing next to it rather than a floor it
        // also satisfies.
        const independent = fs
            .readdirSync(E2E_DIR, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith('.spec.ts'))
            .map((e) => e.name)
            .sort();

        // Measured 2026-09-19: 47 top-level spec files. The floor sits far
        // below that — it is here to catch E2E_DIR resolving somewhere with
        // no specs in it, the one case where both sides agree on empty.
        expect(independent.length).toBeGreaterThanOrEqual(20);
        expect(scanned).toEqual(independent);
        for (const file of scanned) {
            expect(fs.statSync(path.join(E2E_DIR, file)).isFile()).toBe(true);
        }

        // The `.spec.ts` filter is doing real work: the same directory holds
        // the fixtures and helpers every spec imports, and selecting those
        // would feed non-spec source to the cascade detector.
        const everything = fs.readdirSync(E2E_DIR);
        expect(everything).toContain('fixtures.ts');
        expect(everything).toContain('e2e-utils.ts');
        expect(scanned).not.toContain('fixtures.ts');
        expect(scanned).not.toContain('e2e-utils.ts');
    });

    it('control: the only spec files this ratchet skips are NESTED ones (#971)', () => {
        const walk = (dir: string, acc: string[]): string[] => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full, acc);
                else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
                    acc.push(path.relative(E2E_DIR, full));
                }
            }
            return acc;
        };

        const everySpec = walk(E2E_DIR, []);
        const scanned = new Set(specFiles());
        const unscanned = everySpec.filter((rel) => !scanned.has(rel));

        // `readdirSync` is not recursive, so the population this ratchet
        // judges is the TOP LEVEL only. Measured 2026-09-19: 61 spec files
        // exist, 47 are scanned, and the 14 outside are tests/e2e/mobile (13)
        // + tests/e2e/security (1) — five of which declare a top-level `let`
        // the cascade detector has never looked at. No gut can surface this:
        // every gut in the harness SHRINKS the population, and the direction
        // that hurts here is a population that is non-empty but incomplete.
        expect(everySpec.length).toBeGreaterThanOrEqual(scanned.size);
        for (const rel of unscanned) {
            expect(rel.includes(path.sep)).toBe(true);
        }
        // Bounded so the blind spot cannot grow unnoticed. It may only
        // shrink — making the walk recursive takes it to zero.
        expect(unscanned.length).toBeLessThanOrEqual(20);
    });

    it('no spec assigns a top-level `let`/`var` in one test and reads it in another', () => {
        const baselineFiles = new Set(BASELINE.map((b) => b.file));
        const unexpected = offenders.filter((o) => !baselineFiles.has(o.file));
        if (unexpected.length > 0) {
            const detail = unexpected
                .map((o) => `  ${o.file}: binding \`${o.binding}\``)
                .join('\n');
            throw new Error(
                `Cross-test \`let\` cascade detected — a resource created in one ` +
                    `test() is read by another, so a failed setup step cascades.\n` +
                    `Fix: create the resource inside the test that needs it (or a ` +
                    `beforeEach), or collapse the sequence into one test() with ` +
                    `test.step(...). See tests/e2e/fixtures.ts.\n${detail}`,
            );
        }
        expect(unexpected).toEqual([]);
    });

    it('BASELINE has no stale entries (every listed file still offends)', () => {
        const offendingFiles = new Set(offenders.map((o) => o.file));
        const stale = BASELINE.filter((b) => !offendingFiles.has(b.file));
        if (stale.length > 0) {
            throw new Error(
                `BASELINE lists files that no longer offend — delete them: ` +
                    stale.map((s) => s.file).join(', '),
            );
        }
        expect(stale).toEqual([]);
    });

    it('the isolation fixture module exists and exports the `isolatedTenant` fixture', () => {
        const fixturesPath = path.join(E2E_DIR, 'fixtures.ts');
        expect(fs.existsSync(fixturesPath)).toBe(true);
        const fixturesSrc = fs.readFileSync(fixturesPath, 'utf8');
        // The fixture must be wired via `base.extend` and expose
        // `isolatedTenant`. These two anchors are load-bearing.
        expect(fixturesSrc).toMatch(/base\.extend</);
        expect(fixturesSrc).toMatch(/isolatedTenant:/);
    });

    // ── Control (#971) ───────────────────────────────────────────────
    //
    // `selector-teeth` gutted `scan()` to a constant and nothing went red.
    // Read that as a FAILED PROBE, not a hole found: `scan()` genuinely
    // returns [] today — BASELINE is empty and no spec offends — so `[]`
    // reproduces the true value and is not a mutation at all. The seam is
    // `offenders.filter(...)` / `offenders.map(...)`, and the other eight
    // guts (0, false, null, undefined, {}, '', Set, Map) have no `.filter`,
    // so they throw inside the two tests above. One of nine survived.
    //
    // No assertion at this call site can show whether that empty is EARNED:
    // the only thing that reddens a gutted `scan()` is a real offending
    // spec ON DISK, and planting one under tests/e2e mid-run would hand
    // every sibling guard that walks that directory a transient file. So
    // this control re-runs scan()'s own chain over the same corpus and
    // asserts what it had to DO — a real count of files, test spans and
    // candidate bindings, each one CLEARED by detectCascade — plus the same
    // chain flagging a cascade planted into real spec source.
    it('control: `offenders` is an EARNED empty — the chain judged a real population (#971)', () => {
        let totalSpans = 0;
        let filesWithTwoTests = 0;
        const blind: string[] = [];
        const candidates: {
            file: string;
            raw: string;
            src: string;
            spans: Array<[number, number]>;
            bindings: string[];
        }[] = [];

        for (const file of specFiles()) {
            const raw = fs.readFileSync(path.join(E2E_DIR, file), 'utf8');
            const src = stripNoise(raw);
            const spans = testBodySpans(src);
            totalSpans += spans.length;
            if (spans.length === 0) blind.push(file);
            if (spans.length < 2) continue;
            filesWithTwoTests++;
            const bindings = topLevelMutableBindings(src, spans);
            if (bindings.length > 0) {
                candidates.push({ file, raw, src, spans, bindings });
            }
        }

        // Measured 2026-09-19: 113 test spans across 47 specs, 21 files with
        // >= 2 tests, 6 files carrying 7 top-level mutable bindings. Floors
        // sit far below, so ordinary churn never trips them.
        expect(totalSpans).toBeGreaterThanOrEqual(40);
        expect(filesWithTwoTests).toBeGreaterThanOrEqual(8);
        expect(candidates.length).toBeGreaterThanOrEqual(3);
        expect(
            candidates.reduce((n, c) => n + c.bindings.length, 0),
        ).toBeGreaterThanOrEqual(3);

        // A spec the chain finds NO tests in is invisible to this ratchet.
        // Measured 2026-09-19: exactly one — asset-evidence.spec.ts, which
        // holds five test() calls the chain cannot see. stripNoise strips
        // line comments BEFORE strings, so the `//` inside
        // 'https://example.com/evidence-doc' eats the rest of the line
        // including the closing apostrophe; the file is left with an odd
        // number of apostrophes and the single-quote pass then mis-pairs
        // across everything after it (test( count through the passes:
        // 6 -> 5 -> 5 -> 5 -> 0). Recorded so it cannot spread; may only
        // shrink.
        expect(blind.length).toBeLessThanOrEqual(1);

        // Each candidate binding is one detectCascade had to JUDGE — and
        // cleared. That is what makes the [] at the call site mean anything.
        for (const c of candidates) {
            for (const name of c.bindings) {
                expect(detectCascade(name, c.src, c.spans)).toBeNull();
            }
        }

        // ...and the same chain, on that same REAL source plus one cascade
        // planted on the file's OWN binding, flags it. Derived from the
        // corpus rather than a fixture, so it cannot go stale.
        for (const c of candidates) {
            const name = c.bindings[0];
            const planted = stripNoise(
                `${c.raw}\n` +
                    `test('planted writer', async () => { ${name} = 'planted'; });\n` +
                    `test('planted reader', async () => { expect(${name}).toBe('planted'); });\n`,
            );
            const plantedSpans = testBodySpans(planted);
            expect(plantedSpans.length).toBe(c.spans.length + 2);
            expect(topLevelMutableBindings(planted, plantedSpans)).toContain(name);
            expect(detectCascade(name, planted, plantedSpans)).not.toBeNull();
        }

        // Tie it back to the value the tests above actually consume:
        // `offenders` must be an array, and every entry must be a binding
        // this re-run also saw. A guard whose offenders do not correspond to
        // its own population is reporting on something else.
        expect(Array.isArray(offenders)).toBe(true);
        for (const o of offenders) {
            expect(
                candidates.some(
                    (c) => c.file === o.file && c.bindings.includes(o.binding),
                ),
            ).toBe(true);
        }
    });

    // In-file regression proof: the detector must catch the pattern.
    it('regression proof — the detector flags a synthetic cascade', () => {
        const synthetic = `
            import { test, expect } from './fixtures';
            let sharedId = '';
            test('creates', async () => { sharedId = 'abc'; });
            test('reads', async () => { expect(sharedId).toBe('abc'); });
        `;
        const src = stripNoise(synthetic);
        const spans = testBodySpans(src);
        expect(spans.length).toBe(2);
        const bindings = topLevelMutableBindings(src, spans);
        expect(bindings).toContain('sharedId');
        expect(detectCascade('sharedId', src, spans)).not.toBeNull();
    });

    it('regression proof — the detector does NOT flag a self-contained test', () => {
        // A `let` assigned AND read inside the SAME test() is fine —
        // not a cross-test cascade.
        const ok = `
            import { test, expect } from './fixtures';
            test('self-contained', async () => {
                let localId = '';
                localId = 'abc';
                expect(localId).toBe('abc');
            });
            test('also self-contained', async () => {
                let other = 1;
                other = 2;
                expect(other).toBe(2);
            });
        `;
        const src = stripNoise(ok);
        const spans = testBodySpans(src);
        // `localId` / `other` are declared INSIDE test bodies, so they
        // are not top-level bindings at all.
        const bindings = topLevelMutableBindings(src, spans);
        expect(bindings).not.toContain('localId');
        expect(bindings).not.toContain('other');
    });

    it('regression proof — a top-level `let` set in beforeEach is NOT a cascade', () => {
        // Assignment inside beforeEach is the correct shared-setup
        // pattern; the detector only scans `test()` bodies.
        const ok = `
            import { test, expect } from '@playwright/test';
            let slug = '';
            test.beforeEach(async () => { slug = 'acme'; });
            test('a', async () => { expect(slug).toBe('acme'); });
            test('b', async () => { expect(slug).toBe('acme'); });
        `;
        const src = stripNoise(ok);
        const spans = testBodySpans(src);
        // `slug` is read in both test()s but assigned only in
        // beforeEach (outside any test span) → no cascade.
        expect(detectCascade('slug', src, spans)).toBeNull();
    });
});

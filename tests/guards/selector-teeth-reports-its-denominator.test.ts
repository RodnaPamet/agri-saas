/**
 * The mutation harness must say when it audited NOTHING (#865).
 *
 * `scripts/selector-teeth.mjs` finds dead selectors by gutting each
 * module-level function and checking whether anything notices. It deliberately
 * never mutates functions declared inside `it()` / `describe()` — those are
 * assertions, and mutating them produces noise.
 *
 * The consequence went unnoticed: a guard that does its selecting INLINE inside
 * `it()` offers nothing to gut, and the tool printed `all selectors have teeth`
 * for it. "Every selector was killed" and "there was nothing to kill" were the
 * same sentence.
 *
 * That is the defect the tool exists to find, one level up — an empty selection
 * reading as a pass — and it was not rare. So `auditFile` now returns
 * `candidates`, the denominator, and the CLI reports `NOT AUDITED` when it is
 * zero. This file pins both halves.
 *
 * ## The population is COMPUTED below, not quoted here
 *
 * This docblock used to carry the figure:
 *
 *     617  guard + guardrail files      (at df269cddc)
 *     429  have module-level selectors
 *     188  have NONE
 *
 * By 2026-10-27 the real numbers were **829 / 614 / 215**, and nothing had
 * noticed, because the figure lived in a comment and comments do not re-measure
 * themselves. A quoted measurement rots exactly this way — see
 * `a-number-that-does-not-move`.
 *
 * So the last test in this file derives it and PRINTS it on every run. The point
 * is reporting, not ratcheting: it deliberately does not fail when the count
 * grows, because deciding what to do about 215 unauditable guards (#2423) needs
 * the number in front of someone first, and a floor chosen before that
 * conversation would be a number nobody chose.
 *
 * Every assertion here drives the REAL tool — `selectorsIn` for the count, and
 * the CLI itself for the message. A test that restated the rule in its own
 * words would pass while the tool said whatever it liked.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(__dirname, '../..');
const TOOL = path.join(ROOT, 'scripts/selector-teeth.mjs');

/**
 * Read the tool's own `selectorsIn` through a real node process.
 *
 * A direct `import()` cannot work here: ts-jest compiles this file to CJS and
 * rewrites the dynamic import to `require()`, which throws
 * `Cannot use import statement outside a module` against a `.mjs`. Spawning
 * node runs the ACTUAL module the CLI runs, which is the point — a
 * reimplementation of the rule in this file would pass while the tool did
 * something else.
 */
function selectorNamesOf(fileRel: string): string[] {
    const script =
        `import { selectorsIn } from ${JSON.stringify(pathToFileURL(TOOL).href)};` +
        `import { readFileSync } from 'node:fs';` +
        `const src = readFileSync(process.argv[1], 'utf8');` +
        `console.log(JSON.stringify(selectorsIn(src).map((s) => s.name)));`;
    const out = execFileSync('node', ['--input-type=module', '-e', script, path.resolve(ROOT, fileRel)], {
        cwd: ROOT,
        encoding: 'utf-8',
    });
    return JSON.parse(out.trim()) as string[];
}

/**
 * Same, for a snippet held in memory.
 *
 * The source travels as a base64 ARGV value, not through a temp file. An
 * earlier version wrote to a predictable path under `os.tmpdir()`, which
 * CodeQL correctly flagged as `js/insecure-temporary-file` — a world-writable
 * directory plus a guessable name is a symlink swap waiting to happen. Passing
 * the bytes as data removes the file rather than hardening it, and base64
 * keeps the payload out of shell-quoting territory entirely.
 */
function selectorNamesOfSource(src: string): string[] {
    const script =
        `import { selectorsIn } from ${JSON.stringify(pathToFileURL(TOOL).href)};` +
        `const src = Buffer.from(process.argv[1], 'base64').toString('utf8');` +
        `console.log(JSON.stringify(selectorsIn(src).map((s) => s.name)));`;
    const out = execFileSync(
        'node',
        ['--input-type=module', '-e', script, Buffer.from(src, 'utf8').toString('base64')],
        { cwd: ROOT, encoding: 'utf-8' },
    );
    return JSON.parse(out.trim()) as string[];
}

/** Call the tool's own `formatReport` in a real node process, as with selectorsIn. */
function formatReport(payload: unknown, asJson: boolean): string {
    const script =
        `import { formatReport } from ${JSON.stringify(pathToFileURL(TOOL).href)};` +
        `const p = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));` +
        `process.stdout.write(formatReport(p, process.argv[2] === 'json'));`;
    return execFileSync(
        'node',
        [
            '--input-type=module',
            '-e',
            script,
            Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
            asJson ? 'json' : 'text',
        ],
        { cwd: ROOT, encoding: 'utf-8' },
    );
}

function runTool(fixture: string): string {
    // Zero-candidate files return immediately — no jest run happens — so this
    // costs nothing. Never point it at a file WITH candidates: that is one
    // jest invocation per gut.
    return execFileSync('node', [TOOL, fixture], { cwd: ROOT, encoding: 'utf-8' });
}

describe('selectorsIn — the denominator', () => {
    it('counts a module-level selector', () => {
        const src = [
            'export function pick(xs: string[]) {',
            '    return xs.filter((x) => x.startsWith("BAD_"));',
            '}',
            'describe("d", () => { it("t", () => { expect(pick([])).toEqual([]); }); });',
        ].join('\n');
        expect(selectorNamesOfSource(src)).toEqual(['pick']);
    });

    it('counts ZERO when the selecting happens inline inside it()', () => {
        // The blind spot, stated as a value rather than as prose. This is what
        // the tool must not describe as "all selectors have teeth".
        const src = [
            'describe("d", () => {',
            '    it("t", () => {',
            '        const xs = ["a"];',
            '        expect(xs.filter((x) => x.startsWith("BAD_"))).toEqual([]);',
            '    });',
            '});',
        ].join('\n');
        expect(selectorNamesOfSource(src)).toEqual([]);
    });

    it('does not mutate a function declared inside describe()', () => {
        const src = [
            'describe("d", () => {',
            '    function helper() { return []; }',
            '    it("t", () => { expect(helper()).toEqual([]); });',
            '});',
        ].join('\n');
        expect(selectorNamesOfSource(src)).toEqual([]);
    });
});

describe('the CLI distinguishes "audited and clean" from "not audited"', () => {
    const INLINE_ONLY = 'tests/fixtures/selector-teeth-inline-only.test.ts';

    it('says NOT AUDITED for a file it cannot audit', () => {
        const out = runTool(INLINE_ONLY);
        expect(out).toMatch(/NOT AUDITED/);
        expect(out).toMatch(/no module-level selectors/);
    });

    it('does NOT claim the selectors have teeth', () => {
        // The regression. Before `candidates`, this exact invocation printed
        // "all selectors have teeth" — which is why the sweep that found this
        // recorded two files as clean in zero seconds.
        expect(runTool(INLINE_ONLY)).not.toMatch(/have teeth/);
    });

    it('CONTROL: the fixture really does have no module-level selectors', () => {
        // Otherwise the two assertions above could be passing because the
        // fixture drifted, not because the tool reports correctly.
        expect(selectorNamesOf(INLINE_ONLY)).toEqual([]);
    });

    it('CONTROL: the toothless fixture DOES have one, so the count discriminates', () => {
        // The other direction. If `selectorsIn` returned [] for everything,
        // every assertion above would pass and mean nothing.
        expect(selectorNamesOf('tests/fixtures/selector-teeth-selftest.test.ts')).toEqual(['pick']);
    });
});

describe('--json emits JSON, especially when there is something to report', () => {
    /**
     * A payload with BOTH kinds of finding. The empty case never reproduced the
     * bug: the prose blocks were skipped, so the document parsed and the mode
     * looked healthy. It broke only once there was news, which is the one time
     * a caller needs it.
     */
    const withFindings = {
        results: [
            {
                file: 'a.test.ts',
                candidates: 1,
                survivors: [{ selector: 'pick', gut: '[]', line: 13 }],
                untestable: [],
            },
        ],
        unexpected: ['a.test.ts:13  pick()'],
        stale: ['b.test.ts  gone()'],
    };

    it('parses as JSON with survivors, unexpected AND stale all non-empty', () => {
        const parsed = JSON.parse(formatReport(withFindings, true));
        expect(parsed.unexpected).toEqual(['a.test.ts:13  pick()']);
        expect(parsed.stale).toEqual(['b.test.ts  gone()']);
        expect(parsed.results[0].candidates).toBe(1);
    });

    it('emits NOTHING after the closing brace', () => {
        // The regression, stated as the shape rather than as a parse. A future
        // append would still parse if it happened to be valid JSON; nothing may
        // follow the document at all.
        const out = formatReport(withFindings, true);
        expect(out.trimEnd().endsWith('}')).toBe(true);
        expect(out).not.toMatch(/NEW dead selectors/);
        expect(out).not.toMatch(/BASELINE ENTRIES/);
    });

    it('CONTROL: text mode still reports both blocks, so nothing was lost', () => {
        // Silencing the prose in BOTH modes would satisfy every assertion above
        // while destroying the human output the CI job prints.
        const out = formatReport(withFindings, false);
        expect(out).toMatch(/NEW dead selectors/);
        expect(out).toMatch(/BASELINE ENTRIES/);
        expect(out).toMatch(/pick\(\)/);
    });

    it('CONTROL: the empty case parsed even before the fix, so it proves nothing alone', () => {
        const empty = { results: [{ file: 'a.test.ts', candidates: 2, survivors: [], untestable: [] }], unexpected: [], stale: [] };
        expect(() => JSON.parse(formatReport(empty, true))).not.toThrow();
    });
});

describe('the RUN reports its own denominator, not just each file (#2423)', () => {
    const mixed = {
        results: [
            { file: 'a.test.ts', candidates: 3, survivors: [], untestable: [] },
            { file: 'b.test.ts', candidates: 0, survivors: [], untestable: [] },
            { file: 'c.test.ts', candidates: 2, survivors: [], untestable: [] },
        ],
        unexpected: [],
        stale: [],
    };

    it('counts audited files, their selectors, and the unreachable remainder', () => {
        const first = formatReport(mixed, false).split('\n')[0];
        expect(first).toMatch(/3 file\(s\)/);
        expect(first).toMatch(/2 audited/);
        expect(first).toMatch(/5 selector\(s\)/);
        expect(first).toMatch(/1 with no module-level selectors/);
    });

    it('the summary leads the report, so it is not buried under per-file lines', () => {
        // With the audit sharded a run is routinely several files. A total that
        // arrives after thirty lines is a total nobody reads.
        expect(formatReport(mixed, false).startsWith('[selector-teeth] ')).toBe(true);
    });

    it('a run where EVERY file is unreachable says so in the summary', () => {
        // The case that previously needed counting: every line says NOT AUDITED
        // and the exit code is 0, so the summary is the only place the shape of
        // the run appears.
        const none = {
            results: [
                { file: 'a.test.ts', candidates: 0, survivors: [], untestable: [] },
                { file: 'b.test.ts', candidates: 0, survivors: [], untestable: [] },
            ],
            unexpected: [],
            stale: [],
        };
        const first = formatReport(none, false).split('\n')[0];
        expect(first).toMatch(/0 audited/);
        expect(first).toMatch(/\(0 selector\(s\)\)/);
        expect(first).toMatch(/2 with no module-level selectors/);
    });

    it('JSON mode is UNCHANGED — the summary is a human line only', () => {
        // The JSON shape is consumed by tooling and pinned elsewhere in this
        // file; adding a key would be a silent contract change.
        const parsed = JSON.parse(formatReport(mixed, true));
        expect(Object.keys(parsed).sort()).toEqual(['results', 'stale', 'unexpected']);
        expect(formatReport(mixed, true).trimEnd().endsWith('}')).toBe(true);
    });
});

describe('what the audit cannot reach, computed rather than quoted (#2423)', () => {
    /**
     * Every guard file's selector count, in ONE node process.
     *
     * One subprocess per file would be ~829 spawns; this hands the list to a
     * single module that imports the tool's real `selectorsIn`. Still the actual
     * function the CLI uses — a reimplementation here would agree with itself
     * and say nothing about the tool.
     */
    function population(): { file: string; selectors: number }[] {
        const script =
            `import { selectorsIn } from ${JSON.stringify(pathToFileURL(TOOL).href)};`
            + `import { readFileSync } from 'node:fs';`
            + `import { execSync } from 'node:child_process';`
            + `const files = execSync("git ls-files 'tests/guards/*.test.ts' 'tests/guardrails/*.test.ts' "`
            + `  + "'tests/contracts/*.test.ts' 'tests/regression/*.test.ts'", { encoding: 'utf8' })`
            + `  .trim().split('\\n').filter(Boolean);`
            + `const rows = files.map((f) => ({ file: f, selectors: selectorsIn(readFileSync(f, 'utf8')).length }));`
            + `console.log(JSON.stringify(rows));`;
        const out = execFileSync('node', ['--input-type=module', '-e', script], {
            cwd: ROOT,
            encoding: 'utf-8',
            maxBuffer: 32 * 1024 * 1024,
        });
        return JSON.parse(out.trim()) as { file: string; selectors: number }[];
    }

    const ROWS = population();

    it('[selector-teeth-reach] prints how much of the guard suite the audit can reach', () => {
        const auditable = ROWS.filter((r) => r.selectors > 0);
        const unreachable = ROWS.filter((r) => r.selectors === 0);
        const selectors = auditable.reduce((a, r) => a + r.selectors, 0);
        const pctUnreachable = ((100 * unreachable.length) / ROWS.length).toFixed(1);

        console.log(
            `[selector-teeth-reach] ${ROWS.length} guard file(s); `
                + `${auditable.length} auditable holding ${selectors} selector(s); `
                + `${unreachable.length} with NO module-level selectors (${pctUnreachable}% unreachable)`,
        );

        // The FLOOR is on the measurement, not on the debt. A `git ls-files`
        // pathspec that stopped matching would report 0 unreachable out of 0
        // files and read as perfect coverage — the empty-population defect this
        // whole file is about, occurring in the thing that measures it.
        expect(ROWS.length).toBeGreaterThanOrEqual(600);
        expect(auditable.length).toBeGreaterThanOrEqual(400);
        expect(selectors).toBeGreaterThanOrEqual(800);

        // And the unreachable set must be NON-EMPTY, which is the uncomfortable
        // half: 215 files have no module-level selectors today, so a zero here
        // means the counting broke rather than that the debt was paid. When it
        // is genuinely paid this assertion is what has to be deleted, and
        // deleting it is a decision somebody makes in a diff.
        expect(unreachable.length).toBeGreaterThan(0);
    });

    it('[selector-teeth-reach] names the unreachable guards whose subject is security or safety', () => {
        // Not a ratchet and not a sample. These are checked by NAME because a
        // vacuous guard here is discovered by the thing it was meant to prevent,
        // and "26% unreachable" does not tell a reader that these are in it.
        const unreachable = new Set(ROWS.filter((r) => r.selectors === 0).map((r) => r.file));
        const WATCH = [
            'tests/guardrails/middleware-security.test.ts',
            'tests/guardrails/jwt-membership-bound.test.ts',
            'tests/guardrails/pii-hash-not-null.test.ts',
            'tests/guardrails/dose-phi-rei-gate.test.ts',
        ];
        const stillUnreachable = WATCH.filter((f) => unreachable.has(f));
        console.log(
            `[selector-teeth-reach] of ${WATCH.length} watched security/safety guards, `
                + `${stillUnreachable.length} are still unauditable: ${stillUnreachable.join(', ') || 'none'}`,
        );

        // Every watched path must EXIST, or this list rots the way the docblock's
        // figure did — a guard renamed away leaves a name nobody is watching and
        // a count that looks like progress.
        const known = new Set(ROWS.map((r) => r.file));
        expect(WATCH.filter((f) => !known.has(f))).toEqual([]);
    });
});

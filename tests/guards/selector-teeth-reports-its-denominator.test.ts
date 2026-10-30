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
 * By 2026-10-27 the real numbers were 829 / 614 / 215, and nothing had noticed,
 * because the figure lived in a comment and comments do not re-measure
 * themselves. A quoted measurement rots exactly this way — see
 * `a-number-that-does-not-move`. **It rotted a second time**: by 2026-10-30 the
 * file count had moved again, which is why no figure is quoted in this prose
 * any more. The only number written down is `UNAUDITABLE_CEILING` below, and it
 * is enforced, so it cannot drift quietly.
 *
 * ## The no-ratchet stance has ended, deliberately
 *
 * This docblock used to say the point was "reporting, not ratcheting", because
 * "a floor chosen before that conversation would be a number nobody chose".
 * That was right, and the conversation has now happened: #2423 put the measured
 * population and the shape distribution in front of the owner, who chose to
 * extend `selectorsIn` to describe level and to floor the remainder. So there is
 * now a ceiling, and it is a number somebody chose.
 *
 * `selectorsIn` was extended in the same change (#2423): a function declared at
 * DESCRIBE level is shared setup and is now audited, while one inside `it()` is
 * an assertion and is still not. That moved 11 files out of the unauditable set
 * — verified additive, zero previously-found selectors lost or moved.
 *
 * Every assertion here drives the REAL tool — `selectorsIn` for the count, and
 * the CLI itself for the message. A test that restated the rule in its own
 * words would pass while the tool said whatever it liked.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The most guard files allowed to have NO auditable selector — #2423.
 *
 * Measured on 2026-10-30 after `selectorsIn` gained describe-level reach, over
 * the SAME four roots the audit itself uses — guards, guardrails, contracts,
 * regression: 839 files, 636 auditable holding 1,498 selectors, **203** with
 * none. The ceiling is that 203, not a round number above it, because slack in
 * a floor is room for the thing it exists to prevent.
 *
 * The four-root population is load-bearing and was got wrong once while writing
 * this: a hand-rolled walk over `tests/guards` + `tests/guardrails` alone gives
 * 827/627/200, and a ceiling of 200 fails immediately against the real 203.
 * Derive the population from `collectSourceFiles` with the audit's own roots,
 * never from a convenient subset.
 *
 * Of those 203, measured on the same population:
 *
 *    28  have a named function but only inside `it()`, reachable only by the
 *        variant this design rejects as noise
 *   175  have NO named function at all — they assert directly, so there is
 *        nothing for a mutation technique to gut and no tool change reaches them
 *
 * Lowering this number therefore means extracting a named selector in those
 * guards, which is the restructuring #2423 names rather than a tool fix. Do not
 * read the ceiling as a backlog the auditor can work off.
 */
const UNAUDITABLE_CEILING = 200;

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

    it('DOES count a function declared at describe() level', () => {
        // CHANGED BY #2423, and the inversion is the point. This used to assert
        // `[]` — the walk stopped at `sourceFile.statements`, so a `describe`-level
        // helper was invisible and a guard whose only selecting happened there was
        // reported NOT AUDITED. Measured at the time: 827 guard files, 211 of them
        // unauditable, and 11 were this exact shape.
        //
        // A describe-level declaration is shared SETUP — the `walk`, the `read`,
        // the thing every `it` in the block asserts over — so gutting it is the
        // question this tool exists to ask. The test below keeps the other half:
        // inside `it()` is an assertion, and that is still not mutated.
        const src = [
            'describe("d", () => {',
            '    function helper() { return []; }',
            '    it("t", () => { expect(helper()).toEqual([]); });',
            '});',
        ].join('\n');
        expect(selectorNamesOfSource(src)).toEqual(['helper']);
    });

    it('still does NOT count a function declared inside it()', () => {
        // The boundary, asserted rather than assumed. #2423 measured the
        // alternative: recursing into `it()` bodies too would have reached 27
        // more files and created 84 mutation targets inside assertions, which
        // the tool's own rationale calls noise. Not taken, so this must stay
        // empty — it is the only thing distinguishing the two designs.
        const src = [
            'describe("d", () => {',
            '    it("t", () => {',
            '        const helper = () => [];',
            '        expect(helper()).toEqual([]);',
            '    });',
            '});',
        ].join('\n');
        expect(selectorNamesOfSource(src)).toEqual([]);
    });

    it('a describe-level selector is found even when nested two blocks deep', () => {
        // `describe` inside `describe` is common in this suite, and a walk that
        // only went one level down would miss it while looking like it worked.
        const src = [
            'describe("outer", () => {',
            '    describe("inner", () => {',
            '        const walk = () => [];',
            '        it("t", () => { expect(walk()).toEqual([]); });',
            '    });',
            '});',
        ].join('\n');
        expect(selectorNamesOfSource(src)).toEqual(['walk']);
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
     * The FILE LIST comes from the shared `collectSourceFiles`, not from a
     * `git ls-files` of its own. That matters twice over: the helper refuses an
     * empty result, which is the property this file is about; and
     * `file-collection-is-not-silently-empty` flagged the first version of this
     * function as a hand-rolled collector, correctly — it had `ls-files` inside
     * the embedded script and imported no helper.
     *
     * The subprocess therefore does only the thing it must: import the tool's
     * real `selectorsIn`. ts-jest rewrites a dynamic import here to `require()`,
     * which throws against a `.mjs`, and a reimplementation of the rule in this
     * file would agree with itself and say nothing about the tool.
     */
    function selectorCounts(files: string[]): { file: string; selectors: number }[] {
        const script =
            `import { selectorsIn } from ${JSON.stringify(pathToFileURL(TOOL).href)};`
            + `import { readFileSync } from 'node:fs';`
            + `const files = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));`
            + `console.log(JSON.stringify(files.map((f) => ({ file: f, selectors: selectorsIn(readFileSync(f, 'utf8')).length }))));`;
        const out = execFileSync(
            'node',
            ['--input-type=module', '-e', script, Buffer.from(JSON.stringify(files), 'utf8').toString('base64')],
            { cwd: ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
        );
        return JSON.parse(out.trim()) as { file: string; selectors: number }[];
    }

    const ROWS = selectorCounts(
        collectSourceFiles({
            roots: ['tests/guards', 'tests/guardrails', 'tests/contracts', 'tests/regression'],
            extensions: ['.test.ts'],
            // The helper throws below this, so the measurement cannot silently
            // range over nothing — which would report 0 unreachable of 0 files.
            floor: 600,
        }).map((abs) => abs.slice(ROOT.length + 1)),
    );

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
        // half: the debt is real today, so a zero here means the counting broke
        // rather than that it was paid. The size lives in
        // `UNAUDITABLE_CEILING`, not in this comment — the figure that used to
        // sit here rotted twice. When the debt is genuinely paid this assertion
        // is what has to be deleted, and deleting it is a decision somebody
        // makes in a diff.
        expect(unreachable.length).toBeGreaterThan(0);

        // THE RATCHET (#2423). The set may shrink freely; it may not grow.
        //
        // A new guard that does all its selecting inline adds a file nothing can
        // audit, and the old `::warning::`-shaped reporting meant that landed
        // green. Lowering this is the expected direction of travel and needs no
        // ceremony beyond the diff; RAISING it is a decision to make the audit
        // reach less of the repo, which should cost an argument.
        if (unreachable.length > UNAUDITABLE_CEILING) {
            throw new Error(
                `${unreachable.length} guard files have no auditable selector, above the `
                    + `ceiling of ${UNAUDITABLE_CEILING}.\n\n`
                    + `A guard whose selecting happens inline inside it() cannot be `
                    + `mutation-audited, so it passes whether or not it selects anything. `
                    + `Extract the selection into a named helper at module or describe `
                    + `level — which is also how it becomes testable — or raise the `
                    + `ceiling in this file with the reason.\n\n`
                    + `new since the ceiling was set:\n`
                    + unreachable
                        .slice(0, 10)
                        .map((f) => `  ${f}`)
                        .join('\n'),
            );
        }
        expect(unreachable.length).toBeLessThanOrEqual(UNAUDITABLE_CEILING);
    });

    it('[selector-teeth-reach] names the unreachable guards whose subject is security or safety', () => {
        // Not a ratchet and not a sample. These are checked by NAME because a
        // vacuous guard here is discovered by the thing it was meant to prevent,
        // and "26% unreachable" does not tell a reader that these are in it.
        const unreachable = new Set(ROWS.filter((r) => r.selectors === 0).map((r) => r.file));
const WATCH = [
            // ── The original four. All reachable now: middleware-security,
            // jwt-membership-bound and dose-phi-rei-gate were extracted in
            // #2493; pii-hash-not-null already had module-level selectors.
            'tests/guardrails/middleware-security.test.ts',
            'tests/guardrails/jwt-membership-bound.test.ts',
            'tests/guardrails/pii-hash-not-null.test.ts',
            'tests/guardrails/dose-phi-rei-gate.test.ts',

            // ── Extended 2026-10-30, because clearing the first four emptied
            // the reading and left #2483's remaining ~197 files with no printed
            // signal to order them by. Ordering by subject beats file order,
            // and this list is what makes that mechanical rather than
            // remembered.
            //
            // Chosen by subject keyword in the PATH, over the 200 guards the
            // tool reports as having no module-level selector. That screen is
            // deliberately conservative and its limit is worth stating: 193 of
            // the 200 carry no subject keyword in their name, so a guard whose
            // subject is security but whose filename is not will be missed.
            // This is a starting point, not a census.
            //
            // (The first attempt at that screen was wrong in both directions —
            // `av-` matched n-AV-item and `token` matched DESIGN tokens — which
            // is why the patterns it came from now anchor on `/` or `-`.)
            'tests/guards/auth-server-gate-coverage.test.ts',
            'tests/guards/auth-surface-tokens.test.ts',
            'tests/guards/mfa-enrolment-is-reachable-while-pending.test.ts',
            'tests/guardrails/route-permissions-uppercase.test.ts',
            'tests/guards/r14-tenant-switcher-discipline.test.ts',
            'tests/guards/rls-coverage-skip-visibility.test.ts',
            'tests/guardrails/audit-s10-field-level-deferral-closure.test.ts',
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

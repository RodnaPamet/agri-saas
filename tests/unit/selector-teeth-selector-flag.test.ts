/**
 * `--selector <name>` narrows a selector-teeth audit — #2479.
 *
 * ## Why the flag exists
 *
 * The audit mutates each module-level selector through 9 guts and runs the
 * guard's own jest suite for each, and that run is ~33s regardless of file size
 * because `globalSetup` migrates the test DB. Measured across five
 * single-selector files: 324s / 354s / 443s / 543s, median ~400s. So cost is
 * `selectors × ~400s`, which puts `input-commodity-invariants` (5 selectors,
 * ~2000s) past any single-invocation ceiling available. Auditing a file a piece
 * at a time is the only way to reach those without a longer-running context.
 *
 * ## What is tested here, and what is deliberately not
 *
 * Every property below is checked WITHOUT running an audit. Narrowing to a name
 * the file does not have leaves the mutation loop with nothing to iterate, so
 * `auditFile` returns in ~0.5s — which is what makes the narrowing itself cheap
 * to prove.
 *
 * The one property this file does NOT execute is the stale-check narrowing: the
 * baseline comparison lives in the script's CLI block and is not exported, so
 * reaching it costs a real audit. What IS tested is its INPUT —
 * `auditedSelectors` must contain only the narrowed names — because that field
 * is the whole reason the stale check can tell "tested and clean" from "not
 * tested". A partial run judging an unaudited selector would delete another
 * selector's recorded debt.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/selector-teeth.mjs');

/**
 * Call into the real module from a SUBPROCESS.
 *
 * ts-jest rewrites an import of a `.mjs` to `require()`, which throws
 * `require() of ES Module` — the same reason
 * `selector-teeth-reports-its-denominator` shells out for `selectorsIn`. A
 * reimplementation here would agree with itself and say nothing about the tool.
 */
function inModule<T>(body: string): T {
    const script =
        `import * as T from ${JSON.stringify(pathToFileURL(SCRIPT).href)};`
        + `import { readFileSync } from 'node:fs';`
        + `const out = (() => { ${body} })();`
        + `console.log(JSON.stringify(out));`;
    const raw = execFileSync('node', ['--input-type=module', '-e', script], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(raw.trim()) as T;
}
/** One module-level selector (`pick`), so narrowing has something to exclude. */
const FIXTURE = 'tests/fixtures/selector-teeth-selftest.test.ts';

/** Run the CLI and return its exit code plus stderr, without throwing. */
function cli(args: string[]): { code: number; err: string } {
    try {
        execFileSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, err: '' };
    } catch (e) {
        const err = e as { status?: number; stderr?: string };
        return { code: err.status ?? -1, err: err.stderr ?? '' };
    }
}

describe('selector-teeth --selector (#2479)', () => {
    it('[selector-flag] the fixture really has a selector to narrow away', () => {
        // Without this the narrowing assertions below would range over a file
        // with nothing in it, and "narrowed to 0 of 0" proves nothing.
        const names = inModule<string[]>(
            `return T.selectorsIn(readFileSync(${JSON.stringify(FIXTURE)}, 'utf8')).map((s) => s.name);`,
        );
        console.log(`[selector-flag] ${FIXTURE} offers ${names.length} selector(s): ${names.join(', ')}`);
        expect(names).toEqual(['pick']);
    });

    it('narrows the audited set, and says so', () => {
        const r = inModule<{ candidates: number; totalSelectors: number; partial: boolean; auditedSelectors: string[] }>(
            `return T.auditFile(${JSON.stringify(FIXTURE)}, { only: new Set(['notpick']) });`,
        );
        expect({ candidates: r.candidates, total: r.totalSelectors, partial: r.partial })
            .toEqual({ candidates: 0, total: 1, partial: true });
        // The stale check reads THIS. It must not list a selector the run
        // skipped, or a partial audit deletes another selector's debt.
        expect(r.auditedSelectors).toEqual([]);
    });

    it('an un-narrowed run is not marked partial', () => {
        // `only: null` keeps every selector, so this would audit for real — the
        // shape is asserted through a selector set that matches everything the
        // file has, which is still the full set.
        const out = inModule<string>(
            `const r = T.auditFile(${JSON.stringify(FIXTURE)}, { only: new Set(['nothing-at-all']) });`
            + `if (!r.partial) throw new Error('expected a narrowed run to be partial');`
            + `const full = { ...r, candidates: r.totalSelectors, partial: false, auditedSelectors: ['pick'] };`
            + `return T.formatReport({ results: [full], unexpected: [], stale: [] }, false);`,
        );
        expect(out).not.toContain('PARTIAL audit');
    });

    it('the report announces a partial run rather than implying a clean file', () => {
        const partial = {
            file: FIXTURE, candidates: 1, survivors: [], untestable: [],
            auditedSelectors: ['pick'], totalSelectors: 5, partial: true,
        };
        const out = inModule<string>(
            `return T.formatReport({ results: [${JSON.stringify(partial)}], unexpected: [], stale: [] }, false);`,
        );
        expect(out).toContain('PARTIAL audit: 1 of 5 selector(s)');
        // The wording matters: a reader must not take a narrowed run for a
        // clean bill of health on the whole file.
        expect(out).toContain('UNTESTED by this run, not clean');
    });

    it('refuses a --selector that names nothing, instead of auditing zero and passing', () => {
        // The empty-selection pass this tool exists to hunt, in its own CLI.
        const { code, err } = cli(['--selector', 'nosuchfunction', FIXTURE]);
        expect(code).toBe(2);
        expect(err).toContain('do not exist at module level');
        // ...and it says what IS available, so the next invocation can be right.
        expect(err).toContain('pick');
    });

    it('refuses a PATH where a function name belongs', () => {
        // Without this, `--selector <file>` consumed the file as the selector,
        // left the file list empty, and printed the usage text — which reads as
        // "you forgot the file" when the file is right there in the command.
        const { code, err } = cli(['--selector', FIXTURE]);
        expect(code).toBe(2);
        expect(err).toContain('takes a FUNCTION name, got a path');
    });

    it('refuses --selector with no value', () => {
        const { code } = cli(['--selector']);
        expect(code).toBe(2);
    });
});

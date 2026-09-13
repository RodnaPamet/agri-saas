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
 * reading as a pass — and it was not rare. Measured across `tests/guards` +
 * `tests/guardrails` at `df269cddc`:
 *
 *     617  guard + guardrail files
 *     429  have module-level selectors  (auditable)
 *     188  have NONE                    (were getting the clean bill of health)
 *
 * So `auditFile` now returns `candidates`, the denominator, and the CLI reports
 * `NOT AUDITED` when it is zero. This file pins both halves.
 *
 * Every assertion here drives the REAL tool — `selectorsIn` for the count, and
 * the CLI itself for the message. A test that restated the rule in its own
 * words would pass while the tool said whatever it liked.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
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

/** Write a snippet to a temp file so `selectorNamesOf` can read it as node would. */
function selectorNamesOfSource(name: string, src: string): string[] {
    const p = path.join(os.tmpdir(), `selector-teeth-${name}.test.ts`);
    fs.writeFileSync(p, src);
    try {
        return selectorNamesOf(p);
    } finally {
        fs.unlinkSync(p);
    }
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
        expect(selectorNamesOfSource('module-level', src)).toEqual(['pick']);
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
        expect(selectorNamesOfSource('inline', src)).toEqual([]);
    });

    it('does not mutate a function declared inside describe()', () => {
        const src = [
            'describe("d", () => {',
            '    function helper() { return []; }',
            '    it("t", () => { expect(helper()).toEqual([]); });',
            '});',
        ].join('\n');
        expect(selectorNamesOfSource('in-describe', src)).toEqual([]);
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

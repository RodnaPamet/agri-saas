/**
 * `scripts/lib/import-graph.mjs` — EXECUTED, not asserted about (#3058).
 *
 * ## Why it is spawned rather than imported
 *
 * ts-jest compiles this file to CJS, so `await import('…/import-graph.mjs')`
 * becomes a `require` of an `.mjs` and fails module resolution — measured, not
 * assumed. `coverage-scripts.test.ts` already spawns `node` for the same
 * reason, and the pattern is better anyway: it runs the module
 * `verify:changed` actually loads, so a test cannot pass against a copy that
 * drifted.
 *
 * ## What this protects
 *
 * The third selection axis. `verify:changed` picks test ROOTS from two rule
 * axes; this one picks the SPECIFIC suites that transitively import a changed
 * source file, for the roots no rule selects. The failure direction that
 * matters is UNDER-selection — a suite that should have run and did not — so
 * every case below asserts a floor or a named suite rather than an absence.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

/**
 * Ask the real module a question in a child `node`, and parse its answer.
 *
 * One spawn per question: the graph build is ~300 ms over ~5,200 files, which
 * is cheap enough to pay per case and keeps each case independent.
 */
function ask<T>(body: string): T {
    const script = `
        const m = await import(${JSON.stringify(path.join(ROOT, 'scripts/lib/import-graph.mjs'))});
        const ROOT = ${JSON.stringify(ROOT)};
        const files = m.trackedSources(ROOT);
        const graph = m.buildImporterGraph(ROOT, files);
        const counts = m.suiteCountByRoot(files);
        ${body}
    `;
    const r = spawnSync('node', ['--input-type=module', '-e', script], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) {
        throw new Error(`child failed (${r.status}): ${r.stderr?.slice(0, 1200)}`);
    }
    return JSON.parse(r.stdout.trim().split('\n').pop() as string) as T;
}

describe('the import graph ranges over a real tree', () => {
    it('scans the repository, not an empty set', () => {
        const out = ask<{ files: number; graphKeys: number; suites: number; roots: number }>(`
            console.log(JSON.stringify({
                files: files.length,
                graphKeys: graph.size,
                suites: [...counts.values()].reduce((a, b) => a + b, 0),
                roots: [...counts.keys()].length,
            }));
        `);
        console.log(
            `[import-graph] ${out.files} file(s), ${out.graphKeys} graph key(s), `
                + `${out.suites} jest suite(s) across ${out.roots} root(s)`,
        );
        // Floors, because every assertion below is satisfied for free over an
        // empty tree — and an empty graph would make the third axis select
        // NOTHING while reading as "no suites needed".
        expect(out.files).toBeGreaterThanOrEqual(2000);
        expect(out.graphKeys).toBeGreaterThanOrEqual(1000);
        expect(out.suites).toBeGreaterThanOrEqual(2000);
        expect(out.roots).toBeGreaterThanOrEqual(5);
    });
});

describe('it finds the suite that #3030 cost a CI cycle on', () => {
    it('reaches channel-mention-notifies from usecases/channels.ts', () => {
        /*
         * The case this axis was built for. A push-link literal in
         * `usecases/channels.ts` is asserted exactly by that suite, and
         * `verify:changed` derived 2,248 suites across five roots without it —
         * every root green, `Test (shard 2/6)` red on the single assertion.
         *
         * Asserted on the GRAPH rather than on the selection, deliberately:
         * #3057 since added the `tests/integration` path rule, so the suite is
         * now covered by a root and correctly excluded from the per-suite set.
         * The property worth protecting is that the graph can SEE the edge —
         * if it ever stops, the selection silently loses it the moment that
         * rule changes.
         */
        const out = ask<{ total: number; hasMention: boolean }>(`
            const reached = [...m.suitesReaching(graph, 'src/app-layer/usecases/channels.ts')];
            console.log(JSON.stringify({
                total: reached.length,
                hasMention: reached.includes('tests/integration/channel-mention-notifies.test.ts'),
            }));
        `);
        expect(out.hasMention).toBe(true);
        // And it is a handful rather than the whole repo — the thing that
        // makes per-suite selection worth doing at all.
        expect(out.total).toBeGreaterThan(0);
        // Deliberately loose: the point is "far fewer than the 2,248 suites
        // the root-based derivation ran", not a pinned count that churns
        // whenever somebody adds a suite importing channels.
        expect(out.total).toBeLessThan(300);
    });
});

describe('it closes the six-root gap cheaply', () => {
    it('a types barrel selects dozens of suites, not the ~888 of two roots', () => {
        const out = ask<{ suites: number; byRoot: Record<string, number> }>(`
            const SEL = ['tests/unit', 'tests/integration', 'tests/regression'];
            const r = m.unreachedSuitesFor(ROOT, ['src/app-layer/types.ts'], SEL, { files, graph });
            const byRoot = {};
            for (const s of r.suites) {
                const k = m.rootOf(s);
                byRoot[k] = (byRoot[k] || 0) + 1;
            }
            console.log(JSON.stringify({ suites: r.suites.length, byRoot }));
        `);
        console.log(`[import-graph] types.ts -> ${out.suites} suite(s): ${JSON.stringify(out.byRoot)}`);
        // It reaches roots no rule selects — which is the gap #3058 measured.
        expect(Object.keys(out.byRoot)).toContain('tests/guards');
        expect(out.suites).toBeGreaterThan(10);
        // And stays far below the ~888 that adding guards+guardrails as rules
        // would have cost. A number this side of the line is the whole case
        // for the owner's choice.
        expect(out.suites).toBeLessThan(200);
    });

    it('excludes suites already covered by a selected root', () => {
        // The exclusion is what keeps the population honest: naming a suite
        // inside a root jest already walks overstates what is distinct.
        const out = ask<{ guards: number; others: number }>(`
            const r = m.unreachedSuitesFor(
                ROOT, ['src/app-layer/types.ts'],
                ['tests/unit', 'tests/integration', 'tests/regression', 'tests/guards'],
                { files, graph },
            );
            console.log(JSON.stringify({
                guards: r.suites.filter((s) => s.startsWith('tests/guards/')).length,
                others: r.suites.length,
            }));
        `);
        expect(out.guards).toBe(0);
        // The control: excluding one root must not empty the answer, or this
        // test would pass against a function that always returns nothing.
        expect(out.others).toBeGreaterThan(0);
    });

    it('names a whole root when most of it is selected', () => {
        const out = ask<{ suites: number; paths: number; collapsedRoots: string[] }>(`
            const SEL = ['tests/unit', 'tests/integration', 'tests/regression'];
            const r = m.unreachedSuitesFor(ROOT, ['src/components/ui/button.tsx'], SEL, { files, graph });
            const c = m.collapseByRoot(r.suites, counts);
            console.log(JSON.stringify({
                suites: r.suites.length,
                paths: c.paths.length,
                collapsedRoots: c.collapsed.map((x) => x.root),
            }));
        `);
        console.log(
            `[import-graph] button.tsx -> ${out.suites} suite(s) collapsed to ${out.paths} path(s)`,
        );
        // A shared primitive reaches most of tests/rendered, so enumerating it
        // buys no time and buries the readable population.
        expect(out.collapsedRoots).toContain('tests/rendered');
        expect(out.paths).toBeLessThan(out.suites / 4);
    });
});

describe('the resolver discriminates', () => {
    it('follows @/ and relative edges and ignores bare packages', () => {
        const out = ask<{ bare: string[]; aliased: boolean; stem: string[] }>(`
            // A package specifier names no file here; if it were followed, the
            // graph would hold junk keys like 'node:fs' and 'react'.
            console.log(JSON.stringify({
                bare: ['react', 'node:fs', '@prisma/client'].filter((k) => graph.has(k)),
                aliased: graph.has('src/app-layer/usecases/channels'),
                stem: [m.stemOf('src/a/b.ts'), m.stemOf('src/a/b/index.ts'), m.stemOf('src/a/c.tsx')],
            }));
        `);
        expect(out.bare).toEqual([]);
        // The alias edge is the one that matters: an integration suite reaches
        // a usecase by `@/app-layer/...`, so a relative-only resolver would
        // miss most real edges.
        expect(out.aliased).toBe(true);
        // `b.ts` and `b/index.ts` must land on ONE key, or an importer of
        // either is invisible to the other.
        expect(out.stem[0]).toBe('src/a/b');
        expect(out.stem[1]).toBe('src/a/b');
        expect(out.stem[2]).toBe('src/a/c');
    });

    it('selects nothing for a change with no source files', () => {
        // A docs-only or test-only diff must not drag the graph in. Cheap, and
        // it is the branch that runs on most diffs.
        const out = ask<{ suites: string[]; sources: number }>(`
            const r = m.unreachedSuitesFor(ROOT, ['README.md', 'tests/unit/x.test.ts'], [], { files, graph });
            console.log(JSON.stringify(r));
        `);
        expect(out.suites).toEqual([]);
        expect(out.sources).toBe(0);
    });
});

describe('the SEAM is wired, not just the module', () => {
    /*
     * The module being correct says nothing about whether `verify:changed`
     * calls it — "a seam is a new collector". Every case above exercises the
     * module directly, so all seven would stay green with the import deleted
     * from the script and the third axis never running.
     *
     * So this runs the REAL script and asserts its reading line appears. It
     * cannot assert that suites were ADDED, because that depends on the diff
     * the script happens to see, and a test must not depend on the working
     * tree — but the reading proves `unreachedSuitesFor` ran against a real
     * tree, which is the half a behavioural test cannot reach.
     */
    it('verify:changed runs the import graph and reports its cost', () => {
        const r = spawnSync('node', [path.join(ROOT, 'scripts/verify-changed.mjs'), '--explain'], {
            cwd: ROOT,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        });
        // `--explain` runs no tests, so a non-zero status is the script
        // refusing (an empty population) rather than a test failing.
        expect(r.status).toBe(0);

        const reading = (r.stdout ?? '')
            .split('\n')
            .find((l) => l.includes('[verify:changed] import graph:'));
        expect(reading).toBeDefined();
        console.log(`[import-graph] seam: ${reading?.trim()}`);

        // A real tree was walked. The floor is what separates "the axis ran"
        // from "it ran over nothing and selected nothing", which is the one
        // way this could fail toward green.
        const scanned = Number(/import graph: (\d+) file/.exec(reading as string)?.[1] ?? 0);
        expect(scanned).toBeGreaterThanOrEqual(2000);

        // And the escape hatch exists, so the axis's cost stays measurable.
        const off = spawnSync(
            'node',
            [path.join(ROOT, 'scripts/verify-changed.mjs'), '--explain', '--no-graph'],
            { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        );
        expect(off.status).toBe(0);
        expect(off.stdout).not.toContain('[verify:changed] import graph:');
    });
});

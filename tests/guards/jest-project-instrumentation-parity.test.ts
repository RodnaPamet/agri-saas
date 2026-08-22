/**
 * Every jest project must compile the sources with the SAME TypeScript target.
 *
 * ## What goes wrong when they don't
 *
 * `jest.config.js` declares two projects — `node` (env: node) and `jsdom`
 * (env: jsdom) — and each hands ts-jest a tsconfig. Until 2026-08-22 those
 * tsconfigs disagreed:
 *
 *     node   -> tsconfig.json                    target ES2017
 *     jsdom  -> tests/rendered/tsconfig.json     target ES2020
 *
 * `?.` and `??` are ES2020. Under ES2017 ts-jest DOWNLEVELS them into
 * if/ternary chains, so the emitted JS differs — and istanbul instruments the
 * emitted JS, not the source. The same file therefore gets two different
 * coverage shapes depending on which project loaded it. Measured on
 * `src/components/ui/file-icon-resolver.ts`:
 *
 *     node project      26 statements / 30 branches
 *     jsdom project     26 statements / 25 branches
 *
 * When both projects run in ONE process, jest merges the two instrumentations
 * into a single inflated map — **50 statements for a file that has 26**. When
 * they run in separate processes (the sharded Coverage job), each map stays at
 * 26 and istanbul's location-keyed merge preserves it.
 *
 * So the coverage TOTALS depended on whether two projects happened to share a
 * process. That is why the sharded gate and the unsharded reference run
 * disagreed on 53 files — bidirectionally, 15 larger one way and 18 the other,
 * because which instrumentation lands in the merged map follows load order.
 *
 * The divergence PREDATES sharding. Two unsharded runs could disagree too;
 * sharding only made it visible.
 *
 * ## Why this is a guard and not a comment
 *
 * The failure is silent and reads as a coverage-tooling bug rather than a
 * tsconfig one. Nothing else in the repo compares these two files, and the
 * obvious future edit — bumping one project's target for a new language
 * feature — reintroduces it with no signal at all.
 *
 * Aligning UPWARD (ES2020) was deliberate: `lib` is already `esnext`, the
 * esbuild worker/seed bundles already target `node22`, and Next compiles with
 * SWC rather than following tsconfig `target`.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Resolve `target` through the `extends` chain using TypeScript's OWN config
 * loader, which is authoritative about both JSONC and extends resolution.
 *
 * A hand-rolled comment-stripper was tried first and was wrong: the `include`
 * array contains `"./**\/*"`, whose `/*` ... `*\/` a block-comment regex
 * happily eats, corrupting the JSON. Do not reintroduce one.
 */
function resolveTarget(file: string): string | undefined {
    const host: ts.ParseConfigFileHost = {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => {
            /* surfaced by the assertions below as an undefined target */
        },
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, host);
    const target = parsed?.options.target;
    return target === undefined ? undefined : ts.ScriptTarget[target];
}

/** The tsconfig each jest project hands to ts-jest — derived, never hardcoded. */
function projectTsconfigs(): Array<{ project: string; tsconfig: string }> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require('../../jest.config.js') as {
        projects?: Array<{
            displayName?: string | { name?: string };
            transform?: Record<string, unknown>;
        }>;
    };
    const out: Array<{ project: string; tsconfig: string }> = [];
    for (const p of cfg.projects ?? []) {
        const dn = p.displayName;
        const name = (typeof dn === 'string' ? dn : dn?.name) ?? '(unnamed)';
        let tsconfig = 'tsconfig.json'; // ts-jest's default
        for (const value of Object.values(p.transform ?? {})) {
            if (Array.isArray(value) && value[1] && typeof value[1] === 'object') {
                const opt = (value[1] as { tsconfig?: string }).tsconfig;
                if (opt) tsconfig = opt.replace('<rootDir>/', '');
            }
        }
        out.push({ project: name, tsconfig });
    }
    return out;
}

describe('jest projects must instrument identically', () => {
    const projects = projectTsconfigs();

    it('finds every declared project (the guard is derived, not hardcoded)', () => {
        expect(projects.length).toBeGreaterThanOrEqual(2);
        for (const p of projects) {
            expect(fs.existsSync(path.join(ROOT, p.tsconfig))).toBe(true);
        }
    });

    it('compiles with the SAME TypeScript target in every project', () => {
        const targets = projects.map((p) => ({
            ...p,
            target: resolveTarget(path.join(ROOT, p.tsconfig)),
        }));

        for (const t of targets) {
            expect(t.target).toBeDefined();
        }

        const distinct = [...new Set(targets.map((t) => String(t.target).toUpperCase()))];
        // Named in the failure so the reader sees WHICH projects disagree.
        expect({ distinct, targets }).toEqual({
            distinct: [distinct[0]],
            targets,
        });
    });

    it('resolves a target through `extends` rather than only a literal field', () => {
        // tests/rendered/tsconfig.json extends the root; a future edit that
        // deletes its explicit target must still resolve, or the check above
        // would pass on `undefined === undefined`.
        const rendered = path.join(ROOT, 'tests/rendered/tsconfig.json');
        if (!fs.existsSync(rendered)) return;
        const raw = fs.readFileSync(rendered, 'utf8');
        expect(raw).toMatch(/"extends"\s*:/);
        expect(resolveTarget(rendered)).toBeDefined();
    });
});

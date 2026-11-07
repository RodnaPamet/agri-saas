/**
 * Every bare import the worker bundle emits must be resolvable by Node — the
 * worker tier was dead for ~12-17 hours because one was not.
 *
 * ## What happened
 *
 * `scripts/build-worker.mjs` keeps node_modules external (`packages:
 * 'external'`), so any module the bundle reaches contributes its imports
 * VERBATIM to `dist/worker.mjs`. #2784 added a `usecases/rag -> ai/routing`
 * edge, which completed this chain:
 *
 *   scripts/worker.ts
 *     -> jobs/executor-registry -> jobs/classify-photo -> usecases/rag
 *     -> ai/routing -> rate-limit/aiRateLimit -> security/rate-limit-middleware
 *
 * and that last module imports `NextResponse` from `next/server`. Plain Node
 * cannot resolve `next/server`, because next@16.4.x ships NO `exports` map —
 * measured on 16.4.3 AND 16.4.4, so this was never a version regression:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *   '/app/node_modules/next/server' imported from /app/dist/worker.mjs
 *   Did you mean to import "next/server.js"?
 *
 * The worker crash-looped on startup from the first publish after that merge.
 * Every background job stopped — notification digests, expiry sweeps, the mail
 * canary, compliance snapshots and the BullMQ health beat — and **nothing
 * paged**, because the GCP uptime check probes `/api/readyz` on the app tier
 * and the app tier was healthy throughout. CLAUDE.md already warns that a
 * wedged worker keeps the web tier green; this is the crash-looping version of
 * the same blind spot.
 *
 * ## Why this guard and not a rule about one import
 *
 * The property is not "do not import next/server". It is "the bundle Node is
 * handed must load", and the failure arrives through an import chain nobody
 * wrote deliberately — six hops, each reasonable on its own. A rule naming
 * `next/server` would be satisfied by the next Next-only module to appear.
 *
 * So this RESOLVES every external specifier the real build emits, the way Node
 * will at startup. It builds in-process with the same options rather than
 * reading `dist/`, so it cannot pass by inspecting a stale artefact or be
 * skipped because nobody ran the build.
 *
 * It does not claim to catch a devDependency reaching the bundle: that resolves
 * here and fails only in the pruned image, and `scripts/verify-image-deps.mjs`
 * is the control for that axis.
 */

import { build } from 'esbuild';
import { createRequire, isBuiltin } from 'node:module';
import * as fs from 'fs';
import * as path from 'path';
import { REPO_ROOT } from '../helpers/collect-files';

const require_ = createRequire(path.join(REPO_ROOT, 'package.json'));

/** The three bundles `build:worker` produces, built the same way it does. */
const ENTRIES = [
    'scripts/worker.ts',
    'scripts/scheduler.ts',
    'scripts/worker-healthcheck.ts',
];

interface Emitted {
    entry: string;
    externals: string[];
}

async function emitted(): Promise<Emitted[]> {
    const out: Emitted[] = [];
    for (const entry of ENTRIES) {
        const r = await build({
            bundle: true,
            platform: 'node',
            target: 'node22',
            format: 'esm',
            packages: 'external',
            metafile: true,
            write: false,
            absWorkingDir: REPO_ROOT,
            entryPoints: [entry],
            outfile: 'dist/__guard__.mjs',
        });
        /**
         * Read the EMITTED text, not the metafile's external list.
         *
         * The metafile reports specifiers esbuild *saw* — including `@/…` path
         * aliases it then resolved, and relative type-only imports it erased.
         * None of those reach the output, so checking them produced five false
         * positives on a bundle that demonstrably runs. What Node is handed is
         * the output file, so that is what this reads.
         */
        const text = r.outputFiles?.[0]?.text ?? '';
        const specs = new Set<string>();
        for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*["']([^"']+)["']/g)) {
            if (isBareSpecifier(m[1])) specs.add(m[1]);
        }
        for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
            if (isBareSpecifier(m[1])) specs.add(m[1]);
        }
        for (const m of text.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
            if (isBareSpecifier(m[1])) specs.add(m[1]);
        }
        out.push({ entry, externals: [...specs].sort() });
    }
    return out;
}

/**
 * Only BARE package specifiers are the runtime's problem here. esbuild also
 * reports relative imports and glob patterns as external (type-only imports,
 * the i18n message glob); those are not what Node resolves from node_modules.
 */
function isBareSpecifier(spec: string): boolean {
    if (spec.startsWith('.') || spec.startsWith('/')) return false;
    if (spec.includes('*')) return false;
    return true;
}

/**
 * Does Node's ESM loader actually LOAD this specifier?
 *
 * Deliberately not `require.resolve`, and deliberately not
 * `import.meta.resolve` either — both say YES for the specifier that took
 * production down, for different reasons:
 *
 *   require.resolve('next/server')      -> node_modules/next/server.js
 *       CJS appends extensions. ESM does not.
 *   import.meta.resolve('next/server')  -> file:///…/node_modules/next/server
 *       Resolution SUCCEEDS and returns a path that does not exist. The
 *       failure then happens at LOAD, which is exactly the production error:
 *       "Cannot find module '/app/node_modules/next/server'".
 *
 * So the question is resolve AND exist, which is what this does: honour an
 * `exports` map when the package has one, and otherwise require the literal
 * file to be there with no extension guessing.
 */
function resolves(spec: string): boolean {
    // `fs/promises` and friends are builtins without the `node:` prefix, and
    // Node resolves them fine. Asked of the runtime rather than matched
    // against a hand-written list.
    if (isBuiltin(spec)) return true;
    const [scopeOrName, maybeName, ...rest] = spec.split('/');
    const pkg = spec.startsWith('@') ? `${scopeOrName}/${maybeName}` : scopeOrName;
    const subpath = (spec.startsWith('@') ? rest : [maybeName, ...rest])
        .filter(Boolean)
        .join('/');

    let pkgJsonPath: string;
    try {
        pkgJsonPath = require_.resolve(`${pkg}/package.json`);
    } catch {
        // Some packages do not export their own package.json. Fall back to
        // resolving the package entry itself.
        try {
            require_.resolve(pkg);
            return !subpath;
        } catch {
            return false;
        }
    }

    const pkgDir = path.dirname(pkgJsonPath);
    // No eslint-disable here. `no-var-requires` does not fire on this call
    // under tests/, so a directive would be UNUSED — itself a finding, against
    // an `inert eslint-disable` ceiling of ZERO. I wrote one anyway, and the
    // lint gate caught it; that makes three times in one session, after
    // recording the same mistake in two other guards.
    const manifest = require_(pkgJsonPath) as { exports?: unknown };

    if (!subpath) return true;
    // With an `exports` map, Node honours it and we trust the package.
    if (manifest.exports) return true;
    // Without one, ESM requires the literal file — no extension guessing.
    return fs.existsSync(path.join(pkgDir, subpath));
}

describe('the worker bundles import nothing Node cannot resolve', () => {
    let built: Emitted[];

    beforeAll(async () => {
        built = await emitted();
    }, 120_000);

    it('[worker-bundle-externals] prints the denominator', () => {
        const total = built.reduce((n, b) => n + b.externals.length, 0);
        // A floor: a build that emitted no externals would satisfy the
        // assertion below over nothing, and `packages: 'external'` guarantees
        // there are many.
        expect(built).toHaveLength(ENTRIES.length);
        expect(total).toBeGreaterThan(10);
        console.log(
            `[worker-bundle-externals] ${total} external specifier(s) across `
                + built.map((b) => `${path.basename(b.entry)}:${b.externals.length}`).join(' '),
        );
    });

    it('every external specifier resolves', () => {
        const bad: string[] = [];
        for (const b of built) {
            for (const spec of b.externals) {
                if (!resolves(spec)) bad.push(`${b.entry} -> ${spec}`);
            }
        }
        expect(bad).toEqual([]);
    });

    /**
     * The detector's own proof. The bundles are clean now, so without this the
     * assertion above would pass whether or not `resolves` can tell the
     * difference — and the whole incident was an unresolvable import that
     * looked like every other one.
     */
    it('detects an unresolvable specifier', () => {
        // The real thing that broke production.
        expect(resolves('next/server')).toBe(false);
        // A sibling that DOES resolve, so this is not a blanket false.
        expect(resolves('next')).toBe(true);
        // And the two resolvers that get it WRONG, pinned so nobody
        // "simplifies" this back to either of them.
        expect(() => require_.resolve('next/server')).not.toThrow();
        expect(resolves('ioredis')).toBe(true);
        expect(resolves('node:fs')).toBe(true);
        expect(resolves('a-package-that-does-not-exist-xyz')).toBe(false);
    });
});

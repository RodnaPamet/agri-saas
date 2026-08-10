/**
 * Structural ratchet — the knowledge-base seed CLI is actually shippable.
 *
 * REGRESSION CLASS
 * -----------------
 * `scripts/seed.ts` (knowledge/satellite/corpus/all subcommands) exists
 * ONLY because the production runtime image ships no `tsx` and no
 * source `scripts/` tree — devDependencies (including `tsx`) are
 * pruned before the runner stage is built (see the Dockerfile). Before
 * this file existed, `npm run rag:ingest` / `npm run import:knowledge` /
 * `npm run rag:ingest:satellite` could not run in production at all —
 * see docs/implementation-notes/2026-08-10-production-seed-path.md.
 *
 * It stays useless in production unless THREE things remain true at
 * once: esbuild actually bundles `scripts/seed.ts`
 * (`scripts/build-seed.mjs`'s `entryPoints`), the Dockerfile actually
 * runs that build BEFORE the dev-dependency prune (esbuild itself is a
 * devDependency), and the Dockerfile actually ships `dist/` into the
 * runtime image. Any one of the three silently regressing puts
 * production back where this gap started: a one-off, hand-copied
 * applier script as the only way to seed content. Modelled directly on
 * `tests/guards/worker-deployment.test.ts`, which guards the identical
 * mechanism for the BullMQ worker + scheduler bundles.
 *
 * Pure static analysis — reads scripts/seed.ts, scripts/build-seed.mjs,
 * package.json and the Dockerfile. See CLAUDE.md, "Green is not the
 * same as executed": this proves the wiring is present in source, not
 * that a seed run against a live database succeeds — that is exercised
 * manually (VERIFY step) and cannot run in CI without a database.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('knowledge-base seed CLI is deployed', () => {
    it('scripts/seed.ts exists and wires all four subcommands', () => {
        expect(fs.existsSync(path.join(ROOT, 'scripts/seed.ts'))).toBe(true);
        const src = read('scripts/seed.ts');
        expect(src).toMatch(/'knowledge'/);
        expect(src).toMatch(/'satellite'/);
        expect(src).toMatch(/'corpus'/);
        expect(src).toMatch(/'all'/);
        // The three underlying idempotent seed functions must actually
        // be called, not just named in a comment.
        expect(src).toMatch(/importKnowledge\(/);
        expect(src).toMatch(/ingestSatelliteGuide\(/);
        expect(src).toMatch(/ingestGlobalCorpus\(/);
    });

    it('scripts/build-seed.mjs exists and declares the seed entrypoint', () => {
        expect(fs.existsSync(path.join(ROOT, 'scripts/build-seed.mjs'))).toBe(true);
        const src = read('scripts/build-seed.mjs');
        expect(src).toMatch(/entryPoints:\s*\[\s*'scripts\/seed\.ts'\s*\]/);
        expect(src).toMatch(/outfile:\s*'dist\/seed\.mjs'/);
        // node_modules MUST stay external — bundling them would either
        // bloat the output or silently vendor a stale copy.
        expect(src).toMatch(/packages:\s*'external'/);
    });

    it('package.json carries the build:seed script', () => {
        const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
        expect(pkg.scripts?.['build:seed']).toBe('node scripts/build-seed.mjs');
    });

    it('the Dockerfile builds the seed bundle before the dev-dependency prune', () => {
        const dockerfile = read('Dockerfile');
        expect(dockerfile).toMatch(/npm run build:seed/);

        const buildSeedIdx = dockerfile.indexOf('npm run build:seed');
        const pruneIdx = dockerfile.indexOf('npm prune');
        expect(buildSeedIdx).toBeGreaterThan(-1);
        expect(pruneIdx).toBeGreaterThan(-1);
        expect(buildSeedIdx).toBeLessThan(pruneIdx);
    });

    it('the Dockerfile ships the whole dist/ directory (covers dist/seed.mjs)', () => {
        const dockerfile = read('Dockerfile');
        // Same whole-directory COPY that already ships dist/worker.mjs +
        // dist/scheduler.mjs — no separate COPY is needed for seed.mjs,
        // but the COPY itself must keep existing.
        expect(dockerfile).toMatch(/COPY --from=builder (?:--chown=\S+ )?\/app\/dist \.\/dist/);
    });

    // ── Mutation proof ──────────────────────────────────────────────
    //
    // Proves the assertions above are actually sensitive to the
    // regression class they exist to catch, not a tautology that would
    // pass against any file content.
    describe('mutation proof', () => {
        const entryPointPattern = /entryPoints:\s*\[\s*'scripts\/seed\.ts'\s*\]/;

        it('the real build-seed.mjs matches the entrypoint pattern', () => {
            expect(read('scripts/build-seed.mjs')).toMatch(entryPointPattern);
        });

        it('trimming the entrypoint list to empty would fail the pattern match', () => {
            const mutated = read('scripts/build-seed.mjs').replace(
                "entryPoints: ['scripts/seed.ts'],",
                'entryPoints: [],',
            );
            expect(mutated).not.toBe(read('scripts/build-seed.mjs'));
            expect(mutated).not.toMatch(entryPointPattern);
        });

        it('removing the Dockerfile build:seed RUN step would fail the ordering check', () => {
            const dockerfile = read('Dockerfile');
            const mutated = dockerfile.replace(/RUN npm run build:seed\n/, '');
            expect(mutated).not.toBe(dockerfile);
            expect(mutated).not.toMatch(/npm run build:seed/);
        });

        it('dropping the seed subcommand string would fail the subcommand-wiring check', () => {
            const src = read('scripts/seed.ts');
            const mutated = src.replace(/'corpus'/g, '"CORPUS_REMOVED"');
            expect(mutated).not.toBe(src);
            expect(mutated).not.toMatch(/'corpus'/);
        });
    });
});

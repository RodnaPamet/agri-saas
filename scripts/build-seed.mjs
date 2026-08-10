/**
 * Build the standalone knowledge-base seed entrypoint.
 *
 * `scripts/seed.ts` is a CLI (knowledge/satellite/corpus/all
 * subcommands) that must run in the production runtime image, which
 * ships no `tsx` and no source `scripts/` tree (devDependencies are
 * pruned before the runner stage — see the Dockerfile). This mirrors
 * `scripts/build-worker.mjs` exactly: esbuild-bundle the entrypoint
 * — with all its `src/`/`scripts/` imports inlined — into a single
 * self-contained `.mjs` file under `dist/`. node_modules stay
 * external (resolved at runtime from the pruned production
 * `node_modules`), so every package the bundle imports MUST be a
 * production `dependency`, not a `devDependency`.
 *
 * Output: `dist/seed.mjs`.
 * Run:    `node scripts/build-seed.mjs`  (npm script: `build:seed`)
 */
import { build } from 'esbuild';

await build({
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Keep every node_modules package external — resolved at runtime
    // from the production node_modules. Only first-party `src/` +
    // `scripts/` code is inlined into the bundle.
    packages: 'external',
    // Resolves the `@/*` and `@dub/*` path aliases.
    tsconfig: 'tsconfig.json',
    logLevel: 'info',
    // esbuild emits `import.meta` helpers etc. for ESM; banner keeps
    // CJS-style `require`/`__dirname` working for any external that
    // an inlined module reaches for.
    banner: {
        js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
    },
    entryPoints: ['scripts/seed.ts'],
    outfile: 'dist/seed.mjs',
});

console.log('✓ built dist/seed.mjs');

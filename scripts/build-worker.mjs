/**
 * Build the standalone BullMQ worker + scheduler entrypoints.
 *
 * The worker and scheduler run as separate processes from the
 * Next.js server (see `docker-compose.prod.yml` `worker` service).
 * The production image is dev-dependency-pruned, so it cannot run
 * the TypeScript sources directly via `tsx`. This script bundles
 * each entrypoint — with all its `src/` imports inlined — into a
 * single self-contained `.mjs` file under `dist/`. node_modules
 * stay external (resolved at runtime from the pruned production
 * `node_modules`), so every package the bundle imports MUST be a
 * production `dependency`, not a `devDependency`.
 *
 * Output: `dist/worker.mjs`, `dist/scheduler.mjs`.
 * Run:    `node scripts/build-worker.mjs`  (npm script: `build:worker`)
 */
import { build } from 'esbuild';

const common = {
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
};

await build({
    ...common,
    entryPoints: ['scripts/worker.ts'],
    outfile: 'dist/worker.mjs',
});
await build({
    ...common,
    entryPoints: ['scripts/scheduler.ts'],
    outfile: 'dist/scheduler.mjs',
});
// The worker's container healthcheck (#809). Bundled here rather than run
// with tsx because the runner image ships no source tree and no
// devDependencies — the same reason worker.mjs and scheduler.mjs are bundled.
await build({
    ...common,
    entryPoints: ['scripts/worker-healthcheck.ts'],
    outfile: 'dist/worker-healthcheck.mjs',
});

console.log('✓ built dist/worker.mjs + dist/scheduler.mjs + dist/worker-healthcheck.mjs');

/**
 * Build the standalone ZarnoBorsa fetch entrypoint.
 *
 * Mirrors `scripts/build-seed.mjs` and `scripts/build-worker.mjs` — esbuild
 * the entrypoint with its `src/` imports inlined into one self-contained
 * `.mjs` under `dist/`, node_modules external.
 *
 * ## This bundle runs in a DIFFERENT image from the other two
 *
 * `dist/worker.mjs` and `dist/seed.mjs` run in this product's runtime image.
 * This one runs in the official Playwright image, because
 * `verify-image-deps.mjs` forbids Playwright in ours and exists because
 * `npm prune --omit=dev` cannot remove it.
 *
 * So the externals it resolves at runtime are that image's, not ours — which
 * is why the entrypoint imports `playwright` and NOTHING else from
 * node_modules. It deliberately touches no Prisma: a bundle needing both
 * would require a custom image carrying both, and the file handoff to the
 * ingest half costs one JSON document instead.
 *
 * If this bundle ever starts pulling a second external, check what it is
 * before adding it to the fetch image — the short list is the point.
 *
 * Output: `dist/zarnoborsa-fetch.mjs`.
 * Run:    `node scripts/build-zarnoborsa-fetch.mjs`  (npm: `build:zarnoborsa`)
 */
import { build } from 'esbuild';

await build({
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    packages: 'external',
    tsconfig: 'tsconfig.json',
    logLevel: 'info',
    banner: {
        js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
    },
    entryPoints: ['scripts/zarnoborsa-fetch.ts'],
    outfile: 'dist/zarnoborsa-fetch.mjs',
});

console.log('✓ built dist/zarnoborsa-fetch.mjs');

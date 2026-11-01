#!/usr/bin/env node
/**
 * Assert the RUNTIME IMAGE does not carry test tooling.
 *
 * Runs INSIDE the built image in CI, beside `verify-image-patches.mjs`, and
 * for the same reason that one exists: a Dockerfile-shape assertion is a
 * proxy for what shipped, and this is not. The failure it guards against
 * already happened once — `Dockerfile`'s prune comment listed `playwright`
 * among the packages it removed, and it had never removed it.
 *
 * WHY THE PRUNE CANNOT DO THIS (#801)
 *
 * `@playwright/test` sits in devDependencies, but `next` declares it as an
 * OPTIONAL peerDependency, so npm resolves the chain through a PRODUCTION
 * edge and marks every node `dev: false`. `npm prune --omit=dev` is then
 * correct to keep it — by the lockfile's graph it IS a production
 * dependency. The removal has to be explicit, and therefore has to be
 * checked, because an explicit `rm` is exactly the kind of line a later
 * refactor drops.
 *
 * WHY A POSITIVE CONTROL IS MANDATORY
 *
 * "Directory absent" is the same observation as "I am looking in the wrong
 * place". A check that resolves the wrong `node_modules` — or an empty one —
 * would report a clean image forever, and it would fail TOWARD green, which
 * is the failure direction this repo keeps finding. So every run also
 * asserts that packages which MUST be present are present. If the controls
 * are missing, the tree is wrong and the absence proves nothing.
 *
 * Usage:  node verify-image-deps.mjs [rootDir]
 *         (rootDir defaults to /app, the image's WORKDIR)
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Test tooling that must never reach the runtime image. */
const BANNED = [
    'playwright',
    'playwright-core',
    '@playwright/test',
    '@axe-core/playwright',
];

/**
 * Packages the runtime genuinely needs. Their presence proves we resolved a
 * real production tree, so a BANNED miss is a real absence rather than an
 * empty directory.
 */
const REQUIRED = ['next', 'react', 'react-dom', '@prisma/client'];

const root = process.argv[2] ?? '/app';
const modules = join(root, 'node_modules');

const fail = (msg) => {
    console.error(`[verify-image-deps] FAIL: ${msg}`);
    process.exitCode = 1;
};

if (!existsSync(modules)) {
    fail(`no node_modules at ${modules} — cannot verify anything`);
    process.exit(1);
}

// ── Positive control first: prove the tree is real. ──────────────────
const missingControls = REQUIRED.filter((p) => !existsSync(join(modules, p)));
if (missingControls.length > 0) {
    fail(
        `positive control missing (${missingControls.join(', ')}) at ${modules}. ` +
            'The tree is wrong, so an absence of banned packages proves nothing.',
    );
    process.exit(1);
}
console.log(
    `[verify-image-deps] control OK — ${REQUIRED.length} required packages present in ${modules}`,
);

// ── The actual assertion. ────────────────────────────────────────────
const present = BANNED.filter((p) => existsSync(join(modules, p)));
if (present.length > 0) {
    fail(
        `test tooling shipped in the runtime image: ${present.join(', ')}.\n` +
            '  The Dockerfile removes these explicitly after `npm prune --omit=dev`,\n' +
            '  because next declares @playwright/test as an optional peerDependency\n' +
            '  and the prune therefore cannot. Restore that `rm -rf` (see #801).',
    );
    process.exit(1);
}

// `@playwright` may survive as an empty scope directory; that is not a
// finding, but a scope with contents is.
const scope = join(modules, '@playwright');
if (existsSync(scope) && readdirSync(scope).length > 0) {
    fail(`@playwright scope is non-empty: ${readdirSync(scope).join(', ')}`);
    process.exit(1);
}

/**
 * #2582 — the unusable `onnxruntime-node` platform binaries are gone, and the
 * linux one is still here.
 *
 * Both halves are required. A check for the absence alone passes perfectly on
 * an image where the whole package failed to install, or where a path moved —
 * which is the failure that points TOWARD green, so the linux directory is the
 * positive control. If onnxruntime-node is absent entirely this is skipped
 * rather than failed: the package is an optional on-device accelerator, and a
 * build that legitimately omits it must not be reported as a prune failure.
 */
const onnxBin = join(modules, 'onnxruntime-node', 'bin', 'napi-v6');
if (existsSync(onnxBin)) {
    const unusable = ['darwin', 'win32'].filter((p) => existsSync(join(onnxBin, p)));
    if (unusable.length > 0) {
        fail(
            `onnxruntime-node still carries [${unusable.join(', ')}] — ~220 MB that cannot ` +
                'execute in a linux container, and what exhausted the publish runner in #2582.',
        );
        process.exit(1);
    }
    if (!existsSync(join(onnxBin, 'linux'))) {
        fail(
            'onnxruntime-node/bin/napi-v6 exists but its `linux` directory does not — the ' +
                'prune removed the wrong thing, or the layout moved. This is the positive ' +
                'control: without it, an absent package reads as a successful prune.',
        );
        process.exit(1);
    }
    console.log('[verify-image-deps] OK — onnxruntime-node carries linux only');
}

console.log(`[verify-image-deps] OK — none of [${BANNED.join(', ')}] present`);

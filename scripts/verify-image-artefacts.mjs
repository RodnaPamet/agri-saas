#!/usr/bin/env node
/**
 * Assert the RUNTIME IMAGE carries every `dist/` bundle, and that none of them
 * is a stub.
 *
 * Third member of the `verify-image-*` family, running where its two siblings
 * run — CI's `docker` job and `ghcr-publish.yml`, which re-reads the digest
 * FROM THE REGISTRY and re-verifies the pulled bytes. Same reason all three
 * exist: a Dockerfile-shape assertion is a PROXY for what shipped, and this is
 * not.
 *
 * ## The failure it guards against happened, and cost the owner two reports
 *
 * #3081 shipped a ZarnoBorsa fetch bundle whose npm script, compose service
 * and entrypoint publish all existed, and whose Dockerfile build step did not.
 * Nothing failed: the entrypoint's `[ -f ... ]` guard correctly skipped, the
 * shared volume stayed empty, and a Playwright container ran
 * `node … || true` against a file that never existed. The only symptom was
 * prices that did not appear, and the owner reported it twice.
 *
 * `tests/guards/zarnoborsa-fetch-deployment.test.ts` now asserts the pieces
 * are DECLARED, which is necessary and is not this. A guard reads the
 * repository; this reads the image.
 *
 * ## What it does NOT catch, stated so nobody over-trusts it
 *
 * That same chain turned out to have seven links, and **only one of the four
 * defects was an image problem**:
 *
 *   #3096  the Dockerfile never built the bundle      <- THIS SCRIPT
 *   #3113  the volume was root:root, app is uid 1001  <- not an image problem
 *   #3117  ESM cannot resolve a bare import from the
 *          published path; the compose `cd` is inert  <- not an image problem
 *   #3120  the worker did not mount the handoff at all <- not an image problem
 *
 * So this closes one of four. The other three live between "the artefact is in
 * the image" and "the consumer can use it" — ownership, module resolution, and
 * whether the reader is mounted on the writer's volume — and need a POST-DEPLOY
 * check against the running stack. #3099 carries that half; do not read a
 * green run here as a working feature.
 *
 * ## Why a SIZE FLOOR and not `existsSync`
 *
 * esbuild can fail after it has opened the output file, which leaves a short
 * file rather than none, and `existsSync` cannot tell a 200-byte failed build
 * from a 7.5 KB bundle.
 *
 * ## Why the floors are PER ARTEFACT, and measured IN THE IMAGE
 *
 * Measured in the running production container 2026-11-16, beside the same
 * build locally:
 *
 *   artefact                 in the image     local build
 *   worker.mjs                  3,016,110       2,453,391
 *   seed.mjs                      297,724         295,109
 *   scheduler.mjs                 106,388          85,799
 *   machine-listener.mjs           37,839         *absent*
 *   zarnoborsa-fetch.mjs            7,490           7,490
 *   worker-healthcheck.mjs          1,734           1,734
 *
 * Three orders of magnitude between largest and smallest, so any single global
 * floor is wrong in both directions: low enough to pass a truncated
 * `worker.mjs`, or high enough to fail `worker-healthcheck.mjs` — which is the
 * one artefact that already has teeth (the container healthcheck runs it), and
 * therefore the worst possible false alarm.
 *
 * And the numbers have to come from the IMAGE. `worker.mjs` ships 23% larger
 * than it builds here, `scheduler.mjs` 24% larger, and `machine-listener.mjs`
 * does not exist in a local `dist/` at all — so a locally-calibrated floor is
 * calibrated against the wrong population.
 *
 * ## A FLOOR, never a range
 *
 * A bundle that grows is normal: a dependency bump, a new subcommand. A bundle
 * that collapses is the defect. An upper bound would turn routine growth into
 * a red check and teach people to raise it, which is how a ceiling becomes
 * decoration. Each floor is roughly half its measured size — a 2x shrink is
 * not a thing that happens to a working build.
 *
 * ## The positive control is mandatory
 *
 * "File absent" and "I am looking in the wrong place" are the same
 * observation, and the second fails TOWARD green. So the run also asserts that
 * `dist/` resolves and holds the entry the app itself starts from. Without
 * that, a wrong `rootDir` would report a perfect image forever.
 *
 * Usage:  node verify-image-artefacts.mjs [rootDir]
 *         (rootDir defaults to /app, the image's WORKDIR)
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every bundle the image must carry, with the floor each must clear.
 *
 * `measured` is recorded beside the floor on purpose: a floor with no
 * provenance is a guess, and the next person to raise one needs to know what
 * it was derived from and when. Re-measure with
 *   docker compose exec -T app sh -c 'ls -l dist/'
 */
const ARTEFACTS = [
    { file: 'worker.mjs', floor: 1_500_000, measured: 3_016_110, why: 'the BullMQ worker; the whole background tier' },
    { file: 'scheduler.mjs', floor: 50_000, measured: 106_388, why: 'registers the repeatables; without it nothing is scheduled' },
    { file: 'seed.mjs', floor: 150_000, measured: 297_724, why: 'the production seeding CLI (#2936 channels, library, corpus)' },
    { file: 'machine-listener.mjs', floor: 18_000, measured: 37_839, why: 'telemetry ingest' },
    { file: 'worker-healthcheck.mjs', floor: 800, measured: 1_734, why: 'the container healthcheck RUNS this; a missing one marks the worker unhealthy' },
    { file: 'zarnoborsa-fetch.mjs', floor: 3_500, measured: 7_490, why: '#3081 — the bundle that was never built, with no symptom but absent prices' },
];

/**
 * The positive control, and it is deliberately NOT one of the artefacts above.
 *
 * My first draft used `worker.mjs` as both — and the executing test caught
 * what that costs: with `worker.mjs` missing the script reported "the
 * directory is not the one this script is about", which sends an operator
 * hunting a wrong `rootDir` when the directory is right and the worker bundle
 * is genuinely absent. Both exit non-zero, so CI still fails; the DIAGNOSIS is
 * wrong, which is the `uniform-failure-shape-blinds-the-client` shape.
 *
 * So the control is on the ROOT rather than on `dist/`'s contents: these two
 * are what the runner stage COPYs and what it starts from, so their presence
 * proves the path is the app image's WORKDIR without overlapping anything
 * being checked.
 */
const CONTROL_ROOT_ENTRIES = ['package.json', '.next'];

const root = process.argv[2] ?? '/app';
const dist = join(root, 'dist');

const fail = (msg) => console.error(`[verify-image-artefacts] FAIL: ${msg}`);

// CONTROL FIRST, and on the root rather than on dist/ — see the constant.
const missingControls = CONTROL_ROOT_ENTRIES.filter((e) => !existsSync(join(root, e)));
if (missingControls.length > 0) {
    fail(
        `${root} is missing [${missingControls.join(', ')}], so it is not the app image's ` +
            'WORKDIR. Every absence below would be a fact about this probe rather than ' +
            'about the image, so nothing is concluded.',
    );
    process.exit(1);
}

if (!existsSync(dist)) {
    fail(
        `the root is the app image and ${dist} does not exist. The ` +
            '`COPY --from=builder /app/dist ./dist` did not happen.',
    );
    process.exit(1);
}

const present = readdirSync(dist);
if (present.length === 0) {
    fail(`${dist} exists and is EMPTY. Nothing was built, or nothing was copied.`);
    process.exit(1);
}
console.log(
    `[verify-image-artefacts] control OK — ${root} is the app image; ` +
        `${dist} resolves with ${present.length} entr(ies)`,
);

let failed = 0;
for (const { file, floor, measured, why } of ARTEFACTS) {
    const path = join(dist, file);
    if (!existsSync(path)) {
        fail(`${file} is ABSENT. ${why}.`);
        failed += 1;
        continue;
    }
    // ONE descriptor would be tidier; `statSync` is fine here because nothing
    // reads the CONTENTS, so there is no age/bytes pair to tear.
    const { size } = statSync(path);
    if (size < floor) {
        fail(
            `${file} is ${size} bytes, under its ${floor} floor (measured ${measured} ` +
                `on 2026-11-16). A short bundle is a build that failed after opening its ` +
                `output file — which existsSync cannot tell from a good one. ${why}.`,
        );
        failed += 1;
        continue;
    }
    console.log(`[verify-image-artefacts]   OK   ${file} ${size} bytes (floor ${floor})`);
}

if (failed > 0) {
    fail(`${failed} of ${ARTEFACTS.length} artefact(s) missing or short.`);
    process.exit(1);
}

// The DENOMINATOR, printed. A green run over three artefacts and a green run
// over six are the same line without it.
console.log(
    `[verify-image-artefacts] OK — ${ARTEFACTS.length} artefact(s) present and above floor`,
);

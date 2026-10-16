/**
 * Copy maplibre's worker assets from node_modules into `public/maplibre/`.
 *
 * The two copies exist for a reason recorded in full in
 * `tests/guards/maplibre-worker-asset-sync.test.ts`: maplibre v6 loads its
 * worker from a real URL derived from its own `import.meta.url`, which under
 * webpack points into `/_next/static/chunks/` where no such file is emitted,
 * so the worker 404s and the map never initialises. They are CHECKED IN rather
 * than generated at build time because both generation hooks are dead ends in
 * this repo's Docker pipeline — `postinstall` runs in the `deps` stage, which
 * has no `public/`, and a `prebuild` script never fires because the builder
 * runs `npx next build --webpack` directly.
 *
 * None of that is re-litigated here. This script only replaces the shell
 * one-liner the guard's failure message prints, for two reasons:
 *
 *   · that one-liner uses brace expansion, which is bash and zsh but NOT
 *     POSIX sh or dash — so the remedy silently failed for anyone whose shell
 *     lacks it, in a way that looks like the copy having had no effect;
 *   · it gives the operation a NAME. Dependabot cannot run a `cp`, so every
 *     maplibre bump is blocked on a human running the message by hand.
 *
 * `--check` (#1807) compares without copying, for the CI step that makes the
 * drift visible as its own named check instead of two failures among 5395
 * tests in a sharded run. Owner ruling 2026-10-16: fail loudly with the
 * command, do NOT have CI commit the result — that would need
 * `pull_request_target` or a PAT, because GitHub gives a Dependabot-triggered
 * workflow a read-only token, and a job that can write to a bot branch is a
 * materially different trust posture.
 *
 * One implementation for both modes deliberately: a separate checker is a
 * second answer to the same question, and the two agree only until one is
 * corrected.
 *
 * It verifies afterwards rather than trusting `cp`: a copy whose source did
 * not exist leaves the stale file in place and exits 0, which is the failure
 * this script would otherwise make easier to reach.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'node_modules/maplibre-gl/dist');
const SERVED = join(ROOT, 'public/maplibre');

/** Kept in lockstep with REQUIRED_ASSETS in the guard. */
const ASSETS = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

if (!existsSync(DIST)) {
    console.error(
        `[sync-maplibre-worker] ${DIST} does not exist. Run \`npm ci\` first — ` +
            `without the installed package there is nothing to copy FROM, and a ` +
            `silent no-op here would leave the stale asset shipping.`,
    );
    process.exit(1);
}
/** Compare only — for CI, where copying would hide the drift it reports. */
const CHECK_ONLY = process.argv.includes('--check');

if (!CHECK_ONLY) mkdirSync(SERVED, { recursive: true });

const drifted = [];
let changed = 0;
for (const asset of ASSETS) {
    const from = join(DIST, asset);
    const to = join(SERVED, asset);
    if (!existsSync(from)) {
        console.error(
            `[sync-maplibre-worker] ${asset} is missing from the installed package. ` +
                `maplibre may have renamed or dropped it — check its dist/ before ` +
                `assuming this script is broken, and update ASSETS here AND ` +
                `REQUIRED_ASSETS in tests/guards/maplibre-worker-asset-sync.test.ts.`,
        );
        process.exit(1);
    }
    const before = existsSync(to) ? sha256(to) : null;

    if (CHECK_ONLY) {
        const want = sha256(from);
        if (before !== want) {
            drifted.push({ asset, served: before, installed: want });
        }
        console.log(
            `[sync-maplibre-worker] ${asset}: ${before === want ? 'in sync' : 'DRIFTED'} ` +
                `(served ${(before ?? 'absent').slice(0, 16)}… vs installed ${want.slice(0, 16)}…)`,
        );
        continue;
    }

    copyFileSync(from, to);
    const after = sha256(to);
    if (after !== sha256(from)) {
        console.error(`[sync-maplibre-worker] ${asset} did not land — copy verified unequal.`);
        process.exit(1);
    }
    if (before !== after) changed += 1;
    console.log(
        `[sync-maplibre-worker] ${asset}: ${before === after ? 'already in sync' : 'UPDATED'} ` +
            `(${after.slice(0, 16)}…)`,
    );
}

if (CHECK_ONLY) {
    if (drifted.length === 0) {
        console.log('[sync-maplibre-worker] --check: served assets match the installed package.');
        process.exit(0);
    }
    // A GitHub ANNOTATION, so this lands on the PR's Checks view rather than
    // only in a log somebody has to open. The remedy is one command and it is
    // in the message, because the whole point of #1807 is that nobody should
    // have to find the guard to learn it.
    for (const { asset, served, installed } of drifted) {
        console.log(
            `::error file=public/maplibre/${asset}::${asset} is stale — served ` +
                `${(served ?? 'absent').slice(0, 16)}…, installed ${installed.slice(0, 16)}…. ` +
                `Run \`npm run maplibre:sync\` and commit the result.`,
        );
    }
    console.error(
        `\n[sync-maplibre-worker] ${drifted.length} served asset(s) do not match the ` +
            `installed maplibre-gl.\n\n` +
            `  Fix:  npm run maplibre:sync && git add public/maplibre && git commit\n\n` +
            `Why this is not done for you: GitHub gives a Dependabot-triggered workflow a\n` +
            `read-only token, so committing from CI would need \`pull_request_target\` or a\n` +
            `PAT — a job that can write to a bot branch. Owner ruling 2026-10-16: fail\n` +
            `loudly instead (#1807).`,
    );
    process.exit(1);
}

console.log(
    changed === 0
        ? '[sync-maplibre-worker] nothing to do.'
        : `[sync-maplibre-worker] ${changed} file(s) refreshed — commit them WITH the bump.`,
);

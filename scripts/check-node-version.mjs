#!/usr/bin/env node
/**
 * Does this Node satisfy `engines.node`? — #2230.
 *
 * ## Why this is not `engine-strict` in `.npmrc` any more
 *
 * It was, and the reasoning was right: without it npm downgrades an engine
 * mismatch to an `EBADENGINE` warning that scrolls past in install output, so a
 * local Node 23/24 install silently produces a tree never validated against the
 * version CI and production actually run.
 *
 * What that setting could not distinguish is WHO is installing. On 2026-10-23
 * Dependabot's updater image moved to **node 24.22.1 / npm 12.2.1**, so
 * `corepack npm@12 install … --package-lock-only` became a hard `notsup` error
 * against `engines.node: ">=22.0.0 <23.0.0"` and **every security-update job
 * failed**. Nothing reported it: `Dependabot Updates` is GitHub-native, so
 * `ci-failure-issue.yml` has no workflow file to watch and its watchlist guard
 * derives from `readdirSync(.github/workflows)`.
 *
 * Both settings were correct. The fix is to stop asking npm to enforce a policy
 * about OUR toolchain on a third party's runner, and to check it where it
 * actually matters instead.
 *
 * ## Where it matters is LOCAL, which is the part worth being precise about
 *
 * CI cannot produce a wrong-node tree: every job installs through
 * `.github/actions/setup-node-prisma`, which pins `node-version` (default 22)
 * via `actions/setup-node`. So the failure mode the `.npmrc` comment described
 * — an unvalidated tree — is reachable only on a developer machine. That is
 * where this runs: `.husky/pre-commit`, which Dependabot never executes.
 *
 * The CI install step still sets `npm_config_engine_strict` as belt and braces,
 * because a pinned node version is a claim about configuration and this is a
 * claim about what is running.
 *
 * Usage: node scripts/check-node-version.mjs
 * Exits 1 with the required and actual ranges on a mismatch.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * A deliberately small subset of semver range syntax: exactly the comparator
 * form `engines.node` uses here (`>=22.0.0 <23.0.0`).
 *
 * It THROWS on anything it does not understand rather than passing. A range
 * parser that silently returns "satisfied" for a form it cannot read is the
 * same defect one level up — the check would report a clean result about a
 * constraint it never applied.
 */
export function satisfies(version, range) {
    const actual = version.replace(/^v/, '').split('.').map(Number);
    if (actual.length !== 3 || actual.some((n) => !Number.isFinite(n))) {
        throw new Error(`cannot parse node version: ${version}`);
    }
    const cmp = (a, b) => {
        for (let i = 0; i < 3; i += 1) {
            if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
        }
        return 0;
    };
    for (const raw of range.trim().split(/\s+/)) {
        const m = /^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$/.exec(raw);
        if (!m) throw new Error(`unsupported range comparator: ${raw} (in "${range}")`);
        const op = m[1] ?? '=';
        const want = [Number(m[2]), Number(m[3]), Number(m[4])];
        const c = cmp(actual, want);
        const ok =
            (op === '>=' && c >= 0)
            || (op === '<=' && c <= 0)
            || (op === '>' && c > 0)
            || (op === '<' && c < 0)
            || (op === '=' && c === 0);
        if (!ok) return false;
    }
    return true;
}

export function requiredRange() {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const range = pkg?.engines?.node;
    if (!range) throw new Error('package.json declares no engines.node — nothing to check against');
    return range;
}

const INVOKED_DIRECTLY =
    process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (INVOKED_DIRECTLY) {
    try {
        const range = requiredRange();
        if (!satisfies(process.version, range)) {
            console.error(
                `\nThis repository requires Node ${range}; you are running ${process.version}.\n\n`
                + `  Every CI job and every Dockerfile stage builds on node:22-alpine, so a tree\n`
                + `  installed on another major was never validated against what production runs.\n`
                + `  \`nvm use\` picks up .nvmrc (22).\n\n`
                + `  This check lives here rather than in .npmrc's engine-strict because that\n`
                + `  setting could not tell our machines from a third party's: Dependabot's\n`
                + `  updater moved to node 24 and every security-update run began failing (#2230).\n`,
            );
            process.exit(1);
        }
        console.log(`node ${process.version} satisfies engines.node ${range}`);
    } catch (err) {
        console.error(`node version check failed: ${err.message}`);
        process.exit(1);
    }
}

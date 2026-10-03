/**
 * The lockfile still tolerates a failed optional native download. (#1159)
 *
 * ## Why this is a script and not only the jest guard
 *
 * `tests/guards/image-build-install-resilience.test.ts` already asserts these
 * properties and CANNOT catch the failure: when the optional flags are gone,
 * `npm ci` dies on `onnxruntime-node`'s network postinstall before any test
 * runs. The guard is correct and unreachable — the signal arrives as a fully
 * red PR whose stated cause (#1159 was an ESLint patch bump) has nothing to do
 * with the real one.
 *
 * So this runs BEFORE `npm ci`, with zero dependencies: `node` plus `fs`, no
 * install required.
 *
 * ## What it checks, and why each one
 *
 *   1. Every name in package.json's `optionalDependencies` has `optional: true`
 *      on its LOCKFILE ENTRY. npm reads the flag there, not from the root
 *      declaration — a hand-patch that fixed only the declaration is exactly
 *      what shipped the first time (#1231).
 *   2. The total count of flagged entries has not fallen below its floor. That
 *      is the CLOSURE: a dependency of an optional package left unflagged is
 *      itself required, so the tolerance is defeated one level down. Dependabot
 *      dropped 8 of these (199 -> 191).
 *
 * `libc` entries are deliberately NOT checked here: they have their own guard
 * (`lockfile-libc-preserved`, floor 22) and need no pre-install check, because
 * a libc-stripped lockfile still INSTALLS — it just ships wrong-platform
 * binaries — so that guard fires normally. Only the optional flags kill
 * `npm ci` before any test can run.
 *
 * Floors live in `scripts/optional-closure-floors.json`, shared with the jest
 * guard so the two cannot drift.
 *
 * Usage:  node scripts/check-optional-closure.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const pkg = read('package.json');
const lock = read('package-lock.json');
const floors = read('scripts/optional-closure-floors.json');

const failures = [];

// ── control: the manifests parsed and carry a real population ────────
// Without this, an empty or truncated lockfile would satisfy every
// "nothing is missing" check below by having nothing in it.
const entryCount = Object.keys(lock.packages ?? {}).length;
if (entryCount < 500) {
    failures.push(
        `package-lock.json has only ${entryCount} package entries (expected >500) — ` +
            `truncated or unparsed, so every check below is meaningless.`,
    );
}

const optionalNames = Object.keys(pkg.optionalDependencies ?? {});
if (optionalNames.length === 0) {
    failures.push(
        'package.json declares NO optionalDependencies. If that is deliberate, this ' +
            'check and its jest counterpart should be deleted in the same diff; if it is ' +
            'not, the declaration was lost.',
    );
}

// ── 1. each named optional dependency is flagged on its ENTRY ────────
for (const name of optionalNames) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry) {
        failures.push(`node_modules/${name}: no lockfile entry at all`);
    } else if (entry.optional !== true) {
        failures.push(
            `node_modules/${name}: entry is NOT flagged \`"optional": true\` — ` +
                `npm reads the flag here, not from package.json, so its postinstall is fatal`,
        );
    }
}

// ── 2. the closure count has not fallen ──────────────────────────────
const flagged = Object.values(lock.packages ?? {}).filter(
    (e) => e && typeof e === 'object' && e.optional === true,
);
if (flagged.length < floors.optionalEntries) {
    failures.push(
        `optional-entry count is ${flagged.length}, floor is ${floors.optionalEntries} ` +
            `(short by ${floors.optionalEntries - flagged.length}). A lockfile regeneration ` +
            `dropped part of the optional CLOSURE — this is #1159. Restore the flags rather ` +
            `than lowering the floor.`,
    );
}


const width = 34;
console.log('');
console.log(`  ${'optional-closure check'.padEnd(width)} ${'actual'.padStart(8)} ${'floor'.padStart(8)}`);
console.log(`  ${'-'.repeat(width)} ${'-'.repeat(8)} ${'-'.repeat(8)}`);
console.log(`  ${'lockfile package entries'.padEnd(width)} ${String(entryCount).padStart(8)} ${'>500'.padStart(8)}`);
console.log(`  ${'declared optionalDependencies'.padEnd(width)} ${String(optionalNames.length).padStart(8)} ${'>0'.padStart(8)}`);
console.log(`  ${'entries flagged optional'.padEnd(width)} ${String(flagged.length).padStart(8)} ${String(floors.optionalEntries).padStart(8)}`);
console.log('');

if (failures.length > 0) {
    console.error(`  optional-closure check: FAIL (${failures.length})`);
    for (const f of failures) console.error(`    - ${f}`);
    console.error('');
    console.error('  Why this blocks the build rather than warning: without these flags');
    console.error('  `npm ci` treats onnxruntime-node\'s network postinstall as mandatory and');
    console.error('  dies, which is the production-deploy blocker #1231 fixed. The jest guard');
    console.error('  that also asserts this cannot run, because the install fails first.');
    process.exit(1);
}

console.log('  optional-closure check: PASS');

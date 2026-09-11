#!/usr/bin/env node
/**
 * Do a guard's selectors have teeth?
 *
 * The recurring defect in this repo is a guard whose assertion is
 * `expect(<selection>).toEqual([])` and whose SELECTOR is dead: it returns
 * nothing, so the assertion passes over an empty set. Five review rounds across
 * #860, #864, #865, #866 and #873 each closed the named instances and left a
 * population nobody had enumerated — `^RUN` then continuations then heredocs;
 * `docker exec` then `docker compose exec` then `docker container exec` then
 * `"${DOCKER}" exec`.
 *
 * Enumerating populations by hand does not converge. This enumerates MUTATIONS
 * instead, which is a small, fixed space: gut each module-level function to a
 * constant and see whether anything notices.
 *
 * Functions declared inside `it()` / `describe()` are never touched — those are
 * assertions, and mutating them would produce noise rather than signal.
 *
 * Usage:  node scripts/selector-teeth.mjs <file.test.ts> [...]
 *         node scripts/selector-teeth.mjs --json <file.test.ts>
 * Exit:   0 if every selector was killed, 1 if any survived.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * CRASH SAFETY. This tool writes a mutation into a REAL source file and relies
 * on restoring it. A SIGKILL — a CI timeout, a `pkill`, an out-of-memory — skips
 * `finally` and leaves the mutation in the working tree, where it can be
 * committed by accident. That happened while this script was being written.
 *
 * Two defences. First, restore any stray backup at STARTUP, before touching
 * anything, so a killed run self-heals on the next invocation. Second, restore
 * on every signal we can catch. Neither helps against SIGKILL mid-write, which
 * is why `tests/guards/selector-teeth-no-stray-mutations.test.ts` also fails the
 * suite if a `.teeth-bak` is ever left lying around.
 */
const BAK = (f) => `${f}.teeth-bak`;

function restoreIfStray(file) {
    if (existsSync(BAK(file))) {
        copyFileSync(BAK(file), file);
        unlinkSync(BAK(file));
        console.error(`  [recovered] restored ${file} from a previous interrupted run`);
    }
}

let ACTIVE = null;
function restoreActive() {
    if (ACTIVE && existsSync(BAK(ACTIVE))) {
        copyFileSync(BAK(ACTIVE), ACTIVE);
        unlinkSync(BAK(ACTIVE));
    }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restoreActive(); process.exit(130); });
}
process.on('uncaughtException', (e) => { restoreActive(); throw e; });

/** Constants to gut a function body with. First one that TYPECHECKS is used. */
const GUTS = ['[]', "''", '0', 'null', 'undefined', 'false', 'new Set()', 'new Map()', '{}'];

/** Module-level `function name(...)` declarations, with their body extents. */
export function selectorsIn(src) {
    const lines = src.split('\n');
    const out = [];
    let inBlock = 0;
    for (let i = 0; i < lines.length; i++) {
        // crude but sufficient: track describe/it nesting so we never mutate an
        // assertion. A selector declared inside a describe is rare and, if it
        // exists, is genuinely part of the test rather than the population.
        if (/\b(describe|it|test)\s*(\.\w+)?\s*\(/.test(lines[i])) inBlock++;
        if (inBlock > 0) {
            const opens = (lines[i].match(/\{/g) ?? []).length;
            const closes = (lines[i].match(/\}/g) ?? []).length;
            if (closes > opens && inBlock > 0) inBlock = Math.max(0, inBlock - 1);
        }
        const m = /^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);
        if (!m || inBlock > 0) continue;
        let depth = 0, started = false, end = -1;
        for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j]) {
                if (ch === '{') { depth++; started = true; }
                else if (ch === '}') depth--;
            }
            if (started && depth === 0) { end = j; break; }
        }
        if (end > i) out.push({ name: m[1], start: i, end });
    }
    return out;
}

function runGuard(file) {
    // BOTH streams. jest writes its summary ("Test Suites: ... / Tests: ...")
    // to STDERR, so capturing only stdout made every PASSING run look like a
    // run with no summary at all — which the survival test then skipped. The
    // tool reported "no gut typechecked" for selectors it had never scored.
    const r = spawnSync('npx', ['jest', file, '--silent'], { encoding: 'utf8' });
    return { out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, ok: r.status === 0 };
}

/**
 * A mutation SURVIVED only if the suite actually ran and everything passed.
 *
 * Asserted POSITIVELY, on the shape of a clean pass. The first version
 * blacklisted error strings and treated "not red" as survived — so a gut that
 * failed to COMPILE produced
 *     Test Suites: 1 failed, 1 total
 *     Tests:       0 total
 * with no "Tests: N failed" line, and was reported as a surviving mutation. The
 * tool over-reported dead selectors on exactly the mutations that never ran.
 *
 * Blacklisting spellings of failure is the same mistake as Direction C in the
 * postgis guard, which banned `head -1` and was beaten by `head -n 1`. There
 * are unbounded ways to not-run; there is one way to pass.
 */
function cleanPass(out) {
    const suites = /Test Suites:\s+([^\n]*)/.exec(out)?.[1] ?? '';
    const tests = /Tests:\s+([^\n]*)/.exec(out)?.[1] ?? '';
    if (!suites || !tests) return false;                 // never got to a summary
    if (/failed/.test(suites) || /failed/.test(tests)) return false;
    const passed = /(\d+) passed/.exec(tests);
    return Boolean(passed) && Number(passed[1]) > 0;     // and it actually ran assertions
}

/** Did the mutation produce a real, running variant at all? */
function ranAtAll(out) {
    return /Tests:\s+[^\n]*\d+ (passed|failed)/.test(out);
}

export function auditFile(file) {
    restoreIfStray(file);
    const original = readFileSync(file, 'utf8');
    const backup = BAK(file);
    copyFileSync(file, backup);
    ACTIVE = file;
    const survivors = [];
    const untestable = [];
    try {
        for (const sel of selectorsIn(original)) {
            const lines = original.split('\n');
            // EVERY gut that typechecks must be killed. Stopping at the first
            // kill was the tool's own instance of the defect it hunts: gutting
            // `pick()` to `null` fails an assertion (irrelevant), while gutting
            // it to `[]` — the realistic dead-selector shape — passes. Breaking
            // on the `null` kill reported "has teeth" about a selector that is
            // wide open. The success criterion was satisfied by an observation
            // that had nothing to do with the question.
            const survivedGuts = [];
            let anyCompiled = false;
            for (const gut of GUTS) {
                const mutated = [...lines];
                mutated.splice(sel.start + 1, sel.end - sel.start - 1, `    return ${gut};`);
                writeFileSync(file, mutated.join('\n'));
                const { out } = runGuard(file);
                // A gut whose return type does not typecheck never runs, so it
                // is not a mutation of this program at all — skip, do not score.
                if (!ranAtAll(out)) continue;
                anyCompiled = true;
                if (cleanPass(out)) survivedGuts.push(gut);
            }
            if (!anyCompiled) untestable.push(sel.name);
            else if (survivedGuts.length) {
                survivors.push({ selector: sel.name, gut: survivedGuts.join(' | '), line: sel.start + 1 });
            }
        }
    } finally {
        copyFileSync(backup, file);
        unlinkSync(backup);
        ACTIVE = null;
    }
    return { file, survivors, untestable };
}

// Only run the CLI when invoked directly — the audit functions above are
// imported by the tool's own tests, and running the CLI on import made that
// impossible (it exited with a usage message).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('selector-teeth.mjs');
if (!invokedDirectly) { /* imported: expose the API only */ }
else {
/**
 * Known survivors, loaded from tests/guards/selector-teeth-baseline.json.
 *
 * A survivor listed there does not fail the run; one that is NOT listed does.
 * And a listed entry that no longer survives ALSO fails, so the file cannot rot
 * into a permanent allowlist — the failure names it and says to delete it.
 */
function loadBaseline() {
  try {
    const raw = readFileSync('tests/guards/selector-teeth-baseline.json', 'utf8');
    return JSON.parse(raw).known ?? {};
  } catch {
    return {};
  }
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const files = args.filter((a) => !a.startsWith('--'));
if (files.length === 0) {
    console.error('usage: selector-teeth.mjs [--json] <file.test.ts> [...]');
    process.exit(2);
}
const results = files.map(auditFile);
const baseline = loadBaseline();

/** Survivors this run found that the baseline does not excuse. */
const unexpected = [];
/** Baseline entries that no longer survive — the list must shrink. */
const stale = [];
for (const r of results) {
    const listed = baseline[r.file] ?? [];
    for (const s of r.survivors) {
        if (!listed.includes(s.selector)) unexpected.push(`${r.file}:${s.line}  ${s.selector}()`);
    }
    const found = new Set(r.survivors.map((s) => s.selector));
    for (const name of listed) {
        if (!found.has(name)) stale.push(`${r.file}  ${name}()`);
    }
}

if (asJson) {
    console.log(JSON.stringify({ results, unexpected, stale }, null, 2));
} else {
    for (const r of results) {
        for (const s of r.survivors) console.log(`  ${r.file}:${s.line}  ${s.selector}() → return ${s.gut}  SURVIVED`);
        for (const u of r.untestable) console.log(`  ${r.file}  ${u}()  no gut typechecked — not tested`);
        if (!r.survivors.length && !r.untestable.length) console.log(`  ${r.file}  all selectors have teeth`);
    }
}
if (unexpected.length) {
    console.log('\nNEW dead selectors (not in tests/guards/selector-teeth-baseline.json):');
    for (const u of unexpected) console.log(`  ${u}`);
    console.log('\nEach needs a control proving its selector can select on the population');
    console.log('its guard actually scans. If you are knowingly deferring, add it to the');
    console.log('baseline in this PR so the debt is visible in the diff.');
}
if (stale.length) {
    console.log('\nBASELINE ENTRIES THAT NO LONGER SURVIVE — delete them:');
    for (const s of stale) console.log(`  ${s}`);
    console.log('\nThese were fixed. Leaving them listed would let the file rot into a');
    console.log('permanent allowlist, which is what the baseline exists to avoid.');
}
process.exit(unexpected.length || stale.length ? 1 : 0);
}

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
import ts from 'typescript';

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
/**
 * Best-effort, and NOT a guarantee — measured 2026-09-17.
 *
 * Almost all of this tool's wall clock is spent inside `spawnSync`, which
 * blocks the event loop, and node cannot deliver a signal while it is blocked.
 * A SIGTERM that arrives mid-jest is therefore queued behind a child that may
 * outlive the parent, and the process can die with the guard still gutted and
 * a `.teeth-bak` on disk. That happened during a timed-out sweep and left
 * `state-primitives-discipline.test.ts` holding `return {};`.
 *
 * Two things cover it and both are downstream of this handler, not in it: the
 * `[recovered]` path above restores the backup on the NEXT run, and
 * `tests/guards/selector-teeth-no-stray-mutations.test.ts` fails the build if
 * one is left behind. Fixing it here would mean an async spawn and a rewritten
 * run loop; the mitigations are cheaper and already exist.
 *
 * If you interrupt a sweep, run the tool again — or `git status` before you
 * commit.
 */
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restoreActive(); process.exit(130); });
}
process.on('uncaughtException', (e) => { restoreActive(); throw e; });

/** Constants to gut a function body with. First one that TYPECHECKS is used. */
const GUTS = ['[]', "''", '0', 'null', 'undefined', 'false', 'new Set()', 'new Map()', '{}'];

/**
 * Every module-level function-valued declaration, with its body extent.
 *
 * Parsed with the TypeScript compiler rather than matched line by line. The
 * regex version this replaced had two independent false negatives, and both
 * pointed toward "nothing to audit", which reads as a pass:
 *
 *   - Its describe/it gate was `/\b(describe|it|test)\s*(\.\w+)?\s*\(/`,
 *     which also matches `RegExp.prototype.test` — `/^Dockerfile/.test(f)` —
 *     and prose inside a `/** *\/` doc comment, e.g. a line reading
 *     `*   test('A creates it', async () => {`.
 *   - Its counter only ever decremented when a line closed more braces than it
 *     opened, and only by one. So once a brace-opening false positive pushed it
 *     above zero it could never come back down, and EVERY module-level function
 *     later in the file was silently skipped. In `e2e-isolation.test.ts` the
 *     counter stuck at line 13 and all six functions — declared at lines 57-218,
 *     all before the only real `describe` at 234 — were dropped.
 *
 * Measured against the parser over `tests/guards` + `tests/guardrails`: the
 * regex saw 599 of 885 real declarations, missing 286 (32%), and called 338 of
 * 621 files "nothing to audit" when only 186 truly have nothing at module level.
 *
 * The gate is GONE rather than patched, because `sourceFile.statements` IS the
 * module level: a function declared inside `describe()` is not a top-level
 * statement and cannot appear here by construction. A class of defect is
 * removed instead of one spelling of it.
 *
 * A hand-rolled lexer was prototyped first and measured WORSE than the regex
 * (528 candidates / 350 zero-candidate files). Regex literals are why: a
 * pattern like `/['"]/` or `/\{/` opens a phantom string or brace in any
 * scanner that does not track regex-literal context. Do not reach for one.
 *
 * Returns CHARACTER offsets, not line numbers. A concise-bodied arrow
 * (`const read = (rel) => fs.readFileSync(rel)`) has no block for a
 * line-splice to replace, so line extents cannot express it — that bucket is
 * 10 of the 46 unreachable files on its own.
 */
export function selectorsIn(src) {
    const sf = ts.createSourceFile('guard.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const out = [];

    const record = (name, declNode, body) => {
        out.push({
            name,
            // 'block' bodies are replaced wholesale; an expression body is
            // substituted in place, because there is no `return` to write.
            kind: ts.isBlock(body) ? 'block' : 'expr',
            bodyStart: body.getStart(sf),
            bodyEnd: body.getEnd(),
            line: sf.getLineAndCharacterOfPosition(declNode.getStart(sf)).line + 1,
        });
    };

    for (const stmt of sf.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
            record(stmt.name.text, stmt, stmt.body);
            continue;
        }
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
            const init = decl.initializer;
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
                record(decl.name.text, decl, init.body);
            }
        }
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
    // Counted, and reported, because "every selector was killed" and "there
    // was nothing to kill" are the SAME output otherwise — see the note on
    // `candidates` in the return value below.
    const selectors = selectorsIn(original);
    try {
        for (const sel of selectors) {
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
                // Parenthesised for the expression case: `() => {}` parses as
                // an empty BLOCK, not an object literal, so a bare `{}` gut
                // would silently become a no-op body instead of a return value.
                const replacement = sel.kind === 'block' ? `{ return ${gut}; }` : `(${gut})`;
                const mutated =
                    original.slice(0, sel.bodyStart) + replacement + original.slice(sel.bodyEnd);
                writeFileSync(file, mutated);
                const { out } = runGuard(file);
                // A gut whose return type does not typecheck never runs, so it
                // is not a mutation of this program at all — skip, do not score.
                if (!ranAtAll(out)) continue;
                anyCompiled = true;
                if (cleanPass(out)) survivedGuts.push(gut);
            }
            if (!anyCompiled) untestable.push(sel.name);
            else if (survivedGuts.length) {
                survivors.push({ selector: sel.name, gut: survivedGuts.join(' | '), line: sel.line });
            }
        }
    } finally {
        copyFileSync(backup, file);
        unlinkSync(backup);
        ACTIVE = null;
    }
    /**
     * `candidates` is the DENOMINATOR, and it is load-bearing.
     *
     * This tool only mutates MODULE-LEVEL functions — functions declared
     * inside `it()` / `describe()` are deliberately never touched (see the
     * header). A guard that does its selecting inline inside `it()` therefore
     * offers nothing to gut, and until this field existed the run reported
     * `all selectors have teeth` for it: a clean bill of health from an audit
     * that examined nothing.
     *
     * That is the very defect this tool hunts, one level up — an empty
     * selection reading as a pass. A caller can tell "audited and clean"
     * (`candidates > 0`, no survivors) from "not audited" (`candidates === 0`).
     *
     * This docblock used to claim "188 of 617 files have zero candidates, so
     * almost a third of the population". Both halves were wrong. Re-measured at
     * the commit it cited, with `selectorsIn` byte-identical: the real figure
     * under the line-based scanner was 338 of 617 — a MAJORITY, not a third —
     * and 152 of those files were mislabelled rather than genuinely empty. With
     * the parser the honest number is 186 of 621, and the denominator this
     * field reports finally means what it says.
     */
    return { file, candidates: selectors.length, survivors, untestable };
}

/**
 * The whole report, as ONE string.
 *
 * `--json` used to print a valid document and then append prose to the SAME
 * stream, because the "NEW dead selectors" and "BASELINE ENTRIES" blocks sat
 * outside the `else`. stdout therefore stopped being JSON exactly when there
 * was something to report: a machine-readable mode that parsed only while the
 * news was good. A sweep of 94 guards hit it on 42 of them and recorded every
 * one as "unparsed" — while the data it wanted sat in the `unexpected` and
 * `stale` fields of the document it could no longer read.
 *
 * Guarding each block with `!asJson` would have fixed it. Returning ONE value
 * makes it unrepresentable instead: the JSON branch is a single `return`, so no
 * later edit can append to it without first deleting that return. Same reason
 * `cleanPass` asserts a clean pass positively rather than blacklisting failure
 * spellings — there are unbounded ways to append, and one way not to.
 *
 * Exported so the property is testable in milliseconds. Proving it through the
 * CLI costs a real audit: 178s for the one-selector fixture.
 */
export function formatReport({ results, unexpected, stale }, asJson) {
    if (asJson) return JSON.stringify({ results, unexpected, stale }, null, 2);

    const out = [];
    for (const r of results) {
        for (const s of r.survivors) out.push(`  ${r.file}:${s.line}  ${s.selector}() \u2192 return ${s.gut}  SURVIVED`);
        for (const u of r.untestable) out.push(`  ${r.file}  ${u}()  no gut typechecked \u2014 not tested`);
        if (r.candidates === 0) {
            out.push(
                `  ${r.file}  NOT AUDITED - no module-level selectors. Its selecting ` +
                    `happens inline inside it(), which this tool does not mutate.`,
            );
        } else if (!r.survivors.length && !r.untestable.length) {
            out.push(`  ${r.file}  all ${r.candidates} selector(s) have teeth`);
        }
    }
    if (unexpected.length) {
        out.push('\nNEW dead selectors (not in tests/guards/selector-teeth-baseline.json):');
        for (const u of unexpected) out.push(`  ${u}`);
        out.push('\nEach needs a control proving its selector can select on the population');
        out.push('its guard actually scans. If you are knowingly deferring, add it to the');
        out.push('baseline in this PR so the debt is visible in the diff.');
    }
    if (stale.length) {
        out.push('\nBASELINE ENTRIES THAT NO LONGER SURVIVE \u2014 delete them:');
        for (const s of stale) out.push(`  ${s}`);
        out.push('\nThese were fixed. Leaving them listed would let the file rot into a');
        out.push('permanent allowlist, which is what the baseline exists to avoid.');
    }
    return out.join('\n');
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

console.log(formatReport({ results, unexpected, stale }, asJson));

process.exit(unexpected.length || stale.length ? 1 : 0);
}

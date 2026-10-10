#!/usr/bin/env node
/**
 * Report i18n keys that no call site can reach — ADVISORY, never a gate
 * (#1534).
 *
 * ## What this exists for, and what the existing numbers do NOT say
 *
 * CI prints `missing=0 orphan=0 drift=0 untranslated=0` on every run. All four
 * range over *two JSON catalogues agreeing with each other*:
 * `scripts/i18n-diff.mjs:83` computes `orphan` as keys in bg absent from en and
 * never reads `src/` at all. So none of them is evidence that a key is
 * REACHABLE, and a reader who takes `orphan=0` as "no dead keys" has read a
 * correct number as the answer to a different question.
 *
 * ## Why this cannot be a ratchet, and the number that proves it
 *
 * At least one real key is reachable only through a runtime value:
 *
 *     // SmartDefaultsBanner.tsx:44,70
 *     const t = useTranslations('locations.smart');
 *     …   .map((r) => t(`sprayReason.${r.code}`, r.params))
 *
 * No static scan resolves `${r.code}`. A gate that failed on unreferenced keys
 * would demand the deletion of keys the app renders. So this reports THREE
 * numbers and refuses to collapse them:
 *
 *     referenced    a literal call site resolves to it
 *     undecidable   it sits under a prefix some call site builds dynamically
 *     unreferenced  neither — a CANDIDATE for review, not a verdict
 *
 * `unreferenced` is the only actionable set, and it is a candidate list. #1501
 * removed 50 keys this way and each one took three checks by hand.
 *
 * ## Resolution is by VARIABLE NAME, not by file
 *
 * Measured before writing this: 104 files bind more than one translator, one of
 * them nine. So "the namespace of this file" is not a thing, and a per-file
 * model would mis-attribute every call in those 104. Each binding
 *
 *     const <var> = [await] useTranslations|getTranslations('<ns>')
 *
 * maps a NAME to a namespace, and `<var>('key')` resolves against that name.
 * Measured too: 0 bindings take a non-literal namespace and 0 take none, so
 * every scope is resolvable — that is what makes this worth doing at all.
 *
 * Prefix composition falls out of the same mechanism rather than needing a
 * special case: `useTranslations('agStatus')` + `t('spray.parcelsDone')` is
 * `agStatus.spray.parcelsDone`, and a dotted namespace
 * (`useTranslations('ui.table')`) is just a longer prefix.
 *
 * ## Known limits, stated because an advisory tool that hides them is worse
 *
 *  - A translator passed as a prop or returned from a helper is not tracked.
 *    The full-literal sweep below is the backstop: any quoted string anywhere
 *    in `src/` that EXACTLY equals a full key path counts as referenced.
 *    `explainRefusal` (`lib/grain/uncertainty.ts:270`) takes its translator as
 *    a PARAMETER and builds `` `refusal.${code}` `` from it, so those keys
 *    resolve against whatever namespace the caller bound and are invisible
 *    here.
 *  - `translate(` is deliberately NOT matched. Most occurrences in this tree
 *    are CSS transforms (`translate(${x}px, ${y}px)`) inside style strings,
 *    and matching the name would file those as undecidable key prefixes.
 *  - Comments are blanked (line comments first — a `//` line containing `/*`
 *    otherwise opens a block that eats real code, #1497). A key mentioned only
 *    in a comment is dead, and counting the mention as a reference would hide
 *    it.
 *  - A local function genuinely named `t` that is not a translator would
 *    contribute false references. That direction is safe: it UNDER-reports
 *    dead keys.
 *
 * Every limit above pushes toward calling a dead key live. So `unreferenced` is
 * a floor, and the real dead set is at least this big.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const REPO = process.cwd();
const CATALOGUE = join(REPO, 'messages/en.json');
const ROOTS = ['src'];
const EXT = new Set(['.ts', '.tsx']);

/** Blank comments, keeping strings — a module specifier IS a string. */
function blankComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    let mode = null;
    let quote = null;
    while (i < n) {
        const c = src[i];
        const d = i + 1 < n ? src[i + 1] : '';
        if (mode === null) {
            if (c === '/' && d === '/') { mode = 'line'; out += '  '; i += 2; continue; }
            if (c === '/' && d === '*') { mode = 'block'; out += '  '; i += 2; continue; }
            if (c === '"' || c === "'" || c === '`') { mode = 'str'; quote = c; out += c; i += 1; continue; }
            out += c; i += 1; continue;
        }
        if (mode === 'line') {
            if (c === '\n') { mode = null; out += '\n'; } else out += ' ';
            i += 1; continue;
        }
        if (mode === 'block') {
            if (c === '*' && d === '/') { mode = null; out += '  '; i += 2; continue; }
            out += c === '\n' ? '\n' : ' ';
            i += 1; continue;
        }
        // in a string
        out += c;
        if (c === '\\') { if (i + 1 < n) { out += src[i + 1]; i += 2; continue; } }
        else if (c === quote) { mode = null; quote = null; }
        i += 1;
    }
    return out;
}

function flatten(obj, prefix = '', acc = new Set()) {
    for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, acc);
        else acc.add(path);
    }
    return acc;
}

function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        const st = statSync(full);
        if (st.isDirectory()) {
            if (e === 'node_modules' || e === 'generated') continue;
            walk(full, out);
        } else if (EXT.has(extname(e))) out.push(full);
    }
    return out;
}

const keys = flatten(JSON.parse(readFileSync(CATALOGUE, 'utf8')));
const files = ROOTS.flatMap((r) => walk(join(REPO, r)));

const BIND = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*['"]([^'"]+)['"]\s*\)/g;
const referenced = new Set();
const undecidablePrefixes = new Set();
const allStrings = new Set();
let literalCalls = 0;
let dynamicCalls = 0;
let wholeNamespaceDynamic = 0;

for (const file of files) {
    const code = blankComments(readFileSync(file, 'utf8'));

    // every quoted string, for the full-path backstop
    for (const m of code.matchAll(/['"]([A-Za-z][\w.]*)['"]/g)) allStrings.add(m[1]);

    const vars = new Map();
    for (const m of code.matchAll(BIND)) vars.set(m[1], m[2]);
    if (vars.size === 0) continue;

    for (const [name, ns] of vars) {
        // Escape EVERY regex metacharacter, backslash included. The first
        // version escaped only `$` — CodeQL flagged it high-severity
        // ("Incomplete string escaping or encoding: this does not escape
        // backslash characters in the input") on #1564, and it was right about
        // the pattern even though a JS identifier cannot contain a backslash:
        // the binding name comes from a regex capture over source text, so the
        // safety argument rests on the OTHER pattern staying narrow rather
        // than on this line being correct. Same idiom as
        // `tests/guards/optional-deps-do-not-gate-typecheck.test.ts:90`.
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // <var>('key') / <var>("key")
        for (const m of code.matchAll(new RegExp(`\\b${esc}\\(\\s*['"]([^'"]+)['"]`, 'g'))) {
            referenced.add(`${ns}.${m[1]}`);
            literalCalls += 1;
        }
        // <var>(`static.${dynamic}`) — only the STATIC prefix is undecidable.
        // Marking the whole namespace would bury 559 `ui.*` keys because one
        // call site builds one `ui.…` key dynamically; taking the literal head
        // of the template keeps the undecidable set to what is actually
        // unresolvable.
        for (const m of code.matchAll(new RegExp(`\\b${esc}\\(\\s*\`([^\`]*?)\\$\\{`, 'g'))) {
            const head = m[1];
            const cut = head.lastIndexOf('.');
            // `sprayReason.${code}` -> `<ns>.sprayReason`; `${code}` -> `<ns>`
            undecidablePrefixes.add(cut === -1 ? ns : `${ns}.${head.slice(0, cut)}`);
            dynamicCalls += 1;
        }
        // <var>(identifier) or <var>(obj.prop) — nothing static at all, so the
        // whole namespace is unresolvable. Kept separate from the template case
        // because it is a genuinely weaker position, and the counts should not
        // conflate them.
        //
        // The character class admits DOTS, and that is not cosmetic. Without
        // them the pattern stopped at the `.` and then required `,` or `)`,
        // so a member-expression key matched nothing:
        //
        //     // BackAffordance.tsx:123
        //     t.has(destination.label) ? t(destination.label) : destination.label
        //
        // `backNav` was reported 37 of 38 dead as a result — every key reached
        // through that line. Nine such call sites exist (`step.labelKey`,
        // `section.key`, `cls.destination.labelKey`, …), each silently costing
        // its namespace.
        //
        // Worth noting WHICH call sites these are: `t.has(k) ? t(k) : k` is the
        // correct way to call a possibly-missing key, so the most carefully
        // written sites were the ones most likely to be misreported.
        for (const _ of code.matchAll(new RegExp(`\\b${esc}\\(\\s*[A-Za-z_$][\\w$.]*\\s*[,)]`, 'g'))) {
            undecidablePrefixes.add(ns);
            dynamicCalls += 1;
            wholeNamespaceDynamic += 1;
        }
    }
}

// ── Server-side emails use a DIFFERENT mechanism (#1534 follow-up) ──
//
// `translateFor(locale, key, params?)` (`lib/i18n/server-messages.ts:69`)
// takes the FULL key path as its second argument and never binds a namespace,
// so none of the `useTranslations` resolution above sees it. Measured when
// `notificationEmail` came back 99-of-106 unreferenced: nothing binds that
// namespace, because the email templates do not use a translator object at
// all.
//
// The literal form is already covered by the backstop below — a full key path
// in quotes is a full key path wherever it appears. The TEMPLATE form is not,
// and that was the false-positive class: 19 call sites build keys like
// `` `notificationEmail.taskAssigned.${key}` ``, whose static head is exactly
// the undecidable prefix the template logic above computes for a bound
// translator.
//
// Sibling helper `translate(` is NOT matched, on purpose: most occurrences
// here are CSS transforms in style strings, and the name collision would file
// those as key prefixes.
for (const file of files) {
    const code = blankComments(readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/translateFor\(\s*[^,]+,\s*`([^`]*?)\$\{/g)) {
        const head = m[1];
        const cut = head.lastIndexOf('.');
        if (cut === -1) continue; // no dotted head: nothing resolvable to name
        undecidablePrefixes.add(head.slice(0, cut));
        dynamicCalls += 1;
    }
}

// Backstop: a full key path appearing as a quoted literal anywhere.
for (const k of keys) if (allStrings.has(k)) referenced.add(k);

const underUndecidable = (k) =>
    [...undecidablePrefixes].some((p) => k === p || k.startsWith(`${p}.`));

const live = [];
const undecided = [];
const dead = [];
for (const k of keys) {
    if (referenced.has(k)) live.push(k);
    else if (underUndecidable(k)) undecided.push(k);
    else dead.push(k);
}

// ── the three numbers, and the identity that makes them trustworthy ──
const total = keys.size;
if (live.length + undecided.length + dead.length !== total) {
    console.error(
        `[i18n-dead-keys] the partition does not cover the catalogue: ` +
            `${live.length} + ${undecided.length} + ${dead.length} != ${total}`,
    );
    process.exit(2);
}

const byNamespace = new Map();
for (const k of dead) {
    const ns = k.split('.')[0];
    byNamespace.set(ns, (byNamespace.get(ns) ?? 0) + 1);
}
const nsTotal = new Map();
for (const k of keys) {
    const ns = k.split('.')[0];
    nsTotal.set(ns, (nsTotal.get(ns) ?? 0) + 1);
}

// Machine-readable form, so a test can assert on the partition rather than
// parse this script's prose. Printed BEFORE the human report and nothing else,
// so `--json` output stays valid JSON.
if (process.argv.includes('--json')) {
    process.stdout.write(
        `${JSON.stringify(
            {
                total,
                referenced: live.length,
                undecidable: undecided.length,
                unreferenced: dead.length,
                filesScanned: files.length,
                literalCalls,
                dynamicCalls,
                wholeNamespaceDynamic,
                undecidablePrefixes: [...undecidablePrefixes].sort(),
                unreferencedKeys: dead.slice().sort(),
            },
            null,
            0,
        )}\n`,
    );
    process.exit(0);
}

console.log(`[i18n-dead-keys] catalogue: ${CATALOGUE.replace(`${REPO}/`, '')}`);
console.log(`[i18n-dead-keys] files scanned: ${files.length}`);
console.log(
    `[i18n-dead-keys] literal call sites: ${literalCalls}  dynamic: ${dynamicCalls}` +
        ` (of which ${wholeNamespaceDynamic} pass a bare identifier, so their WHOLE namespace is unresolvable)`,
);
console.log(`[i18n-dead-keys] undecidable namespaces: ${[...undecidablePrefixes].sort().join(', ') || '(none)'}`);
console.log('');
console.log(`  referenced   ${String(live.length).padStart(5)}  a literal call site resolves to it`);
console.log(`  undecidable  ${String(undecided.length).padStart(5)}  under a dynamically-built prefix`);
console.log(`  unreferenced ${String(dead.length).padStart(5)}  CANDIDATE for review — not a verdict`);
console.log(`  ${''.padEnd(13)}${String(total).padStart(5)}  total (the three above sum to this)`);
console.log('');
console.log('  worst namespaces by unreferenced count:');
for (const [ns, n] of [...byNamespace.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${ns.padEnd(16)} ${String(n).padStart(4)} of ${nsTotal.get(ns)}`);
}

if (process.argv.includes('--list')) {
    console.log('\n  unreferenced keys:');
    for (const k of dead.sort()) console.log(`    ${k}`);
}

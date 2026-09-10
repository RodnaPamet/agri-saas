/**
 * `docs/dependency-policy.md` — the MACHINE-CHECKABLE half, and only that.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not widened later into the
 * thing it deliberately is not:
 *
 * That document is permanent governance and, until this guard, NOTHING
 * asserted its contents. Measured on 2026-09-11 against the full suite:
 * replacing the `picomatch` security row with a deliberately false one —
 * wrong package, invented advisory, inverted production/dev claim — left the
 * run green; gutting the file to one junk line left it green; DELETING the
 * file failed exactly one assertion, the existence check in
 * `dependency-governance-integrity.test.ts`. That is the defect class this
 * repo has been fighting all week: an observable BOTH the healthy and the
 * broken document produce.
 *
 * The obvious implementation — assert some phrases are present — IS that
 * defect class. A row can keep every phrase it has and invert its meaning
 * (#860's guard was defeated by a flag satisfied by its own name in a
 * trailing comment). So this guard checks NO PROSE. It checks the things a
 * machine can settle, each against a source of truth OUTSIDE the document:
 *
 *   1. doc row  ↔ `package.json` overrides — BOTH directions, because a
 *      deleted row and an undocumented override are both drift.
 *   2. the `Scope` column (production / dev / absent) ↔ `package-lock.json`
 *      (`dev: true` on the resolved entries).
 *   3. the resolved lockfile version ↔ the floor/ceiling the row states.
 *   4. a security row's floor vs the PATCHED VERSION its own Advisory cell
 *      names. This is the error that actually shipped: #863's picomatch row
 *      read a floor-decay hygiene raise as a fix for CVE-2026-33671 when
 *      4.0.4 was already the patched line.
 *   5. every `Checked` date parses, is not in the future, and is younger
 *      than REVIEW_MAX_AGE_DAYS.
 *
 * Everything else on that page — every Cause / Resolution / Defect / Why
 * cell, every narrative section — is UNGUARDED, and the document says so in
 * its own words under "What is machine-checked here, and what is NOT". The
 * guard's silence is not endorsement of the reasoning.
 *
 * The "teeth" describe block at the bottom mutates the REAL parsed rows —
 * not fixtures — and asserts each checker reports the corruption. A checker
 * fed a fixture proves nothing about the input the production tree produces.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const DOC_REL = 'docs/dependency-policy.md';

const DOC = fs.readFileSync(path.join(ROOT, DOC_REL), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

/** A `Checked` date older than this must be re-read by a human. */
const REVIEW_MAX_AGE_DAYS = 365;

// ─────────────────────────────────────────────────────────────────────────
// Minimal semver. The repo declares no `semver` dependency (and no
// @types/semver), and a guard that stands on a transitive package is a
// guard that can vanish in a lockfile regeneration. Every helper here is
// exercised by its own positive AND negative assertions below — a
// comparator that always returned true would make every version check a
// tautology.
// ─────────────────────────────────────────────────────────────────────────
type Version = [number, number, number];
interface Comparator {
    op: '>=' | '>' | '<=' | '<' | '=';
    version: Version;
}

function parseVersion(raw: string): Version | null {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpVersion(a: Version, b: Version): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

function caretUpper([maj, min, pat]: Version): Version {
    if (maj > 0) return [maj + 1, 0, 0];
    if (min > 0) return [0, min + 1, 0];
    return [0, 0, pat + 1];
}

/** `^4.0.7`, `>=2.2.16 <2.2.25`, `1.2.3` → comparators. `$react` → null. */
function parseRange(range: string): Comparator[] | null {
    const tokens = range.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const out: Comparator[] = [];
    for (const token of tokens) {
        const caret = /^\^(\d+\.\d+\.\d+)$/.exec(token);
        if (caret) {
            const v = parseVersion(caret[1])!;
            out.push({ op: '>=', version: v }, { op: '<', version: caretUpper(v) });
            continue;
        }
        const tilde = /^~(\d+\.\d+\.\d+)$/.exec(token);
        if (tilde) {
            const v = parseVersion(tilde[1])!;
            out.push({ op: '>=', version: v }, { op: '<', version: [v[0], v[1] + 1, 0] });
            continue;
        }
        const cmp = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(token);
        if (!cmp) return null;
        out.push({ op: (cmp[1] as Comparator['op']) ?? '=', version: parseVersion(cmp[2])! });
    }
    return out;
}

function satisfies(version: Version, range: string): boolean | null {
    const comparators = parseRange(range);
    if (!comparators) return null;
    return comparators.every((c) => {
        const d = cmpVersion(version, c.version);
        switch (c.op) {
            case '>=':
                return d >= 0;
            case '>':
                return d > 0;
            case '<=':
                return d <= 0;
            case '<':
                return d < 0;
            case '=':
                return d === 0;
        }
    });
}

/** The lowest version a range admits — the "floor" a security row states. */
function rangeFloor(range: string): Version | null {
    const comparators = parseRange(range);
    if (!comparators) return null;
    const lower = comparators.filter((c) => c.op === '>=' || c.op === '>' || c.op === '=');
    if (lower.length === 0) return null;
    return lower.reduce((a, b) => (cmpVersion(a.version, b.version) >= 0 ? a : b)).version;
}

const fmt = (v: Version) => v.join('.');

// ─────────────────────────────────────────────────────────────────────────
// Markdown table parsing
// ─────────────────────────────────────────────────────────────────────────
interface Table {
    heading: string;
    headers: string[];
    /** Each row as header → cell, plus the 1-based file line it came from. */
    rows: Array<{ line: number; cells: Record<string, string> }>;
}

/** Split a table row on `|`, honouring the `\|` escape used inside cells. */
function splitCells(line: string): string[] {
    const parts = line.split(/(?<!\\)\|/);
    return parts.slice(1, -1).map((c) => c.trim());
}

function parseTables(md: string): Table[] {
    const lines = md.split('\n');
    const tables: Table[] = [];
    let heading = '(preamble)';
    for (let i = 0; i < lines.length; i++) {
        const h = /^#{2,3}\s+(.*)$/.exec(lines[i]);
        if (h) {
            heading = h[1].trim();
            continue;
        }
        if (!lines[i].startsWith('|')) continue;
        const start = i;
        while (i < lines.length && lines[i].startsWith('|')) i++;
        const block = lines.slice(start, i);
        if (block.length < 3) continue;
        const headers = splitCells(block[0]);
        tables.push({
            heading,
            headers,
            rows: block.slice(2).map((row, idx) => {
                const cells = splitCells(row);
                const record: Record<string, string> = {};
                headers.forEach((name, col) => {
                    record[name] = cells[col] ?? '';
                });
                return { line: start + 2 + idx + 1, cells: record };
            }),
        });
    }
    return tables;
}

const TABLES = parseTables(DOC);

function tableUnder(heading: string): Table {
    const found = TABLES.filter((t) => t.heading === heading);
    if (found.length !== 1) {
        throw new Error(
            `${DOC_REL}: expected exactly ONE table under "${heading}", found ${found.length}. ` +
                `The guard reads that table; renaming the heading or splitting the table silently ` +
                `removes every assertion below, so this throws instead of iterating nothing.`,
        );
    }
    return found[0];
}

// ─────────────────────────────────────────────────────────────────────────
// The documented override rows
// ─────────────────────────────────────────────────────────────────────────
type Spec = string | Record<string, string>;

interface DocEntry {
    /** `package.json` overrides key this cell names — may be a `*` glob. */
    key: string;
    spec: Spec;
}

interface DocRow {
    section: string;
    line: number;
    entries: DocEntry[];
    advisory: string;
    scope: string;
    checked: string;
}

/** Parse `` `pkg` → `^1.2.3` `` / `` `pkg` → `{child: ^1.2.3}` `` pairs. */
function parseOverrideCell(cell: string): DocEntry[] {
    const out: DocEntry[] = [];
    const re = /`([^`]+)`\s*(?:→|->)\s*`([^`]+)`/g;
    for (const m of cell.matchAll(re)) {
        const key = m[1].trim();
        const raw = m[2].trim();
        if (raw.startsWith('{')) {
            const spec: Record<string, string> = {};
            for (const pair of raw.replace(/^\{|\}$/g, '').split(',')) {
                const [k, ...rest] = pair.split(':');
                if (!k || rest.length === 0) continue;
                spec[k.trim()] = rest.join(':').trim();
            }
            out.push({ key, spec });
        } else {
            out.push({ key, spec: raw });
        }
    }
    return out;
}

function rowsFrom(heading: string, overrideColumn: string): DocRow[] {
    return tableUnder(heading).rows.map((r) => ({
        section: heading,
        line: r.line,
        entries: parseOverrideCell(r.cells[overrideColumn] ?? ''),
        advisory: r.cells.Advisory ?? '',
        scope: r.cells.Scope ?? '',
        checked: r.cells.Checked ?? '',
    }));
}

const CONFLICT_ROWS = rowsFrom('Resolved conflicts', '`overrides` entry');
const SECURITY_ROWS = rowsFrom('Security overrides', 'Override');
const CEILING_ROWS = rowsFrom('Regression ceilings', 'Override');
/** Every row that names at least one override, from every table. */
const ALL_OVERRIDE_ROWS = [...CONFLICT_ROWS, ...SECURITY_ROWS, ...CEILING_ROWS].filter(
    (r) => r.entries.length > 0,
);
/** The rows that carry the machine-checked Scope / Checked columns. */
const SCOPED_ROWS = [...SECURITY_ROWS, ...CEILING_ROWS];

const UNDOCUMENTED_HEADING = 'Overrides recorded here but not explained';

/** The doc's own list of overrides it does NOT explain. */
function parseUndocumentedList(md: string): string[] {
    const lines = md.split('\n');
    const start = lines.findIndex((l) => /^#{2,3}\s+/.test(l) && l.includes(UNDOCUMENTED_HEADING));
    if (start < 0) return [];
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
        if (/^#{1,3}\s+/.test(lines[i])) break;
        const m = /^-\s+`([^`]+)`\s*$/.exec(lines[i]);
        if (m) out.push(m[1]);
    }
    return out;
}

const UNDOCUMENTED = parseUndocumentedList(DOC);
const OVERRIDES: Record<string, Spec> = PKG.overrides ?? {};
const LOCK_PACKAGES: Record<string, { version?: string; dev?: boolean }> = LOCK.packages ?? {};

// ─────────────────────────────────────────────────────────────────────────
// Checkers. Every one returns a list of errors so it can be run against a
// MUTATED copy of the real rows and asserted to speak up.
// ─────────────────────────────────────────────────────────────────────────
function globToRegExp(key: string): RegExp {
    const escaped = key
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(`^${escaped}$`);
}

function matchingOverrideKeys(key: string, overrides: Record<string, Spec>): string[] {
    if (!key.includes('*')) return key in overrides ? [key] : [];
    const re = globToRegExp(key);
    return Object.keys(overrides).filter((k) => re.test(k));
}

function sameSpec(a: Spec, b: Spec): boolean {
    if (typeof a === 'string' || typeof b === 'string') return a === b;
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    return ak.length === bk.length && ak.every((k, i) => k === bk[i] && a[k] === b[k]);
}

/** Direction A — a documented row must describe a real override entry. */
function checkDocumentedRowsResolve(rows: DocRow[], overrides: Record<string, Spec>): string[] {
    const errors: string[] = [];
    for (const row of rows) {
        for (const entry of row.entries) {
            const keys = matchingOverrideKeys(entry.key, overrides);
            if (keys.length === 0) {
                errors.push(
                    `${DOC_REL}:${row.line} documents \`${entry.key}\`, which is NOT an entry in package.json overrides.`,
                );
                continue;
            }
            for (const key of keys) {
                if (!sameSpec(entry.spec, overrides[key])) {
                    errors.push(
                        `${DOC_REL}:${row.line} says \`${key}\` → ${JSON.stringify(entry.spec)}, ` +
                            `package.json overrides says ${JSON.stringify(overrides[key])}.`,
                    );
                }
            }
        }
    }
    return errors;
}

/** Direction B — every override entry must be documented, or listed as not. */
function checkEveryOverrideAccountedFor(
    rows: DocRow[],
    undocumented: string[],
    overrides: Record<string, Spec>,
): string[] {
    const errors: string[] = [];
    const claimedBy = new Map<string, string[]>();
    const claim = (key: string, by: string) =>
        claimedBy.set(key, [...(claimedBy.get(key) ?? []), by]);

    for (const row of rows) {
        for (const entry of row.entries) {
            for (const key of matchingOverrideKeys(entry.key, overrides)) {
                claim(key, `${DOC_REL}:${row.line}`);
            }
        }
    }
    for (const key of undocumented) {
        if (!(key in overrides)) {
            errors.push(
                `${DOC_REL} lists \`${key}\` under "${UNDOCUMENTED_HEADING}", but package.json overrides ` +
                    `has no such entry — stale.`,
            );
            continue;
        }
        claim(key, `"${UNDOCUMENTED_HEADING}" list`);
    }
    for (const key of Object.keys(overrides)) {
        const claims = claimedBy.get(key) ?? [];
        if (claims.length === 0) {
            errors.push(
                `package.json overrides carries \`${key}\`, which ${DOC_REL} neither documents in a table ` +
                    `nor lists under "${UNDOCUMENTED_HEADING}".`,
            );
        } else if (claims.length > 1) {
            errors.push(`\`${key}\` is claimed twice in ${DOC_REL}: ${claims.join(' and ')}.`);
        }
    }
    return errors;
}

/** Which lockfile entries resolve a given override subject. */
function resolvedEntries(subject: string, parent: string | null): string[] {
    const all = Object.keys(LOCK_PACKAGES).filter(
        (k) => k === `node_modules/${subject}` || k.endsWith(`/node_modules/${subject}`),
    );
    if (!parent) return all;
    const nested = all.filter((k) => k.endsWith(`/${parent}/node_modules/${subject}`));
    return nested.length > 0 ? nested : all.filter((k) => k === `node_modules/${subject}`);
}

type ScopeVerdict = 'production' | 'dev' | 'absent';

function lockfileScope(entries: string[]): ScopeVerdict {
    if (entries.length === 0) return 'absent';
    return entries.some((k) => LOCK_PACKAGES[k].dev !== true) ? 'production' : 'dev';
}

/** Each documented (subject, parent, range) triple a scoped row asserts. */
function subjectsOf(row: DocRow): Array<{ subject: string; parent: string | null; range: string }> {
    const out: Array<{ subject: string; parent: string | null; range: string }> = [];
    for (const entry of row.entries) {
        if (typeof entry.spec === 'string') {
            // `brace-expansion@^5`-style keys name a selector, not a package.
            out.push({ subject: entry.key.replace(/@[^@/]*$/, ''), parent: null, range: entry.spec });
        } else {
            for (const [child, range] of Object.entries(entry.spec)) {
                out.push({ subject: child, parent: entry.key, range });
            }
        }
    }
    return out;
}

const SCOPE_VALUES: ScopeVerdict[] = ['production', 'dev', 'absent'];

/** Check 2 — the Scope column against the lockfile. */
function checkScope(rows: DocRow[]): string[] {
    const errors: string[] = [];
    for (const row of rows) {
        if (!SCOPE_VALUES.includes(row.scope as ScopeVerdict)) {
            errors.push(
                `${DOC_REL}:${row.line} has Scope "${row.scope}" — must be one of ${SCOPE_VALUES.join(' / ')}.`,
            );
            continue;
        }
        for (const { subject, parent } of subjectsOf(row)) {
            const entries = resolvedEntries(subject, parent);
            const actual = lockfileScope(entries);
            if (actual !== row.scope) {
                const detail =
                    entries.length === 0
                        ? 'no entry'
                        : entries.map((k) => `${k} dev=${LOCK_PACKAGES[k].dev === true}`).join(', ');
                errors.push(
                    `${DOC_REL}:${row.line} claims Scope "${row.scope}" for \`${subject}\`` +
                        `${parent ? ` (under \`${parent}\`)` : ''}, but package-lock.json resolves ${actual} (${detail}).`,
                );
            }
        }
    }
    return errors;
}

/**
 * Check 3 — the version the lockfile resolves must satisfy the stated range.
 *
 * The "primary" entry is the hoisted copy (or, for a scoped override, the
 * copy nested under the parent it names). Copies bundled inside the `npm`
 * CLI tree are deliberately NOT the subject: npm does not apply `overrides`
 * to its own bundled dependencies, and the Dockerfile deletes that CLI from
 * the image outright.
 */
function checkLockfileSatisfiesRange(rows: DocRow[]): string[] {
    const errors: string[] = [];
    for (const row of rows) {
        for (const { subject, parent, range } of subjectsOf(row)) {
            const entries = resolvedEntries(subject, parent);
            const primary =
                entries.find((k) => k === `node_modules/${subject}`) ??
                entries.find((k) => (parent ? k.endsWith(`/${parent}/node_modules/${subject}`) : false)) ??
                entries[0];
            if (!primary) continue; // absent — the Scope check owns that case
            const version = parseVersion(LOCK_PACKAGES[primary].version ?? '');
            if (!version) {
                errors.push(
                    `package-lock.json ${primary} has version "${LOCK_PACKAGES[primary].version}", ` +
                        `which this guard cannot parse.`,
                );
                continue;
            }
            const ok = satisfies(version, range);
            if (ok === null) {
                errors.push(
                    `${DOC_REL}:${row.line} states range "${range}" for \`${subject}\`, which this guard ` +
                        `cannot parse — a security / ceiling row must state a plain semver range so it can be checked.`,
                );
            } else if (!ok) {
                errors.push(
                    `${DOC_REL}:${row.line} states "${range}" for \`${subject}\`, but package-lock.json ` +
                        `resolves ${fmt(version)} at ${primary}, which does NOT satisfy it.`,
                );
            }
        }
    }
    return errors;
}

/**
 * A patched version named by an Advisory cell. `inclusive` means the
 * advisory affects that version too (`<=X`), so the floor must be strictly
 * above it.
 */
interface Patched {
    version: Version;
    inclusive: boolean;
    source: string;
}

function patchedVersionsFrom(advisory: string): Patched[] {
    const out: Patched[] = [];
    const push = (raw: string, inclusive: boolean, source: string) => {
        const v = parseVersion(raw);
        if (v) out.push({ version: v, inclusive, source: source.trim() });
    };
    for (const m of advisory.matchAll(/patched(?:\s+at|\s+in)?\s+`?(\d+\.\d+\.\d+)`?/gi)) {
        push(m[1], false, m[0]);
    }
    for (const m of advisory.matchAll(/fixed(?:\s+at|\s+in)?\s+`?(\d+\.\d+\.\d+)`?/gi)) {
        push(m[1], false, m[0]);
    }
    for (const m of advisory.matchAll(/<(?!=)\s*(\d+\.\d+\.\d+)/g)) {
        push(m[1], false, m[0]);
    }
    for (const m of advisory.matchAll(/<=\s*(\d+\.\d+\.\d+)/g)) {
        push(m[1], true, m[0]);
    }
    return out;
}

const ADVISORY_ID = /\b(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\b/i;

/**
 * Check 4 — the floor a security row states must not sit BELOW the patched
 * version its own Advisory cell names. #863 shipped exactly that inversion.
 */
function checkFloorAgainstAdvisory(rows: DocRow[]): string[] {
    const errors: string[] = [];
    for (const row of rows) {
        if (!ADVISORY_ID.test(row.advisory)) {
            errors.push(
                `${DOC_REL}:${row.line} — Advisory cell names no CVE / GHSA id. A security row must cite one.`,
            );
        }
        const patched = patchedVersionsFrom(row.advisory);
        if (patched.length === 0) {
            errors.push(
                `${DOC_REL}:${row.line} — Advisory cell states no patched version (write "patched X.Y.Z", ` +
                    `or the affected range "<X.Y.Z" / "<=X.Y.Z"). Without one the floor cannot be checked, ` +
                    `and an unchecked row is the whole defect this guard exists for.`,
            );
            continue;
        }
        for (const { subject, range } of subjectsOf(row)) {
            const floor = rangeFloor(range);
            if (!floor) {
                errors.push(
                    `${DOC_REL}:${row.line} — cannot read a floor out of "${range}" for \`${subject}\`.`,
                );
                continue;
            }
            const sameLine = patched.filter((p) => p.version[0] === floor[0]);
            if (sameLine.length === 0) {
                errors.push(
                    `${DOC_REL}:${row.line} — floor ${fmt(floor)} for \`${subject}\` is on major ${floor[0]}, ` +
                        `but the Advisory cell names patched versions only on major(s) ` +
                        `${[...new Set(patched.map((p) => p.version[0]))].join(', ')}. One of the two is wrong.`,
                );
                continue;
            }
            for (const p of sameLine) {
                const d = cmpVersion(floor, p.version);
                const ok = p.inclusive ? d > 0 : d >= 0;
                if (!ok) {
                    errors.push(
                        `${DOC_REL}:${row.line} — floor ${fmt(floor)} for \`${subject}\` is BELOW the patched ` +
                            `version its own Advisory cell names ("${p.source}"). ` +
                            `The override admits a release the advisory still affects.`,
                    );
                }
            }
        }
    }
    return errors;
}

/** Check 5 — the Checked date. */
function checkDate(value: string, where: string, now: Date): string[] {
    const errors: string[] = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        errors.push(`${where} — Checked date "${value}" is not a YYYY-MM-DD date.`);
        return errors;
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        errors.push(`${where} — Checked date "${value}" is not a real calendar date.`);
        return errors;
    }
    const ageDays = (now.getTime() - parsed.getTime()) / 86_400_000;
    // One day of slack on the future side, and one day only: an author east
    // of UTC writes today's LOCAL date while CI reads the clock in UTC, so a
    // same-day entry is legitimately up to a day "ahead". Two days ahead is
    // not a timezone.
    if (ageDays < -1) {
        errors.push(`${where} — Checked date "${value}" is in the FUTURE.`);
    } else if (ageDays > REVIEW_MAX_AGE_DAYS) {
        errors.push(
            `${where} — Checked date "${value}" is ${Math.floor(ageDays)} days old ` +
                `(limit ${REVIEW_MAX_AGE_DAYS}). Re-read the advisory, confirm the floor, and bump the date.`,
        );
    }
    return errors;
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────
describe('docs/dependency-policy.md — machine-checkable claims', () => {
    describe('the guard is reading a real, non-empty document', () => {
        // An empty selection is a PASS for every loop below, so the counts
        // are asserted before anything iterates over them.
        it('parses the three override tables', () => {
            expect(CONFLICT_ROWS.length).toBeGreaterThanOrEqual(4);
            expect(SECURITY_ROWS.length).toBeGreaterThanOrEqual(6);
            expect(CEILING_ROWS.length).toBeGreaterThanOrEqual(1);
        });

        it('every row that should name an override does', () => {
            // The conflicts table has one row whose resolution was a direct
            // bump, so it names none; every security / ceiling row must.
            expect(ALL_OVERRIDE_ROWS.length).toBeGreaterThanOrEqual(10);
            for (const row of SCOPED_ROWS) {
                expect(row.entries.length).toBeGreaterThan(0);
            }
        });

        it('the documented rows cover a real slice of package.json overrides', () => {
            const covered = new Set(
                ALL_OVERRIDE_ROWS.flatMap((r) =>
                    r.entries.flatMap((e) => matchingOverrideKeys(e.key, OVERRIDES)),
                ),
            );
            expect(covered.size).toBeGreaterThanOrEqual(10);
            expect(Object.keys(OVERRIDES).length).toBeGreaterThanOrEqual(covered.size);
        });

        it('the "not explained" list is parsed and every entry is real', () => {
            expect(UNDOCUMENTED.length).toBeGreaterThan(0);
            for (const key of UNDOCUMENTED) expect(Object.keys(OVERRIDES)).toContain(key);
        });

        it('the doc states which half of it is unguarded', () => {
            // Deliberately a PRESENCE check, and the only one in this file:
            // the subject IS a disclaimer, so its presence is the property.
            // It proves nothing about the prose it disclaims.
            expect(DOC).toContain('## What is machine-checked here, and what is NOT');
            expect(DOC).toContain('UNGUARDED PROSE');
        });
    });

    describe('the version comparator itself', () => {
        it('orders versions', () => {
            expect(cmpVersion([4, 0, 7], [4, 0, 4])).toBe(1);
            expect(cmpVersion([4, 0, 4], [4, 0, 7])).toBe(-1);
            expect(cmpVersion([4, 0, 4], [4, 0, 4])).toBe(0);
        });

        it('accepts what a range admits and REJECTS what it excludes', () => {
            expect(satisfies([4, 0, 7], '^4.0.7')).toBe(true);
            expect(satisfies([4, 0, 5], '^4.0.7')).toBe(false);
            expect(satisfies([5, 0, 0], '^4.0.7')).toBe(false);
            expect(satisfies([0, 2, 7], '^0.2.7')).toBe(true);
            expect(satisfies([0, 3, 0], '^0.2.7')).toBe(false);
            expect(satisfies([2, 2, 24], '>=2.2.16 <2.2.25')).toBe(true);
            expect(satisfies([2, 2, 25], '>=2.2.16 <2.2.25')).toBe(false);
            expect(satisfies([1, 0, 0], '$react')).toBeNull();
        });

        it('reads the floor out of a range', () => {
            expect(rangeFloor('^4.0.7')).toEqual([4, 0, 7]);
            expect(rangeFloor('>=2.2.16 <2.2.25')).toEqual([2, 2, 16]);
            expect(rangeFloor('$react')).toBeNull();
        });
    });

    describe('doc ↔ package.json overrides, both directions', () => {
        it('every documented row names a real override with the same spec', () => {
            expect(checkDocumentedRowsResolve(ALL_OVERRIDE_ROWS, OVERRIDES)).toEqual([]);
        });

        it('every override entry is documented or listed as not explained', () => {
            expect(checkEveryOverrideAccountedFor(ALL_OVERRIDE_ROWS, UNDOCUMENTED, OVERRIDES)).toEqual([]);
        });
    });

    describe('doc ↔ package-lock.json', () => {
        it('every Scope column agrees with the lockfile', () => {
            expect(checkScope(SCOPED_ROWS)).toEqual([]);
        });

        it('every resolved version satisfies the range the doc states', () => {
            expect(checkLockfileSatisfiesRange(SCOPED_ROWS)).toEqual([]);
        });
    });

    describe('security floors vs the advisories they cite', () => {
        it('no security row states a floor below its own patched version', () => {
            expect(checkFloorAgainstAdvisory(SECURITY_ROWS)).toEqual([]);
        });
    });

    describe('review dates', () => {
        it('every Checked date parses, is not in the future, and has not expired', () => {
            const now = new Date();
            const errors = SCOPED_ROWS.flatMap((r) => checkDate(r.checked, `${DOC_REL}:${r.line}`, now));
            expect(errors).toEqual([]);
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // The guard itself has teeth.
    //
    // Every fixture below is a MUTATED COPY OF THE REAL PARSED DOCUMENT —
    // never a hand-built row — because a checker fed a fixture proves
    // nothing about the input the production tree produces. Each case
    // asserts the specific message, beside the un-mutated controls above
    // that report none.
    // ─────────────────────────────────────────────────────────────────────
    describe('the guard itself has teeth', () => {
        const realRow = (needle: string): DocRow => {
            const found = SECURITY_ROWS.find((r) =>
                r.entries.some(
                    (e) => e.key === needle || (typeof e.spec === 'object' && needle in e.spec),
                ),
            );
            if (!found) throw new Error(`no real security row names ${needle} — this fixture is stale`);
            return found;
        };
        const clone = (row: DocRow, patch: Partial<DocRow>): DocRow => ({ ...row, ...patch });

        it('a documented spec that drifts from package.json is reported', () => {
            const mutated = clone(realRow('picomatch'), {
                entries: [{ key: 'picomatch', spec: '^4.0.9' }],
            });
            const errors = checkDocumentedRowsResolve([mutated], OVERRIDES);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('package.json overrides says "^4.0.7"');
        });

        it('a row naming an override that does not exist is reported', () => {
            const mutated = clone(realRow('picomatch'), {
                entries: [{ key: 'picomatch-typo', spec: '^4.0.7' }],
            });
            expect(checkDocumentedRowsResolve([mutated], OVERRIDES)).toEqual([
                expect.stringContaining('NOT an entry in package.json overrides'),
            ]);
        });

        it('DELETING a real row leaves its override undocumented — reported', () => {
            const survivors = ALL_OVERRIDE_ROWS.filter((r) => r !== realRow('picomatch'));
            expect(checkEveryOverrideAccountedFor(survivors, UNDOCUMENTED, OVERRIDES)).toEqual([
                expect.stringContaining('package.json overrides carries `picomatch`'),
            ]);
        });

        it('a NEW undocumented override entry is reported', () => {
            const withExtra = { ...OVERRIDES, 'left-pad': '^1.3.0' };
            expect(checkEveryOverrideAccountedFor(ALL_OVERRIDE_ROWS, UNDOCUMENTED, withExtra)).toEqual([
                expect.stringContaining('package.json overrides carries `left-pad`'),
            ]);
        });

        it('a stale entry in the "not explained" list is reported', () => {
            expect(
                checkEveryOverrideAccountedFor(ALL_OVERRIDE_ROWS, [...UNDOCUMENTED, 'left-pad'], OVERRIDES),
            ).toEqual([expect.stringContaining('stale')]);
        });

        it('an override both documented AND listed as unexplained is reported', () => {
            expect(
                checkEveryOverrideAccountedFor(ALL_OVERRIDE_ROWS, [...UNDOCUMENTED, 'picomatch'], OVERRIDES),
            ).toEqual([expect.stringContaining('claimed twice')]);
        });

        it('a production package claimed as dev-only is reported, and the reverse', () => {
            const prod = realRow('picomatch'); // lockfile: no dev flag → production
            expect(prod.scope).toBe('production');
            const asDev = checkScope([clone(prod, { scope: 'dev' })]);
            expect(asDev).toHaveLength(1);
            expect(asDev[0]).toContain('claims Scope "dev"');
            expect(asDev[0]).toContain('package-lock.json resolves production');

            const dev = realRow('tmp'); // lockfile: dev: true
            expect(dev.scope).toBe('dev');
            const asProd = checkScope([clone(dev, { scope: 'production' })]);
            expect(asProd).toHaveLength(1);
            expect(asProd[0]).toContain('package-lock.json resolves dev');
        });

        it('a package the lockfile does not resolve at all cannot be claimed present', () => {
            const absent = realRow('hono');
            expect(absent.scope).toBe('absent');
            expect(checkScope([clone(absent, { scope: 'production' })])).toEqual([
                expect.stringContaining('package-lock.json resolves absent'),
            ]);
        });

        it('an unknown Scope value is reported rather than skipped', () => {
            expect(checkScope([clone(realRow('picomatch'), { scope: 'prod' })])).toEqual([
                expect.stringContaining('must be one of production / dev / absent'),
            ]);
        });

        it('a range the lockfile does not satisfy is reported', () => {
            const mutated = clone(realRow('picomatch'), {
                entries: [{ key: 'picomatch', spec: '^4.9.0' }],
            });
            expect(checkLockfileSatisfiesRange([mutated])).toEqual([
                expect.stringContaining('does NOT satisfy it'),
            ]);
        });

        it('a floor BELOW the advisory’s patched version is reported', () => {
            // The #863 shape on the real row: the advisory names 4.1.0 while
            // the override floor stays ^4.0.7.
            const mutated = clone(realRow('picomatch'), {
                advisory: 'CVE-2026-33671 — ReDoS in pattern compilation (high); patched at 4.1.0',
            });
            expect(checkFloorAgainstAdvisory([mutated])).toEqual([
                expect.stringContaining('is BELOW the patched'),
            ]);
        });

        it('an inclusive affected range (<=X) requires a floor strictly above X', () => {
            const atTheBoundary = clone(realRow('protobufjs'), {
                advisory: 'GHSA-j3f2-48v5-ccww — affects `>=8.0.0 <=8.6.6` (moderate)',
            });
            expect(checkFloorAgainstAdvisory([atTheBoundary])).toEqual([
                expect.stringContaining('is BELOW the patched'),
            ]);
        });

        it('an Advisory cell with no patched version is reported, not skipped', () => {
            const mutated = clone(realRow('picomatch'), {
                advisory: 'CVE-2026-33671 — ReDoS in pattern compilation (high)',
            });
            expect(checkFloorAgainstAdvisory([mutated])).toEqual([
                expect.stringContaining('states no patched version'),
            ]);
        });

        it('an Advisory cell with no advisory id is reported', () => {
            const mutated = clone(realRow('picomatch'), {
                advisory: 'ReDoS in pattern compilation (high); patched at 4.0.4',
            });
            expect(checkFloorAgainstAdvisory([mutated])).toEqual([
                expect.stringContaining('names no CVE / GHSA id'),
            ]);
        });

        it('a patched version on another major line is reported', () => {
            const mutated = clone(realRow('picomatch'), {
                advisory: 'CVE-2026-33671 — ReDoS (high); patched at 3.0.9',
            });
            expect(checkFloorAgainstAdvisory([mutated])).toEqual([
                expect.stringContaining('names patched versions only on major(s) 3'),
            ]);
        });

        it('an unparseable, future, or expired Checked date is reported', () => {
            const now = new Date('2026-09-11T00:00:00Z');
            expect(checkDate('yesterday', 'x', now)).toEqual([
                expect.stringContaining('is not a YYYY-MM-DD date'),
            ]);
            expect(checkDate('2026-02-30', 'x', now)).toEqual([
                expect.stringContaining('is not a real calendar date'),
            ]);
            expect(checkDate('2026-12-01', 'x', now)).toEqual([expect.stringContaining('in the FUTURE')]);
            expect(checkDate('2026-09-13', 'x', now)).toEqual([expect.stringContaining('in the FUTURE')]);
            expect(checkDate('2024-01-01', 'x', now)).toEqual([expect.stringContaining('days old')]);
            expect(checkDate('2025-09-10', 'x', now)).toEqual([expect.stringContaining('days old')]);
            expect(checkDate('2026-09-11', 'x', now)).toEqual([]);
            expect(checkDate('2026-09-12', 'x', now)).toEqual([]); // one day of timezone slack
            expect(checkDate('2025-10-01', 'x', now)).toEqual([]);
        });
    });
});

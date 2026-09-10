/**
 * The `overrides` table must keep DOING something — structurally, offline.
 *
 * ## What this cost, twice
 *
 * `docs/dependency-policy.md` records three security floors re-floored on
 * 2026-07-25 after an audit found their ranges had decayed into admitting a
 * version the recorded advisory still affects. Six weeks later #853 found
 * two more and re-floored them. In every case the lockfile happened to sit
 * on a patched version, so `npm audit` was green and nothing in the repo
 * looked wrong — which is exactly why the entry-by-entry fix only resets
 * the clock. Two occurrences of one class in six weeks is a class.
 *
 * ## What this guard deliberately does NOT do
 *
 * It does not ask whether a floor still covers its advisory. That is a
 * statement about the GitHub Advisory Database at time T, not about the
 * repo, and no function of `package.json` + `package-lock.json` can decide
 * it. Putting the query on the merge path would reproduce the exact defect
 * `scripts/audit-exemptions.mjs` exists to prevent — npm's bulk endpoint
 * answers `200 {}` both for "no advisories" and "package not recognised",
 * so a network guard fails OPEN on registry degradation — and the advisory
 * endpoint additionally serves WITHDRAWN advisories (`affects=uuid@11.1.1`
 * returns GHSA-qmq6-f8pr-cx5x, withdrawn as a duplicate), so a naive
 * checker would have flagged this repo's one runtime security floor as
 * decayed on day one.
 *
 * There is therefore **no advisory query on the merge path**, here or in
 * `tests/helpers/overrides-analysis.ts`. The four checks are the
 * structural half of the question, and they are decidable:
 *
 *   A  no floor without a target      — the key must exist in the lockfile
 *   B  no override that cannot act    — nested overrides need a real edge
 *   C  no floor that isn't a floor    — it must exclude something reachable
 *   D  no silent widening             — it must not relax someone's floor
 *                                       or break someone's exact pin
 *
 * ## Why there is a waiver list, and why it is dated
 *
 * All four checks are RED on the tree this guard landed on — 31 findings
 * over 39 entries. A guard that arrives already-failing gets skipped, and
 * this repo has a documented history of exactly that (see `.trivyignore`'s
 * eight dead entries, and the coverage job that could only ever detect a
 * regression after the merge). So today's findings are written down, one
 * per entry, each with a REASON and a REVIEW date — the
 * `scripts/audit-exemptions.mjs` idiom, including its two sharp rules:
 *
 *   • a STALE waiver fails the build (the finding stopped being produced,
 *     so the waiver is now a blind spot), and
 *   • an EXPIRED waiver fails the build (its own author's review date has
 *     passed), so the list can only shrink.
 *
 * ## Why the fixtures
 *
 * `tests/guards/trivyignore-exemptions.test.ts` exists because a guard over
 * a currently-clean file "rots into a tautology". The inverse rots too: a
 * guard whose every live finding is waived would pass identically if the
 * analysis returned nothing at all. So the rules are also driven by
 * SYNTHETIC fixtures that must fail, each paired with a positive control
 * that must pass — and by an in-memory mutation proof against the REAL
 * package.json, which injects a decayed floor and asserts the live analysis
 * turns red on it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    analyseOverrides,
    declaredRange,
    findingKey,
    lockEntriesFor,
    overrideEdges,
    splitOverrideKey,
    type CheckId,
    type Finding,
    type Lockfile,
    type PackageJson,
} from '../helpers/overrides-analysis';

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as PackageJson;
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as Lockfile;

// ─────────────────────────────────────────────────────────────────────────
// Dormant floors — check A only.
//
// A floor over a package that is NOT in the lockfile is not automatically
// wrong: `hono` is kept deliberately, for if the transitive edge returns.
// But it is the most dangerous shape in the table, because npm audit sees
// no package and Dependabot sees no dependency — the entry is invisible to
// every other tool in the repo, which is how both hono entries decayed
// twice. Listing one here is a statement that its absence is intended.
//
// A dormant floor goes STALE the moment the package DOES appear in the
// lockfile: it is a live floor then, and checks C and D start applying.
// ─────────────────────────────────────────────────────────────────────────
interface DormantFloor {
    /** The `overrides` key, exactly as written in package.json. */
    key: string;
    reason: string;
    /** ISO date. Once it passes, the build fails until someone re-argues. */
    review: string;
}

const DORMANT_FLOORS: DormantFloor[] = [
    {
        key: 'hono',
        reason:
            'GHSA-hvrm-45r6-mjfj (hono/jsx does not isolate context per request; affects ' +
            '>=4.11.8 <4.12.27) is recorded against this entry in docs/dependency-policy.md, ' +
            'which also records that hono arrives only transitively through @prisma/dev (#367) ' +
            'and that prisma dropped it — the lockfile holds no copy at any version. Kept as a ' +
            'floor for if the edge returns, exactly as that document says. On review: confirm ' +
            '@prisma/dev still pulls no hono, and re-read the advisory against ^4.12.27. This ' +
            'is the shape that decayed twice, so the review is the whole mitigation.',
        review: '2027-01-16',
    },
    {
        key: '@hono/node-server',
        reason:
            'The server adapter that arrived on the same dropped @prisma/dev edge as `hono`; ' +
            'likewise absent from the lockfile at any version. Unlike `hono` it has NO row in ' +
            "docs/dependency-policy.md's security table, so what ^1.19.13 is a floor against is " +
            'undocumented — which is the precise state a dormant floor decays from. On review: ' +
            'either document the advisory it answers, or delete the entry.',
        review: '2027-01-16',
    },
];

// ─────────────────────────────────────────────────────────────────────────
// Waivers — checks B, C, D.
//
// One entry per (check, override entry). Keys are built from the OVERRIDE,
// never from a lockfile path, so a hoist does not invalidate a waiver and
// nobody learns to delete entries without reading them.
// ─────────────────────────────────────────────────────────────────────────
interface Waiver {
    check: Exclude<CheckId, 'A'>;
    /** Matches `Finding.target`: `picomatch`, or `npm > undici`. */
    target: string;
    reason: string;
    review: string;
}

/** Shared prose for the twelve dead `@visx/*` subkeys — one defect, twelve entries. */
const VISX_DEAD_SUBKEY =
    'Dead subkey: this @visx package does not declare the peer the override names, so npm ' +
    'has never applied it. Only @visx/bounds and @visx/tooltip declare react-dom, and ' +
    '@visx/curve / @visx/scale (d3 wrappers with no JSX) declare no react peer at all. ' +
    "docs/dependency-policy.md says \"each @visx/* package's react / react-dom pinned to the " +
    'root version\"; that is true for 10 of the 22 subkeys and false for these 12. The fix is ' +
    'to DELETE the dead subkeys — a pure package.json edit that cannot change resolution, ' +
    'since npm was never applying them — and it is deliberately not in this guard\'s diff so ' +
    'the guard lands without a dependency change. Waived only until that PR.';

/** Shared prose for the five @typescript-eslint entries, which are one decay. */
const TSESLINT_DECAYED_FLOOR =
    'The ^8.61.0 floor sits BELOW every requester in the tree: ' +
    '@typescript-eslint/eslint-plugin@8.70.0 pins its siblings at 8.70.0 exactly and peers ' +
    'parser at ^8.70.0, and typescript-eslint@8.65.0 pins at 8.65.0. So the entry excludes ' +
    'nothing anybody could install (C) while simultaneously permitting 8.61.0, older than ' +
    'anything anyone asked for (D). This is the same decay class as the 2026-07-25 re-floor ' +
    'and #853. Fix: raise all five entries to the installed line in ONE dependency PR, which ' +
    'is out of this guard\'s diff on purpose — a guard that also moves the thing it measures ' +
    'cannot be reviewed.';

const WAIVERS: Waiver[] = [
    // ── B: overrides that cannot act ─────────────────────────────────────
    { check: 'B', target: '@visx/axis > react-dom', reason: VISX_DEAD_SUBKEY, review: '2026-11-14' },
    { check: 'B', target: '@visx/clip-path > react-dom', reason: VISX_DEAD_SUBKEY, review: '2026-11-14' },
    { check: 'B', target: '@visx/curve > react', reason: VISX_DEAD_SUBKEY, review: '2026-11-14' },
    { check: 'B', target: '@visx/curve > react-dom', reason: VISX_DEAD_SUBKEY, review: '2026-11-14' },
    { check: 'B', target: '@visx/event > react-dom', reason: VISX_DEAD_SUBKEY, review: '2026-11-14' },
    { check: 'B', target: '@visx/gradient > react-dom', reason: VISX_DEAD_SUBKEY, review: '2026-11-14' },
    { check: 'B', target: '@visx/group > react-dom', reason: VISX_DEAD_SUBKEY, review: '2026-11-14' },
    { check: 'B', target: '@visx/responsive > react-dom', reason: VISX_DEAD_SUBKEY, review: '2026-11-14' },
    { check: 'B', target: '@visx/scale > react', reason: VISX_DEAD_SUBKEY, review: '2026-11-14' },
    { check: 'B', target: '@visx/scale > react-dom', reason: VISX_DEAD_SUBKEY, review: '2026-11-14' },
    { check: 'B', target: '@visx/shape > react-dom', reason: VISX_DEAD_SUBKEY, review: '2026-11-14' },
    { check: 'B', target: '@visx/text > react-dom', reason: VISX_DEAD_SUBKEY, review: '2026-11-14' },
    {
        check: 'B',
        target: 'npm > undici',
        reason:
            'npm@11.19.0 declares no `undici` in dependencies / peerDependencies / ' +
            'optionalDependencies — it is a transitive of one of its 65 bundleDependencies — ' +
            'and the only copy npm resolves (node_modules/npm/node_modules/undici) is ' +
            'inBundle:true, i.e. bytes shipped inside the npm tarball that npm installs as ' +
            'published. The entry has therefore never moved anything, on either count, and ' +
            '`npm` here is a devDependency-only CLI. Fix: delete it, or replace it with a ' +
            'check on the npm version actually shipped; leaving it reads as a mitigation.',
        review: '2026-11-14',
    },

    // ── C: floors that exclude nothing ───────────────────────────────────
    { check: 'C', target: '@typescript-eslint/parser', reason: TSESLINT_DECAYED_FLOOR, review: '2026-10-16' },
    { check: 'C', target: '@typescript-eslint/scope-manager', reason: TSESLINT_DECAYED_FLOOR, review: '2026-10-16' },
    { check: 'C', target: '@typescript-eslint/typescript-estree', reason: TSESLINT_DECAYED_FLOOR, review: '2026-10-16' },
    { check: 'C', target: '@typescript-eslint/utils', reason: TSESLINT_DECAYED_FLOOR, review: '2026-10-16' },
    { check: 'C', target: '@typescript-eslint/type-utils', reason: TSESLINT_DECAYED_FLOOR, review: '2026-10-16' },
    {
        check: 'C',
        target: 'find-my-way',
        reason:
            '@prisma/dev is the only requester and it pins find-my-way@9.7.0 EXACTLY, so a ' +
            '^9.7.0 override excludes no version that edge could ever have resolved. It is a ' +
            'no-op that reads as protection. Decide on review: delete it, or raise it to the ' +
            'range that actually excludes whatever it was added for and record that in ' +
            'docs/dependency-policy.md, which carries no row for this entry.',
        review: '2026-12-11',
    },
    {
        check: 'C',
        target: 'nanoid',
        reason:
            'The override restates postcss\'s own `nanoid: ^3.3.18` verbatim — the single ' +
            'requester in the tree — so it excludes nothing. Harmless today and misleading in ' +
            'review, which is the C class exactly. Decide on review: drop it, or state in ' +
            'docs/dependency-policy.md that it exists to hold the floor if postcss widens.',
        review: '2026-12-11',
    },

    // ── D: silent widening ───────────────────────────────────────────────
    { check: 'D', target: '@typescript-eslint/parser', reason: TSESLINT_DECAYED_FLOOR, review: '2026-10-16' },
    { check: 'D', target: '@typescript-eslint/scope-manager', reason: TSESLINT_DECAYED_FLOOR, review: '2026-10-16' },
    { check: 'D', target: '@typescript-eslint/typescript-estree', reason: TSESLINT_DECAYED_FLOOR, review: '2026-10-16' },
    { check: 'D', target: '@typescript-eslint/utils', reason: TSESLINT_DECAYED_FLOOR, review: '2026-10-16' },
    { check: 'D', target: '@typescript-eslint/type-utils', reason: TSESLINT_DECAYED_FLOOR, review: '2026-10-16' },
    {
        check: 'D',
        target: 'picomatch',
        reason:
            'A DECAYED FLOOR, live: ^4.0.4 sits below lint-staged\'s own `picomatch: ^4.0.7`, ' +
            'so the floor added for CVE-2026-33671 (see the picomatch note in ' +
            'tests/guards/trivyignore-exemptions.test.ts) now permits a version lint-staged ' +
            'itself rejects. Nothing else in the repo can see this: the lockfile resolves a ' +
            'patched version, so npm audit is green — the same shape as the 2026-07-25 ' +
            'entries. Fix: raise the floor in the same dependency PR as the ' +
            '@typescript-eslint entries.',
        review: '2026-10-16',
    },
    {
        check: 'D',
        target: 'postcss',
        reason:
            'next@16.3.4 pins postcss@8.5.23 exactly; the override is `$postcss`, which ' +
            'resolves to the root devDependency range ^8.5.28 and excludes that pin. The ' +
            '`$name` form is REQUIRED here by ' +
            'tests/guards/overrides-no-direct-dep-conflict.test.ts (a literal range on a ' +
            'direct dependency aborted an entire Dependabot run), so this is a deliberate ' +
            'trade, not a defect — but it does take next off the postcss build it pins and ' +
            'tests, and until now nothing said so anywhere. On review: confirm the current ' +
            'next release still builds on the root postcss line.',
        review: '2026-12-11',
    },
    {
        check: 'D',
        target: 'deepmerge-ts',
        reason:
            '@prisma/config pins deepmerge-ts@7.1.5 exactly and the ^8.0.1 override excludes ' +
            'it, moving that edge across a MAJOR. That may well be intended (the 8.x line ' +
            'carries the fix the floor was added for) but a cross-major override of an exact ' +
            'pin is the highest-risk shape in the table and carries no row in ' +
            'docs/dependency-policy.md. On review: record the advisory and the compatibility ' +
            'argument there, or drop the floor.',
        review: '2026-12-11',
    },
    {
        check: 'D',
        target: 'mysql2',
        reason:
            'prisma pins mysql2@3.15.3 exactly and the ^3.23.1 override excludes it. This is ' +
            'the other half of the decision recorded in scripts/audit-exemptions.mjs, where ' +
            "npm's suggested fix for the mysql2/prisma pair was a MAJOR DOWNGRADE and was " +
            'correctly rejected (#800): we hold the floor and accept the pin break instead. ' +
            'On review: confirm prisma still starts against the floored mysql2 line.',
        review: '2026-12-11',
    },
];

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers over the two lists — driven by fixtures below as well as by
// the live tree, so their logic is executed rather than merely asserted.
// ─────────────────────────────────────────────────────────────────────────
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A reason short enough to be a shrug is not a reason. */
const MIN_REASON_CHARS = 120;

function waiverKeys(): Set<string> {
    return new Set(WAIVERS.map((w) => `${w.check}:${w.target}`));
}

function dormantKeys(): Set<string> {
    return new Set(DORMANT_FLOORS.map((d) => `A:${d.key}`));
}

/** Findings nothing has accepted responsibility for. */
export function unwaived(findings: Finding[]): Finding[] {
    const accepted = new Set([...waiverKeys(), ...dormantKeys()]);
    return findings.filter((f) => !accepted.has(findingKey(f)));
}

/** Waivers whose finding is no longer produced — a blind spot, not a saving. */
function staleWaivers(findings: Finding[]): string[] {
    const live = new Set(findings.map(findingKey));
    return WAIVERS.filter((w) => !live.has(`${w.check}:${w.target}`)).map((w) => `${w.check}:${w.target}`);
}

/** Dormant floors whose package is now installed — they are live floors again. */
function stableDormantFloors(): string[] {
    return DORMANT_FLOORS.filter((d) => {
        const { name, selector } = splitOverrideKey(d.key);
        return lockEntriesFor(lock, name, selector).length > 0;
    }).map((d) => d.key);
}

/** Entries whose own author's review date has passed. */
export function expired(today: Date): string[] {
    const iso = today.toISOString().slice(0, 10);
    return [
        ...DORMANT_FLOORS.map((d) => ({ id: `A:${d.key}`, review: d.review })),
        ...WAIVERS.map((w) => ({ id: `${w.check}:${w.target}`, review: w.review })),
    ]
        .filter((e) => e.review < iso)
        .map((e) => `${e.id} (review was ${e.review})`);
}

function describeFindings(findings: Finding[]): string {
    return findings.map((f) => `  [${f.check}] ${f.target}\n      ${f.detail}`).join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────
const analysis = analyseOverrides(pkg, lock);

describe('overrides — the analysis is looking at something', () => {
    // Every check below takes a SELECTION. An empty selection passes each of
    // them, so the population is asserted non-empty first — otherwise a
    // restructured overrides block or a renamed lockfile shape would turn the
    // whole file green while checking nothing.
    it('finds the overrides it is meant to be checking', () => {
        expect(Object.keys(pkg.overrides ?? {}).length).toBeGreaterThan(5);
    });

    it('flattens the block into a non-trivial set of edges', () => {
        // 39 keys today, 51 edges (nested keys contribute one edge per child).
        expect(analysis.edges.length).toBeGreaterThan(40);
        expect(analysis.edges.filter((e) => e.parent !== null).length).toBeGreaterThan(10);
    });

    it('reads a real lockfile, not an empty object', () => {
        expect(Object.keys(lock.packages ?? {}).length).toBeGreaterThan(1000);
    });

    it('the lockfile scanner resolves a package that is definitely installed', () => {
        // Positive control for check A. Without it, a scanner that matched
        // NOTHING would report every override as targetless and look identical
        // to one that works.
        expect(lockEntriesFor(lock, 'uuid').length).toBeGreaterThan(0);
        expect(lockEntriesFor(lock, '@typescript-eslint/utils').length).toBeGreaterThan(0);
    });

    it('the requester scanner finds a declared edge it is known to depend on', () => {
        // Positive control for checks C and D: `next` really does pin postcss
        // exactly, and that is the edge check D reports. A scanner returning
        // no requesters would make both checks silently vacuous.
        const [, next] = lockEntriesFor(lock, 'next')[0] ?? [];
        expect(next).toBeDefined();
        expect(declaredRange(next!, 'postcss')).toEqual({ range: expect.any(String), field: 'dependencies' });
    });

    it('check B does not reject every nested override — a live edge stays green', () => {
        // Positive control for check B. `@visx/axis` DOES declare a `react`
        // peer, so that subkey must not be reported; if it were, B would be
        // rejecting everything and the twelve waivers below would mean nothing.
        const keys = new Set(analysis.findings.map(findingKey));
        expect(keys.has('B:@visx/axis > react')).toBe(false);
        expect(keys.has('B:@visx/tooltip > react-dom')).toBe(false);
        expect(keys.has('B:next-auth > next')).toBe(false);
    });

    it('every requester range in the tree parsed — nothing was skipped silently', () => {
        // Both C and D fail toward GREEN on a range they cannot parse (C must
        // prove ALL requesters are subsets; D must prove a specific relation).
        // Collecting them and asserting the list is empty is what stops that
        // from being a silent shrug.
        expect(analysis.unparseableRanges).toEqual([]);
    });

    it('no override nests deeper than {parent: {child: range}}', () => {
        // npm allows deeper nesting; this analysis reads one level. Surfacing
        // an unsupported shape beats skipping it quietly.
        expect(analysis.unsupportedNesting).toEqual([]);
    });

    it('every override value resolves to a parseable range', () => {
        const unresolved = analysis.edges.filter((e) => e.resolved === null);
        expect(unresolved.map((e) => `${e.key} > ${e.child} = ${e.raw}`)).toEqual([]);
    });
});

describe('overrides — every structural finding is answered', () => {
    it('no unwaived finding', () => {
        const open = unwaived(analysis.findings);
        if (open.length > 0) {
            throw new Error(
                `${open.length} overrides entry/entries no longer do the job an override is for.\n\n` +
                    `${describeFindings(open)}\n\n` +
                    'Fix the entry, or add it to WAIVERS / DORMANT_FLOORS in this file with a ' +
                    'written reason and a review date. A waiver is a decision with an owner and ' +
                    'an expiry — not a way to make the guard quiet.',
            );
        }
    });

    it('no stale waiver — an entry whose finding stopped being produced', () => {
        const stale = staleWaivers(analysis.findings);
        expect(stale).toEqual([]);
    });

    it('no dormant floor whose package is now installed', () => {
        // A dormant floor is a claim that the package is absent. Once it is
        // present the entry is a LIVE floor and checks C and D apply to it, so
        // the dormant listing has to go rather than keep covering it.
        expect(stableDormantFloors()).toEqual([]);
    });

    it('no expired entry', () => {
        expect(expired(new Date())).toEqual([]);
    });

    it('every entry carries a real reason and a well-formed review date', () => {
        const bad: string[] = [];
        for (const d of DORMANT_FLOORS) {
            if (!ISO_DATE.test(d.review)) bad.push(`A:${d.key} review "${d.review}" is not YYYY-MM-DD`);
            if (d.reason.trim().length < MIN_REASON_CHARS) bad.push(`A:${d.key} reason is too short to be one`);
        }
        for (const w of WAIVERS) {
            const id = `${w.check}:${w.target}`;
            if (!ISO_DATE.test(w.review)) bad.push(`${id} review "${w.review}" is not YYYY-MM-DD`);
            if (w.reason.trim().length < MIN_REASON_CHARS) bad.push(`${id} reason is too short to be one`);
        }
        expect(bad).toEqual([]);
    });

    it('no duplicate waiver or dormant-floor keys', () => {
        const ids = [...DORMANT_FLOORS.map((d) => `A:${d.key}`), ...WAIVERS.map((w) => `${w.check}:${w.target}`)];
        expect(ids.length).toBe(new Set(ids).size);
    });

    it('every waived key names an override that still exists', () => {
        const keys = new Set(Object.keys(pkg.overrides ?? {}));
        const orphans = [...DORMANT_FLOORS.map((d) => d.key), ...WAIVERS.map((w) => w.target.split(' > ')[0])].filter(
            (k) => !keys.has(k),
        );
        expect(orphans).toEqual([]);
    });

    it('a substantial set of overrides is covered and CLEAN, not merely waived', () => {
        // If every entry were waived, this suite would pass identically with
        // the analysis returning nothing at all — the inverse of the tautology
        // trivyignore-exemptions.test.ts guards against. Measured 2026-09-10:
        // 31 findings touching 24 of the 39 keys, so 15 keys are actively
        // checked and clean. A new finding on any of those 15 fails the build
        // with no waiver standing between it and the reader.
        const waivedKeys = new Set(
            [...DORMANT_FLOORS.map((d) => d.key), ...WAIVERS.map((w) => w.target.split(' > ')[0])],
        );
        const clean = Object.keys(pkg.overrides ?? {}).filter((k) => !waivedKeys.has(k));
        expect(clean.length).toBeGreaterThanOrEqual(12);
    });
});

describe('overrides — the guard turns red on the REAL tree when a floor decays', () => {
    // The fixtures below prove each RULE. These prove the WIRING: the same
    // package.json this repo ships, plus one injected defect, is red.
    it('A — an override over a package nobody installs', () => {
        const mutated: PackageJson = {
            ...pkg,
            overrides: { ...pkg.overrides, 'not-a-package-anyone-installs': '^1.0.0' },
        };
        const keys = new Set(analyseOverrides(mutated, lock).findings.map(findingKey));
        expect(keys.has('A:not-a-package-anyone-installs')).toBe(true);
    });

    it('D — a floor that relaxes the root package\'s own exact pin', () => {
        // `next` is pinned exactly in dependencies. An override below it is a
        // relaxation, and it is invisible to npm audit whenever the lockfile
        // happens to sit on a good version — the 2026-07-25 shape verbatim.
        const mutated: PackageJson = { ...pkg, overrides: { ...pkg.overrides, next: '^15.0.0' } };
        const finding = analyseOverrides(mutated, lock).findings.find((f) => findingKey(f) === 'D:next');
        expect(finding?.detail).toContain('RELAXATION');
    });

    it('the unmutated tree produces exactly the findings this file accounts for', () => {
        // The complement of the two mutations: without an injected defect the
        // finding set is closed, so a NEW finding cannot arrive unnoticed.
        expect(unwaived(analysis.findings)).toEqual([]);
        expect(analysis.findings.length).toBeGreaterThan(20);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// The rules have teeth — synthetic fixtures, each with a positive control.
// ─────────────────────────────────────────────────────────────────────────
describe('the checks themselves — synthetic fixtures that MUST fail', () => {
    function keysOf(p: PackageJson, l: Lockfile): Set<string> {
        return new Set(analyseOverrides(p, l).findings.map(findingKey));
    }

    const ROOT_ENTRY = { dependencies: {} };

    describe('A — no floor without a target', () => {
        const lockWithReal: Lockfile = {
            packages: { '': ROOT_ENTRY, 'node_modules/real': { version: '1.0.0' } },
        };

        it('rejects an override over a package absent from the lockfile', () => {
            expect(keysOf({ overrides: { ghost: '^1.0.0' } }, lockWithReal)).toContain('A:ghost');
        });

        it('rejects a selector-keyed override no installed version satisfies', () => {
            // `brace-expansion@^5` shape: the NAME is present, the selector
            // matches nothing, so the override still governs no instance.
            expect(keysOf({ overrides: { 'real@^2': '^2.1.0' } }, lockWithReal)).toContain('A:real@^2');
        });

        it('accepts an override whose package IS installed (positive control)', () => {
            expect(keysOf({ overrides: { real: '^1.0.0' } }, lockWithReal)).not.toContain('A:real');
        });
    });

    describe('B — no override that cannot act', () => {
        it('rejects a nested override on an edge the parent does not declare', () => {
            const l: Lockfile = {
                packages: {
                    '': ROOT_ENTRY,
                    'node_modules/parent': { version: '1.0.0', dependencies: { other: '^1.0.0' } },
                    'node_modules/child': { version: '1.0.0' },
                },
            };
            const found = keysOf({ overrides: { parent: { child: '^1.0.0' } } }, l);
            expect(found).toContain('B:parent > child');
        });

        it('rejects a nested override whose only resolved copy is bundled', () => {
            // The npm > undici shape: the parent DOES declare the child, but
            // the bytes ship inside the parent's own tarball and npm installs
            // them as published.
            const l: Lockfile = {
                packages: {
                    '': ROOT_ENTRY,
                    'node_modules/parent': { version: '1.0.0', dependencies: { child: '^1.0.0' } },
                    'node_modules/parent/node_modules/child': { version: '1.0.0', inBundle: true },
                },
            };
            expect(keysOf({ overrides: { parent: { child: '^2.0.0' } } }, l)).toContain('B:parent > child');
        });

        it('accepts a nested override on a real, unbundled edge (positive control)', () => {
            const l: Lockfile = {
                packages: {
                    '': ROOT_ENTRY,
                    'node_modules/parent': { version: '1.0.0', peerDependencies: { child: '^1.0.0' } },
                    'node_modules/child': { version: '1.5.0' },
                },
            };
            expect(keysOf({ overrides: { parent: { child: '^1.2.0' } } }, l)).not.toContain('B:parent > child');
        });

        it('counts a peerDependency / optionalDependency edge as declared', () => {
            // npm applies an override to any of the three declaration fields;
            // a check that only read `dependencies` would report every visx
            // and next-auth peer entry and drown the real findings.
            for (const field of ['peerDependencies', 'optionalDependencies'] as const) {
                const l: Lockfile = {
                    packages: {
                        '': ROOT_ENTRY,
                        'node_modules/parent': { version: '1.0.0', [field]: { child: '^1.0.0' } },
                        'node_modules/child': { version: '1.5.0' },
                    },
                };
                expect(keysOf({ overrides: { parent: { child: '^1.2.0' } } }, l)).not.toContain('B:parent > child');
            }
        });
    });

    describe('C — no floor that isn\'t a floor', () => {
        function lockWhere(requesterRange: string): Lockfile {
            return {
                packages: {
                    '': ROOT_ENTRY,
                    'node_modules/lib': { version: '1.5.0' },
                    'node_modules/consumer': { version: '1.0.0', dependencies: { lib: requesterRange } },
                },
            };
        }

        it('rejects a floor every requester already satisfies', () => {
            expect(keysOf({ overrides: { lib: '^1.0.0' } }, lockWhere('^1.2.0'))).toContain('C:lib');
        });

        it('accepts a floor that really does exclude something (positive control)', () => {
            expect(keysOf({ overrides: { lib: '^1.2.0' } }, lockWhere('^1.0.0'))).not.toContain('C:lib');
        });

        it('EXEMPTS a `$name` override on a direct dependency', () => {
            // Load-bearing: overrides-no-direct-dep-conflict.test.ts asserts
            // `overrides.sharp === '$sharp'` LITERALLY, because a repeated
            // literal range on a direct dependency aborted an entire Dependabot
            // run. Check C must never argue with that.
            const p: PackageJson = { dependencies: { sharp: '^0.35.4' }, overrides: { sharp: '$sharp' } };
            const l: Lockfile = {
                packages: {
                    '': { dependencies: { sharp: '^0.35.4' } },
                    'node_modules/sharp': { version: '0.35.4' },
                    'node_modules/consumer': { version: '1.0.0', dependencies: { sharp: '^0.35.5' } },
                },
            };
            expect(keysOf(p, l)).not.toContain('C:sharp');
        });
    });

    describe('D — no silent widening', () => {
        function lockWhere(requesterRange: string): Lockfile {
            return {
                packages: {
                    '': ROOT_ENTRY,
                    'node_modules/lib': { version: '1.5.0' },
                    'node_modules/consumer': { version: '1.0.0', dependencies: { lib: requesterRange } },
                },
            };
        }

        it('rejects an override whose floor is BELOW a requester\'s floor', () => {
            const findings = analyseOverrides({ overrides: { lib: '^1.0.0' } }, lockWhere('^1.5.0')).findings;
            const d = findings.find((f) => findingKey(f) === 'D:lib');
            expect(d?.detail).toContain('RELAXATION');
        });

        it('rejects an override that excludes a requester\'s EXACT pin', () => {
            const findings = analyseOverrides({ overrides: { lib: '^2.0.0' } }, lockWhere('1.9.9')).findings;
            const d = findings.find((f) => findingKey(f) === 'D:lib');
            expect(d?.detail).toContain('PIN-BREAK');
        });

        it('ACCEPTS an ordinary upward security floor (positive control)', () => {
            // `uuid@^11.1.1` over next-auth's `^8.3.2` is what a security floor
            // IS. A rule that flagged this would have to waive every floor in
            // the table on day one, which is the reading this guard rejects —
            // see the module docblock in tests/helpers/overrides-analysis.ts.
            expect(keysOf({ overrides: { lib: '^2.0.0' } }, lockWhere('^1.0.0'))).not.toContain('D:lib');
        });

        it('ACCEPTS a ceiling that stays inside the requester\'s range', () => {
            // The `nwsapi` shape: `>=2.2.16 <2.2.25` inside jsdom's `^2.2.16`.
            expect(keysOf({ overrides: { lib: '>=1.2.0 <1.4.0' } }, lockWhere('^1.2.0'))).not.toContain('D:lib');
        });

        it('honours a key selector — an edge outside it is not this override\'s requester', () => {
            // `brace-expansion@^5` governs only instances resolving into ^5;
            // minimatch's `^1.1.7` edge is a different instance entirely, and
            // counting it would report a pin-break on every keyed override.
            const l: Lockfile = {
                packages: {
                    '': ROOT_ENTRY,
                    'node_modules/lib': { version: '5.0.9' },
                    'node_modules/old-consumer': { version: '1.0.0', dependencies: { lib: '^1.1.7' } },
                },
            };
            expect(keysOf({ overrides: { 'lib@^5': '^5.0.9' } }, l)).not.toContain('D:lib@^5');
        });

        it('resolves `$name` against the root package\'s own range', () => {
            // The postcss shape: `$postcss` is not a literal, and reading it as
            // one would make check D blind to the entry entirely.
            const p: PackageJson = { devDependencies: { lib: '^1.5.0' }, overrides: { lib: '$lib' } };
            const l: Lockfile = {
                packages: {
                    '': { dependencies: { lib: '^1.5.0' } },
                    'node_modules/lib': { version: '1.5.0' },
                    'node_modules/consumer': { version: '1.0.0', dependencies: { lib: '1.4.0' } },
                },
            };
            const d = analyseOverrides(p, l).findings.find((f) => findingKey(f) === 'D:lib');
            expect(d?.detail).toContain('PIN-BREAK');
        });
    });

    describe('the parsers themselves', () => {
        it('splits scoped keys and version selectors correctly', () => {
            expect(splitOverrideKey('@hono/node-server')).toEqual({ name: '@hono/node-server', selector: null });
            expect(splitOverrideKey('brace-expansion@^5')).toEqual({ name: 'brace-expansion', selector: '^5' });
            expect(splitOverrideKey('@scope/pkg@^2.1.0')).toEqual({ name: '@scope/pkg', selector: '^2.1.0' });
        });

        it('surfaces an override nested deeper than one level rather than skipping it', () => {
            const { unsupportedNesting } = overrideEdges({
                overrides: { a: { b: { c: '^1.0.0' } } },
            } as PackageJson);
            expect(unsupportedNesting).toEqual(['a > b']);
        });

        it('collects an unparseable requester range instead of dropping it', () => {
            const l: Lockfile = {
                packages: {
                    '': ROOT_ENTRY,
                    'node_modules/lib': { version: '1.0.0' },
                    'node_modules/consumer': { version: '1.0.0', dependencies: { lib: 'github:foo/bar' } },
                },
            };
            expect(analyseOverrides({ overrides: { lib: '^1.0.0' } }, l).unparseableRanges).toHaveLength(1);
        });
    });

    describe('the waiver bookkeeping', () => {
        it('flags an entry whose review date has passed', () => {
            // Rule 4 of the audit-exemptions idiom, ported: a `review` that is
            // only ever printed is write-only, and an accepted-for-now risk
            // becomes a forgotten one.
            expect(expired(new Date('2099-01-01T00:00:00Z')).length).toBeGreaterThan(0);
        });

        it('does not flag entries whose review date is still ahead', () => {
            expect(expired(new Date('2026-09-10T00:00:00Z'))).toEqual([]);
        });

        it('an unwaived finding is reported, not absorbed', () => {
            expect(unwaived([{ check: 'C', target: 'something-new', detail: 'x' }])).toHaveLength(1);
        });
    });
});

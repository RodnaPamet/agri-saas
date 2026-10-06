/**
 * The known-flake ledger is the thing that makes a NEW flake legible.
 *
 * ## What it is for
 *
 * On a green E2E shard, a spec that failed an attempt and passed on retry is
 * byte-identical in the log to one that has done so every run for a month.
 * That is #1076 exactly: its spec needed a retry on essentially every run,
 * stayed a `::notice` every time, and was only noticed when the retries ran
 * out and it blocked an unrelated dependency bump (#1036).
 *
 * `ci.yml` now classifies each flake against `tests/e2e/known-flakes.json` —
 * a ledgered one stays a notice, an unledgered one becomes a warning. The
 * split is between KNOWN and NEW, deliberately not between flake and failure:
 * the step's own comment records that annotating every green-run flake as an
 * error was measured and reverted because it cried wolf on clean runs.
 *
 * ## The failure mode this file actually guards
 *
 * The ledger is itself a fail-open mechanism. An entry matches on spec file +
 * title substring, so if a test is RENAMED and its ledger entry is not, the
 * entry stops matching that test — harmless — but if a title is made SHORTER
 * or more generic it can start matching a DIFFERENT test, silently excusing a
 * genuinely new flake as known. The strongest assertion here is therefore that
 * every ledgered title still occurs verbatim in its spec file: a rename breaks
 * the build instead of quietly widening the excuse.
 *
 * It cannot assert a flake has STOPPED. Absence is not observable from one
 * run, so pruning a fixed entry stays a human review — which is why every
 * entry carries an issue and a reason rather than just a name.
 */
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const LEDGER_REL = 'tests/e2e/known-flakes.json';
const WORKFLOW_REL = '.github/workflows/ci.yml';

interface Flake {
    spec: string;
    title: string;
    issue: number;
    firstSeen: string;
    /**
     * ISO date. Once it passes, the build FAILS until someone re-argues the
     * entry — the `overrides-structural-decay` pattern, for the same reason.
     *
     * #1329 is what this closes. A ledgered flake is deliberately QUIET: a
     * ::notice, not a warning, because annotating every green-run flake as an
     * error was measured on run 35427726541 and reverted for crying wolf. The
     * cost of that correct decision is that an entry ledgered in September
     * under an issue with no progress is indistinguishable from one fixed
     * yesterday, and stays quiet for ever. A review date is the forcing
     * function: it cannot be satisfied by nobody looking.
     */
    review: string;
    reason: string;
}

const ledger = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, LEDGER_REL), 'utf8')) as {
    flakes: Flake[];
};
const workflow = fs.readFileSync(path.join(REPO_ROOT, WORKFLOW_REL), 'utf8');

/**
 * The classification rule, in TypeScript, so it is EXECUTED here rather than
 * only asserted about. The workflow runs the jq equivalent; the text pin below
 * is what stops the two drifting.
 */
export function isLedgered(line: string, flakes: readonly Flake[]): boolean {
    return flakes.some((f) => line.includes(f.spec) && line.includes(f.title));
}

/** The jq filter `ci.yml` actually runs, lifted from the workflow itself. */
export function workflowJqFilter(yaml: string): string {
    const m = yaml.match(/'(\.flakes \| any\([^']*)'/);
    if (!m) {
        throw new Error(
            'Could not find the ledger jq filter in ci.yml. If the classification moved, ' +
                'this guard is no longer executing the real rule — fix the extractor rather ' +
                'than deleting the test, or the TS copy below becomes the only thing checked.',
        );
    }
    return m[1];
}

/**
 * Classify a log line the way the WORKFLOW does — by running its jq.
 *
 * The TS `isLedgered` above is a reimplementation, and the workflow pins its
 * jq only as TEXT. A text pin catches an edit to the filter; it cannot catch
 * the two DISAGREEING, which is exactly the bug that shipped once: a bare
 * `.spec` inside `contains()` resolves against the string input and errors,
 * so every line — ledgered ones included — read as unledgered. The workflow
 * comment records that being caught by hand, against real log lines. This
 * makes it a test.
 */
function isLedgeredByJq(line: string, ledgerJson: string): boolean {
    const r = spawnSync(
        'jq',
        ['-e', '--arg', 'l', line, workflowJqFilter(workflow), '-'],
        { input: ledgerJson, encoding: 'utf8' },
    );
    // jq -e exits 1 for a false/null result and >1 for an ERROR. Those must not
    // be conflated: an error means the filter is broken, and reading it as
    // "not ledgered" is how the original bug hid.
    if (r.status !== 0 && r.status !== 1) {
        throw new Error(`jq failed (status ${r.status}): ${r.stderr?.trim() ?? 'no stderr'}`);
    }
    return r.status === 0;
}

const E2E_SPECS = collectSourceFiles({
    roots: ['tests/e2e'],
    extensions: ['.spec.ts'],
    floor: 40, // measured 70
});

describe('the known-flake ledger', () => {
    it('control: the ledger and the spec population both loaded', () => {
        expect(ledger.flakes.length).toBeGreaterThan(0);
        expect(E2E_SPECS.length).toBeGreaterThanOrEqual(40);
    });

    it('every entry carries a REVIEW date, and no entry has expired', () => {
        // #1329 — the forcing function. A ledgered flake is quiet by design, so
        // without an expiry an entry outlives the investigation that justified
        // it and nothing ever says so. This is the `overrides-structural-decay`
        // pattern: once the date passes the build fails until someone re-argues.
        const today = new Date().toISOString().slice(0, 10);
        const expired: string[] = [];
        for (const f of ledger.flakes) {
            expect(typeof f.review).toBe('string');
            // Shape pinned, so a typo'd date cannot read as "far future".
            expect(f.review).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(Number.isNaN(Date.parse(f.review))).toBe(false);
            // The review must be AFTER the day it was first seen, or it is not
            // a review of anything.
            expect(f.review > f.firstSeen).toBe(true);
            if (f.review < today) expired.push(`${f.spec} :: ${f.title} (review ${f.review})`);
        }
        if (expired.length > 0) {
            throw new Error(
                `${expired.length} known-flake entr(ies) are past their review date:\n` +
                    expired.map((e) => `  ${e}`).join('\n') +
                    `\n\nA ledgered flake is annotated as a ::notice rather than a warning, ` +
                    `deliberately — so it is QUIET, and an entry nobody revisits stays quiet ` +
                    `for ever. That is #1329. Either fix the spec and delete the entry, or ` +
                    `re-argue it: confirm the issue is still live, update the reason with what ` +
                    `has been learned, and move the date to the next point the question is ` +
                    `answerable. Do not bump the date alone.`,
            );
        }
        expect(expired).toEqual([]);
    });

    it('every entry carries a spec, a real title, an issue and a reason', () => {
        for (const f of ledger.flakes) {
            expect(f.spec).toMatch(/\.spec\.ts$/);
            expect(f.title.length).toBeGreaterThan(8);
            expect(Number.isInteger(f.issue)).toBe(true);
            expect(f.firstSeen).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            // A name without a reason is an excuse. 120 chars is roughly one
            // real sentence about what was measured.
            expect(f.reason.length).toBeGreaterThan(120);
        }
    });

    it('no duplicate entries', () => {
        const keys = ledger.flakes.map((f) => `${f.spec}::${f.title}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('every ledgered spec FILE still exists', () => {
        const basenames = new Set(E2E_SPECS.map((f) => path.basename(f)));
        const missing = ledger.flakes.filter((f) => !basenames.has(f.spec));
        expect(missing.map((f) => f.spec)).toEqual([]);
    });

    it('every ledgered TITLE still occurs in its spec — a rename cannot widen the excuse', () => {
        // The load-bearing one. A title that no longer matches its own test is
        // either dead (harmless but misleading) or, if it was shortened,
        // matching a DIFFERENT test and excusing a flake nobody ledgered.
        const orphaned: string[] = [];
        for (const f of ledger.flakes) {
            const file = E2E_SPECS.find((p) => path.basename(p) === f.spec);
            if (!file) continue; // covered by the previous test
            if (!fs.readFileSync(file, 'utf8').includes(f.title)) {
                orphaned.push(`${f.spec} :: "${f.title}"`);
            }
        }
        expect(orphaned).toEqual([]);
    });

    it('a title matches ONLY its own test, not a sibling in the same file', () => {
        // The widening hazard, asserted rather than trusted: for each entry,
        // no OTHER `test('...')` title in the same file may contain it.
        const collisions: string[] = [];
        for (const f of ledger.flakes) {
            const file = E2E_SPECS.find((p) => path.basename(p) === f.spec);
            if (!file) continue;
            const titles = [
                ...fs.readFileSync(file, 'utf8').matchAll(/\btest\(\s*[`'"]([^`'"]+)[`'"]/g),
            ].map((m) => m[1]);
            const hits = titles.filter((t) => t.includes(f.title));
            if (hits.length > 1) collisions.push(`${f.spec} :: "${f.title}" matches ${hits.length}`);
        }
        expect(collisions).toEqual([]);
    });

    // ── The rule, executed ────────────────────────────────────────────

    it('classifies real log-line shapes correctly', () => {
        const ledgered =
            '✘  74 [chromium] › tests/e2e/entity-detail-layout.spec.ts:51:9 › EntityDetailLayout › asset detail page renders the shell — breadcrumbs, header, body (18.6s)';
        const unledgered =
            '✘  12 [chromium] › tests/e2e/journal-offline-create.spec.ts:40:9 › Journal › queues an entry while offline (9.1s)';
        // A ledgered FILE but a different TITLE is NOT ledgered.
        const siblingInLedgeredFile =
            '✘  63 [chromium] › tests/e2e/data-table-platform.spec.ts:90:9 › DataTable Platform — Cross-page regression › Tasks page renders DataTable (12.0s)';

        expect(isLedgered(ledgered, ledger.flakes)).toBe(true);
        expect(isLedgered(unledgered, ledger.flakes)).toBe(false);
        expect(isLedgered(siblingInLedgeredFile, ledger.flakes)).toBe(false);
        // Line numbers move — entity-detail-layout went :24 -> :51 inside one
        // PR when a comment block was added above it. Matching must not care.
        expect(isLedgered(ledgered.replace(':51:9', ':24:9'), ledger.flakes)).toBe(true);
        // An empty ledger classifies everything as new, which is the safe way
        // round and must stay true.
        expect(isLedgered(ledgered, [])).toBe(false);
    });

    it('the WORKFLOW jq agrees with this file on every case — not just textually', () => {
        // The pin below asserts the filter's TEXT. This asserts its BEHAVIOUR,
        // which is a different thing: the two copies could read identically and
        // still disagree, and the one bug this classification has actually had
        // was of exactly that kind (`.spec` inside contains() resolving against
        // the string input, so every line read as unledgered while the text
        // looked right).
        const ledgerJson = JSON.stringify(ledger);
        const cases: Array<[string, boolean]> = [
            [
                '✘  74 [chromium] › tests/e2e/entity-detail-layout.spec.ts:51:9 › EntityDetailLayout › asset detail page renders the shell — breadcrumbs, header, body (18.6s)',
                true,
            ],
            [
                '✘  12 [chromium] › tests/e2e/journal-offline-create.spec.ts:40:9 › Journal › queues an entry while offline (9.1s)',
                false,
            ],
            [
                '✘  63 [chromium] › tests/e2e/data-table-platform.spec.ts:90:9 › DataTable Platform — Cross-page regression › Tasks page renders DataTable (12.0s)',
                false,
            ],
            // #1329's additions, including the ciso-portfolio case that was
            // reading as NEW on every run because only its sibling was ledgered.
            [
                '✘  20 [chromium] › tests/e2e/tooltip-and-copy.spec.ts:158:9 › Epic 56 — tooltip + copy primitives › task detail header — task.key is copyable via CopyText (32.9s)',
                true,
            ],
            [
                '✘  55 [chromium] › tests/e2e/ciso-portfolio.spec.ts:183:9 › CISO portfolio journey (Epic O-4) › F — read-only invariant: AUDITOR cannot create tenant-level records (20.0s)',
                true,
            ],
        ];

        // Positive control FIRST: if jq cannot classify anything as ledgered,
        // every `false` expectation below passes for the wrong reason — which is
        // the precise shape of the bug this test exists for.
        expect(cases.some(([, want]) => want)).toBe(true);
        expect(isLedgeredByJq(cases[0][0], ledgerJson)).toBe(true);

        for (const [line, want] of cases) {
            expect(isLedgeredByJq(line, ledgerJson)).toBe(want);
            // ...and the two implementations agree, which is the drift check.
            expect(isLedgered(line, ledger.flakes)).toBe(want);
        }
    });

    // ── The workflow uses this rule ───────────────────────────────────

    it('ci.yml reads the ledger and splits notice from warning', () => {
        expect(workflow).toContain(LEDGER_REL);
        // The `. as $f` capture is the correction that made this work at all: a
        // bare `.spec` inside contains() resolves against the STRING input and
        // errors, which read as "unledgered" for every line.
        expect(workflow).toContain(
            '.flakes | any(. as $f | ($l | contains($f.spec)) and ($l | contains($f.title)))',
        );
        expect(workflow).toContain('::notice::flaky (known, see');
        expect(workflow).toContain('::warning::NEW flake, not in');
        // A missing ledger must say so rather than silently classifying.
        expect(workflow).toMatch(/is missing, so every flake below reads as unledgered/);
    });
});

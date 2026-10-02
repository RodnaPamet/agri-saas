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
import * as path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const LEDGER_REL = 'tests/e2e/known-flakes.json';
const WORKFLOW_REL = '.github/workflows/ci.yml';

interface Flake {
    spec: string;
    title: string;
    issue: number;
    firstSeen: string;
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

/**
 * The flake-ledger probe must report the two facts that rot on wall-clock
 * time, and must refuse rather than report a clean bill over what it could
 * not read.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `.github/scripts/flake-ledger-pointers.sh` had been in production since
 * #1803 with NO test executing it. It was hand-verified with DRY_RUN=1, which
 * is better than nothing and is why it worked — and adding the review-date
 * check (#2966) to it surfaced THREE defects inside an hour, each of which a
 * hand-test reads straight past:
 *
 *   1. `read` with `IFS=$'\t'` treats tab as IFS WHITESPACE and COLLAPSES runs
 *      of it, so an entry with no `review` field lost its empty column and the
 *      spec slid into the date slot. The missing-field branch then reported
 *      "unparseable date 'entity-detail-layout.spec.ts'" — a real refusal with
 *      the wrong diagnosis, which is worse than a crash, because it sends the
 *      reader to fix a date that is not there. The separator is US (U+001F)
 *      now, which is not IFS whitespace.
 *
 *   2. `date -d` CANNOT validate its own input. Measured on this runner:
 *      `date -u -d wat +%s` prints 1794265200 and exits 0, while
 *      `date -u -d not-a-date` fails. It accepts some garbage and rejects
 *      other garbage, so a non-zero exit from it is no evidence either way —
 *      and the first draft's date validation was exactly that exit code. It is
 *      a ROUND TRIP now: `date` re-emits the value as `%Y-%m-%d` and the
 *      result must be byte-identical, so anything it had to interpret fails.
 *      The draft also carried a format regex alongside; a mutation removed it
 *      with all 19 tests green, measurement showed the round trip strictly
 *      stronger, and it was dropped rather than kept as unkillable decoration.
 *
 *   3. `${x:+a #$x}${x:-b}` printed `#42424242`. `:-` substitutes the VALUE
 *      when the variable IS set, so both expansions fire and the number
 *      doubles. That line was the ORIGINAL script's, in dry-run output only —
 *      which is precisely why it survived two months: a human reads
 *      `#42424242` in a hand-test and the eye corrects it.
 *
 * All three are decision logic, and none is visible in YAML. The lesson is
 * this probe's own: a mechanism that reports on other people's staleness needs
 * to be at least as verifiable as what it watches.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/flake-ledger-pointers.sh');
const REAL_LEDGER = path.join(REPO_ROOT, 'tests/e2e/known-flakes.json');

const POINTER_TITLE = 'points at a closed issue';
const REVIEW_TITLE = 'due for review';

interface Scenario {
    /**
     * The clock. REQUIRED in every scenario that cares, because every review
     * date in the ledger is in the FUTURE on the day it is written — so
     * without an override the due branch is unreachable and only the empty one
     * is ever executed. A harness that cannot express the failing input is the
     * defect this repo keeps meeting, so the override is a control, not a
     * convenience.
     */
    today?: string;
    /** Ledger contents to write; omit to run against the REAL ledger on disk. */
    ledger?: unknown;
    /** Per-issue state. Anything unlisted answers OPEN. */
    states?: Record<string, 'OPEN' | 'CLOSED'>;
    /** An already-open tracking issue, per check. */
    tracking?: { pointer?: string; review?: string };
    viewFails?: boolean;
    listFails?: boolean;
}

interface Result {
    status: number;
    out: string;
    /** Every argv the stub was handed, one per line. */
    calls: string[];
}

function run(s: Scenario): Result {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-ledger-'));
    try {
        const callLog = path.join(dir, 'calls.txt');
        let ledger = REAL_LEDGER;
        if (s.ledger !== undefined) {
            ledger = path.join(dir, 'ledger.json');
            fs.writeFileSync(ledger, JSON.stringify(s.ledger));
        }

        const stateCases = Object.entries(s.states ?? {})
            .map(([n, v]) => `      ${n}) printf '%s' ${JSON.stringify(v)} ;;`)
            .join('\n');

        // No backticks anywhere in this stub: the whole thing is a TS template
        // literal, and a backtick inside a shell comment closes it (TS1005).
        const stub = `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "\${args//$'\\n'/ }" >> ${JSON.stringify(callLog)}
case "$1 $2" in
  "issue view")
    ${s.viewFails ? 'exit 1' : ''}
    case "$3" in
${stateCases}
      *) printf '%s' 'OPEN' ;;
    esac
    ;;
  "issue list")
    ${s.listFails ? 'exit 1' : ''}
    # Told apart by the TITLE in the search, because the two checks ask two
    # different questions and answering one with the other's number is how a
    # self-close ends up asserted against the wrong axis.
    case "$args" in
      *${JSON.stringify(POINTER_TITLE)}*) printf '%s' ${JSON.stringify(s.tracking?.pointer ?? '')} ;;
      *${JSON.stringify(REVIEW_TITLE)}*)  printf '%s' ${JSON.stringify(s.tracking?.review ?? '')} ;;
      *) printf '%s' '' ;;
    esac
    ;;
esac
exit 0
`;
        const bin = path.join(dir, 'gh');
        fs.writeFileSync(bin, stub, { mode: 0o755 });

        let status = 0;
        let out = '';
        try {
            out = execFileSync('bash', [SCRIPT], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    GH: bin,
                    LEDGER: ledger,
                    DRY_RUN: '1',
                    ...(s.today === undefined ? {} : { TODAY: s.today }),
                },
            });
        } catch (e) {
            const err = e as { status?: number; stdout?: string; stderr?: string };
            status = err.status ?? -1;
            out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
        }

        const calls = fs.existsSync(callLog)
            ? fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean)
            : [];
        return { status, out, calls };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** A ledger shaped like the real one, with the fields both checks read. */
function entry(over: Record<string, unknown> = {}) {
    return {
        spec: 'some.spec.ts',
        title: 'a flaky test',
        issue: 1076,
        firstSeen: '2026-09-23',
        review: '2026-12-31',
        reason: 'because',
        ...over,
    };
}

describe('§1 the review-date check reports, and only when a date has arrived', () => {
    it('reports nothing while every date is in the future', () => {
        const r = run({ today: '2026-11-10' });
        expect(r.status).toBe(0);
        expect(r.out).toContain('0 due for review');
        expect(r.out).not.toContain('DRY RUN: would create');
    });

    it('reports an entry on the day its date arrives — not the day after', () => {
        // The boundary is the whole point of a date: `>` instead of `>=` makes
        // the probe a day late every time, and a day late reads as working.
        const r = run({ today: '2026-11-18' });
        expect(r.status).toBe(0);
        expect(r.out).toContain('3 due for review');
        expect(r.out).toContain(`DRY RUN: would create "Flake ledger: an entry is ${REVIEW_TITLE}"`);
    });

    it('names every due entry, with its spec and how far past it is', () => {
        const r = run({ today: '2027-02-01' });
        expect(r.out).toContain('4 due for review');
        // 2026-11-18 -> 2027-02-01 is 75 days. A table row nobody can act on
        // without opening the ledger is the thing this report exists to avoid.
        expect(r.out).toMatch(/\| #1076 \| 2026-11-18 \| 75 \|/);
        expect(r.out).toContain('entity-detail-layout.spec.ts');
    });

    it('prints the DENOMINATOR beside the finding', () => {
        // A count of due entries with no population beside it cannot tell "one
        // of four" from "one of forty" — and a ledger that silently shrank
        // would report 0 due and look healthy.
        const r = run({ today: '2026-11-10' });
        expect(r.out).toMatch(/\[flake-ledger\] 4 ledgered; 0 due for review as of 2026-11-10/);
    });
});

describe('§2 each check files and closes on its OWN axis', () => {
    it('closes only the review issue when reviews clear but a pointer is stale', () => {
        const r = run({
            today: '2026-11-10',
            states: { 1862: 'CLOSED' },
            tracking: { pointer: '111', review: '222' },
        });
        expect(r.status).toBe(0);
        // The review issue closes — nothing is due.
        expect(r.out).toContain('DRY RUN: would close #222');
        // The pointer issue does NOT: #1862 is still closed. A single shared
        // tracking issue could not express this, which is why there are two.
        expect(r.out).toContain('DRY RUN: would comment on #111');
        expect(r.out).not.toContain('would close #111');
    });

    it('closes only the pointer issue when pointers clear but a review is due', () => {
        const r = run({ today: '2026-11-18', tracking: { pointer: '111', review: '222' } });
        expect(r.out).toContain('DRY RUN: would close #111');
        expect(r.out).toContain('DRY RUN: would comment on #222');
        expect(r.out).not.toContain('would close #222');
    });

    it('names the issue number ONCE', () => {
        // #42424242 — see the header. The expansion that produced it is
        // invisible in any assertion that only checks the number OCCURS.
        const r = run({ today: '2026-11-18', tracking: { review: '4242' } });
        expect(r.out).toContain('would comment on #4242 ');
        expect(r.out).not.toContain('#42424242');
    });

    it('creates rather than comments when no tracking issue is open', () => {
        const r = run({ today: '2026-11-18' });
        expect(r.out).toContain('DRY RUN: would create');
        expect(r.out).not.toContain('would comment on');
    });
});

describe('§3 it REFUSES rather than reporting over what it could not read', () => {
    it('fails when the ledger is not where it looks', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-ledger-missing-'));
        try {
            let status = 0;
            let out = '';
            try {
                out = execFileSync('bash', [SCRIPT], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, LEDGER: path.join(dir, 'nope.json'), DRY_RUN: '1' },
                });
            } catch (e) {
                const err = e as { status?: number; stdout?: string; stderr?: string };
                status = err.status ?? -1;
                out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
            }
            expect(status).toBe(1);
            expect(out).toContain('::error::ledger not found');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('fails on an entry carrying NO review date, and says so', () => {
        // The diagnosis is the assertion, not just the exit code: the tab-IFS
        // bug produced exit 1 with a confident wrong reason.
        const r = run({ ledger: { flakes: [entry({ review: undefined })] } });
        expect(r.status).toBe(1);
        expect(r.out).toContain('carries no review date');
        expect(r.out).not.toContain('not a YYYY-MM-DD');
    });

    it('fails on a review date that is not a date', () => {
        const r = run({ ledger: { flakes: [entry({ review: 'not-a-date' })] } });
        expect(r.status).toBe(1);
        expect(r.out).toContain("carries 'not-a-date', which is not a YYYY-MM-DD date");
    });

    it('fails on a WELL-SHAPED impossible date', () => {
        // 2026-13-45 matches the regex. Without the round-trip check `date`
        // normalises it silently to 2027-02-14 and the probe reports a date
        // the ledger does not contain.
        const r = run({ ledger: { flakes: [entry({ review: '2026-13-45' })] } });
        expect(r.status).toBe(1);
        expect(r.out).toContain('not a YYYY-MM-DD date');
    });

    it('fails on a garbage clock that `date -d` would happily accept', () => {
        // The control for defect 2 in the header. `date -u -d wat +%s` exits 0
        // and prints an epoch, so this case can only pass if something other
        // than that exit code is deciding.
        const r = run({ today: 'wat' });
        expect(r.status).toBe(1);
        expect(r.out).toContain("TODAY='wat' is not a YYYY-MM-DD date");
    });

    it('fails when an issue lookup could not be performed', () => {
        const r = run({ today: '2026-11-10', viewFails: true });
        expect(r.status).toBe(1);
        expect(r.out).toContain('unverified, which is not the same as fine');
    });

    it('fails when it cannot tell whether a tracking issue already exists', () => {
        // Guessing "none" here files a duplicate every single week.
        const r = run({ today: '2026-11-10', listFails: true });
        expect(r.status).toBe(1);
        expect(r.out).toContain('refusing to guess whether');
    });

    it('fails on a ledger that parses to no entries', () => {
        const r = run({ ledger: { flakes: [] } });
        expect(r.status).toBe(1);
        expect(r.out).toContain('::error::');
    });
});

describe('§4 controls — the harness and the real ledger', () => {
    it('the real ledger carries a review date on every entry', () => {
        // Ties this suite to the shipped artefact: a ledger that stopped
        // carrying the field would make §1 assert over a shape nothing uses.
        const parsed = JSON.parse(fs.readFileSync(REAL_LEDGER, 'utf8')) as {
            flakes: { review?: string; issue?: number }[];
        };
        expect(parsed.flakes.length).toBeGreaterThan(0);
        for (const f of parsed.flakes) {
            expect(f.review).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(Number.isInteger(f.issue)).toBe(true);
        }
    });

    it('the clock override is what makes the due branch reachable', () => {
        // Without this, every assertion in §1 could be satisfied by a probe
        // that reports 0 due unconditionally — because on any real day it
        // would be right. The two answers must DIFFER on one ledger.
        const future = run({ today: '2026-11-10' }).out;
        const arrived = run({ today: '2026-11-18' }).out;
        expect(future).toContain('0 due for review');
        expect(arrived).toContain('3 due for review');
        expect(future).not.toEqual(arrived);
    });

    it('the stub was actually called — a silent no-op would pass §1 otherwise', () => {
        const r = run({ today: '2026-11-10' });
        expect(r.calls.some((c) => c.startsWith('issue view'))).toBe(true);
        expect(r.calls.some((c) => c.startsWith('issue list'))).toBe(true);
    });
});

/**
 * The Dependabot health probe fires on a SUSTAINED outage, not on a flap — #2422.
 *
 * ## Why this test exists at all
 *
 * The probe moved from daily to 6-hourly, and that made its old verdict rule
 * too eager. The rule was "no success newer than the newest failure"; four
 * times a day, with an updater that flaps — 5 of the last 20 completed runs
 * unsuccessful while PRs kept arriving — that files and self-closes an issue
 * every few hours, which teaches people to ignore it. The cost of being
 * ignored is higher than the latency it saved.
 *
 * So the rule gained a second condition, and this file is what stops it being
 * loosened or tightened by accident. The arithmetic lives in a shell script
 * that runs unattended every six hours; without a test, a change to it is
 * discovered by a missed outage or by a wave of noise, both after the fact.
 *
 * ## It drives the REAL script, not a copy of the logic
 *
 * `HEALTH_VERDICT_ONLY=1` plus `HEALTH_RUNS_JSON` makes the script judge the
 * supplied history, print the verdict, and stop before anything is written. A
 * TypeScript reimplementation of the rule would be a second copy to drift —
 * the mistake `a-crosscheck-in-the-old-method` names — so the seam exists
 * precisely so there is only one copy.
 *
 * The two-variable gate is deliberate and asserted below: a single stray
 * `HEALTH_RUNS_JSON` would otherwise replace the real run history with
 * whatever it held, and the probe would report on data nobody fetched.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const SCRIPT = join(process.cwd(), '.github/scripts/dependabot-updater-health.sh');

interface Run {
    created_at: string;
    conclusion: string;
}

const fail = (created_at: string): Run => ({ created_at, conclusion: 'failure' });
const ok = (created_at: string): Run => ({ created_at, conclusion: 'success' });

/** Runs the real script in verdict-only mode and returns what it decided. */
function verdict(runs: Run[]): { down: boolean; unanswered: number; spanMin: number } {
    const out = execFileSync('bash', [SCRIPT], {
        encoding: 'utf8',
        env: {
            ...process.env,
            HEALTH_VERDICT_ONLY: '1',
            HEALTH_RUNS_JSON: JSON.stringify(runs),
        },
    });
    const m = /VERDICT down=([01]) unanswered=(\d+) span_min=(\d+)/.exec(out);
    if (!m) throw new Error(`no verdict line in output:\n${out}`);
    return { down: m[1] === '1', unanswered: Number(m[2]), spanMin: Number(m[3]) };
}

describe('the probe exists and is reachable', () => {
    it('the script is where this test thinks it is', () => {
        // Without this, a rename turns every assertion below into an ENOENT
        // that reads as a broken test rather than a missing probe.
        expect(existsSync(SCRIPT)).toBe(true);
    });
});

describe('a SUSTAINED outage is reported', () => {
    it('the real outage of 2026-10-27 — two failures 51 minutes apart', () => {
        // The positive control, and it is a real case rather than an invented
        // one: these are the timestamps that prompted the 6-hourly move, with
        // the last success the previous evening.
        expect(verdict([
            fail('2026-10-27T11:07:59Z'),
            fail('2026-10-27T10:16:00Z'),
            ok('2026-10-26T18:00:04Z'),
        ])).toEqual({ down: true, unanswered: 2, spanMin: 51 });
    });

    it('a window with NO success anywhere is down, span test or not', () => {
        // Deliberately a separate branch in the script: when the whole window
        // is red there is nothing to measure a span against, and demanding one
        // would make a total outage report healthy.
        expect(verdict([fail('2026-10-27T11:07:59Z'), fail('2026-10-27T10:16:00Z')]).down).toBe(true);
    });

    it('a long outage is still down', () => {
        expect(verdict([
            fail('2026-10-27T15:00:00Z'),
            fail('2026-10-27T13:00:00Z'),
            fail('2026-10-27T10:00:00Z'),
            ok('2026-10-26T18:00:04Z'),
        ])).toEqual({ down: true, unanswered: 3, spanMin: 300 });
    });
});

describe('a FLAP is not reported — the half that is easy to lose', () => {
    it('a single failure after a success is not an outage', () => {
        expect(verdict([fail('2026-10-27T11:07:59Z'), ok('2026-10-26T18:00:04Z')]))
            .toEqual({ down: false, unanswered: 1, spanMin: 0 });
    });

    it('two failures four minutes apart are ONE concurrent batch', () => {
        // The case the span exists for. Dependabot runs several jobs at once —
        // three at 22:52 on 2026-10-23 — so a count of two proves nothing
        // about duration, and a bad leg in one batch is not a dead updater.
        expect(verdict([
            fail('2026-10-27T11:07:00Z'),
            fail('2026-10-27T11:03:00Z'),
            ok('2026-10-26T18:00:04Z'),
        ])).toEqual({ down: false, unanswered: 2, spanMin: 4 });
    });

    it('a success AFTER the failures clears it — this is what self-closes the issue', () => {
        expect(verdict([
            ok('2026-10-27T12:00:00Z'),
            fail('2026-10-27T11:07:59Z'),
            fail('2026-10-27T10:16:00Z'),
        ])).toEqual({ down: false, unanswered: 0, spanMin: 0 });
    });

    it('an all-green window is not down', () => {
        expect(verdict([ok('2026-10-27T11:00:00Z')]).down).toBe(false);
    });
});

describe('the boundary is where the script says it is', () => {
    it('19 minutes apart does NOT fire, 20 does', () => {
        // Pinning the threshold itself. A change to SUSTAINED_MIN should have
        // to edit this test and say why, rather than sliding silently.
        const base = ok('2026-10-26T18:00:04Z');
        expect(verdict([fail('2026-10-27T10:19:00Z'), fail('2026-10-27T10:00:00Z'), base]).down).toBe(false);
        expect(verdict([fail('2026-10-27T10:20:00Z'), fail('2026-10-27T10:00:00Z'), base]).down).toBe(true);
    });
});

describe('the test seam cannot be tripped by accident', () => {
    it('HEALTH_VERDICT_ONLY alone refuses, rather than judging nothing', () => {
        // An empty history would otherwise compute "no failures" and report the
        // updater healthy having examined nothing — the empty-population defect
        // this repo keeps finding, inside the probe's own test hatch.
        let stderr = '';
        try {
            execFileSync('bash', [SCRIPT], {
                encoding: 'utf8',
                env: { ...process.env, HEALTH_VERDICT_ONLY: '1', HEALTH_RUNS_JSON: '' },
            });
        } catch (e) {
            stderr = String((e as { stdout?: string; stderr?: string }).stdout ?? '')
                + String((e as { stderr?: string }).stderr ?? '');
        }
        expect(stderr).toMatch(/needs HEALTH_RUNS_JSON/);
    });

    it('HEALTH_RUNS_JSON alone does NOT replace the real history', () => {
        // The two-variable gate. With only the data variable set, the script
        // must take its normal path — which, with no repo, fails on the repo
        // rather than silently judging the supplied rows.
        let out = '';
        try {
            execFileSync('bash', [SCRIPT], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GITHUB_REPOSITORY: '',
                    HEALTH_RUNS_JSON: JSON.stringify([fail('2026-10-27T11:00:00Z')]),
                },
            });
        } catch (e) {
            out = String((e as { stdout?: string }).stdout ?? '') + String((e as { stderr?: string }).stderr ?? '');
        }
        expect(out).toMatch(/GITHUB_REPOSITORY is required/);
        expect(out).not.toMatch(/VERDICT down=/);
    });
});

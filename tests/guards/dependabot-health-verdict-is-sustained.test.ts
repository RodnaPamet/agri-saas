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
    /**
     * The dependency group, from `display_title` — #2600.
     *
     * Optional so every pre-existing case below keeps compiling unchanged. An
     * absent title reads as one group, which is what those cases mean: they
     * were written when the only question was "is it sustained", and a
     * same-group default keeps their verdicts exactly as they were.
     */
    title?: string;
}

const fail = (created_at: string, title = 'npm_and_yarn in / for group-a'): Run => ({
    created_at,
    conclusion: 'failure',
    title,
});
const ok = (created_at: string, title = 'npm_and_yarn in / for group-a'): Run => ({
    created_at,
    conclusion: 'success',
    title,
});

/** Runs the real script in verdict-only mode and returns what it decided. */
function verdict(runs: Run[]): {
    down: boolean;
    stuck: boolean;
    unanswered: number;
    spanMin: number;
    groups: number;
} {
    const out = execFileSync('bash', [SCRIPT], {
        encoding: 'utf8',
        env: {
            ...process.env,
            HEALTH_VERDICT_ONLY: '1',
            HEALTH_RUNS_JSON: JSON.stringify(runs),
        },
    });
    // The parser reads EVERY field by name rather than by position. #2600
    // added `stuck=` and `groups=` between the existing ones, and a
    // positional regex would have stopped matching and reported "no verdict
    // line" for all eleven cases — a parser failure that reads as the script
    // being broken.
    const field = (name: string): string => {
        const m = new RegExp(`VERDICT[^\n]*\\b${name}=(\\d+)`).exec(out);
        if (!m) throw new Error(`no \`${name}\` in the verdict line:\n${out}`);
        return m[1];
    };
    return {
        down: field('down') === '1',
        stuck: field('stuck') === '1',
        unanswered: Number(field('unanswered')),
        spanMin: Number(field('span_min')),
        groups: Number(field('groups')),
    };
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
        // `stuck: true` beside `down: true` is the whole of #2600's correction.
        //
        // This is the REAL outage of 2026-10-27, and its failures are all one
        // group. The first attempt at #2600 made a single group SUPPRESS the
        // outage verdict, on the reasoning that a real outage fails across
        // groups — and this case refused it, because a genuine patching outage
        // would then have been reported as a harmless stuck advisory.
        //
        // So `stuck` annotates and never suppresses: `down` is unchanged from
        // what it has always been here, and the flag only changes the ISSUE
        // WORDING so a human is told to read the error type. Downgrading an
        // outage is the dangerous direction; saying "check which of two things
        // this is" costs nothing.
        ])).toEqual({ down: true, stuck: true, unanswered: 2, spanMin: 51, groups: 1 });
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
        ])).toEqual({ down: true, stuck: true, unanswered: 3, spanMin: 300, groups: 1 });
    });
});

describe('a FLAP is not reported — the half that is easy to lose', () => {
    it('a single failure after a success is not an outage', () => {
        expect(verdict([fail('2026-10-27T11:07:59Z'), ok('2026-10-26T18:00:04Z')]))
            .toEqual({ down: false, stuck: false, unanswered: 1, spanMin: 0, groups: 1 });
    });

    it('two failures four minutes apart are ONE concurrent batch', () => {
        // The case the span exists for. Dependabot runs several jobs at once —
        // three at 22:52 on 2026-10-23 — so a count of two proves nothing
        // about duration, and a bad leg in one batch is not a dead updater.
        expect(verdict([
            fail('2026-10-27T11:07:00Z'),
            fail('2026-10-27T11:03:00Z'),
            ok('2026-10-26T18:00:04Z'),
        ])).toEqual({ down: false, stuck: false, unanswered: 2, spanMin: 4, groups: 1 });
    });

    it('a success AFTER the failures clears it — this is what self-closes the issue', () => {
        expect(verdict([
            ok('2026-10-27T12:00:00Z'),
            fail('2026-10-27T11:07:59Z'),
            fail('2026-10-27T10:16:00Z'),
        ])).toEqual({ down: false, stuck: false, unanswered: 0, spanMin: 0, groups: 0 });
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

describe('a STUCK advisory is not an outage — #2600', () => {
    /**
     * #2598's real shape: five failures over three hours, every one the same
     * group, every one `security_update_not_possible` because the only patch
     * path for `brace-expansion` was a DOWNGRADE from the copy vendored inside
     * `npm` itself. Nothing was broken, and the issue said "security and
     * version bumps are not arriving".
     *
     * The span test cannot catch this — it exists to stop a TRANSIENT reading
     * as an outage, and a permanent refusal crosses any threshold a real
     * outage must cross. The group count is what separates them.
     */
    const BRACE = 'npm_and_yarn in /. for brace-expansion, brace-expansion';
    const OTHER = 'github_actions in / for actions/checkout';

    it('one group failing repeatedly is FLAGGED, and still reported down', () => {
        const v = verdict([
            fail('2026-10-31T16:56:00Z', BRACE),
            fail('2026-10-31T13:27:00Z', BRACE),
            ok('2026-10-29T19:18:00Z', 'npm_and_yarn in / for aws-sdk'),
        ]);
        // BOTH, and that is the design. `stuck` changes the wording so a
        // reader is told to check the error type; it does not and must not
        // clear the verdict, because the 2026-10-27 case above proves a real
        // outage can look exactly like this from run conclusions alone.
        expect(v).toMatchObject({ down: true, stuck: true, groups: 1 });
        expect(v.unanswered).toBeGreaterThanOrEqual(2);
        expect(v.spanMin).toBeGreaterThanOrEqual(20);
    });

    it('stuck is NEVER set without a success in the window to contrast against', () => {
        // With nothing green at all there is no evidence the updater works, so
        // the softer wording would be unearned.
        expect(
            verdict([fail('2026-10-31T16:56:00Z', BRACE), fail('2026-10-31T13:27:00Z', BRACE)]),
        ).toMatchObject({ down: true, stuck: false });
    });

    it('TWO groups failing is still an outage — the #2230 case is unchanged', () => {
        const v = verdict([
            fail('2026-10-31T16:56:00Z', BRACE),
            fail('2026-10-31T13:27:00Z', OTHER),
            ok('2026-10-29T19:18:00Z', 'npm_and_yarn in / for aws-sdk'),
        ]);
        expect(v).toMatchObject({ down: true, stuck: false, groups: 2 });
    });

    it('a success newer than every failure is healthy, neither down nor stuck', () => {
        const v = verdict([fail('2026-10-31T16:56:00Z', BRACE), ok('2026-10-31T20:00:00Z', BRACE)]);
        expect(v).toMatchObject({ down: false, stuck: false, unanswered: 0, groups: 0 });
    });

    it('an unsustained single failure is neither — the hiccup path still wins', () => {
        // One failure, so the span test refuses it before the group test is
        // reached. Asserted because the two checks could otherwise be reordered
        // into something that calls every single red run a stuck advisory.
        const v = verdict([fail('2026-10-31T16:56:00Z', BRACE), ok('2026-10-31T16:00:00Z', BRACE)]);
        expect(v).toMatchObject({ down: false, stuck: false, unanswered: 1 });
    });

});

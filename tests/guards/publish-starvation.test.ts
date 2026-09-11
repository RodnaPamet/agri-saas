/**
 * Publish must be able to ship the tip during a busy period (#877).
 *
 * ── What was broken ──
 *
 * `ghcr-publish.yml` ran with `cancel-in-progress: true`. A publish takes
 * 13.6 min at the median and 22.8 at the measured worst; 37% of the gaps
 * between consecutive merges to main are shorter than 21.4 min. When merges
 * arrive faster than a build finishes, EVERY build is cancelled before it can
 * push, nothing ships, and no run is red — each cancellation is individually
 * correct. On 2026-09-10 that state held for over three hours.
 *
 * ── Why this is a simulation, and what stops it being a story ──
 *
 * A merge cadence is not something a test can produce, so the semantics are
 * modelled (tests/helpers/actions-concurrency.ts) and the model is checked
 * against 199 REAL publish runs before any conclusion is drawn from it:
 * replaying the true merge timestamps under the OLD policy reproduces
 * GitHub's own success/cancelled verdict on ~94% of those runs. The
 * comparison is run at a CONSTANT build duration on purpose — feeding each
 * run its own recorded duration would leak the answer, because a run that
 * succeeded is by definition one no merge interrupted.
 *
 * ── The honest limit, stated rather than hidden ──
 *
 * A CLOSED burst — three merges in twenty minutes and then silence — ends
 * with the tip built under BOTH policies, and under the old one it is built
 * SOONER. That case is asserted below precisely so nobody mistakes it for the
 * proof. What the old policy cannot do is ship anything while the busy period
 * is still going, which is the measured incident and the discriminating
 * scenario here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
    resolveConcurrency,
    shippingMetrics,
    simulateConcurrency,
    type MergeEvent,
    type SimulationResult,
} from '../helpers/actions-concurrency';

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ghcr-publish.yml');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'ghcr-publish-history.json');

interface HistoryRun {
    sha: string;
    mergedAt: string;
    conclusion: string;
    minutes: number;
}
interface History {
    window: { from: string; to: string };
    runs: HistoryRun[];
}

const history: History = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const workflowDoc = yaml.load(fs.readFileSync(WORKFLOW, 'utf8')) as Record<string, unknown>;

/** Measured over the fixture's successful runs. */
const MEDIAN_BUILD_MIN = 13.6;
const WORST_BUILD_MIN = 22.8;
/** The publish that finally got through on 2026-09-10, once merges were held: 21m22s. */
const INCIDENT_BUILD_MIN = 21.4;

const T0 = new Date(history.runs[0].mergedAt).getTime();
const realMerges: MergeEvent[] = history.runs.map((r) => ({
    sha: r.sha,
    at: (new Date(r.mergedAt).getTime() - T0) / 60000,
}));

/** merges every `cadence` minutes, `count` of them, starting at t=0. */
function cadence(count: number, everyMinutes: number): MergeEvent[] {
    return Array.from({ length: count }, (_, i) => ({
        sha: `c${String(i).padStart(2, '0')}`,
        at: i * everyMinutes,
    }));
}

/**
 * The simulation as an OBSERVER standing at minute `horizon` would see it.
 *
 * Every run eventually ends, so a simulation played to exhaustion always
 * builds the last commit — which is exactly why the old policy looked healthy:
 * the tip DOES get built, once the merges stop. The question that matters is
 * what has shipped while the busy period is still going.
 */
function asOf(result: SimulationResult, horizon: number): SimulationResult {
    return {
        runs: result.runs.filter((r) => r.endedAt <= horizon),
        published: result.published.filter((p) => p.at <= horizon),
    };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the evidence this stands on is real and non-empty', () => {
    it('the fixture holds a substantial run of REAL publish history', () => {
        // An empty or tiny fixture would make every simulation below vacuously
        // agreeable. This is the first thing to fail if it is ever emptied.
        expect(history.runs.length).toBeGreaterThanOrEqual(150);
        const days =
            (new Date(history.window.to).getTime() - new Date(history.window.from).getTime()) /
            86_400_000;
        expect(days).toBeGreaterThan(20);
    });

    it('that history contains BOTH outcomes, so agreement is not free', () => {
        const conclusions = history.runs.map((r) => r.conclusion);
        expect(conclusions.filter((c) => c === 'success').length).toBeGreaterThan(50);
        expect(conclusions.filter((c) => c === 'cancelled').length).toBeGreaterThan(20);
    });

    it('the recorded cadence really is faster than a build, often', () => {
        const gaps = realMerges.slice(1).map((m, i) => m.at - realMerges[i].at);
        expect(gaps.length).toBeGreaterThan(150);
        const tooFast = gaps.filter((g) => g < INCIDENT_BUILD_MIN).length;
        // 73/198 when captured. The starvation needs no unusual behaviour.
        expect(tooFast / gaps.length).toBeGreaterThan(0.25);
    });
});

describe('the publish workflow queues instead of cancelling', () => {
    it('resolves `cancel-in-progress: false` from the live YAML', () => {
        const resolved = resolveConcurrency(workflowDoc);
        // `resolveConcurrency` throws on a non-boolean, so a quoted "false" —
        // which GitHub reads as a truthy string — cannot satisfy this.
        expect(resolved.cancelInProgress).toBe(false);
    });

    it('keeps ONE group per ref, which is what serialises `:latest`', () => {
        const { group } = resolveConcurrency(workflowDoc);
        expect(group).toContain('github.ref');
        // A per-commit group would run publishes in parallel; see the
        // `:latest` ordering measurement further down for why that is refused.
        expect(group).not.toContain('github.sha');
    });

    it('still runs on every push to main, and on manual dispatch', () => {
        // The group only matters if these events land in it. `workflow_dispatch`
        // on main joins the same group — which is why manual dispatch never
        // rescued a starved publish.
        expect(Object.keys(workflowDoc)).toContain('on');
        const on = workflowDoc.on as Record<string, unknown>;
        expect(Object.keys(on)).toEqual(expect.arrayContaining(['push', 'workflow_dispatch']));
        expect((on.push as { branches: string[] }).branches).toContain('main');
    });
});

describe('the model implements GitHub’s concurrency rules', () => {
    const two: MergeEvent[] = [
        { sha: 'a', at: 0 },
        { sha: 'b', at: 5 },
    ];

    it('cancel-in-progress: true kills the run that is EXECUTING', () => {
        const { runs } = simulateConcurrency({
            merges: two,
            buildMinutes: 20,
            cancelInProgress: true,
        });
        const a = runs.find((r) => r.sha === 'a');
        expect(a).toMatchObject({ outcome: 'cancelled-while-running', startedAt: 0, endedAt: 5 });
    });

    it('cancel-in-progress: false lets the executing run FINISH', () => {
        const { runs, published } = simulateConcurrency({
            merges: two,
            buildMinutes: 20,
            cancelInProgress: false,
        });
        expect(runs.find((r) => r.sha === 'a')).toMatchObject({ outcome: 'success', endedAt: 20 });
        expect(published.map((p) => p.sha)).toEqual(['a', 'b']);
    });

    it('...and still DROPS a superseded PENDING run, at zero runner minutes', () => {
        // The load-bearing half. Without it, `false` would mean "build every
        // commit" and the queue would grow without bound during a busy hour.
        const three: MergeEvent[] = [
            { sha: 'a', at: 0 },
            { sha: 'b', at: 5 },
            { sha: 'c', at: 9 },
        ];
        const result = simulateConcurrency({
            merges: three,
            buildMinutes: 20,
            cancelInProgress: false,
        });
        const b = result.runs.find((r) => r.sha === 'b');
        expect(b).toMatchObject({ outcome: 'cancelled-while-pending', startedAt: null });
        expect(result.published.map((p) => p.sha)).toEqual(['a', 'c']);

        const metrics = shippingMetrics(three, result);
        // Two builds for three commits — a is already executing, c is the
        // newest. b costs nothing at all.
        expect(metrics.imagesShipped).toBe(2);
        expect(metrics.runnerMinutes).toBe(40);
        expect(metrics.wastedMinutes).toBe(0);
    });
});

describe('the model reproduces the history GitHub actually recorded', () => {
    // Replayed at a CONSTANT duration: giving each run its own recorded
    // duration would hand the model the answer for every success.
    const replay = simulateConcurrency({
        merges: realMerges,
        buildMinutes: MEDIAN_BUILD_MIN,
        cancelInProgress: true,
    });
    const predicted = new Map(
        replay.runs.map((r) => [r.sha, r.outcome === 'success' ? 'success' : 'cancelled']),
    );
    const comparable = history.runs.filter(
        (r) => r.conclusion === 'success' || r.conclusion === 'cancelled',
    );

    it('predicts a non-trivial mix, not a constant', () => {
        expect(comparable.length).toBeGreaterThanOrEqual(150);
        const values = [...predicted.values()];
        expect(values.filter((v) => v === 'success').length).toBeGreaterThan(20);
        expect(values.filter((v) => v === 'cancelled').length).toBeGreaterThan(20);
    });

    it('agrees with the recorded conclusion on the large majority of runs', () => {
        const agreed = comparable.filter((r) => predicted.get(r.sha) === r.conclusion).length;
        const rate = agreed / comparable.length;
        // 93.9% at capture. The residue is real: build durations vary from
        // 7.6 to 22.8 minutes and this replay pins one number.
        expect(rate).toBeGreaterThan(0.85);
    });
});

describe('ACCEPTANCE — a busy period at the measured incident cadence', () => {
    // The 2026-09-10 shape: merges roughly every 8 minutes, publishes taking
    // 21m22s, for three hours.
    const BUSY_MINUTES = 180;
    const busy = cadence(23, 8);
    // Resolved lazily, inside the tests that use it. At describe scope a
    // malformed workflow would throw during collection and take the whole file
    // down as "0 tests" — a red with no surviving control beside it.
    const liveCancelInProgress = () => resolveConcurrency(workflowDoc).cancelInProgress;

    /** What an observer at the three-hour mark would see. */
    const observed = (cancelInProgress: boolean) =>
        asOf(
            simulateConcurrency({
                merges: busy,
                buildMinutes: INCIDENT_BUILD_MIN,
                cancelInProgress,
            }),
            BUSY_MINUTES,
        );

    it('the scenario is a real busy period, not an empty one', () => {
        expect(busy.length).toBeGreaterThanOrEqual(20);
        expect(busy[busy.length - 1].at).toBeLessThanOrEqual(BUSY_MINUTES);
    });

    it('OLD (cancel-in-progress: true): NOTHING ships in three hours', () => {
        const metrics = shippingMetrics(busy, observed(true));
        // The measured incident, reproduced: 23 commits merged, zero images,
        // not one of them ever reaching the registry inside the window.
        expect(metrics.imagesShipped).toBe(0);
        expect(metrics.neverShipped).toBe(busy.length);
        expect(metrics.maxUnshippedMinutes).toBe(Number.POSITIVE_INFINITY);
        // And it was not for want of trying: ~40 min of build per hour, burnt.
        expect(metrics.wastedMinutes).toBeGreaterThan(100);
    });

    it('NEW (the config read from the workflow file): images keep shipping', () => {
        const metrics = shippingMetrics(busy, observed(liveCancelInProgress()));
        expect(metrics.imagesShipped).toBeGreaterThanOrEqual(7);
        expect(metrics.neverShipped).toBeLessThan(busy.length);
        expect(metrics.maxUnshippedMinutes).toBeLessThanOrEqual(2 * INCIDENT_BUILD_MIN);
    });

    it('NEW: three merges in twenty minutes end with the tip built', () => {
        // Take the first twenty minutes of the busy period — merges at 0, 8
        // and 16 — and ask whether that window's tip has an image, WITHOUT the
        // busy period stopping. It never stops here; merges keep arriving for
        // another 2h40m, which is what the old policy could not survive.
        const windowMerges = busy.filter((m) => m.at <= 20);
        expect(windowMerges).toHaveLength(3);
        const tip = windowMerges[windowMerges.length - 1];

        const order = new Map(busy.map((m, i) => [m.sha, i]));
        const tipIndex = order.get(tip.sha)!;

        // "Built" means an image for the tip or for something newer — a later
        // commit's image supersedes it, and that is a ship, not a miss.
        const built = (cancelInProgress: boolean) =>
            observed(cancelInProgress).published.find(
                (p) => p.at >= tip.at && order.get(p.sha)! >= tipIndex,
            );

        const underOld = built(true);
        const underNew = built(liveCancelInProgress());

        expect(underOld).toBeUndefined();
        expect(underNew).toBeDefined();
        // and it arrives within two build durations of that merge.
        expect(underNew!.at - tip.at).toBeLessThanOrEqual(2 * INCIDENT_BUILD_MIN);
    });

    it('a CLOSED three-merge burst does not discriminate — stated, not hidden', () => {
        // Merges at 0, 8, 16 and then silence. The last merge's build is not
        // interrupted by anything, so BOTH policies build the tip, and the old
        // one builds it sooner because it does not first finish a stale build.
        // This is exactly why the bug was invisible: every isolated burst
        // looked fine.
        const closed = cadence(3, 8);
        const tip = closed[2];
        const at = (cancelInProgress: boolean) => {
            const { published } = simulateConcurrency({
                merges: closed,
                buildMinutes: INCIDENT_BUILD_MIN,
                cancelInProgress,
            });
            const hit = published.find((p) => p.sha === tip.sha);
            expect(hit).toBeDefined();
            return hit!.at;
        };
        expect(at(true)).toBeCloseTo(tip.at + INCIDENT_BUILD_MIN, 5);
        expect(at(false)).toBeGreaterThan(at(true));
        expect(at(false)).toBeLessThanOrEqual(tip.at + 2 * INCIDENT_BUILD_MIN);
    });
});

describe('controls — both verdicts are reachable, so neither is a tautology', () => {
    it('the model CAN report a built tip under the old policy', () => {
        // One merge, nothing to cancel it. If this failed, "unbuilt tip" above
        // would just be what the model always says.
        const single = cadence(1, 0);
        const { published } = simulateConcurrency({
            merges: single,
            buildMinutes: INCIDENT_BUILD_MIN,
            cancelInProgress: true,
        });
        expect(published.map((p) => p.sha)).toEqual([single[0].sha]);
    });

    it('the model CAN report an UNBUILT tip under the new policy', () => {
        // A horizon shorter than one build. If this failed, "the tip is built"
        // would be what the model always says.
        const busy = cadence(5, 8);
        const { published } = simulateConcurrency({
            merges: busy,
            buildMinutes: INCIDENT_BUILD_MIN,
            cancelInProgress: false,
        });
        const tip = busy[busy.length - 1].sha;
        const early = published.filter((p) => p.at <= busy[busy.length - 1].at);
        expect(early.map((p) => p.sha)).not.toContain(tip);
    });

    it('the SAME merges and policy flip verdict as the horizon moves', () => {
        // The horizon is what carries the meaning, so it has to be shown
        // working in both directions on one simulation. Merges every 8 min,
        // 21.4-min builds, queueing: at minute 20 nothing has shipped yet; at
        // minute 200 everything has.
        const merges = cadence(5, 8);
        const result = simulateConcurrency({
            merges,
            buildMinutes: INCIDENT_BUILD_MIN,
            cancelInProgress: false,
        });

        const early = shippingMetrics(merges, asOf(result, 20));
        expect(early.imagesShipped).toBe(0);
        expect(early.neverShipped).toBe(merges.length);
        expect(early.maxUnshippedMinutes).toBe(Number.POSITIVE_INFINITY);

        const late = shippingMetrics(merges, asOf(result, 200));
        expect(late.imagesShipped).toBeGreaterThan(0);
        expect(late.neverShipped).toBe(0);
        expect(Number.isFinite(late.maxUnshippedMinutes)).toBe(true);
    });
});

describe('what the change costs, over the real 199-merge timeline', () => {
    const run = (cancelInProgress: boolean, buildMinutes: number) => {
        const result = simulateConcurrency({ merges: realMerges, buildMinutes, cancelInProgress });
        return shippingMetrics(realMerges, result);
    };

    it.each([
        ['median build', MEDIAN_BUILD_MIN],
        ['worst-case build', WORST_BUILD_MIN],
    ])('%s: queueing ships more, wastes less, and never rolls back', (_label, minutes) => {
        const before = run(true, minutes);
        const after = run(false, minutes);

        expect(after.imagesShipped).toBeGreaterThan(before.imagesShipped);
        expect(after.wastedMinutes).toBeLessThan(before.wastedMinutes / 3);
        expect(after.maxUnshippedMinutes).toBeLessThan(before.maxUnshippedMinutes);
        // Serialised in one group, so `:latest` only ever moves forward.
        expect(after.latestPointerRegressions).toBe(0);
        // The extra runner minutes are real builds that ship, not waste.
        expect(after.runnerMinutes).toBeGreaterThan(before.runnerMinutes);
        expect(after.runnerMinutes).toBeLessThan(before.runnerMinutes * 1.5);
    });

    it('a per-commit group would roll `:latest` BACKWARDS — measured, not asserted', () => {
        // The rejected alternative (b): ci.yml's per-commit group shape. Real
        // durations, so the spread that causes the reordering is the real one.
        const durationOf = new Map(
            history.runs.map((r) => [
                r.sha,
                r.conclusion === 'success' ? r.minutes : MEDIAN_BUILD_MIN,
            ]),
        );
        const result = simulateConcurrency({
            merges: realMerges,
            buildMinutes: (m) => durationOf.get(m.sha) ?? MEDIAN_BUILD_MIN,
            cancelInProgress: false,
            groupOf: (m) => `ghcr-publish-refs/heads/main-${m.sha}`,
        });
        const metrics = shippingMetrics(realMerges, result);

        // Positive control: the parallel arrangement did in fact run and ship
        // everything, so a zero-regression reading would mean something.
        expect(metrics.imagesShipped).toBe(realMerges.length);
        expect(metrics.latestPointerRegressions).toBeGreaterThan(0);
    });
});

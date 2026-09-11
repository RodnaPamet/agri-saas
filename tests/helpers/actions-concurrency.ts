/**
 * A model of GitHub Actions' `concurrency` semantics, plus the shipping
 * metrics that make a publish policy comparable to another one.
 *
 * WHY THIS EXISTS (#877). `ghcr-publish` ran under
 *
 *     concurrency:
 *       group: ghcr-publish-${{ github.ref }}
 *       cancel-in-progress: true
 *
 * A publish takes 13.6 min at the median and 22.8 min at the worst measured.
 * When merges arrive faster than that, every build is cancelled before it
 * finishes and NOTHING ships — with no failure anywhere, because each
 * individual cancellation is correct. Measured 2026-09-10: production sat
 * three commits behind for over three hours.
 *
 * The change cannot be proved by running it: a merge cadence is not something
 * a test can produce. So the semantics are modelled here and the model is
 * VALIDATED against 199 real publish runs (tests/fixtures/ghcr-publish-history.json)
 * before any conclusion is drawn from it. See tests/guards/publish-starvation.test.ts.
 *
 * ── The rule that decides everything ──
 *
 * GitHub keeps, per concurrency group, ONE running run and ONE pending run.
 *
 *   cancel-in-progress: true   a new run CANCELS the running one and starts.
 *   cancel-in-progress: false  a new run waits as PENDING; and "any previously
 *                              pending run in the group is cancelled".
 *
 * That second half is the load-bearing part and it is easy to get backwards.
 * `cancel-in-progress: false` does NOT mean "build every commit": the running
 * build finishes, intermediate commits are dropped while still pending (zero
 * runner minutes), and only the NEWEST pending commit is built next. This repo
 * already learned that rule the other way round, in ci.yml's concurrency
 * comment — there the pending-drop was the bug, because CI produces per-commit
 * signals. Here it is the feature, because a publish produces one mutable
 * `:latest` pointer and only the newest commit's image matters.
 */

/** A merge to the publishing branch. `at` is minutes from an arbitrary zero. */
export interface MergeEvent {
    sha: string;
    at: number;
}

export type RunOutcome =
    | 'success'
    | 'cancelled-while-running'
    /**
     * Superseded before it ever executed. `startedAt` is null — the run burned
     * no runner minutes. A record type that could not express this would make
     * `cancel-in-progress: false` look as expensive as building every commit,
     * which is precisely the wrong conclusion.
     */
    | 'cancelled-while-pending';

export interface RunRecord {
    sha: string;
    group: string;
    /** null iff the run was cancelled while still pending. */
    startedAt: number | null;
    /** When it finished, was cancelled, or was dropped from the queue. */
    endedAt: number;
    outcome: RunOutcome;
}

export interface SimulationInput {
    merges: readonly MergeEvent[];
    /** Minutes a build takes. A function lets real per-commit durations be replayed. */
    buildMinutes: number | ((merge: MergeEvent) => number);
    cancelInProgress: boolean;
    /**
     * Which concurrency group a merge lands in. The default puts every merge in
     * one group, which is what `ghcr-publish-${{ github.ref }}` does for pushes
     * to main (and for a `workflow_dispatch` on main — it joins the same group,
     * which is why manual dispatch never rescued a starved publish).
     *
     * Returning a per-commit group models the rejected alternative: runs go
     * fully parallel, and completions can then arrive out of merge order.
     */
    groupOf?: (merge: MergeEvent) => string;
}

export interface SimulationResult {
    /** Every run, in the order it ended (completed, cancelled, or dropped). */
    runs: RunRecord[];
    /** Successful publishes, in completion order — i.e. the order `:latest` moved. */
    published: { at: number; sha: string }[];
}

interface LiveRun {
    merge: MergeEvent;
    startedAt: number;
    endsAt: number;
}

interface GroupState {
    running: LiveRun | null;
    pending: MergeEvent | null;
}

const ONE_GROUP = () => 'default';

/**
 * Replay a merge stream through GitHub's concurrency rules.
 *
 * Ties (a completion at exactly the moment of a merge) resolve completion-first:
 * the run had already finished when the webhook arrived.
 */
export function simulateConcurrency(input: SimulationInput): SimulationResult {
    const groupOf = input.groupOf ?? ONE_GROUP;
    const durationOf =
        typeof input.buildMinutes === 'function'
            ? input.buildMinutes
            : () => input.buildMinutes as number;

    const merges = [...input.merges].sort((a, b) => a.at - b.at);
    const groups = new Map<string, GroupState>();
    const runs: RunRecord[] = [];
    const published: { at: number; sha: string }[] = [];

    const stateFor = (key: string): GroupState => {
        let s = groups.get(key);
        if (!s) {
            s = { running: null, pending: null };
            groups.set(key, s);
        }
        return s;
    };

    const start = (merge: MergeEvent, at: number): LiveRun => ({
        merge,
        startedAt: at,
        endsAt: at + durationOf(merge),
    });

    const nextCompletion = (): { key: string; state: GroupState } | null => {
        let best: { key: string; state: GroupState } | null = null;
        for (const [key, state] of groups) {
            if (!state.running) continue;
            if (!best || state.running.endsAt < best.state.running!.endsAt) {
                best = { key, state };
            }
        }
        return best;
    };

    let i = 0;
    for (;;) {
        const mergeAt = i < merges.length ? merges[i].at : Number.POSITIVE_INFINITY;
        const completion = nextCompletion();
        const completionAt = completion
            ? completion.state.running!.endsAt
            : Number.POSITIVE_INFINITY;

        if (completionAt === Number.POSITIVE_INFINITY && mergeAt === Number.POSITIVE_INFINITY) {
            break;
        }

        if (completionAt <= mergeAt) {
            const { key, state } = completion!;
            const done = state.running!;
            runs.push({
                sha: done.merge.sha,
                group: key,
                startedAt: done.startedAt,
                endedAt: done.endsAt,
                outcome: 'success',
            });
            published.push({ at: done.endsAt, sha: done.merge.sha });
            state.running = null;
            if (state.pending) {
                state.running = start(state.pending, done.endsAt);
                state.pending = null;
            }
            continue;
        }

        const merge = merges[i++];
        const key = groupOf(merge);
        const state = stateFor(key);

        if (!state.running) {
            state.running = start(merge, merge.at);
            continue;
        }

        if (input.cancelInProgress) {
            const killed = state.running;
            runs.push({
                sha: killed.merge.sha,
                group: key,
                startedAt: killed.startedAt,
                endedAt: merge.at,
                outcome: 'cancelled-while-running',
            });
            state.running = start(merge, merge.at);
            continue;
        }

        // Queue. Any run already waiting in this group is dropped — GitHub keeps
        // only the newest pending run per group.
        if (state.pending) {
            runs.push({
                sha: state.pending.sha,
                group: key,
                startedAt: null,
                endedAt: merge.at,
                outcome: 'cancelled-while-pending',
            });
        }
        state.pending = merge;
    }

    return { runs, published };
}

export interface ShippingMetrics {
    imagesShipped: number;
    cancelledWhileRunning: number;
    cancelledWhilePending: number;
    /** Runner minutes actually consumed (a pending cancellation consumes none). */
    runnerMinutes: number;
    /** Runner minutes consumed by runs that shipped nothing. */
    wastedMinutes: number;
    /**
     * Per merge, minutes until an image for THAT commit or a LATER one existed.
     * `Infinity` when the horizon ended with the commit still unshipped.
     */
    unshippedMinutes: number[];
    maxUnshippedMinutes: number;
    neverShipped: number;
    /**
     * Times `:latest` moved BACKWARDS — a publish landing after a publish of a
     * newer commit. Zero whenever the runs are serialised in one group; this
     * counts what a per-commit group would cost.
     */
    latestPointerRegressions: number;
}

export function shippingMetrics(
    merges: readonly MergeEvent[],
    result: SimulationResult,
): ShippingMetrics {
    const order = new Map(merges.map((m, index) => [m.sha, index]));
    const positionOf = (sha: string): number => {
        const p = order.get(sha);
        if (p === undefined) {
            throw new Error(`published sha ${sha} is not in the merge stream`);
        }
        return p;
    };

    const unshippedMinutes = merges.map((merge, index) => {
        const hit = result.published.find(
            (p) => p.at >= merge.at && positionOf(p.sha) >= index,
        );
        return hit ? hit.at - merge.at : Number.POSITIVE_INFINITY;
    });
    const finite = unshippedMinutes.filter((m) => Number.isFinite(m));

    let regressions = 0;
    let high = -1;
    for (const p of result.published) {
        const pos = positionOf(p.sha);
        if (pos < high) regressions += 1;
        else high = pos;
    }

    const minutesOf = (r: RunRecord) => (r.startedAt === null ? 0 : r.endedAt - r.startedAt);

    return {
        imagesShipped: result.runs.filter((r) => r.outcome === 'success').length,
        cancelledWhileRunning: result.runs.filter((r) => r.outcome === 'cancelled-while-running')
            .length,
        cancelledWhilePending: result.runs.filter((r) => r.outcome === 'cancelled-while-pending')
            .length,
        runnerMinutes: result.runs.reduce((sum, r) => sum + minutesOf(r), 0),
        wastedMinutes: result.runs
            .filter((r) => r.outcome !== 'success')
            .reduce((sum, r) => sum + minutesOf(r), 0),
        unshippedMinutes,
        maxUnshippedMinutes: finite.length ? Math.max(...finite) : Number.POSITIVE_INFINITY,
        neverShipped: unshippedMinutes.filter((m) => !Number.isFinite(m)).length,
        latestPointerRegressions: regressions,
    };
}

export interface ResolvedConcurrency {
    group: string;
    cancelInProgress: boolean;
}

/**
 * Read a workflow's concurrency block as GitHub would resolve it.
 *
 * Deliberately strict about the type of `cancel-in-progress`. YAML would happily
 * accept `"false"`, which GitHub treats as a truthy string — the setting would
 * silently revert to cancelling while the file still read as fixed. A test that
 * only checked `!== true` would pass on that.
 */
export function resolveConcurrency(doc: unknown): ResolvedConcurrency {
    const concurrency = (doc as { concurrency?: unknown })?.concurrency;
    if (concurrency === undefined || concurrency === null) {
        throw new Error('workflow declares no `concurrency` block');
    }
    if (typeof concurrency === 'string') {
        return { group: concurrency, cancelInProgress: false };
    }
    const block = concurrency as Record<string, unknown>;
    const group = block.group;
    const cancel = block['cancel-in-progress'];
    if (typeof group !== 'string' || group.length === 0) {
        throw new Error('`concurrency.group` is missing or not a string');
    }
    if (typeof cancel !== 'boolean') {
        throw new Error(
            `\`concurrency.cancel-in-progress\` must be a YAML boolean, got ${typeof cancel} (${JSON.stringify(
                cancel,
            )}). A quoted "false" is a truthy string to GitHub.`,
        );
    }
    return { group, cancelInProgress: cancel };
}

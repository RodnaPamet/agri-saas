/**
 * Douglas–Peucker simplification for a day's machine track — #2948 stage 3.
 *
 * ## DISPLAY ONLY. Nothing that MEASURES may use this.
 *
 * The worked-parcel derivation, the retention sweep and anything else that
 * produces a number must read RAW positions. A simplified track is a picture
 * of the path, and measuring a picture yields a confident wrong figure —
 * worse than a crash, because somebody puts it in a subsidy return.
 *
 * That rule is held by `tests/guards/track-simplify-is-display-only.test.ts`
 * and NOT by this paragraph, on the `notice-score-is-shadow-only` pattern: a
 * rule in a comment is held by nobody.
 *
 * ## Why it exists at all
 *
 * A tracker at 30 s writes ~2,900 points a day — ~250 KB of JSON per
 * machine-day on rural LTE, for detail a phone screen cannot show (measured by
 * the iOS session, which draws it). 3 m is chosen against the WORK, not the
 * screen: implement passes are 12–36 m apart, so every pass and turn survives
 * and only points along a straight run go.
 *
 * ## Three kinds of point are never dropped, and the third is the one to remember
 *
 *  - the FIRST and LAST point, so the day's extent is never shortened;
 *  - every point where `ignition` CHANGES, because a stop that matters would
 *    otherwise vanish into a straight run. A machine idling at a headland for
 *    forty minutes is exactly what an operator is looking for, and it is
 *    geometrically indistinguishable from a point passed straight through.
 *
 * Implemented by SPLITTING the track at protected indices and running
 * Douglas–Peucker on each span independently, rather than special-casing the
 * recursion. The split is what makes the guarantee structural: a protected
 * point cannot be dropped because it is never inside a span.
 *
 * ## Over the cap it raises the TOLERANCE; it does not cut the day
 *
 * The first design capped the output and set `truncated`. That fails the
 * definition the feature was given — "the same path at screen resolution" —
 * because a day cut at 1,500 points is a different, shorter path, and on
 * screen it reads as a machine that stopped mid-afternoon. Doubling the
 * tolerance keeps the whole day at lower resolution, which satisfies that
 * definition at every point count.
 *
 * So `truncated` keeps its contract meaning — the day genuinely did not fit,
 * e.g. the raw row cap in the query — and stays a different condition from
 * "drawn coarser", which is what `simplified` and `toleranceM` report.
 */
import { perpendicularMetres } from '@/lib/geo/local-metres';

/** The default tolerance, in metres. See the docblock for why 3. */
export const DEFAULT_TOLERANCE_M = 3;

/** Soft ceiling on the returned point count. */
export const DEFAULT_MAX_POINTS = 1_500;

/**
 * Bound on the tolerance-doubling loop. 3 m doubled twelve times is ~12 km,
 * far past any farm, so reaching this means the input is not a track. It
 * exists so a pathological input cannot spin — not as a tuning knob.
 */
const MAX_PASSES = 12;

/**
 * Ceiling on perpendicular-distance computations per `simplifyTrack` call.
 *
 * MEASURED, because the radial pre-pass does NOT bound the worst case — it
 * collapses points that are CLOSE, and the quadratic shape is a sawtooth whose
 * points are far apart in travel and far off the line between their
 * neighbours. The pre-pass leaves such a track untouched, correctly.
 *
 *   realistic day, 2,880 points      41k calls     32 ms
 *   sawtooth,      2,900 points     4.2M calls  1,215 ms
 *
 * 400k is ~10x the realistic day and ~125 ms at the measured rate, which
 * bounds an HTTP handler. Exhausting it stops the SPLITTING, so the result is
 * a valid simplification at a coarser effective resolution — a prefix of the
 * refinement sequence, which is what a larger tolerance would have produced
 * anyway. It is reported rather than silent: `budgetExhausted` says the shape
 * was limited by work rather than by `toleranceM`, and those are different
 * facts about the same coarse line.
 */
const PERP_BUDGET = 400_000;

/** The minimum this needs of a point. Callers pass their own richer objects. */
export interface SimplifiableTrackPoint {
    lon: string;
    lat: string;
    ignition: boolean | null;
}

export interface SimplifyResult<T> {
    /** A SUBSET of the input objects, by reference, in input order. */
    points: T[];
    /** True when anything was dropped. */
    simplified: boolean;
    /** The tolerance actually achieved, which may exceed the one requested. */
    toleranceM: number;
    /** The input count, so a reader can tell a light touch from a heavy one. */
    rawCount: number;
    /**
     * True when the work ceiling stopped the refinement. The line is coarser
     * than `toleranceM` implies, and the cause is the input's shape rather
     * than the tolerance — a distinction a reader cannot recover otherwise.
     */
    budgetExhausted: boolean;
}

export interface SimplifyOptions {
    toleranceM?: number;
    maxPoints?: number;
}

/** lon/lat as numbers, for the geometry ONLY — never for the output. */
function coord(p: SimplifiableTrackPoint): [number, number] {
    return [Number(p.lon), Number(p.lat)];
}

/**
 * Indices that must survive: the ends, and every `ignition` transition.
 *
 * `null` is treated as its own value rather than as `false`: a machine with no
 * ignition input wired must not read as a continuous stream of "engine off"
 * transitions, which would protect every point and simplify nothing.
 */
function protectedIndices(points: readonly SimplifiableTrackPoint[]): number[] {
    const keep = new Set<number>([0, points.length - 1]);
    for (let i = 1; i < points.length; i++) {
        if (points[i].ignition !== points[i - 1].ignition) {
            // BOTH sides of the transition: the last point before the change
            // and the first after it, so the straight run either side cannot
            // swallow the moment it happened.
            keep.add(i - 1);
            keep.add(i);
        }
    }
    return [...keep].sort((a, b) => a - b);
}

/**
 * Douglas–Peucker over `points[from..to]` inclusive, returning kept indices.
 *
 * Iterative with an explicit stack rather than recursive: a day's track is
 * thousands of points, and a recursive implementation's depth is the worst
 * case of the split, which a nearly-straight run drives toward O(n).
 */
function douglasPeucker(
    points: readonly SimplifiableTrackPoint[],
    from: number,
    to: number,
    toleranceM: number,
    budget: Budget,
): number[] {
    const keep = new Set<number>([from, to]);
    const stack: [number, number][] = [[from, to]];

    while (stack.length > 0) {
        const span = stack.pop();
        if (!span) break;
        const [a, b] = span;
        if (b - a < 2) continue;

        // Checked per SPAN rather than per call: abandoning a span half-scanned
        // would pick the worst point of a prefix, which is a different and
        // arbitrary answer. Stopping between spans leaves a coarser but
        // principled line.
        if (budget.left < b - a) {
            // An explicit FLAG, not `left <= 0` at the end: breaking out
            // leaves `left` positive but too small for the next span, so the
            // arithmetic check reported "not exhausted" on a run that had in
            // fact stopped refining. Found by a test asserting the flag.
            budget.exhausted = true;
            break;
        }
        budget.left -= b - a;

        const pa = coord(points[a]);
        const pb = coord(points[b]);
        let worst = -1;
        let worstD = 0;
        for (let i = a + 1; i < b; i++) {
            const d = perpendicularMetres(coord(points[i]), pa, pb);
            if (d > worstD) {
                worstD = d;
                worst = i;
            }
        }
        if (worst >= 0 && worstD > toleranceM) {
            keep.add(worst);
            stack.push([a, worst], [worst, b]);
        }
    }
    return [...keep];
}

/** One pass at a fixed tolerance, respecting the protected anchors. */
interface Budget {
    left: number;
    exhausted: boolean;
}

/**
 * One pass at a fixed tolerance, respecting the protected anchors.
 *
 * ## There is deliberately NO radial pre-filter, and that is a REVERSAL
 *
 * This had one — drop a point within `toleranceM` of the last kept point, the
 * `simplify-js` arrangement — added after measuring Douglas-Peucker at 4.2M
 * perpendicular calls (1,215 ms) on a dense 2,900-point sawtooth. A mutation
 * removed it and all 39 tests stayed green, twice, including a test written
 * specifically to catch it. So I measured what it actually does, and the
 * justification I had written for it was wrong in both halves:
 *
 *  - **Jitter BELOW the tolerance:** a 40-minute idle is 80 points inside
 *    ~1.5 m, and DP drops them anyway, because a deviation under the
 *    tolerance is exactly what DP discards. My claim that DP "measures from a
 *    chord across the cluster and keeps a scattering" was simply false.
 *  - **Deviation ABOVE the tolerance:** that is the sawtooth, whose points are
 *    13 m apart — so a radial sweep at 3 m thins nothing. It cannot help the
 *    only case that is slow.
 *
 * The one shape it would have changed is dense noise that is both closer than
 * the tolerance AND deviating further than it, where radial filtering would
 * drop points DP would keep — a behaviour change, not a speed win, and not
 * one anybody asked for.
 *
 * So the quadratic case is bounded by the work BUDGET, which is proved by a
 * mutation, and this pass is gone. A protection no mutation can kill is one
 * the next reader trusts for a guarantee it does not provide.
 */
function onePass(
    points: readonly SimplifiableTrackPoint[],
    toleranceM: number,
    budget: Budget,
): number[] {
    const anchors = protectedIndices(points);
    const keep = new Set<number>(anchors);
    for (let s = 0; s < anchors.length - 1; s++) {
        for (const i of douglasPeucker(points, anchors[s], anchors[s + 1], toleranceM, budget)) {
            keep.add(i);
        }
    }
    return [...keep].sort((a, b) => a - b);
}

/**
 * Simplify a track for display.
 *
 * Returns the caller's own objects, by reference and in input order, so no
 * coordinate is ever rebuilt from the `number` the geometry used — the stored
 * `Decimal` strings reach the response exactly as they came out of the
 * database.
 */
export function simplifyTrack<T extends SimplifiableTrackPoint>(
    points: readonly T[],
    opts: SimplifyOptions = {},
): SimplifyResult<T> {
    const requested = opts.toleranceM ?? DEFAULT_TOLERANCE_M;
    const maxPoints = opts.maxPoints ?? DEFAULT_MAX_POINTS;
    const rawCount = points.length;

    // Two points cannot be simplified and zero cannot be indexed — an early
    // return also keeps `protectedIndices` from adding -1 for an empty input.
    if (rawCount <= 2) {
        return {
            points: [...points], simplified: false, toleranceM: requested, rawCount,
            budgetExhausted: false,
        };
    }

    const budget: Budget = { left: PERP_BUDGET, exhausted: false };
    let toleranceM = requested;
    let kept = onePass(points, toleranceM, budget);

    // The anchors are a FLOOR the tolerance cannot push past: a track with
    // more ignition transitions than `maxPoints` keeps all of them, and the
    // loop must stop rather than double for ever chasing a cap it cannot
    // reach. That is the right trade — those are the points an operator is
    // looking for. `MAX_PASSES` and the work budget are what bound it.
    //
    // There is deliberately NO "stop when a doubling did not help" check. The
    // first draft had one and it broke the feature: a 24-lane day reduces to
    // 59 points at 3 m and ALSO at 6 m, because 6 m still resolves lanes 12 m
    // apart — so the loop broke on that one flat step and returned 59 against
    // a cap of 20, never reaching the tolerance that would have worked.
    // Reduction in point count is not monotone per doubling; the cap is the
    // only correct stop condition.
    let attempt = toleranceM;
    for (let pass = 0; kept.length > maxPoints && pass < MAX_PASSES; pass++) {
        attempt *= 2;
        const candidate = onePass(points, attempt, budget);
        // Keep the smaller of the two: a coarser tolerance cannot make the
        // line better, and on a flat step it returns the same set.
        //
        // `toleranceM` advances only when the candidate is ACTUALLY taken, so
        // the reported figure describes the line returned. Advancing it with
        // `attempt` would over-report after a discarded step — and the iOS
        // session may gate a copy line on this number, so an over-report is a
        // sentence shown to a farmer about coarseness that is not there.
        if (candidate.length < kept.length) {
            kept = candidate;
            toleranceM = attempt;
        }
        if (budget.exhausted) break;
    }

    return {
        points: kept.map((i) => points[i]),
        simplified: kept.length < rawCount,
        toleranceM,
        rawCount,
        budgetExhausted: budget.exhausted,
    };
}

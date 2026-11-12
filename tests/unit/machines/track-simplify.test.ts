/**
 * The track simplifier. Mostly about what it must NEVER drop.
 *
 * Every "it dropped points" assertion is paired with a control that it kept
 * the ones that matter, because "returns 2 points" is satisfied by a function
 * that throws the track away — and a thrown-away track still draws a line
 * between the right endpoints, so it looks plausible on a map.
 *
 * Geometry is built in METRES around a Sofia base and converted once, so each
 * case says what it means ("40 m off the line") rather than carrying opaque
 * decimals.
 */
import {
    simplifyTrack,
    DEFAULT_TOLERANCE_M,
    DEFAULT_MAX_POINTS,
    type SimplifiableTrackPoint,
} from '@/lib/machines/track-simplify';
import { perpendicularMetres, toLocalMetres, distanceMetres } from '@/lib/geo/local-metres';

const BASE_LON = 23.3219;
const BASE_LAT = 42.6977;
const M_PER_DEG = 111_320;
const COS = Math.cos(BASE_LAT * (Math.PI / 180));

/** A point `eastM` east and `northM` north of the base. */
function pt(eastM: number, northM: number, ignition: boolean | null = true): SimplifiableTrackPoint {
    return {
        lon: (BASE_LON + eastM / (M_PER_DEG * COS)).toFixed(7),
        lat: (BASE_LAT + northM / M_PER_DEG).toFixed(7),
        ignition,
    };
}

/** A straight east–west run of `n` points, `spacingM` apart. */
function straightRun(n: number, spacingM = 10, ignition: boolean | null = true) {
    return Array.from({ length: n }, (_, i) => pt(i * spacingM, 0, ignition));
}

describe('§0 the controls — it simplifies, and it does not throw the track away', () => {
    it('collapses a straight run to its two ends', () => {
        const r = simplifyTrack(straightRun(50));
        expect(r.points).toHaveLength(2);
        expect(r.simplified).toBe(true);
        expect(r.rawCount).toBe(50);
    });

    it('KEEPS a zigzag whose deviation exceeds the tolerance', () => {
        // The other direction. Without this, "collapses to 2" is satisfied by
        // a function that returns the endpoints of anything.
        const zig = Array.from({ length: 21 }, (_, i) => pt(i * 10, i % 2 === 0 ? 0 : 40));
        const r = simplifyTrack(zig);
        expect(r.points.length).toBeGreaterThan(10);
    });

    it('leaves a track already under the tolerance alone', () => {
        const r = simplifyTrack([pt(0, 0), pt(10, 0.5), pt(20, 0)]);
        // The middle point is 0.5 m off a 20 m line — under 3 m, so it goes.
        expect(r.points).toHaveLength(2);
    });

    it('returns 0, 1 and 2-point tracks untouched', () => {
        for (const n of [0, 1, 2]) {
            const r = simplifyTrack(straightRun(n));
            expect(r.points).toHaveLength(n);
            expect(r.simplified).toBe(false);
            expect(r.rawCount).toBe(n);
        }
    });
});

describe('§1 the ends are never dropped', () => {
    it('keeps the first and last point of a long straight run', () => {
        const run = straightRun(500);
        const r = simplifyTrack(run);
        expect(r.points[0]).toBe(run[0]);
        expect(r.points.at(-1)).toBe(run.at(-1));
    });

    it('keeps them even when the tolerance is enormous', () => {
        const run = straightRun(500);
        const r = simplifyTrack(run, { toleranceM: 100_000 });
        expect(r.points).toHaveLength(2);
        expect(r.points[0]).toBe(run[0]);
        expect(r.points[1]).toBe(run.at(-1));
    });
});

describe('§2 every ignition transition survives', () => {
    it('keeps both sides of a stop in the middle of a straight run', () => {
        // Geometrically this point is indistinguishable from one passed
        // straight through, which is exactly why it needs protecting: a
        // machine idling at a headland is what the operator is looking for.
        const run = [...straightRun(20, 10, true), ...straightRun(20, 10, false)];
        // Re-space the second half so it continues the line.
        const track = run.map((p, i) => pt(i * 10, 0, i < 20));
        const r = simplifyTrack(track);
        expect(r.points).toContain(track[19]); // last with ignition on
        expect(r.points).toContain(track[20]); // first with it off
    });

    it('keeps EVERY transition when the machine stops repeatedly', () => {
        const track = Array.from({ length: 60 }, (_, i) =>
            pt(i * 10, 0, Math.floor(i / 10) % 2 === 0),
        );
        const r = simplifyTrack(track);
        // Five transitions, two points each, plus the two ends.
        for (let i = 1; i < track.length; i++) {
            if (track[i].ignition !== track[i - 1].ignition) {
                expect(r.points).toContain(track[i - 1]);
                expect(r.points).toContain(track[i]);
            }
        }
    });

    it('treats null ignition as its OWN value, not as false', () => {
        // If null collapsed to false, an all-null track (a machine with no
        // ignition wired) would read as a transition at every point and
        // simplify nothing — so this asserts the straight run still collapses.
        const r = simplifyTrack(straightRun(50, 10, null));
        expect(r.points).toHaveLength(2);
    });

    it('DOES protect a null -> true transition, because that is a real change', () => {
        const track = Array.from({ length: 40 }, (_, i) => pt(i * 10, 0, i < 20 ? null : true));
        const r = simplifyTrack(track);
        expect(r.points).toContain(track[19]);
        expect(r.points).toContain(track[20]);
    });
});

describe('§3 the tolerance is a real threshold', () => {
    it('drops a point just UNDER and keeps one just OVER', () => {
        // Both sides of the same boundary, so an always-keep or always-drop
        // implementation fails one of them.
        const under = simplifyTrack([pt(0, 0), pt(100, DEFAULT_TOLERANCE_M - 0.5), pt(200, 0)]);
        expect(under.points).toHaveLength(2);

        const over = simplifyTrack([pt(0, 0), pt(100, DEFAULT_TOLERANCE_M + 0.5), pt(200, 0)]);
        expect(over.points).toHaveLength(3);
    });

    it('honours an explicit tolerance', () => {
        const track = [pt(0, 0), pt(100, 10), pt(200, 0)];
        expect(simplifyTrack(track, { toleranceM: 5 }).points).toHaveLength(3);
        expect(simplifyTrack(track, { toleranceM: 20 }).points).toHaveLength(2);
    });

    it('survives an implement pass at 12 m — the spacing the tolerance was chosen against', () => {
        // Adjacent passes 12 m apart must not be merged into one line.
        const passes: SimplifiableTrackPoint[] = [];
        for (let lane = 0; lane < 4; lane++) {
            for (let i = 0; i < 20; i++) {
                passes.push(pt(lane % 2 === 0 ? i * 10 : (19 - i) * 10, lane * 12));
            }
        }
        const r = simplifyTrack(passes);
        // Each lane's turn must survive, so at least two points per lane.
        expect(r.points.length).toBeGreaterThanOrEqual(8);
    });
});

describe('§4 over the cap it raises the tolerance and keeps the WHOLE day', () => {
    /**
     * A REALISTIC day: 24 lanes 12 m apart, 10 m spacing, a little GPS noise.
     * 2,880 points that DP reduces to ~59 — so the cap is exercised with a
     * small `maxPoints` rather than with a synthetic sawtooth, which is DP's
     * O(n²) worst case and measured at 4.2M perpendicular calls for 2,900
     * points. Testing the cap should not require the pathological shape.
     */
    function realisticDay(lanes = 24, perLane = 120) {
        const out: SimplifiableTrackPoint[] = [];
        for (let lane = 0; lane < lanes; lane++) {
            for (let i = 0; i < perLane; i++) {
                const east = (lane % 2 === 0 ? i : perLane - 1 - i) * 10;
                out.push(pt(east + Math.sin(i) * 0.4, lane * 12 + Math.cos(i) * 0.4));
            }
        }
        return out;
    }

    it('reduces a realistic day to a handful of points at the default tolerance', () => {
        // The control for this whole block: 2,880 points of real passes go to
        // tens, which is what makes a small cap below a meaningful test.
        const r = simplifyTrack(realisticDay());
        expect(r.rawCount).toBe(2880);
        expect(r.points.length).toBeLessThan(200);
        expect(r.points.length).toBeGreaterThan(40); // every lane's turn survives
    });

    it('comes in at or under a cap it has to work for', () => {
        const r = simplifyTrack(realisticDay(), { maxPoints: 20 });
        expect(r.points.length).toBeLessThanOrEqual(20);
    });

    it('reports the tolerance it achieved, not the one requested', () => {
        const r = simplifyTrack(realisticDay(), { maxPoints: 20 });
        expect(r.toleranceM).toBeGreaterThan(DEFAULT_TOLERANCE_M);
        expect(r.rawCount).toBe(2880);
        expect(r.simplified).toBe(true);
    });

    it('still spans the whole day — the first and last point are the raw ones', () => {
        // The property the cap-and-cut design would have broken: a cut day
        // reads on screen as a machine that stopped mid-afternoon.
        const track = realisticDay();
        const r = simplifyTrack(track, { maxPoints: 20 });
        expect(r.points[0]).toBe(track[0]);
        expect(r.points.at(-1)).toBe(track.at(-1));
    });

    it('does NOT raise the tolerance when the track already fits', () => {
        const r = simplifyTrack(straightRun(100));
        expect(r.toleranceM).toBe(DEFAULT_TOLERANCE_M);
    });

    it('terminates when the anchors alone exceed the cap, rather than spinning', () => {
        // More ignition transitions than the cap allows. Those points are the
        // ones an operator wants, so keeping them and exceeding the cap is the
        // right trade — but it must not loop for ever chasing a cap it cannot
        // reach.
        const track = Array.from({ length: 400 }, (_, i) => pt(i * 10, 0, i % 2 === 0));
        const r = simplifyTrack(track, { maxPoints: 10 });
        expect(r.points.length).toBeGreaterThan(10);
        expect(r.toleranceM).toBeLessThan(DEFAULT_TOLERANCE_M * 2 ** 13);
    });
});

describe('§4a the work budget bounds a pathological track', () => {
    /** DP's O(n²) shape: every point is the new worst off its neighbours. */
    const sawtooth = (n: number) =>
        Array.from({ length: n }, (_, i) => pt(i * 5, (i % 2 === 0 ? 1 : -1) * 6));

    it('returns in bounded time on a sawtooth the radial pass cannot thin', () => {
        // The radial pre-pass collapses points that are CLOSE; a sawtooth's
        // points are 13 m apart, so it legitimately keeps them all and DP pays
        // the quadratic cost. Measured at 1,215 ms for 2,900 points, times up
        // to 12 tolerance passes — which is why the budget exists.
        const t0 = Date.now();
        const r = simplifyTrack(sawtooth(2900));
        const ms = Date.now() - t0;
        expect(ms).toBeLessThan(5_000);
        expect(r.rawCount).toBe(2900);
        expect(r.points.length).toBeGreaterThan(0);
    });

    it('says so, rather than reporting a coarse line as if the tolerance caused it', () => {
        const r = simplifyTrack(sawtooth(2900));
        expect(r.budgetExhausted).toBe(true);
    });

    it('does NOT claim exhaustion on a realistic day — the control', () => {
        // Without this, `budgetExhausted: true` unconditionally passes above.
        const day: SimplifiableTrackPoint[] = [];
        for (let lane = 0; lane < 24; lane++) {
            for (let i = 0; i < 120; i++) {
                day.push(pt((lane % 2 === 0 ? i : 119 - i) * 10, lane * 12));
            }
        }
        const r = simplifyTrack(day);
        expect(r.budgetExhausted).toBe(false);
    });

    it('still keeps the ends when the budget runs out', () => {
        const track = sawtooth(2900);
        const r = simplifyTrack(track);
        expect(r.points[0]).toBe(track[0]);
        expect(r.points.at(-1)).toBe(track.at(-1));
    });
});

describe('§5 the output never rebuilds a coordinate', () => {
    it('returns the SAME objects, by reference', () => {
        // The geometry uses `Number(lon)`; the output must not. The stored
        // Decimal strings reach the response exactly as they left the database.
        const track = straightRun(50);
        const r = simplifyTrack(track);
        for (const p of r.points) {
            expect(track.includes(p as SimplifiableTrackPoint)).toBe(true);
        }
    });

    it('preserves input ORDER', () => {
        const track = Array.from({ length: 200 }, (_, i) => pt(i * 10, (i % 7) * 4));
        const r = simplifyTrack(track);
        const indices = r.points.map((p) => track.indexOf(p as SimplifiableTrackPoint));
        expect(indices).toEqual([...indices].sort((a, b) => a - b));
    });

    it('carries the caller_s extra fields through untouched', () => {
        const track = straightRun(20).map((p, i) => ({ ...p, recordedAt: `t${i}`, speedKph: i }));
        const r = simplifyTrack(track);
        expect(r.points[0].recordedAt).toBe('t0');
        expect(r.points.at(-1)!.speedKph).toBe(19);
    });
});

describe('§6 the local-metres primitives', () => {
    it('measures to the SEGMENT, not to the infinite line', () => {
        // A point beyond an endpoint must measure to that endpoint. On the
        // infinite line this would be ~0.
        const a: [number, number] = [BASE_LON, BASE_LAT];
        const b = [Number(pt(100, 0).lon), Number(pt(100, 0).lat)] as [number, number];
        const beyond = [Number(pt(200, 0).lon), Number(pt(200, 0).lat)] as [number, number];
        expect(perpendicularMetres(beyond, a, b)).toBeCloseTo(100, 0);
    });

    it('handles a degenerate segment — a stationary machine produces these in quantity', () => {
        const a: [number, number] = [BASE_LON, BASE_LAT];
        const p = [Number(pt(0, 50).lon), Number(pt(0, 50).lat)] as [number, number];
        expect(perpendicularMetres(p, a, a)).toBeCloseTo(50, 0);
    });

    it('computes the perpendicular distance of a point off a line', () => {
        const a: [number, number] = [BASE_LON, BASE_LAT];
        const b = [Number(pt(100, 0).lon), Number(pt(100, 0).lat)] as [number, number];
        const off = [Number(pt(50, 7).lon), Number(pt(50, 7).lat)] as [number, number];
        expect(perpendicularMetres(off, a, b)).toBeCloseTo(7, 0);
    });

    it('toLocalMetres is affine — equal longitudes give equal x at any latitude', () => {
        // The reason the cos factor comes from ONE latitude rather than per
        // point: a per-point cos makes the transform non-affine, and a
        // perpendicular distance in such a frame is not a distance in any
        // plane.
        const north = toLocalMetres(BASE_LON + 0.01, BASE_LAT + 0.05, BASE_LON, BASE_LAT);
        const south = toLocalMetres(BASE_LON + 0.01, BASE_LAT - 0.05, BASE_LON, BASE_LAT);
        expect(north.x).toBeCloseTo(south.x, 9);
    });

    it('agrees with distanceMetres on a straight offset', () => {
        const d = distanceMetres(BASE_LON, BASE_LAT, Number(pt(300, 0).lon), BASE_LAT);
        expect(d).toBeCloseTo(300, 0);
    });
});

describe('§7 the reading is honest', () => {
    it('reports simplified: false when nothing was dropped', () => {
        const r = simplifyTrack([pt(0, 0), pt(100, 50), pt(200, 0)]);
        expect(r.points).toHaveLength(3);
        expect(r.simplified).toBe(false);
    });

    it('rawCount is the INPUT count, so a reader can tell light from heavy', () => {
        const r = simplifyTrack(straightRun(2900));
        expect(r.rawCount).toBe(2900);
        expect(r.points.length).toBeLessThan(10);
    });

    it('the default cap is the one the contract names', () => {
        expect(DEFAULT_MAX_POINTS).toBe(1500);
        expect(DEFAULT_TOLERANCE_M).toBe(3);
    });
});

describe('§8 toleranceM describes the line RETURNED', () => {
    it('does not advance past the tolerance that produced the kept set', () => {
        // The doubling loop tries a coarser tolerance and DISCARDS the result
        // when it is not smaller. Reporting the attempted figure instead of
        // the taken one over-reports coarseness — and the iOS session may gate
        // a copy line on this number, so that is a sentence shown to a farmer
        // about coarseness that is not there.
        const day: SimplifiableTrackPoint[] = [];
        for (let lane = 0; lane < 24; lane++) {
            for (let i = 0; i < 120; i++) {
                day.push(pt((lane % 2 === 0 ? i : 119 - i) * 10, lane * 12));
            }
        }
        const r = simplifyTrack(day, { maxPoints: 20 });
        // Whatever tolerance is reported must actually yield the kept count.
        const replay = simplifyTrack(day, { toleranceM: r.toleranceM, maxPoints: 1e9 });
        expect(replay.points.length).toBe(r.points.length);
    });

    it('reports the requested tolerance when no doubling happened', () => {
        const r = simplifyTrack(straightRun(100));
        expect(r.toleranceM).toBe(DEFAULT_TOLERANCE_M);
    });
});

describe('§9 the two gaps a mutation found — added because they SURVIVED', () => {
    it('protects a null -> FALSE transition, which Boolean() would collapse', () => {
        // The mutation `Boolean(a) !== Boolean(b)` left all 36 tests green,
        // because my only null test was an ALL-null track, which collapses the
        // same either way. The discriminating case is null -> false.
        //
        // It is reachable: a Codec 8 record carries only the IO elements that
        // are configured or changed, so a frame can omit ignition (null) and a
        // later one report it off (false). Semantically that is the moment we
        // LEARNED the engine was off, which is informative — `null` is
        // unknown, `false` is known-off, and they are not the same fact.
        const track = Array.from({ length: 40 }, (_, i) => pt(i * 10, 0, i < 20 ? null : false));
        const r = simplifyTrack(track);
        expect(r.points).toContain(track[19]);
        expect(r.points).toContain(track[20]);
    });

    it('also protects false -> null, the other direction of the same fact', () => {
        const track = Array.from({ length: 40 }, (_, i) => pt(i * 10, 0, i < 20 ? false : null));
        const r = simplifyTrack(track);
        expect(r.points).toContain(track[19]);
        expect(r.points).toContain(track[20]);
    });

    it('collapses an IDLE CLUSTER to almost nothing', () => {
        // A machine idling 40 minutes at 30 s intervals is 80 points inside
        // ~1.5 m of GPS jitter — measured, all 79 consecutive gaps under the
        // 3 m tolerance.
        //
        // This test was written to justify a radial pre-filter and instead
        // disproved it: DP alone already drops the cluster, because a
        // deviation under the tolerance is exactly what DP discards. The
        // property is worth keeping; the mechanism I credited for it was not
        // doing the work. See `onePass`.
        const track: SimplifiableTrackPoint[] = [];
        for (let i = 0; i < 80; i++) track.push(pt(Math.sin(i * 7) * 1.2, Math.cos(i * 11) * 1.2));
        for (let lane = 0; lane < 10; lane++) {
            for (let i = 0; i < 60; i++) {
                track.push(pt((lane % 2 === 0 ? i : 59 - i) * 10 + 5, lane * 12));
            }
        }
        const r = simplifyTrack(track);
        // The whole 80-point idle cluster lies within the first few metres, so
        // almost none of it should reach the output.
        const fromCluster = r.points.filter((p) => track.indexOf(p as SimplifiableTrackPoint) < 80);
        expect(fromCluster.length).toBeLessThanOrEqual(3);
        // …and the real passes still survive, so this is not "it dropped
        // everything".
        expect(r.points.length).toBeGreaterThan(15);
    });
});

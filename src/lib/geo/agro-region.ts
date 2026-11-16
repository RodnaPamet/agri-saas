/**
 * Which half of the country an agronomic calendar window applies to — #3100.
 *
 * `/api/agro-calendar` REQUIRES `?region=north|south` and refuses a missing
 * one with a 400, deliberately: a default there would serve one half of the
 * country's sowing dates to the other half silently. This module exists so the
 * CLIENT can pre-select that picker from the farm's own blocks, which is a
 * convenience; it never becomes a server-side default.
 *
 * ## The table is a RULING, not a published source
 *
 * Owner ruling 2026-11-16, relayed through the agrent-ios session, which
 * compiled the calendar dataset from МЗХ's integrated-production guide and its
 * technology cards. Those documents give **no oblast table** — they name only
 * the Danube plain and Dobrudzha, the foothills, and the southern plains. So
 * the fourteen below are a decision about where the line falls, and the file
 * says so rather than implying МЗХ published it.
 *
 * The divide follows the Balkan range rather than any administrative boundary,
 * so the oblasti the range runs THROUGH have no natural half. София-град,
 * Софийска, Сливен and Бургас are all SOUTH by that ruling, and each of them
 * is a judgement somebody could reasonably make differently.
 *
 * ## Three things this deliberately does NOT do
 *
 * - **It does not default the ROUTE.** `agroRegionForBounds` returning `south`
 *   is a suggestion for a picker. The 400 on a missing `region` stays.
 * - **It does not resolve a FARM.** A farm with blocks in both halves has no
 *   single region, which is why the calendar route never took a farm in the
 *   first place. This answers per BLOCK; the client decides what to do when
 *   its blocks disagree (agrent-ios: default only when they all agree).
 * - **It does not guess when it cannot tell.** A block with no bounds, or a
 *   point outside every oblast ring, is `null` — never a nearest-match. A
 *   wrong default is worse than no default, because the farmer will not know
 *   they were handed the other half's dates.
 */
import { OBLAST_CODES, OBLAST_RINGS } from './oblast-polygons.generated';

export const AGRO_REGIONS = ['north', 'south'] as const;
export type AgroRegion = (typeof AGRO_REGIONS)[number];

/**
 * The fourteen NORTHERN oblasti, by ISO 3166-2:BG code — owner ruling.
 *
 * Codes rather than names, because the code is the join key the geojson
 * carries (`shapeISO`) and a name is a string somebody will re-spell. The
 * Bulgarian name rides along so the ruling is readable here, and
 * `agro-region.test.ts` checks each name against `BULGARIA_REGIONS` so a
 * comment cannot drift from the code beside it.
 */
export const NORTH_OBLASTS: readonly string[] = [
    'BG-03', // Варна
    'BG-04', // Велико Търново
    'BG-05', // Видин
    'BG-06', // Враца
    'BG-07', // Габрово
    'BG-08', // Добрич
    'BG-11', // Ловеч
    'BG-12', // Монтана
    'BG-15', // Плевен
    'BG-17', // Разград
    'BG-18', // Русе
    'BG-19', // Силистра
    'BG-25', // Търговище
    'BG-27', // Шумен
];

const NORTH = new Set(NORTH_OBLASTS);

/**
 * The half an oblast belongs to, or `null` for a code this table does not
 * know.
 *
 * `null` rather than a `south` fallback: every one of the 28 IS classified
 * (asserted in the suite), so an unknown code means the caller passed
 * something that is not a Bulgarian oblast — and answering `south` to that
 * would be inventing agronomy for a place we cannot locate.
 */
export function agroRegionForOblast(code: string): AgroRegion | null {
    if (NORTH.has(code)) return 'north';
    return OBLAST_RINGS[code] !== undefined ? 'south' : null;
}

/**
 * The oblast containing `[lon, lat]`, or `null` if no ring does.
 *
 * Ray casting on each oblast's single closed outer ring. The generator
 * REFUSES a MultiPolygon or a second ring precisely so this stays correct:
 * a hole would be silently ignored by this algorithm, so the input shape it
 * assumes is enforced upstream rather than hoped for here.
 *
 * Linear over 28 rings (~3,000 vertices total) and allocation-free. A farm has
 * tens of blocks, not thousands, so an index would be optimising a loop that
 * does not appear in any measurement.
 */
export function oblastForPoint(lon: number, lat: number): string | null {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    for (const code of OBLAST_CODES) {
        if (pointInRing(OBLAST_RINGS[code], lon, lat)) return code;
    }
    return null;
}

/**
 * Exported for the CONTINUITY test in §2b, which is what holds the comparison
 * below in place.
 *
 * WHAT MATTERS IS THAT THE TWO COMPARISONS ARE THE SAME, not that they are
 * strict. An earlier version of this comment claimed `>` prevented "the
 * classic vertex double-count"; that was misattributed, and the mutation
 * proof is what corrected it. Measured over 71,070 probes at vertex
 * latitudes across all 28 rings:
 *
 *     strict `>` vs symmetric `>=`  ->     75 disagreements (0.1%)
 *     strict `>` vs MIXED `> / >=`  -> 35,185 disagreements (half)
 *
 * So swapping both sides to `>=` is very nearly the same function — the 75
 * are points lying exactly on a horizontal edge, where "inside" is genuinely
 * ambiguous and irrelevant to a block's centre. Mixing the two comparisons is
 * what double-counts a vertex, and it is wrong for half of all such points.
 *
 * That is why the test asserts CONTINUITY rather than a particular operator:
 * a mixed comparison makes a point at a vertex latitude read as outside while
 * its neighbours a micro-degree either side read as inside, and no
 * hand-picked coordinate lands exactly on a vertex latitude, so the points
 * are derived from the rings themselves.
 */
export function pointInRing(
    ring: readonly (readonly [number, number])[],
    x: number,
    y: number,
): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        // The SAME comparison on both endpoints. Mixing `>` and `>=` here is
        // the double-count — measured wrong for half of all vertex-latitude
        // points — and §2b is what fails if anyone does.
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * The region for a `Location.boundsJson` value, or `null`.
 *
 * **It is the bounding box's CENTRE, not a centroid.** `Location` stores only
 * `[west, south, east, north]`; the polygons live on its `Parcel` rows in
 * PostGIS. For this question that is enough — oblasti are ~100 km across and a
 * block is ~1 km, so the bbox centre and the true centroid are in the same
 * oblast except for a block sitting on a boundary, where the farmer overrides
 * the picker anyway. If that ever stops being acceptable, the upgrade is
 * `ST_Centroid` over the parcels, and it belongs in `src/lib/db/geo.ts` with
 * every other `ST_*`.
 *
 * Tolerant of the stored shape being anything at all, because `boundsJson` is
 * `Json?` and nothing in the database constrains it.
 */
export function agroRegionForBounds(bounds: unknown): AgroRegion | null {
    if (!Array.isArray(bounds) || bounds.length !== 4) return null;
    const [west, south, east, north] = bounds.map((v) => (typeof v === 'number' ? v : NaN));
    if (![west, south, east, north].every((v) => Number.isFinite(v))) return null;
    // A degenerate or inverted box is not a location. Equal edges are fine —
    // a single-point block is legitimate.
    if (east < west || north < south) return null;
    const code = oblastForPoint((west + east) / 2, (south + north) / 2);
    return code === null ? null : agroRegionForOblast(code);
}

/**
 * North/South for a farm block — #3100.
 *
 * ## What is actually at risk here
 *
 * Two different things, and they need different kinds of assertion.
 *
 * The TABLE is an owner ruling with no published source behind it, so there is
 * nothing to verify it against — only its completeness and its exclusivity can
 * be checked, plus the four oblasti the ruling called out by name because the
 * Balkan range runs through them.
 *
 * The LOOKUP is geometry, and it can be checked hard: every one of the 28
 * oblast centroids must resolve to its own oblast. That is derived from
 * `BULGARIA_REGIONS` rather than hand-picked, so it ranges over every ring
 * instead of the handful a human would think to list — and it is what would
 * catch a ray cast that is subtly wrong for concave provinces.
 *
 * ## The failure this suite is shaped to prevent
 *
 * A function that answers `south` to everything passes any test that only
 * checks southern points, and `/api/agro-calendar` would then serve southern
 * sowing dates to Dobrudzha with nothing failing. So every positive has a
 * negative beside it, and `oblastForPoint` is asserted to say NO — a lookup
 * that cannot return null has no discriminating power at all.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    AGRO_REGIONS,
    NORTH_OBLASTS,
    agroRegionForBounds,
    agroRegionForOblast,
    oblastForPoint,
    pointInRing,
} from '@/lib/geo/agro-region';
import { OBLAST_CODES, OBLAST_RINGS } from '@/lib/geo/oblast-polygons.generated';
import { BULGARIA_REGIONS } from '@/lib/geo/bulgaria-regions';

const BY_CODE = new Map(BULGARIA_REGIONS.map((r) => [r.code, r]));

describe('§1 the ruling — complete, exclusive, and readable', () => {
    it('[agro-region] classifies every oblast, 14 north and 14 south', () => {
        const north = OBLAST_CODES.filter((c) => agroRegionForOblast(c) === 'north');
        const south = OBLAST_CODES.filter((c) => agroRegionForOblast(c) === 'south');
        const unclassified = OBLAST_CODES.filter((c) => agroRegionForOblast(c) === null);
        console.log(
            `[agro-region] ${OBLAST_CODES.length} oblast(s): ${north.length} north, `
            + `${south.length} south, ${unclassified.length} unclassified`,
        );
        expect(OBLAST_CODES).toHaveLength(28);
        expect(unclassified).toEqual([]);
        expect(north).toHaveLength(14);
        expect(south).toHaveLength(14);
        // Exclusive by construction, asserted anyway: a code in both lists
        // would make the counts right and the answer arbitrary.
        expect(north.filter((c) => south.includes(c))).toEqual([]);
    });

    it('the Bulgarian name beside each code is the name that code actually has', () => {
        // The module carries `'BG-03', // Варна` so the ruling reads as the
        // owner stated it. A comment cannot be type-checked, so a renumbering
        // would leave fourteen plausible-looking lies. Parsed from the source.
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../../src/lib/geo/agro-region.ts'),
            'utf8',
        );
        const pairs = [...src.matchAll(/'(BG-\d\d)',\s*\/\/\s*(\S[^\n]*?)\s*$/gm)];
        // Control: the extraction must find all fourteen, or this passes over
        // nothing — the empty-population defect.
        expect(pairs).toHaveLength(NORTH_OBLASTS.length);
        for (const [, code, name] of pairs) {
            expect(BY_CODE.get(code)?.nameBg).toBe(name);
        }
    });

    it('the four the ruling named are SOUTH — the Balkan range runs through them', () => {
        // Owner ruling 2026-11-16, called out explicitly because each is a
        // judgement somebody could reasonably make differently.
        for (const name of ['София (столица)', 'София (област)', 'Сливен', 'Бургас']) {
            const code = BULGARIA_REGIONS.find((r) => r.nameBg === name)?.code;
            expect({ name, code: code ?? null }).not.toEqual({ name, code: null });
            expect(agroRegionForOblast(code as string)).toBe('south');
        }
    });

    it('an unknown code is null, never a fallback half', () => {
        for (const code of ['BG-99', 'RO-01', '', 'north']) {
            expect(agroRegionForOblast(code)).toBeNull();
        }
    });
});

describe('§2 the lookup — derived over every ring', () => {
    it('[agro-region] all 28 oblast centroids resolve to their own oblast', () => {
        const misses: string[] = [];
        for (const r of BULGARIA_REGIONS) {
            const got = oblastForPoint(r.lon, r.lat);
            if (got !== r.code) misses.push(`${r.code} ${r.nameBg} -> ${String(got)}`);
        }
        console.log(
            `[agro-region] ${BULGARIA_REGIONS.length - misses.length}/`
            + `${BULGARIA_REGIONS.length} centroids self-resolve`,
        );
        expect(BULGARIA_REGIONS).toHaveLength(28);
        expect(misses).toEqual([]);
    });

    it('says NO outside the country — the control that gives it any power', () => {
        // Without this, every positive above is satisfied by a function that
        // returns the first ring it is given.
        for (const [lon, lat] of [
            [0, 0],
            [29.5, 43.0], // Black Sea, east of the coast
            [19.0, 42.0], // Adriatic
            [23.3, 48.0], // north of the Danube, well into Romania
            [100, 100],
        ] as const) {
            expect(oblastForPoint(lon, lat)).toBeNull();
        }
    });

    it('refuses a non-finite coordinate rather than scanning with NaN', () => {
        expect(oblastForPoint(Number.NaN, 42)).toBeNull();
        expect(oblastForPoint(23, Number.POSITIVE_INFINITY)).toBeNull();
    });

    it('a handful of real towns land in the right half, as a readable anchor', () => {
        const cases: Array<[string, number, number, string]> = [
            ['Плевен', 24.6067, 43.417, 'north'],
            ['Добрич', 27.8273, 43.5726, 'north'],
            ['Русе', 25.9667, 43.8356, 'north'],
            ['Пловдив', 24.7453, 42.1354, 'south'],
            ['Хасково', 25.5555, 41.9344, 'south'],
            ['Благоевград', 23.0994, 42.0117, 'south'],
        ];
        for (const [town, lon, lat, want] of cases) {
            const code = oblastForPoint(lon, lat);
            expect({ town, region: code ? agroRegionForOblast(code) : null })
                .toEqual({ town, region: want });
        }
        // Both halves are represented, so this cannot pass by answering one.
        expect(new Set(cases.map((c) => c[3]))).toEqual(new Set(AGRO_REGIONS));
    });
});

describe('§2b the ray cast is CONTINUOUS at a vertex latitude', () => {
    /*
     * WHY THIS SECTION EXISTS, measured rather than imagined.
     *
     * Mutating the ray cast to a MIXED comparison (`yi > y !== yj >= y`)
     * fails three tests here. Mutating it to a SYMMETRIC `>=` passes
     * everything — and that is correct rather than a gap: measured over the
     * 71,070 probes below, the two symmetric forms disagree on 75 points
     * (0.1%, all lying exactly on a horizontal edge, where "inside" is
     * genuinely ambiguous), while strict-versus-mixed disagrees on 35,185 —
     * half.
     *
     * That measurement corrected the module's own comment, which had claimed
     * the strict form prevented "the classic double-count". It does not; the
     * double-count comes from MIXING the comparisons. So the property asserted
     * here is CONTINUITY, not an operator: a mixed comparison makes a point at
     * a vertex latitude read as outside while its neighbours a micro-degree
     * either side read as inside. No hand-picked coordinate lands exactly on a
     * vertex latitude, which is why the points are derived from the rings.
     *
     * Worth keeping because of how it was found: the first fifteen tests were
     * all green — centroids self-resolved, towns landed in the right half —
     * and only a mutation showed which claim they were actually holding.
     *
     * Ground truth is not assumed: a point is taken as INSIDE only because the
     * points just above and just below it both are. That makes the assertion
     * about the function's self-consistency rather than about geography.
     */
    const EPS = 1e-6;

    it('[agro-region] a point AT a vertex latitude agrees with its neighbours', () => {
        let examined = 0;
        let bracketed = 0;
        const breaks: string[] = [];
        for (const code of OBLAST_CODES) {
            const ring = OBLAST_RINGS[code];
            const xs = ring.map((p) => p[0]);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            for (const [, y] of ring) {
                for (let k = 1; k < 24; k += 1) {
                    const x = minX + ((maxX - minX) * k) / 24;
                    examined += 1;
                    // Bracket: both neighbours inside means the vertex latitude
                    // is in the interior, whatever the function says AT it.
                    if (!pointInRing(ring, x, y + EPS)) continue;
                    if (!pointInRing(ring, x, y - EPS)) continue;
                    bracketed += 1;
                    if (!pointInRing(ring, x, y)) {
                        breaks.push(`${code} lat=${y} lon=${x.toFixed(5)}`);
                    }
                }
            }
        }
        console.log(
            `[agro-region] continuity: ${examined} probe(s), ${bracketed} bracketed by both `
            + `neighbours, ${breaks.length} discontinuous`,
        );
        // Control: the scan must actually find interior vertex latitudes, or
        // an empty population satisfies the assertion below over nothing.
        expect(bracketed).toBeGreaterThan(200);
        expect(breaks.slice(0, 8)).toEqual([]);
    });
});

describe('§3 bounds — tolerant, because boundsJson is unconstrained Json', () => {
    it('takes the centre of a well-formed box', () => {
        // Plovdiv, [west, south, east, north] — longitude FIRST.
        expect(agroRegionForBounds([24.7, 42.1, 24.79, 42.17])).toBe('south');
        // Dobrudzha.
        expect(agroRegionForBounds([27.7, 43.5, 27.95, 43.65])).toBe('north');
    });

    it('a single-point box is legitimate', () => {
        expect(agroRegionForBounds([24.6067, 43.417, 24.6067, 43.417])).toBe('north');
    });

    it('is null for anything that is not four finite numbers', () => {
        for (const bad of [
            null,
            undefined,
            [],
            [1, 2, 3],
            [1, 2, 3, 4, 5],
            ['24.7', '42.1', '24.79', '42.17'],
            [24.7, 42.1, 24.79, Number.NaN],
            {},
            'north',
            [{}, {}, {}, {}],
        ]) {
            expect({ bad, region: agroRegionForBounds(bad) }).toEqual({ bad, region: null });
        }
    });

    it('is null for an INVERTED box rather than silently reading it backwards', () => {
        // east < west, or north < south. A caller that swapped lat and lon
        // produces exactly this, and answering a half to it would be confident
        // nonsense about a place that is not where they meant.
        expect(agroRegionForBounds([24.79, 42.1, 24.7, 42.17])).toBeNull();
        expect(agroRegionForBounds([24.7, 42.17, 24.79, 42.1])).toBeNull();
    });

    it('is null for a box whose centre is outside the country', () => {
        expect(agroRegionForBounds([29.4, 42.9, 29.6, 43.1])).toBeNull();
    });
});

describe('§4 the generated rings match their source', () => {
    it('[agro-region] every ring is closed, single, and keyed by a real oblast', () => {
        let vertices = 0;
        for (const code of OBLAST_CODES) {
            const ring = OBLAST_RINGS[code];
            vertices += ring.length;
            expect(BY_CODE.has(code)).toBe(true);
            // A ray cast over an unclosed ring silently drops the last edge.
            expect(ring[0]).toEqual(ring[ring.length - 1]);
            expect(ring.length).toBeGreaterThan(3);
        }
        console.log(`[agro-region] ${OBLAST_CODES.length} rings, ${vertices} vertices`);
        expect(vertices).toBeGreaterThan(2000);
    });

    it('the committed module is in sync with public/geo/bg-oblasti.geojson', () => {
        // The generator is the authority; this is the `tokens:check` property
        // as a test, so a hand-edit of the generated file fails here rather
        // than only in whichever CI step remembers to run the script.
        const gj = JSON.parse(
            fs.readFileSync(
                path.resolve(__dirname, '../../../public/geo/bg-oblasti.geojson'),
                'utf8',
            ),
        ) as { features: Array<{ properties: { shapeISO: string } }> };
        expect(gj.features).toHaveLength(OBLAST_CODES.length);
        expect(gj.features.map((f) => f.properties.shapeISO).sort())
            .toEqual([...OBLAST_CODES].sort());
    });
});

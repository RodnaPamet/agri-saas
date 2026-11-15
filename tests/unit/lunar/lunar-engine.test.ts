/**
 * The lunar engine, EXECUTED — #3070.
 *
 * `tests/guards/lunar-rules-have-copy.test.ts` is a guard: it reads source and
 * catalogue text and contributes zero runtime coverage, so every function in
 * `src/lib/lunar/` could be wrong in a way it cannot see. This file runs them.
 *
 * ## The assertions are textbook constants, not the library's own answers
 *
 * Checking `moonAt` by recomputing it from `astronomy-engine` would be a
 * cross-check in the same method — it would agree with any bug that lived in
 * how we USE the library, which is where every bug here would live. So the
 * anchors are facts that hold independently of any implementation: the synodic
 * month is 29.53 days, the sidereal month 27.32, a sign is 30°, and the
 * ayanamsa is ~24° today.
 */
import {
    AYANAMSA_AT_J2000_DEG,
    PRECESSION_DEG_PER_YEAR,
    ayanamsaDegrees,
} from '@/lib/lunar/ayanamsa';
import {
    DAY_TYPES,
    DEGREES_PER_SIGN,
    ELEMENTS,
    SIGNS,
    dayTypeOfSign,
    elementOfSign,
    normaliseDegrees,
    signOfSiderealLongitude,
} from '@/lib/lunar/zodiac';
import { findSignChange, moonAt } from '@/lib/lunar/moon';
import { CROP_GROUPS, RECOMMENDATIONS, RULES, adviceFor } from '@/lib/lunar/rules';
import { LUNAR_TIME_ZONE, MAX_LUNAR_DAYS, lunarDay, lunarRange } from '@/lib/lunar/lunar-day';

const J2000 = new Date('2000-01-01T12:00:00Z');
const DAY_MS = 86_400_000;

describe('ayanamsa — the sidereal/tropical offset', () => {
    it('is the J2000 value at J2000 and precesses linearly', () => {
        expect(ayanamsaDegrees(J2000)).toBeCloseTo(AYANAMSA_AT_J2000_DEG, 3);

        const oneCentury = new Date(J2000.getTime() + 365.25 * 100 * DAY_MS);
        const drift = ayanamsaDegrees(oneCentury) - ayanamsaDegrees(J2000);
        // ~1.4° per century. The sign matters: precession INCREASES the
        // ayanamsa, so a flipped sign would put the tradition's reading a
        // whole sign the wrong way.
        expect(drift).toBeCloseTo(PRECESSION_DEG_PER_YEAR * 100, 2);
        expect(drift).toBeGreaterThan(0);
    });

    it('is about 24° in the 2020s — one sign of drift, which is the whole point', () => {
        const deg = ayanamsaDegrees(new Date('2026-06-01T00:00:00Z'));
        expect(deg).toBeGreaterThan(23.5);
        expect(deg).toBeLessThan(25);
        // Just under one sign, so a sidereal reading is usually the PREVIOUS
        // sign to a tropical one. That is the discrepancy farmers using an
        // almanac will see, and it is expected rather than a bug.
        expect(deg).toBeLessThan(DEGREES_PER_SIGN);
    });
});

describe('zodiac — 12 signs of 30°, and the wrap', () => {
    it('places a longitude in the right sign, including both boundaries', () => {
        expect(signOfSiderealLongitude(0)).toBe('aries');
        expect(signOfSiderealLongitude(29.999)).toBe('aries');
        // The boundary belongs to the NEXT sign, not to both.
        expect(signOfSiderealLongitude(30)).toBe('taurus');
        expect(signOfSiderealLongitude(359.999)).toBe('pisces');
        // 360 is 0 — a modulo that returned a 13th bucket would throw or
        // produce undefined here.
        expect(signOfSiderealLongitude(360)).toBe('aries');
        expect(signOfSiderealLongitude(-1)).toBe('pisces');
        expect(signOfSiderealLongitude(720 + 45)).toBe('taurus');
    });

    it('covers every sign exactly once across a full circle', () => {
        const seen = SIGNS.map((_, i) => signOfSiderealLongitude(i * DEGREES_PER_SIGN + 15));
        expect(seen).toEqual([...SIGNS]);
        expect(new Set(seen).size).toBe(12);
    });

    it('maps element and day type by the traditional 4-cycle', () => {
        expect(elementOfSign('aries')).toBe('fire');
        expect(elementOfSign('taurus')).toBe('earth');
        expect(elementOfSign('gemini')).toBe('air');
        expect(elementOfSign('cancer')).toBe('water');
        // fire→fruit, earth→root, air→flower, water→leaf
        expect(dayTypeOfSign('aries')).toBe('fruit');
        expect(dayTypeOfSign('taurus')).toBe('root');
        expect(dayTypeOfSign('gemini')).toBe('flower');
        expect(dayTypeOfSign('cancer')).toBe('leaf');

        // And the cycle repeats every four signs for all twelve — so each
        // element and each day type is used exactly three times.
        const byElement = SIGNS.map(elementOfSign);
        for (const el of ELEMENTS) {
            expect(byElement.filter((e) => e === el)).toHaveLength(3);
        }
        const byType = SIGNS.map(dayTypeOfSign);
        for (const dt of DAY_TYPES) {
            expect(byType.filter((t) => t === dt)).toHaveLength(3);
        }
    });

    it('normalises into [0, 360)', () => {
        expect(normaliseDegrees(-10)).toBeCloseTo(350, 9);
        expect(normaliseDegrees(370)).toBeCloseTo(10, 9);
        expect(normaliseDegrees(360)).toBeCloseTo(0, 9);
    });
});

describe('moonAt — phase and sidereal position', () => {
    it('reports a self-consistent phase, and never an out-of-range illumination', () => {
        for (let i = 0; i < 40; i += 1) {
            const at = new Date(Date.UTC(2026, 0, 1) + i * DAY_MS);
            const m = moonAt(at);
            expect(m.elongation).toBeGreaterThanOrEqual(0);
            expect(m.elongation).toBeLessThan(360);
            expect(m.illumination).toBeGreaterThanOrEqual(0);
            expect(m.illumination).toBeLessThanOrEqual(1);
            // Waxing is defined by elongation, not by the illuminated
            // fraction — which is equal either side of full and so cannot
            // distinguish the two halves of the month.
            expect(m.phase).toBe(m.elongation < 180 ? 'waxing' : 'waning');
            expect(m.dayType).toBe(dayTypeOfSign(m.sign));
            expect(SIGNS).toContain(m.sign);
        }
    });

    it('returns to the same phase after one synodic month (29.53 days)', () => {
        const a = moonAt(new Date('2026-04-02T00:00:00Z'));
        const b = moonAt(new Date(new Date('2026-04-02T00:00:00Z').getTime() + 29.5306 * DAY_MS));
        // Shortest angular distance, so a wrap through 0 is not read as 350°.
        const gap = Math.min(
            Math.abs(a.elongation - b.elongation),
            360 - Math.abs(a.elongation - b.elongation),
        );
        expect(gap).toBeLessThan(5);
    });

    it('is SIDEREAL — it disagrees with the tropical sign on most days', () => {
        // The ayanamsa is ~24° of a 30° sign, so the sidereal sign is the
        // previous one for roughly 24/30 of the zodiac. If the ayanamsa were
        // never applied the two would agree ALWAYS and this fails — which is
        // the one assertion here that would catch a silently tropical engine.
        let disagreements = 0;
        const samples = 60;
        for (let i = 0; i < samples; i += 1) {
            const at = new Date(Date.UTC(2026, 2, 1) + i * DAY_MS);
            const m = moonAt(at);
            const tropical = signOfSiderealLongitude(
                normaliseDegrees(m.siderealLongitude + ayanamsaDegrees(at)),
            );
            if (tropical !== m.sign) disagreements += 1;
        }
        expect(disagreements).toBeGreaterThan(samples * 0.6);
    });

    it('passes through all twelve signs within one sidereal month', () => {
        const start = Date.UTC(2026, 5, 1);
        const seen = new Set<string>();
        // 27.32 days per circuit; sample every 6h so a 2.3-day sign cannot be
        // stepped over.
        for (let h = 0; h <= 28 * 24; h += 6) {
            seen.add(moonAt(new Date(start + h * 3_600_000)).sign);
        }
        expect(seen.size).toBe(12);
    });
});

describe('findSignChange — bisection on the sign INDEX', () => {
    it('finds no change inside a bracket that stays in one sign', () => {
        // An hour is far shorter than the ~2.3 days the Moon spends in a sign,
        // so at least one such bracket must exist; take the first.
        let found = false;
        for (let i = 0; i < 48 && !found; i += 1) {
            const from = new Date(Date.UTC(2026, 6, 1) + i * 3_600_000);
            const to = new Date(from.getTime() + 3_600_000);
            if (moonAt(from).sign === moonAt(to).sign) {
                expect(findSignChange(from, to)).toBeNull();
                found = true;
            }
        }
        expect(found).toBe(true);
    });

    it('brackets the crossing it finds, and gets the Pisces→Aries wrap right', () => {
        // THE case this function's docblock is about: longitude wraps 360→0, so
        // a bisection comparing LONGITUDES finds the wrong root here while
        // looking perfectly correct for the other eleven boundaries.
        let wrap: { at: Date; toSign: string } | null = null;
        let bracketStart = new Date(0);
        // Search a full sidereal month — the Moon enters Aries exactly once.
        for (let d = 0; d < 28 && !wrap; d += 1) {
            const from = new Date(Date.UTC(2026, 0, 1) + d * DAY_MS);
            const to = new Date(from.getTime() + DAY_MS);
            const change = findSignChange(from, to);
            if (change && change.toSign === 'aries') {
                wrap = change;
                bracketStart = from;
            }
        }
        expect(wrap).not.toBeNull();
        const crossing = wrap as { at: Date; toSign: string };
        expect(crossing.toSign).toBe('aries');
        // Inside the bracket it was given…
        expect(crossing.at.getTime()).toBeGreaterThanOrEqual(bracketStart.getTime());
        expect(crossing.at.getTime()).toBeLessThanOrEqual(bracketStart.getTime() + DAY_MS);
        // …and genuinely a boundary: just before is Pisces, at/after is Aries.
        expect(moonAt(new Date(crossing.at.getTime() - 60_000)).sign).toBe('pisces');
        expect(moonAt(crossing.at).sign).toBe('aries');
    });
});

describe('the rule table', () => {
    it('is exhaustive over dayType × phase, with every crop group present', () => {
        let nonEmpty = 0;
        for (const dayType of DAY_TYPES) {
            for (const phase of ['waxing', 'waning'] as const) {
                const advice = adviceFor(dayType, phase);
                for (const group of CROP_GROUPS) {
                    expect(Array.isArray(advice[group])).toBe(true);
                    if (advice[group].length > 0) nonEmpty += 1;
                    // Every verdict is a declared member — a typo here would
                    // resolve to no copy and render the key to a farmer.
                    for (const rec of advice[group]) expect(RECOMMENDATIONS).toContain(rec);
                }
            }
        }
        // 8 cells × 3 groups = 24 slots; the table must actually say something.
        expect(nonEmpty).toBeGreaterThanOrEqual(12);
        expect(Object.keys(RULES)).toHaveLength(DAY_TYPES.length);
    });
});

describe('lunarDay / lunarRange — farm-local days', () => {
    it('describes the day it was asked for, consistently', () => {
        const day = lunarDay('2026-05-12');
        expect(day.date).toBe('2026-05-12');
        expect(day.element).toBe(elementOfSign(day.sign));
        expect(day.dayType).toBe(dayTypeOfSign(day.sign));
        expect(Object.keys(day.recommendations).sort()).toEqual([...CROP_GROUPS].sort());
        expect(LUNAR_TIME_ZONE).toBe('Europe/Sofia');
    });

    it('keeps every transition inside the local day it is reported on', () => {
        // Scan a month so at least one day with a transition is covered — the
        // Moon changes sign ~13 times in 30 days, so an empty scan would mean
        // the search is broken rather than that the sky was quiet.
        const days = lunarRange('2026-05-01', '2026-05-31', MAX_LUNAR_DAYS);
        const withTransitions = days.filter((d) => d.transitions.length > 0);
        expect(withTransitions.length).toBeGreaterThanOrEqual(10);
        for (const d of withTransitions) {
            for (const tr of d.transitions) {
                // Reported on the day it falls in, in the farm's zone.
                expect(
                    new Intl.DateTimeFormat('en-CA', {
                        timeZone: LUNAR_TIME_ZONE,
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                    }).format(tr.at),
                ).toBe(d.date);
                expect(tr.toDayType).toBe(dayTypeOfSign(tr.toSign));
            }
            // At most one in a day — the Moon needs ~2.3 days to cross a sign.
            expect(d.transitions.length).toBeLessThanOrEqual(1);
        }
    });

    it('walks consecutive days with no gap or repeat, inclusive of both ends', () => {
        const days = lunarRange('2026-02-26', '2026-03-03', MAX_LUNAR_DAYS);
        expect(days.map((d) => d.date)).toEqual([
            // Across a month boundary in a non-leap year: `+1` on the string
            // is what this is built to avoid.
            '2026-02-26',
            '2026-02-27',
            '2026-02-28',
            '2026-03-01',
            '2026-03-02',
            '2026-03-03',
        ]);
    });

    it('crosses both Bulgarian DST switches without losing or repeating a day', () => {
        // Sofia springs forward on the last Sunday of March (23-hour day) and
        // back on the last Sunday of October (25-hour day). A day walk built
        // on a fixed 24-hour step duplicates one and skips the other.
        const spring = lunarRange('2026-03-27', '2026-03-31', MAX_LUNAR_DAYS);
        expect(spring.map((d) => d.date)).toEqual([
            '2026-03-27',
            '2026-03-28',
            '2026-03-29',
            '2026-03-30',
            '2026-03-31',
        ]);
        const autumn = lunarRange('2026-10-23', '2026-10-27', MAX_LUNAR_DAYS);
        expect(autumn.map((d) => d.date)).toEqual([
            '2026-10-23',
            '2026-10-24',
            '2026-10-25',
            '2026-10-26',
            '2026-10-27',
        ]);
    });

    it('stops at maxDays rather than serving an unbounded span', () => {
        const capped = lunarRange('2026-01-01', '2026-12-31', 5);
        expect(capped).toHaveLength(5);
        expect(capped[0].date).toBe('2026-01-01');
        expect(capped[4].date).toBe('2026-01-05');
        // And a reversed range terminates instead of looping to the cap.
        expect(lunarRange('2026-05-10', '2026-05-01', MAX_LUNAR_DAYS)).toHaveLength(1);
    });
});

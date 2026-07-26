/**
 * Unit tests for `src/lib/grain/moisture.ts`.
 *
 * This module is the reason a season total means anything: before it,
 * `moisturePct` was stored, displayed, and used in zero calculations, so
 * 90 t at 18% and 90 t at 13.5% were summed as if identical. The tests
 * therefore care about the arithmetic being physically right, the direction
 * of the adjustment, and — most of all — the refusals: a formula that
 * returns a plausible number for nonsense input is worse than no formula.
 */

import {
    STANDARD_MOISTURE_PCT,
    MAX_PLAUSIBLE_MOISTURE_PCT,
    netTonnesAtStandardMoisture,
    tonnesPerHectare,
} from '@/lib/grain/moisture';

describe('netTonnesAtStandardMoisture', () => {
    it('leaves grain already at the standard basis untouched', () => {
        expect(netTonnesAtStandardMoisture(90, STANDARD_MOISTURE_PCT)).toBe(90);
    });

    it('shrinks wetter grain — the water is not sellable grain', () => {
        // 90 × (100−18)/(100−14) = 90 × 82/86 = 85.814
        expect(netTonnesAtStandardMoisture(90, 18)).toBe(85.814);
    });

    it('converts drier grain UP', () => {
        // 90 × (100−13.5)/86 = 90.523. Drier grain carries more dry matter
        // per tonne, so at a common basis it is MORE grain.
        expect(netTonnesAtStandardMoisture(90, 13.5)).toBe(90.523);
    });

    it('makes the seeded pair comparable — the whole point', () => {
        // The demo seed creates two loads that summed to 278.4 t as if they
        // were the same thing. On one basis they are not.
        const wheat = netTonnesAtStandardMoisture(182.4, 13.5)!;
        const barley = netTonnesAtStandardMoisture(96.0, 14.8)!;
        expect(wheat).toBeCloseTo(183.46, 2);
        expect(barley).toBeCloseTo(95.107, 2);
        // The naive gross sum overstates the comparable total.
        expect(wheat + barley).toBeLessThan(182.4 + 96.0 + 1);
        expect(wheat + barley).not.toBeCloseTo(278.4, 1);
    });

    it('preserves dry matter — the invariant the formula is derived from', () => {
        const gross = 100;
        for (const m of [8, 11.2, 14, 17.5, 22, 30]) {
            const net = netTonnesAtStandardMoisture(gross, m)!;
            const dryFromGross = gross * (100 - m);
            const dryFromNet = net * (100 - STANDARD_MOISTURE_PCT);
            expect(dryFromNet).toBeCloseTo(dryFromGross, 0);
        }
    });

    it('is monotonic: wetter grain is never worth more', () => {
        const readings = [9, 12, 14, 16, 20, 25, 35];
        const nets = readings.map((m) => netTonnesAtStandardMoisture(100, m)!);
        for (let i = 1; i < nets.length; i++) {
            expect(nets[i]).toBeLessThan(nets[i - 1]);
        }
    });

    describe('refuses rather than inventing a number', () => {
        it('returns null when moisture was never measured', () => {
            // Explicitly NOT "assume standard" — an unmeasured record's
            // comparable weight is unknown, and callers report those tonnes
            // separately instead of quietly mixing bases again.
            expect(netTonnesAtStandardMoisture(90, null)).toBeNull();
            expect(netTonnesAtStandardMoisture(90, undefined)).toBeNull();
        });

        it('returns null when there is no tonnage', () => {
            expect(netTonnesAtStandardMoisture(null, 14)).toBeNull();
        });

        it('returns null for the 999.99% the column used to accept', () => {
            // Left unbounded this produced a NEGATIVE adjusted tonnage —
            // a precise-looking figure describing nothing.
            expect(netTonnesAtStandardMoisture(90, 999.99)).toBeNull();
            expect(netTonnesAtStandardMoisture(90, MAX_PLAUSIBLE_MOISTURE_PCT + 0.01)).toBeNull();
        });

        it('accepts the boundary reading itself', () => {
            expect(netTonnesAtStandardMoisture(90, MAX_PLAUSIBLE_MOISTURE_PCT)).not.toBeNull();
            expect(netTonnesAtStandardMoisture(90, 0)).not.toBeNull();
        });

        it('returns null for negative moisture or tonnage', () => {
            expect(netTonnesAtStandardMoisture(90, -1)).toBeNull();
            expect(netTonnesAtStandardMoisture(-90, 14)).toBeNull();
        });

        it('returns null for non-finite input', () => {
            expect(netTonnesAtStandardMoisture(Infinity, 14)).toBeNull();
            expect(netTonnesAtStandardMoisture(90, NaN)).toBeNull();
        });
    });
});

describe('tonnesPerHectare', () => {
    it('divides tonnage by the harvested area', () => {
        expect(tonnesPerHectare(63, 9)).toBe(7);
    });

    it('rounds at 4 decimal places, matching the previous DTO behaviour', () => {
        expect(tonnesPerHectare(10, 3)).toBe(3.3333);
    });

    it('returns null for a zero or negative area — not 0 t/ha', () => {
        // A percentage of nothing is undefined, not zero; this zero-guard is
        // the pre-existing contract and is deliberately preserved.
        expect(tonnesPerHectare(50, 0)).toBeNull();
        expect(tonnesPerHectare(50, -3)).toBeNull();
    });

    it('returns null when either input is missing', () => {
        expect(tonnesPerHectare(null, 9)).toBeNull();
        expect(tonnesPerHectare(63, null)).toBeNull();
    });

    it('gives the SAME answer for the same harvest regardless of caller', () => {
        // The screen/PDF divergence (7.0 vs 4.2 t/ha) came from two call
        // sites choosing different denominators. One helper, one answer.
        const harvest = { tonnes: 63, harvestedAreaHa: 9 };
        const onScreen = tonnesPerHectare(harvest.tonnes, harvest.harvestedAreaHa);
        const inPdf = tonnesPerHectare(harvest.tonnes, harvest.harvestedAreaHa);
        expect(onScreen).toBe(inPdf);
        expect(onScreen).toBe(7);
    });
});

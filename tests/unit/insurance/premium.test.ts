import {
    INSTALMENT_COUNTS,
    INSURANCE_ENGINE_VERSION,
    MAX_AREA_DCA,
    MAX_SUM_INSURED_CENTS,
    quotePremium,
    sumInsuredFromPerDca,
} from '@/lib/insurance/premium';

const ok = (r: ReturnType<typeof quotePremium>) => {
    if (!r.ok) throw new Error(`expected a quote, got refusal: ${r.reason}`);
    return r;
};

describe('quotePremium — the product owner\'s worked example', () => {
    it('1,000 dca insured for €100,000 gives €10,000 premium and €10.00 per dca', () => {
        const q = ok(quotePremium({ areaDca: 1000, sumInsuredCents: 10_000_000, tariffBp: 1000, instalments: 1 }));
        expect(q.premiumCents).toBe(1_000_000);
        expect(q.premiumPerDcaCents).toBe(1_000);
        expect(q.sumInsuredPerDcaCents).toBe(10_000);
        expect(q.engineVersion).toBe(INSURANCE_ENGINE_VERSION);
    });

    it.each([
        [1, [1_000_000]],
        [2, [500_000, 500_000]],
        [3, [333_334, 333_333, 333_333]],
        [4, [250_000, 250_000, 250_000, 250_000]],
    ])('splits €10,000 into %i instalment(s)', (n, expected) => {
        const q = ok(quotePremium({ areaDca: 1000, sumInsuredCents: 10_000_000, tariffBp: 1000, instalments: n }));
        expect(q.instalmentsCents).toEqual(expected);
    });

    it('puts the leftover cents on the FIRST instalment: 101 in 4', () => {
        // 101 cents of premium = a sum insured of 1_010 cents at 10 %.
        const q = ok(quotePremium({ areaDca: 1, sumInsuredCents: 1_010, tariffBp: 1000, instalments: 4 }));
        expect(q.premiumCents).toBe(101);
        expect(q.instalmentsCents).toEqual([26, 25, 25, 25]);
    });
});

describe('the three reference cases, to the cent', () => {
    // These are the same A / B / C shown on the roadmap page and asserted
    // again end to end in step 5. If one changes, all three places change.
    it('A — 1,000 dca, €100,000.00, paid in 3', () => {
        const q = ok(quotePremium({ areaDca: 1000, sumInsuredCents: 10_000_000, tariffBp: 1000, instalments: 3 }));
        expect(q.premiumCents).toBe(1_000_000);
        expect(q.premiumPerDcaCents).toBe(1_000);
        expect(q.sumInsuredPerDcaCents).toBe(10_000);
        expect(q.instalmentsCents).toEqual([333_334, 333_333, 333_333]);
    });

    it('B — 12.345 dca (square-metre precision), €3,000.00, paid in 2', () => {
        const q = ok(quotePremium({ areaDca: 12.345, sumInsuredCents: 300_000, tariffBp: 1000, instalments: 2 }));
        expect(q.premiumCents).toBe(30_000);
        expect(q.premiumPerDcaCents).toBe(2_430);
        expect(q.sumInsuredPerDcaCents).toBe(24_301);
        expect(q.instalmentsCents).toEqual([15_000, 15_000]);
    });

    it('C — 250 dca, €37,500.55, paid in 4: lands on half a cent', () => {
        // 3_750_055 x 10 % = 375_005.5 exactly. Round-half-up gives 375_006,
        // leaving two cents for the first instalment.
        const q = ok(quotePremium({ areaDca: 250, sumInsuredCents: 3_750_055, tariffBp: 1000, instalments: 4 }));
        expect(q.premiumCents).toBe(375_006);
        expect(q.premiumPerDcaCents).toBe(1_500);
        expect(q.sumInsuredPerDcaCents).toBe(15_000);
        expect(q.instalmentsCents).toEqual([93_753, 93_751, 93_751, 93_751]);
    });
});

describe('conservation properties over seeded random input', () => {
    it('instalments always sum back to the premium, and the first carries the remainder', () => {
        // Deterministic LCG — a fixed seed, so a failure is reproducible and
        // a rerun cannot quietly pass on different numbers.
        let seed = 0x5eed;
        const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

        for (let i = 0; i < 2000; i++) {
            const areaDca = Math.max(0.001, Math.round(next() * 500_000 * 1000) / 1000);
            const sumInsuredCents = 1 + Math.floor(next() * 5_000_000_000);
            const tariffBp = 1 + Math.floor(next() * 10_000);
            const instalments = INSTALMENT_COUNTS[Math.floor(next() * INSTALMENT_COUNTS.length)];

            const q = ok(quotePremium({ areaDca, sumInsuredCents, tariffBp, instalments }));
            const sum = q.instalmentsCents.reduce((a, b) => a + b, 0);
            expect(sum).toBe(q.premiumCents);
            expect(q.instalmentsCents).toHaveLength(instalments);
            for (const part of q.instalmentsCents.slice(1)) {
                expect(q.instalmentsCents[0]).toBeGreaterThanOrEqual(part);
            }
            const max = Math.max(...q.instalmentsCents);
            const min = Math.min(...q.instalmentsCents);
            expect(max - min).toBeLessThanOrEqual(instalments - 1);
        }
    });
});

describe('every refusal reason is reachable', () => {
    const base = { areaDca: 100, sumInsuredCents: 100_000, tariffBp: 1000, instalments: 1 };

    it.each([NaN, Infinity, -1, 0, MAX_AREA_DCA + 1])('refuses area %p', (areaDca) => {
        expect(quotePremium({ ...base, areaDca })).toEqual({ ok: false, reason: 'area' });
    });

    it.each([NaN, Infinity, -1, 0, 1.5, MAX_SUM_INSURED_CENTS + 1])(
        'refuses sum insured %p',
        (sumInsuredCents) => {
            expect(quotePremium({ ...base, sumInsuredCents })).toEqual({ ok: false, reason: 'sumInsured' });
        },
    );

    it.each([0, 10_001, 999.5])('refuses tariff %p', (tariffBp) => {
        expect(quotePremium({ ...base, tariffBp })).toEqual({ ok: false, reason: 'tariff' });
    });

    it.each([0, 5, 2.5])('refuses instalments %p', (instalments) => {
        expect(quotePremium({ ...base, instalments })).toEqual({ ok: false, reason: 'instalments' });
    });

    it('never throws and never returns NaN for a refused input', () => {
        const r = quotePremium({ areaDca: NaN, sumInsuredCents: NaN, tariffBp: NaN, instalments: NaN });
        expect(r.ok).toBe(false);
    });
});

describe('the caps are self-checking', () => {
    it('sum insured x max tariff stays a safe integer', () => {
        // A future cap raise fails HERE rather than silently losing precision
        // in production.
        expect(Number.isSafeInteger(MAX_SUM_INSURED_CENTS * 10_000)).toBe(true);
    });
});

describe('area does not change the premium', () => {
    it('the same sum insured over 10, 1,000 and 12.345 dca gives one premium', () => {
        const premiums = [10, 1000, 12.345].map(
            (areaDca) => ok(quotePremium({ areaDca, sumInsuredCents: 10_000_000, tariffBp: 1000, instalments: 1 })).premiumCents,
        );
        expect(new Set(premiums).size).toBe(1);
        expect(premiums[0]).toBe(1_000_000);
    });
});

describe('sumInsuredFromPerDca — client and server round the same way', () => {
    it('multiplies and rounds', () => {
        expect(sumInsuredFromPerDca(10_000, 1000)).toBe(10_000_000);
        expect(sumInsuredFromPerDca(1_500, 250)).toBe(375_000);
    });

    it('does NOT round-trip a rounded per-dca figure back to the original total', () => {
        // Case B: €3,000.00 over 12.345 dca reports 24_301 cents per dca, but
        // 24_301 x 12.345 = 299_995.845 -> 299_996, four cents SHORT of the
        // €3,000.00 actually insured. That is the
        // whole reason the per-dca figures are documented DISPLAY-ONLY: the
        // total is what gets paid, and nothing may multiply these back up.
        expect(sumInsuredFromPerDca(24_301, 12.345)).toBe(299_996);
        expect(sumInsuredFromPerDca(24_301, 12.345)).not.toBe(300_000);
    });

    it.each([
        [0, 100],
        [-1, 100],
        [NaN, 100],
        [100, 0],
        [100, MAX_AREA_DCA + 1],
        [MAX_SUM_INSURED_CENTS, 1000],
    ])('refuses (%p per dca, %p dca)', (perDca, area) => {
        expect(sumInsuredFromPerDca(perDca, area)).toBeNull();
    });
});

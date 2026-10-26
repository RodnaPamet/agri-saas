/**
 * The calculator is EUR-only — owner ruling 2026-10-26.
 *
 * `Калкулатор` refused with `COST_CURRENCY_MIXED` on the owner's own farm. The
 * live rows were 10 × 'EUR', 3 × 'EURO' and 1 × 'BGN' — three spellings of two
 * currencies, one pegged to the other. These assert the normalisation that
 * resolves that, including the exact production shape.
 */
import { normaliseCostToEur, allResolveToEur } from '@/lib/grain/currencies';
import { BGN_PER_EUR, bgnToEur } from '@/lib/exchange/currency';

describe('normaliseCostToEur', () => {
    it('passes euro through in every spelling the free-text field produced', () => {
        for (const code of ['EUR', 'EURO', 'euro', ' eur ', '€', 'EUROS']) {
            expect({ code, ...normaliseCostToEur(1200, code) })
                .toEqual({ code, eur: 1200, refusal: null });
        }
    });

    it('treats an unrecorded currency as euro, not as unknown', () => {
        // The app is EUR-only, so a blank is a missing LABEL rather than an
        // unknown unit. Refusing here is what made the calculator useless on a
        // farm whose rows were simply never labelled.
        for (const code of [null, undefined, '', '   ']) {
            expect(normaliseCostToEur(40, code)).toEqual({ eur: 40, refusal: null });
        }
    });

    it('converts lev at the legally fixed peg, reusing the exchange helper', () => {
        // Reused rather than reimplemented so the calculator and the grain
        // exchange cannot drift to two different pegs. The exchange already
        // converted its stored BGN listings at this rate in a SQL migration.
        expect(normaliseCostToEur(1.0, 'BGN')).toEqual({ eur: bgnToEur(1.0), refusal: null });
        expect(normaliseCostToEur(1.95583, 'BGN').eur).toBe(1);
        // Rounded to the Decimal(12,2) precision both sides store.
        expect(normaliseCostToEur(100, 'BGN').eur).toBe(Math.round((100 / BGN_PER_EUR) * 100) / 100);
        // The lev's own free-text spellings, which the same field produced.
        for (const code of ['bgn', 'лв', 'ЛВ.', 'BGL']) {
            expect({ code, refusal: normaliseCostToEur(10, code).refusal })
                .toEqual({ code, refusal: null });
        }
    });

    it('REFUSES a genuinely foreign currency rather than relabelling it', () => {
        // The asymmetry is the point. A peg is arithmetic; a dollar rate is a
        // market quote this product does not have. Folding USD into euro would
        // misstate money by whatever the rate happens to be that day.
        for (const code of ['USD', 'GBP', 'RON', 'PLN', 'CHF']) {
            expect({ code, ...normaliseCostToEur(500, code) })
                .toEqual({ code, eur: null, refusal: 'FOREIGN' });
        }
    });

    it('withholds rather than inventing a figure for a missing amount', () => {
        expect(normaliseCostToEur(null, 'EUR')).toEqual({ eur: null, refusal: null });
        expect(normaliseCostToEur(Number.NaN, 'EUR')).toEqual({ eur: null, refusal: null });
    });

    it('resolves the owner farm\'s EXACT production mix to one currency', () => {
        // Measured read-only on production 2026-10-26 by the agrent-ios
        // session: PAYROLL 1200 EURO, RENT 40 EURO, FERTILIZER 10 EURO,
        // OTHER 1.00 BGN, plus 10 rows already 'EUR'. This is the farm whose
        // calculator was refusing.
        const rows: Array<[number, string | null]> = [
            [1200, 'EURO'], [40, 'EURO'], [10, 'EURO'], [1.0, 'BGN'],
            ...Array.from({ length: 10 }, () => [100, 'EUR'] as [number, string]),
        ];
        expect(allResolveToEur(rows.map(([, c]) => c))).toBe(true);
        const total = rows.reduce((sum, [a, c]) => sum + (normaliseCostToEur(a, c).eur ?? 0), 0);
        // 1200 + 40 + 10 + (1 / 1.95583 -> 0.51) + 10 x 100
        expect(total).toBeCloseTo(1250 + bgnToEur(1.0) + 1000, 2);
    });

    it('allResolveToEur is false as soon as one row is foreign', () => {
        // The control in the other direction: a predicate that returned true
        // unconditionally would let a dollar row into a euro total.
        expect(allResolveToEur(['EUR', 'EURO', null, 'BGN'])).toBe(true);
        expect(allResolveToEur(['EUR', 'USD'])).toBe(false);
    });
});

/**
 * The calculator is EUR-only — owner ruling 2026-10-26.
 *
 * `Калкулатор` refused with `COST_CURRENCY_MIXED` on the owner's own farm. The
 * live rows were 10 × 'EUR', 3 × 'EURO' and 1 × 'BGN' — three spellings of two
 * currencies, one pegged to the other. These assert the normalisation that
 * resolves that, including the exact production shape.
 */
import { normaliseCostToEur, allResolveToEur, isStoredAsEuro } from '@/lib/grain/currencies';
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

describe('isStoredAsEuro — the WRITE-path question, which is not the read one', () => {
    it('says yes to every euro spelling, and to an unrecorded currency', () => {
        for (const code of ['EUR', 'eur', ' EUR ', 'EURO', 'EUROS', '€', 'E', '', '   ', null, undefined]) {
            expect({ code, stored: isStoredAsEuro(code) }).toEqual({ code, stored: true });
        }
    });

    it('says NO to lev — and this is where it DIVERGES from allResolveToEur', () => {
        // The whole reason this function exists. `allResolveToEur(['BGN'])` is
        // TRUE, because normaliseCostToEur converts lev at the fixed peg and
        // returns no refusal — it answers "can the rollup total this row".
        //
        // That is a different question from "is this row already euro", and
        // using the rollup's answer on the save path was a real mistake caught
        // before it shipped (#2398): it would have left the one production BGN
        // row editable, let the form pin it to EUR, and relabelled 1.00 BGN as
        // 1.00 EUR — overstating a farmer's cost by 1.95583x.
        for (const code of ['BGN', 'bgn', 'лв', 'ЛВ.', 'BGL']) {
            expect({ code, storedAsEuro: isStoredAsEuro(code), rollupCanTotal: allResolveToEur([code]) })
                .toEqual({ code, storedAsEuro: false, rollupCanTotal: true });
        }
    });

    it('says no to a foreign currency, where the two predicates AGREE', () => {
        // Printed beside the divergence above so the contrast is visible: both
        // say no here, and only lev splits them.
        for (const code of ['USD', 'GBP', 'RON', 'PLN']) {
            expect({ code, storedAsEuro: isStoredAsEuro(code), rollupCanTotal: allResolveToEur([code]) })
                .toEqual({ code, storedAsEuro: false, rollupCanTotal: false });
        }
    });

    it('classifies the owner farm\'s EXACT production mix into editable and locked', () => {
        // 14 rows, measured read-only on production 2026-10-27: 10 'EUR',
        // 3 'EURO', 1 'BGN'. Exactly ONE row locks.
        const production = [...Array(10).fill('EUR'), ...Array(3).fill('EURO'), 'BGN'];
        const locked = production.filter((c) => !isStoredAsEuro(c));
        expect({ rows: production.length, locked }).toEqual({ rows: 14, locked: ['BGN'] });
        // And the naive predicate, pinned as the mistake it is: a literal
        // comparison against 'EUR' locks FOUR rows, three of them wrongly.
        const naive = production.filter((c) => c !== 'EUR');
        expect(naive).toEqual(['EURO', 'EURO', 'EURO', 'BGN']);
    });
});

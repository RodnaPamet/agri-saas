/**
 * The calculator is EUR-only — owner ruling 2026-10-26, and since #2793 that
 * is true of the SOURCE as well as of the data.
 *
 * `Калкулатор` refused with `COST_CURRENCY_MIXED` on the owner's own farm. The
 * live rows were 10 × 'EUR', 3 × 'EURO' and 1 × 'BGN' — three spellings of two
 * currencies, one pegged to the other. These assert the normalisation that
 * resolves that, including that exact shape.
 *
 * TWO things changed on 2026-11-08 and they pull in opposite directions, so
 * read both before editing a case here. The EURO-folding half is UNTOUCHED —
 * it is what stopped the calculator calling one farm's costs mixed. The LEV
 * half is gone: `normaliseCostToEur` used to convert a BGN amount at the fixed
 * 1.95583 peg and now refuses it `FOREIGN`, because the one production lev row
 * was deleted (measured 2026-11-06) and `COST_ENTRY_CURRENCY_NOT_EUR` has
 * refused a non-euro cost on write since #2398. The 2026-10-26 mix is
 * therefore kept as a HISTORICAL shape — production is 13 rows, all EUR — and
 * its lev row now asserts the refusal rather than the conversion.
 */
import { normaliseCostToEur, allResolveToEur, isStoredAsEuro } from '@/lib/grain/currencies';

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

    it('REFUSES lev in every spelling, and withholds the amount with it (#2793)', () => {
        // It used to CONVERT these, at the legally fixed 1.95583 peg, and
        // return `refusal: null` — reusing the exchange module's helper so the
        // calculator and the marketplace could not drift to two pegs. Both the
        // helper and the peg constant are gone.
        //
        // `eur: null` is asserted alongside the refusal because that is the
        // half that protects the money: a refusal carrying the raw lev figure
        // would let a caller that only reads `.eur` add 500 лв to a euro total
        // as 500 €, which is the 96% overstatement the removal must not cause.
        for (const code of ['BGN', 'bgn', ' bgn ', 'лв', 'ЛВ.', 'BGL']) {
            expect({ code, ...normaliseCostToEur(500, code) })
                .toEqual({ code, eur: null, refusal: 'FOREIGN' });
        }
    });

    it('REFUSES a genuinely foreign currency rather than relabelling it', () => {
        // Relabelling any of these as euro would misstate money by whatever
        // the rate happens to be that day. There used to be an asymmetry here
        // — a peg is arithmetic, a dollar rate is a market quote this product
        // does not have — and lev has joined this list rather than keeping its
        // own arm, so there is now one rule: not euro, not totalled.
        for (const code of ['USD', 'GBP', 'RON', 'PLN', 'CHF']) {
            expect({ code, ...normaliseCostToEur(500, code) })
                .toEqual({ code, eur: null, refusal: 'FOREIGN' });
        }
    });

    it('withholds rather than inventing a figure for a missing amount', () => {
        expect(normaliseCostToEur(null, 'EUR')).toEqual({ eur: null, refusal: null });
        expect(normaliseCostToEur(Number.NaN, 'EUR')).toEqual({ eur: null, refusal: null });
    });

    it('resolves the owner farm\'s 2026-10-26 mix, lev now excepted', () => {
        // Measured read-only on production 2026-10-26 by the agrent-ios
        // session: PAYROLL 1200 EURO, RENT 40 EURO, FERTILIZER 10 EURO,
        // OTHER 1.00 BGN, plus 10 rows already 'EUR'. This is the farm whose
        // calculator was refusing. The BGN row was deleted on 2026-11-06, so
        // the shape is historical — kept because it is the only place the
        // EURO-folding half is pinned against a real farm.
        const rows: Array<[number, string | null]> = [
            [1200, 'EURO'], [40, 'EURO'], [10, 'EURO'], [1.0, 'BGN'],
            ...Array.from({ length: 10 }, () => [100, 'EUR'] as [number, string]),
        ];
        // The lev row is what breaks this now, and nothing else does — printed
        // as a pair so a future failure says WHICH half moved.
        expect({
            withLev: allResolveToEur(rows.map(([, c]) => c)),
            asProductionStandsToday: allResolveToEur(
                rows.filter(([, c]) => c !== 'BGN').map(([, c]) => c),
            ),
        }).toEqual({ withLev: false, asProductionStandsToday: true });
        const total = rows.reduce((sum, [a, c]) => sum + (normaliseCostToEur(a, c).eur ?? 0), 0);
        // 1200 + 40 + 10 + 10 x 100. The lev row contributes NOTHING — not its
        // converted 0.51, and not its raw 1.00 either.
        expect(total).toBeCloseTo(1250 + 1000, 2);
    });

    it('allResolveToEur is false as soon as one row is non-euro', () => {
        // The control in the other direction: a predicate that returned true
        // unconditionally would let a dollar row into a euro total.
        expect(allResolveToEur(['EUR', 'EURO', null, '€'])).toBe(true);
        expect(allResolveToEur(['EUR', 'USD'])).toBe(false);
        // Lev was the one code that passed this and failed `isStoredAsEuro`.
        expect(allResolveToEur(['EUR', 'EURO', null, 'BGN'])).toBe(false);
    });
});

describe('isStoredAsEuro — the WRITE-path question, which is not the read one', () => {
    it('says yes to every euro spelling, and to an unrecorded currency', () => {
        for (const code of ['EUR', 'eur', ' EUR ', 'EURO', 'EUROS', '€', 'E', '', '   ', null, undefined]) {
            expect({ code, stored: isStoredAsEuro(code) }).toEqual({ code, stored: true });
        }
    });

    it('says NO to lev — where it USED to diverge from allResolveToEur', () => {
        // The reason this function exists, kept because it is why the save
        // path does not call the rollup's predicate. `allResolveToEur(['BGN'])`
        // was TRUE while `normaliseCostToEur` converted lev at the fixed peg —
        // it answers "can the rollup total this row", a different question
        // from "is this row already euro" — and using the rollup's answer on
        // the save path was a real mistake caught before it shipped (#2398):
        // it would have left the one production BGN row editable, let the form
        // pin it to EUR, and relabelled 1.00 BGN as 1.00 EUR, overstating a
        // farmer's cost by 1.95583x.
        //
        // #2793 made both answer `false`, so the two no longer diverge on any
        // code at all. The pair is still PRINTED rather than collapsed to one
        // assertion: a future money unit that converts again would reopen the
        // gap here, which is the signal worth keeping.
        for (const code of ['BGN', 'bgn', 'лв', 'ЛВ.', 'BGL']) {
            expect({ code, storedAsEuro: isStoredAsEuro(code), rollupCanTotal: allResolveToEur([code]) })
                .toEqual({ code, storedAsEuro: false, rollupCanTotal: false });
        }
    });

    it('says no to a foreign currency, where the two predicates also AGREE', () => {
        // Printed beside the case above so the contrast is visible — and as of
        // #2793 there is no contrast left to see. No code splits them.
        for (const code of ['USD', 'GBP', 'RON', 'PLN']) {
            expect({ code, storedAsEuro: isStoredAsEuro(code), rollupCanTotal: allResolveToEur([code]) })
                .toEqual({ code, storedAsEuro: false, rollupCanTotal: false });
        }
    });

    it('classifies the owner farm\'s 2026-10-27 mix into editable and locked', () => {
        // 14 rows, measured read-only on production 2026-10-27: 10 'EUR',
        // 3 'EURO', 1 'BGN'. Exactly ONE row locks. Historical since the lev
        // row was deleted on 2026-11-06 — this function's answers did not
        // change in #2793, only its sibling's did.
        const production = [...Array(10).fill('EUR'), ...Array(3).fill('EURO'), 'BGN'];
        const locked = production.filter((c) => !isStoredAsEuro(c));
        expect({ rows: production.length, locked }).toEqual({ rows: 14, locked: ['BGN'] });
        // And the naive predicate, pinned as the mistake it is: a literal
        // comparison against 'EUR' locks FOUR rows, three of them wrongly.
        const naive = production.filter((c) => c !== 'EUR');
        expect(naive).toEqual(['EURO', 'EURO', 'EURO', 'BGN']);
    });
});

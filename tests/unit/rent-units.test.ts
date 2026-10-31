/**
 * Rent units, and the currency a money unit carries (#2397 follow-up).
 *
 * `ParcelLease` has no currency COLUMN. The unit is the only place a rent's
 * currency is recorded, which is why `MONEY_RENT_UNIT_CURRENCY` exists and why
 * rent could not be totalled with costs until it did.
 */
import {
    CANONICAL_RENT_UNITS,
    canonicalRentUnit,
    isMoneyRentUnit,
    MONEY_RENT_UNIT_CURRENCY,
    RENT_UNIT_EUR,
    RENT_UNIT_KG,
    RENT_UNIT_LEVA,
} from '@/lib/agro/rent-units';

describe('the euro rent unit', () => {
    it.each([
        ['€/дка'],
        ['€/декар'],
        ['€/dka'],
        ['евро/дка'],
        ['евро/декар'],
        ['eur/дка'],
        ['eur/dka'],
        ['eur/dca'],
        ['euro/dka'],
        ['EUR/DKA'],
        ['  € / дка  '],
    ])('folds %s to the canonical €/дка', (raw) => {
        expect(canonicalRentUnit(raw)).toBe(RENT_UNIT_EUR);
    });

    it('is canonical alongside leva and kg', () => {
        expect(CANONICAL_RENT_UNITS).toContain(RENT_UNIT_EUR);
        // Leva is KEPT canonical deliberately: it is what is in the database
        // for every lease recorded before 2026-10-31, and dropping it would
        // turn those into unrecognised units and REFUSE them — the opposite of
        // converting them.
        expect(CANONICAL_RENT_UNITS).toContain(RENT_UNIT_LEVA);
    });
});

describe('which units carry a currency', () => {
    it('maps the two money units to codes the cost vocabulary understands', () => {
        expect(MONEY_RENT_UNIT_CURRENCY[RENT_UNIT_EUR]).toBe('EUR');
        expect(MONEY_RENT_UNIT_CURRENCY[RENT_UNIT_LEVA]).toBe('BGN');
    });

    it('gives produce rent NO currency, and that is the point', () => {
        // `кг/дка` is a MASS. Giving it a currency would be the same category
        // error as summing it with money, which `RentBasisResult`'s two arms
        // exist to make impossible.
        expect(MONEY_RENT_UNIT_CURRENCY[RENT_UNIT_KG]).toBeUndefined();
        expect(isMoneyRentUnit(RENT_UNIT_KG)).toBe(false);
    });

    it.each([[RENT_UNIT_EUR], [RENT_UNIT_LEVA]])('%s is money', (u) => {
        expect(isMoneyRentUnit(u)).toBe(true);
    });

    it.each([[null], [undefined], [''], ['лв/ха'], ['USD/дка'], ['кг/дка']])(
        'treats %p as not-money',
        (u) => {
            expect(isMoneyRentUnit(u as string | null | undefined)).toBe(false);
        },
    );

    it('every canonical money unit has a currency, and every mapped unit is canonical', () => {
        // Both directions. A money unit with no currency would resolve to a
        // figure nothing can label; a mapped unit that is not canonical would
        // be a currency for a unit `canonicalRentUnit` never produces.
        const mapped = Object.keys(MONEY_RENT_UNIT_CURRENCY);
        for (const u of mapped) expect(CANONICAL_RENT_UNITS).toContain(u);
        const moneyCanonical = CANONICAL_RENT_UNITS.filter((u) => u !== RENT_UNIT_KG);
        expect([...mapped].sort()).toEqual([...moneyCanonical].sort());
    });
});

describe('unknown units still round-trip verbatim', () => {
    it('keeps an unrecognised unit as typed, so it groups with itself', () => {
        // Unchanged behaviour, asserted because the euro aliases above are new
        // and an over-broad alias key would start swallowing these.
        expect(canonicalRentUnit('USD/дка')).toBe('USD/дка');
        expect(canonicalRentUnit('лв/ха')).toBe('лв/ха');
    });

    it('does not fold a bare currency with no rate', () => {
        expect(canonicalRentUnit('€')).toBe('€');
        expect(canonicalRentUnit('лв')).toBe('лв');
    });
});

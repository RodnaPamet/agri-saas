/**
 * Unit — the Exchange currency policy.
 *
 * This module is the single place that decides what a price MEANS, so the
 * tests here are the specification for three claims the product makes:
 *
 *   1. The BGN→EUR conversion is EXACT arithmetic at a legally fixed rate,
 *      not an FX guess. That is the entire reason a one-shot data migration
 *      was a defensible answer, and the constant must match the SQL.
 *   2. USD is not convertible and must never be relabelled.
 *   3. An aggregate may only be computed over ONE currency. Every average and
 *      comparison on every surface routes through these predicates, so a
 *      regression here is a regression everywhere at once.
 */
import {
    EXCHANGE_CURRENCY,
    BGN_PER_EUR,
    bgnToEur,
    currencySymbol,
    isAggregatable,
    isAggregatableWith,
    formatPricePerTonne,
} from '@/lib/exchange/currency';

describe('the fixed BGN↔EUR rate', () => {
    it('is the legally fixed 1.95583, not a market quote', () => {
        // Pegged since 1999 and the irrevocable euro-adoption rate. If this
        // number ever changes, the migration that already ran was wrong.
        expect(BGN_PER_EUR).toBe(1.95583);
    });

    it('converts to 2 dp, matching the Decimal(12,2) column and the SQL ROUND', () => {
        expect(bgnToEur(1.95583)).toBe(1);
        // The defect's own example: a 320 BGN listing was being SHOWN as
        // "320 €/t" — a ~1.96x overstatement of its value.
        expect(bgnToEur(320)).toBe(163.61);
        expect(bgnToEur(0)).toBe(0);
    });

    it('never returns more than 2 decimal places', () => {
        for (const bgn of [1, 7, 99.99, 12345.67, 1000000]) {
            const eur = bgnToEur(bgn);
            expect(Number(eur.toFixed(2))).toBe(eur);
        }
    });
});

describe('aggregation is single-currency', () => {
    it('only the marketplace currency may join a cross-listing aggregate', () => {
        expect(EXCHANGE_CURRENCY).toBe('EUR');
        expect(isAggregatable('EUR')).toBe(true);
        // USD floats: comparing its digits to a euro price is meaningless, so
        // it is excluded from the ticker average and the ★ best-price ring.
        expect(isAggregatable('USD')).toBe(false);
        // BGN rows no longer exist after the migration, but the predicate must
        // still refuse one rather than silently treat it as euro.
        expect(isAggregatable('BGN')).toBe(false);
    });

    it('reports the shared currency of a set, or null when it is mixed', () => {
        expect(isAggregatableWith(['EUR', 'EUR'])).toBe('EUR');
        // A same-currency legacy group is still averageable — under ITS label.
        expect(isAggregatableWith(['USD', 'USD'])).toBe('USD');
        // Mixed → no aggregate at all. The old code averaged anyway and
        // labelled the result with whichever currency came first in the array.
        expect(isAggregatableWith(['EUR', 'USD'])).toBeNull();
        // Nothing priced → nothing to say.
        expect(isAggregatableWith([])).toBeNull();
    });
});

describe('price formatting carries the row own currency', () => {
    it('renders the symbol for the currency it was given, not a fixed unit', () => {
        expect(formatPricePerTonne(320, 'EUR')).toBe('320 €/t');
        // The regression this replaces: a USD row printed as "900 €/t".
        expect(formatPricePerTonne(900, 'USD')).toBe('900 $/t');
    });

    it('takes the tonne glyph from the caller so Bulgarian gets cyrillic т', () => {
        expect(formatPricePerTonne('250', 'EUR', 'т')).toBe('250 €/т');
    });

    it('falls back to the raw code for a currency it has no symbol for', () => {
        expect(currencySymbol('XAU')).toBe('XAU');
        expect(formatPricePerTonne(5, 'XAU')).toBe('5 XAU/t');
    });
});

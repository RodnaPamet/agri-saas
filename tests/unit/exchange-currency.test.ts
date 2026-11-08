/**
 * Unit — the Exchange currency policy.
 *
 * This module is the single place that decides what a price MEANS, so the
 * tests here are the specification for two claims the product makes:
 *
 *   1. No currency is convertible, and none may be relabelled — USD because
 *      it floats, and BGN because #2793 removed the fixed-peg converter this
 *      file used to specify. The lev's one-shot conversion already happened,
 *      in `20260729120000_exchange_euro_denomination`, which carries the
 *      1.95583 literal itself; the block that used to pin a `BGN_PER_EUR`
 *      export against that SQL is gone with the export it pinned.
 *   2. An aggregate may only be computed over ONE currency. Every average and
 *      comparison on every surface routes through these predicates, so a
 *      regression here is a regression everywhere at once.
 */
import {
    EXCHANGE_CURRENCY,
    currencySymbol,
    isAggregatable,
    isAggregatableWith,
    formatPricePerTonne,
} from '@/lib/exchange/currency';

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

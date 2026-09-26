import { formatCents } from '@/lib/insurance/format';

describe('formatCents — cents are ALWAYS shown', () => {
    it.each<[number, string, string]>([
        [1_000_000, '€10,000.00', 'the worked example'],
        [333_334, '€3,333.34', 'the first instalment of €10,000 in 3'],
        [333_330, '€3,333.30', 'the case formatExactCurrency gets wrong'],
        [30, '€0.30', 'under a euro'],
        [5, '€0.05', 'a single-digit cent'],
        [0, '€0.00', 'zero'],
    ])('%p -> %p (%s)', (cents, expected) => {
        expect(formatCents(cents)).toBe(expected);
    });

    it('accepts a custom symbol', () => {
        expect(formatCents(1_000_000, 'лв')).toBe('лв10,000.00');
    });

    it('is why it exists: trailing zeros survive', () => {
        // formatDecimal sets only maximumFractionDigits, so the app's other
        // money formatters render this as "€3,333.3". An instalment line
        // missing its second decimal reads as a typo.
        expect(formatCents(333_330)).toMatch(/\.30$/);
        expect(formatCents(1_000_000)).toMatch(/\.00$/);
    });
});

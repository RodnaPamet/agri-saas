import { parseAreaDca, parseMoneyToCents } from '@/lib/insurance/parse';

/**
 * Table-driven: one row per input and expected output, so a regression names
 * the exact string that broke rather than a line number.
 */
describe('parseMoneyToCents', () => {
    it.each<[string, number | null, string]>([
        ['100000', 10_000_000, 'plain digits'],
        ['100 000', 10_000_000, 'space as thousands separator'],
        ['100\u00a0000', 10_000_000, 'NBSP as thousands separator'],
        ['100\u202f000', 10_000_000, 'narrow NBSP as thousands separator'],
        ['100.000', 10_000_000, 'single dot before exactly 3 digits = THOUSANDS'],
        ['100,000', 10_000_000, 'single comma before exactly 3 digits = THOUSANDS'],
        ['100000,5', 10_000_050, 'comma before 1 digit = decimal'],
        ['100000.50', 10_000_050, 'dot before 2 digits = decimal'],
        ['1.234.567,89', 123_456_789, 'Bulgarian: dots group, last comma decimal'],
        ['1,234,567.89', 123_456_789, 'English: commas group, last dot decimal'],
        ['\u20ac 100 000', 10_000_000, 'leading currency symbol'],
        ['100 000 \u20ac', 10_000_000, 'trailing currency symbol'],
        [' 42 ', 4_200, 'surrounding whitespace'],
        ['1234.567', null, '4 digits before a 3-digit group is neither reading'],
        ['', null, 'empty'],
        ['abc', null, 'letters'],
        ['-5', null, 'a sign'],
        ['1e5', null, 'exponent notation'],
        ['10.1234', null, 'more than 2 decimals'],
    ])('%p -> %p (%s)', (input, expected) => {
        expect(parseMoneyToCents(input)).toBe(expected);
    });

    it('accepts a caller-supplied symbol as well as the euro sign', () => {
        expect(parseMoneyToCents('100 000 lv', { symbol: 'lv' })).toBe(10_000_000);
    });
});

describe('parseAreaDca', () => {
    it.each<[string, number | null, string]>([
        ['12,345', 12.345, 'comma is ALWAYS decimal here \u2014 square metres'],
        ['12.345', 12.345, 'dot is ALWAYS decimal here'],
        ['1 000', 1000, 'space still groups thousands'],
        ['0', null, 'zero area'],
        ['12.3456', null, 'more than 3 decimals'],
        ['-3', null, 'a sign'],
    ])('%p -> %p (%s)', (input, expected) => {
        expect(parseAreaDca(input)).toBe(expected);
    });
});

describe('the asymmetry between the two parsers is deliberate', () => {
    it('reads the SAME string differently, and that is the point', () => {
        // "12.345" is twelve thousand three hundred and forty-five euros, and
        // twelve point three four five decares. Reading money as a decimal
        // would quote a premium 1000x too small; reading an area as thousands
        // would inflate a 12-decare parcel to 12,345.
        expect(parseMoneyToCents('12.345')).toBe(1_234_500);
        expect(parseAreaDca('12.345')).toBe(12.345);
    });
});

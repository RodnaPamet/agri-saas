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

describe('a space is a THOUSANDS separator, so its groups must be threes', () => {
    /**
     * Spaces were stripped wholesale before any grouping check, while commas and
     * dots went through `groupsOfThree`. That asymmetry read "1 2 3 4" as 1234 —
     * nonsense producing a PLAUSIBLE figure, which on a sum-insured field reaches
     * the operator as a real number. The worst way to be wrong.
     *
     * Found because the iOS client hit the identical defect in its own parser and
     * asked whether this one shared it. It did, in both parsers.
     */
    it.each([
        ['every group a single digit', '1 2 3 4'],
        ['a two-digit tail group', '1 23'],
        ['a four-digit tail group', '12 3456'],
        ['two groups, second too short', '1 2'],
        ['a valid group after an invalid one', '1 2 345'],
        ['a two-digit final group', '100 00'],
    ])('money rejects %s (%p)', (_label, input) => {
        expect(parseMoneyToCents(input)).toBeNull();
    });

    it.each([
        ['every group a single digit', '1 2 3 4'],
        ['a two-digit tail group', '1 23'],
        ['two groups, second too short', '1 2'],
    ])('area rejects %s (%p)', (_label, input) => {
        expect(parseAreaDca(input)).toBeNull();
    });

    it('still reads a real thousands grouping, with or without a decimal', () => {
        // The first group is free — "12 345" is ordinary — and only the LAST
        // group may carry the decimal tail.
        expect(parseMoneyToCents('100 000')).toBe(10_000_000);
        expect(parseMoneyToCents('12 345')).toBe(1_234_500);
        expect(parseMoneyToCents('100 000,50')).toBe(10_000_050);
        expect(parseMoneyToCents('1 234 567.89')).toBe(123_456_789);
        expect(parseAreaDca('100 000')).toBe(100_000);
        expect(parseAreaDca('1 000,5')).toBe(1000.5);
    });

    it('is unbothered by surrounding whitespace, which is not a grouping', () => {
        expect(parseMoneyToCents('1000 ')).toBe(100_000);
        expect(parseMoneyToCents(' 100 000 ')).toBe(10_000_000);
    });

    it('leaves the money/area asymmetry intact', () => {
        // The point of this file: the same characters read opposite ways.
        expect(parseMoneyToCents('12,345')).toBe(1_234_500);
        expect(parseAreaDca('12,345')).toBe(12.345);
    });
});

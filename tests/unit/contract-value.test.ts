/**
 * Unit tests for `src/lib/grain/contract-value.ts`.
 *
 * `grain.prisma` has described contract value as "volume × price" since
 * the module shipped; nothing computed it (`grep contractValue src/` →
 * 0 hits). This module is that computation, and these tests pin the two
 * rules that make it safe to put on a dashboard:
 *
 *   1. **Decimal, never float.** The product of a Decimal(14,3) and a
 *      Decimal(14,2) needs 5 places to be exact, and a book total is
 *      money.
 *   2. **Never sum across currencies.** €100k + $100k is not 200k of
 *      anything.
 */

import { Prisma } from '@prisma/client';
import {
    computeContractValue,
    summariseContractBook,
} from '@/lib/grain/contract-value';

const D = (v: string) => new Prisma.Decimal(v);

const contract = (over: Partial<Record<string, unknown>> = {}) =>
    ({
        status: 'ACTIVE',
        volumeTonnes: D('100'),
        pricePerTonne: D('200'),
        priceCurrency: 'EUR',
        ...over,
    }) as any;

describe('computeContractValue', () => {
    it('multiplies volume by price', () => {
        expect(computeContractValue(D('500'), D('210'))).toBe('105000');
    });

    it('is exact where float would drift', () => {
        // 0.1 * 3 === 0.30000000000000004 in IEEE-754 doubles.
        expect(computeContractValue(D('0.1'), D('3'))).toBe('0.3');
        // 1234.567 t × 89.12 /t — five decimal places, exactly.
        expect(computeContractValue(D('1234.567'), D('89.12'))).toBe('110024.61104');
    });

    it('accepts wire strings as well as Decimals', () => {
        // Values cross the JSON boundary as strings; the helper must not
        // require a Prisma.Decimal to stay exact.
        expect(computeContractValue('1234.567', '89.12')).toBe('110024.61104');
    });

    it.each([
        ['no volume', null, D('210')],
        ['no price', D('500'), null],
        ['neither', null, null],
        ['undefined volume', undefined, D('210')],
    ])('returns null when there is %s', (_label, volume, price) => {
        // Null, not zero: zero would claim the deal is worth nothing and
        // would silently drag a book total down.
        expect(computeContractValue(volume as any, price as any)).toBeNull();
    });

    it('survives a malformed stored value instead of throwing', () => {
        // A bad value must not take down a whole list read.
        expect(computeContractValue('not-a-number', D('10'))).toBeNull();
    });

    it('handles a zero price without pretending it is missing', () => {
        // A genuinely free/zero-priced contract is worth 0, which is a
        // different statement from "unpriced".
        expect(computeContractValue(D('100'), D('0'))).toBe('0');
    });
});

describe('summariseContractBook', () => {
    it('groups by currency and never blends them', () => {
        const totals = summariseContractBook([
            contract({ priceCurrency: 'EUR', volumeTonnes: D('100'), pricePerTonne: D('200') }),
            contract({ priceCurrency: 'USD', volumeTonnes: D('50'), pricePerTonne: D('300') }),
            contract({ priceCurrency: 'EUR', volumeTonnes: D('10'), pricePerTonne: D('100') }),
        ]);

        expect(totals).toHaveLength(2);
        const eur = totals.find((t) => t.currency === 'EUR')!;
        const usd = totals.find((t) => t.currency === 'USD')!;
        expect(eur.contractValue).toBe('21000'); // 20000 + 1000
        expect(eur.contractedTonnes).toBe('110');
        expect(eur.contractCount).toBe(2);
        expect(usd.contractValue).toBe('15000');
        // The critical property: no bucket anywhere holds 36000.
        expect(totals.some((t) => t.contractValue === '36000')).toBe(false);
    });

    it('gives contracts with no currency their own bucket, sorted last', () => {
        const totals = summariseContractBook([
            contract({ priceCurrency: null, volumeTonnes: D('10'), pricePerTonne: D('1000') }),
            contract({ priceCurrency: 'EUR', volumeTonnes: D('1'), pricePerTonne: D('1') }),
        ]);
        expect(totals).toHaveLength(2);
        // Unspecified last regardless of magnitude — 10000 > 1 here.
        expect(totals[totals.length - 1].currency).toBeNull();
        expect(totals[totals.length - 1].contractValue).toBe('10000');
    });

    it('treats a blank/whitespace currency as unspecified', () => {
        const totals = summariseContractBook([
            contract({ priceCurrency: '   ' }),
            contract({ priceCurrency: '' }),
        ]);
        expect(totals).toHaveLength(1);
        expect(totals[0].currency).toBeNull();
        expect(totals[0].contractCount).toBe(2);
    });

    it('does not let a literal "null" currency code collide with the no-currency bucket', () => {
        const totals = summariseContractBook([
            contract({ priceCurrency: 'null', volumeTonnes: D('1'), pricePerTonne: D('1') }),
            contract({ priceCurrency: null, volumeTonnes: D('2'), pricePerTonne: D('1') }),
        ]);
        // Two distinct buckets. Asserted by membership, not by sorting —
        // `Array.prototype.sort` stringifies, so `null` and `'null'`
        // would compare equal and the assertion would prove nothing.
        expect(totals).toHaveLength(2);
        const currencies = totals.map((t) => t.currency);
        expect(currencies).toContain('null');
        expect(currencies).toContain(null);
        // The real-currency bucket keeps its own value.
        expect(totals.find((t) => t.currency === 'null')!.contractValue).toBe('1');
        expect(totals.find((t) => t.currency === null)!.contractValue).toBe('2');
    });

    it('counts unpriced contracts instead of silently under-reporting', () => {
        const totals = summariseContractBook([
            contract({ volumeTonnes: D('100'), pricePerTonne: D('10') }),
            contract({ volumeTonnes: D('100'), pricePerTonne: null }),
            contract({ volumeTonnes: null, pricePerTonne: D('10') }),
        ]);
        expect(totals).toHaveLength(1);
        expect(totals[0].contractValue).toBe('1000');
        expect(totals[0].contractCount).toBe(3);
        expect(totals[0].unpricedCount).toBe(2);
        // Tonnes still accumulate for the row that has a volume but no
        // price — it IS contracted tonnage, just not valued.
        expect(totals[0].contractedTonnes).toBe('200');
    });

    it('filters to the requested statuses', () => {
        const totals = summariseContractBook(
            [
                contract({ status: 'ACTIVE', volumeTonnes: D('100'), pricePerTonne: D('10') }),
                contract({ status: 'DRAFT', volumeTonnes: D('900'), pricePerTonne: D('10') }),
                contract({ status: 'CANCELLED', volumeTonnes: D('900'), pricePerTonne: D('10') }),
                contract({ status: 'DELIVERED', volumeTonnes: D('50'), pricePerTonne: D('10') }),
            ],
            ['ACTIVE', 'DELIVERED'],
        );
        expect(totals[0].contractValue).toBe('1500'); // 1000 + 500
        expect(totals[0].contractCount).toBe(2);
    });

    it('values every row when no status filter is given', () => {
        const totals = summariseContractBook([
            contract({ status: 'DRAFT', volumeTonnes: D('10'), pricePerTonne: D('10') }),
        ]);
        expect(totals[0].contractValue).toBe('100');
    });

    it('returns an empty array for no contracts', () => {
        expect(summariseContractBook([])).toEqual([]);
        expect(summariseContractBook([contract()], ['SETTLED'])).toEqual([]);
    });

    it('sorts currency buckets by descending value', () => {
        const totals = summariseContractBook([
            contract({ priceCurrency: 'GBP', volumeTonnes: D('1'), pricePerTonne: D('1') }),
            contract({ priceCurrency: 'EUR', volumeTonnes: D('100'), pricePerTonne: D('100') }),
            contract({ priceCurrency: 'USD', volumeTonnes: D('10'), pricePerTonne: D('10') }),
        ]);
        expect(totals.map((t) => t.currency)).toEqual(['EUR', 'USD', 'GBP']);
    });

    it('accumulates large books without float error', () => {
        // 1000 contracts of 0.001 t at 0.01 /t = 0.00001 each.
        // Float accumulation of 0.00001 a thousand times drifts;
        // Decimal gives exactly 0.01.
        const many = Array.from({ length: 1000 }, () =>
            contract({ volumeTonnes: D('0.001'), pricePerTonne: D('0.01') }),
        );
        expect(summariseContractBook(many)[0].contractValue).toBe('0.01');
    });
});

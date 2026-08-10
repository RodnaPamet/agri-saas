/**
 * Per-decare rate calculator — spray/fertilizer totals.
 */
import {
    DCA_PER_HA,
    haToDca,
    dcaToHa,
    totalForArea,
    amountUnitOf,
    areaBasisOf,
    totalForRate,
    trimNumber,
    formatTotal,
    totalLabel,
} from '@/lib/agro/rate-calc';

describe('haToDca', () => {
    it('converts hectares to decares (1 ha = 10 dca)', () => {
        expect(DCA_PER_HA).toBe(10);
        expect(haToDca(10)).toBe(100);
        expect(haToDca(0.5)).toBe(5);
        expect(haToDca(0)).toBe(0);
    });
    it('returns 0 for non-finite area', () => {
        expect(haToDca(NaN)).toBe(0);
    });
});

describe('dcaToHa', () => {
    it('converts decares to hectares (fixed known values)', () => {
        expect(dcaToHa(100)).toBe(10);
        expect(dcaToHa(10)).toBe(1);
        expect(dcaToHa(5)).toBe(0.5);
        expect(dcaToHa(0)).toBe(0);
    });
    it('returns 0 for non-finite area', () => {
        expect(dcaToHa(NaN)).toBe(0);
    });
    it('round-trips through haToDca (both directions, not just a no-op)', () => {
        // A round trip alone would pass even if BOTH directions carried the
        // same wrong factor — pair it with the fixed-value assertions above,
        // which pin the actual factor of 10, not just self-consistency.
        for (const areaHa of [1, 10, 2.5, 0, 137.4]) {
            expect(dcaToHa(haToDca(areaHa))).toBeCloseTo(areaHa, 10);
        }
        for (const areaDca of [1, 100, 25, 0, 1374]) {
            expect(haToDca(dcaToHa(areaDca))).toBeCloseTo(areaDca, 10);
        }
    });
    it('is the true inverse of haToDca, not an identity in disguise', () => {
        // Catches the failure mode where someone "fixes" dcaToHa by making
        // it also multiply (a copy-paste of haToDca) — round trip alone
        // would still look fine only if BOTH were wrong the same way, but
        // this pins the actual, non-1:1 relationship directly.
        expect(dcaToHa(100)).not.toBe(100);
        expect(dcaToHa(100)).toBe(haToDca(1));
    });
});

describe('totalForArea', () => {
    it('computes rate × decares', () => {
        // 14 L/dca over a 10 ha (100 dca) parcel = 1400.
        expect(totalForArea(14, 10)).toBe(1400);
        // 100 ml/dca over 100 dca = 10000 ml.
        expect(totalForArea(100, 10)).toBe(10000);
    });
    it('is zero for zero area or non-finite inputs', () => {
        expect(totalForArea(14, 0)).toBe(0);
        expect(totalForArea(NaN, 10)).toBe(0);
        expect(totalForArea(14, NaN)).toBe(0);
    });
});

describe('amountUnitOf', () => {
    it('extracts the head amount unit from a rate symbol', () => {
        expect(amountUnitOf('ml/dca')).toBe('ml');
        expect(amountUnitOf('L/ha')).toBe('L');
        expect(amountUnitOf('kg/dca')).toBe('kg');
        expect(amountUnitOf('L / dca')).toBe('L');
    });
    it('falls back to the whole symbol when there is no slash', () => {
        expect(amountUnitOf('L')).toBe('L');
    });
});

describe('trimNumber', () => {
    it('drops trailing zeros and caps at 2dp', () => {
        expect(trimNumber(10)).toBe('10');
        expect(trimNumber(10.0)).toBe('10');
        expect(trimNumber(2.5)).toBe('2.5');
        expect(trimNumber(2.567)).toBe('2.57');
        expect(trimNumber(1400)).toBe('1400');
    });
});

describe('formatTotal', () => {
    it('matches the worked example', () => {
        // Water: 14 L/dca × 100 dca = 1400 L.
        expect(formatTotal(totalForArea(14, 10), 'L/dca')).toBe('1400 L');
        // Product: 100 ml/dca × 100 dca = 10000 ml → 10 L.
        expect(formatTotal(totalForArea(100, 10), 'ml/dca')).toBe('10 L');
    });
    it('promotes ml→L and g→kg at ≥ 1000', () => {
        expect(formatTotal(50000, 'ml/dca')).toBe('50 L');
        expect(formatTotal(2500, 'g/dca')).toBe('2.5 kg');
    });
    it('keeps small quantities in the base unit', () => {
        expect(formatTotal(100, 'ml/dca')).toBe('100 ml');
        expect(formatTotal(0, 'ml/dca')).toBe('0 ml');
        expect(formatTotal(3, 'L/ha')).toBe('3 L');
    });
});

describe('areaBasisOf', () => {
    it('reads the /ha or /dca basis from the symbol', () => {
        expect(areaBasisOf('L/dca')).toBe('dca');
        expect(areaBasisOf('mL/dca')).toBe('dca');
        expect(areaBasisOf('L/ha')).toBe('ha');
        expect(areaBasisOf('kg/ha')).toBe('ha');
        // Unknown/absent denominator defaults to hectare.
        expect(areaBasisOf('L')).toBe('ha');
    });

    it('recognises the Bulgarian decare denominator (Cyrillic дка)', () => {
        // The seeded symbols are Cyrillic — these must resolve to the decare
        // basis, not silently fall through to hectare.
        expect(areaBasisOf('кг/дка')).toBe('dca');
        expect(areaBasisOf('л/дка')).toBe('dca');
        expect(areaBasisOf('мл/дка')).toBe('dca');
        // Cyrillic hectare stays hectare.
        expect(areaBasisOf('кг/ха')).toBe('ha');
    });
});

describe('totalForRate (basis-aware)', () => {
    it('multiplies /dca rates by decares', () => {
        expect(totalForRate(14, 'L/dca', 10)).toBe(1400);
        expect(totalForRate(100, 'mL/dca', 10)).toBe(10000);
        // Bulgarian symbol: 20 кг/дка over 10 ha (= 100 dca) = 2000 kg.
        expect(totalForRate(20, 'кг/дка', 10)).toBe(2000);
    });
    it('multiplies /ha rates by hectares', () => {
        // 2 L/ha over 10 ha = 20 L (NOT × dca).
        expect(totalForRate(2, 'L/ha', 10)).toBe(20);
    });
    it('is zero for non-finite inputs', () => {
        expect(totalForRate(NaN, 'L/dca', 10)).toBe(0);
    });
});

describe('totalLabel', () => {
    it('computes and formats honoring the basis', () => {
        expect(totalLabel(14, 'L/dca', 10)).toBe('1400 L');
        expect(totalLabel(100, 'mL/dca', 10)).toBe('10 L');
        // Per-hectare rate stays per-hectare.
        expect(totalLabel(2, 'L/ha', 10)).toBe('20 L');
    });
});

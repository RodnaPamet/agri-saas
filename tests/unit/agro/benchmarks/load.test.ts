/**
 * The national yields and support rates dataset (agrent-ios#638): the
 * committed file loads, and the validator refuses the shapes that would
 * otherwise read as working.
 */
import raw from '@/lib/agro/benchmarks/dataset.json';
import { BENCHMARKS, benchmarkCommodities, benchmarksFor, served, validateBenchmarks } from '@/lib/agro/benchmarks/load';

const clone = () => JSON.parse(JSON.stringify(raw));

describe('the committed dataset', () => {
    it('loads, and every citation resolves to a source', () => {
        expect(BENCHMARKS.yields.length).toBeGreaterThanOrEqual(12);
        expect(BENCHMARKS.supportRates.length).toBeGreaterThanOrEqual(10);
        for (const x of [...BENCHMARKS.yields, ...BENCHMARKS.supportRates]) {
            expect(Object.keys(BENCHMARKS.sources)).toContain(x.cite.source);
        }
    });

    it('holds the published figures as printed', () => {
        // Positive controls against the source pages, so a re-compile that
        // divided or converted shows up as a number change rather than passing.
        expect(benchmarksFor({ commodity: 'wheat' }).yields[0].kgPerHa).toBe(5731);
        const protein = BENCHMARKS.supportRates.find((r) => r.scheme === 'protein');
        expect(protein).toMatchObject({ currency: 'BGN', perHaStotinki: 25474 });
        // Its 2025 rate is not published yet, and the note says so (#3166).
        expect(protein?.note?.bg).toMatch(/2025/);
    });

    it('carries the Campaign 2025 fruit-and-vegetable order in euro, unconverted (#3166)', () => {
        // РД 09-470/24.04.2026, point IV: 1 510,32 / 1 006,88 евро/ха.
        const pepper = BENCHMARKS.supportRates.find((r) => r.scheme === 'veg-pepper');
        expect(pepper).toMatchObject({
            campaign: 2025, currency: 'EUR', perHaStotinki: 151032, perHaOver30Stotinki: 100688,
            cite: { source: 'mzh-rd09-470-2026', point: 'IV' },
        });
        // Euro per hectare to euro per decare is a division, never the peg.
        expect(served(pepper!).perDaEurCents).toBe(15103);
        expect(served(pepper!).perDaOver30EurCents).toBe(10069);
        // Every fruit-and-vegetable scheme moved; only protein stays on 2024.
        const old = BENCHMARKS.supportRates.filter((r) => r.campaign !== 2025).map((r) => r.scheme);
        expect(old).toEqual(['protein']);
    });

    it('answers one commodity with its yield and the schemes that list it', () => {
        const peas = benchmarksFor({ commodity: 'peas' });
        expect(peas.yields.map((y) => y.commodity)).toEqual(['peas']);
        expect(peas.supportRates.map((r) => r.scheme)).toContain('protein');
        // Wheat has no coupled scheme; an empty list there is a real answer.
        expect(benchmarksFor({ commodity: 'wheat' }).supportRates).toEqual([]);
        expect(benchmarkCommodities()).toContain('sunflower');
    });
});

describe('what the validator refuses', () => {
    it('a citation naming a source the map does not hold', () => {
        const d = clone();
        d.yields[0].cite.source = 'nowhere';
        expect(() => validateBenchmarks(d)).toThrow(/sources map/);
    });

    it('a commodity listed twice', () => {
        const d = clone();
        d.yields.push({ ...d.yields[0] });
        expect(() => validateBenchmarks(d)).toThrow(/listed twice/);
    });

    it('a scheme listed twice', () => {
        const d = clone();
        d.supportRates.push({ ...d.supportRates[0] });
        expect(() => validateBenchmarks(d)).toThrow(/listed twice/);
    });

    it('an over-30 rate above the first-30 rate', () => {
        const d = clone();
        const r = d.supportRates.find((x: { perHaOver30Stotinki?: number }) => x.perHaOver30Stotinki !== undefined);
        r.perHaOver30Stotinki = r.perHaStotinki + 1;
        expect(() => validateBenchmarks(d)).toThrow(/transposed/);
    });

    it('a fractional amount — money is integer minor units', () => {
        const d = clone();
        d.supportRates[0].perHaStotinki = 1836.07;
        expect(() => validateBenchmarks(d)).toThrow(/malformed/);
    });

    it('accepts the unmodified clone (control)', () => {
        expect(() => validateBenchmarks(clone())).not.toThrow();
    });
});

describe('commodity slugs', () => {
    it('refuses an alias where a canonical slug exists', () => {
        const d = clone();
        const r = d.yields.find((y: { commodity: string }) => y.commodity === 'rapeseed');
        r.commodity = 'canola';
        expect(() => validateBenchmarks(d)).toThrow(/canonical commodity is `rapeseed`/);
    });

    it('accepts a crop the vocabulary does not know (control)', () => {
        expect(benchmarkCommodities()).toContain('chickpeas');
    });
});

describe('the euro figure per decare', () => {
    it('converts a lev rate per hectare at the peg, half up, once', () => {
        // 254,74 лв/ha = 25,474 лв/дка = 13,0247 € → 1302 cents.
        const protein = benchmarksFor({ commodity: 'peas' }).supportRates.find((r) => r.scheme === 'protein');
        expect(protein).toMatchObject({ perHaStotinki: 25474, perDaEurCents: 1302, perDaOver30EurCents: null });
    });

    it('converts the over-30 rate too, and it stays below the first-30 one', () => {
        // A leva order (the 2024 fruit rate, kept here as a fixture since the
        // dataset moved to the 2025 euro order): 1 836,07 лв/ha → 93,88 €/дка;
        // 1 224,06 лв/ha → 62,59 €/дка.
        const fruit = BENCHMARKS.supportRates.find((r) => r.scheme === 'fruit')!;
        const leva = served({ ...fruit, campaign: 2024, currency: 'BGN', perHaStotinki: 183607, perHaOver30Stotinki: 122406 });
        expect(leva).toMatchObject({ perDaEurCents: 9388, perDaOver30EurCents: 6259 });
        // The 2025 euro order: 1 126,54 €/ha → 112,65 €/дка; 751,03 → 75,10.
        expect(benchmarksFor().supportRates.find((r) => r.scheme === 'fruit'))
            .toMatchObject({ perDaEurCents: 11265, perDaOver30EurCents: 7510 });
    });

    it('divides a euro rate without converting it', () => {
        const eur = served({ ...BENCHMARKS.supportRates[0], currency: 'EUR', perHaStotinki: 12345, perHaOver30Stotinki: undefined });
        expect(eur.perDaEurCents).toBe(1235);
        expect(eur.perDaOver30EurCents).toBeNull();
    });
});

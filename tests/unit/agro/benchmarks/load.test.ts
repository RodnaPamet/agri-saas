/**
 * The national yields and support rates dataset (agrent-ios#638): the
 * committed file loads, and the validator refuses the shapes that would
 * otherwise read as working.
 */
import raw from '@/lib/agro/benchmarks/dataset.json';
import { BENCHMARKS, benchmarkCommodities, benchmarksFor, validateBenchmarks } from '@/lib/agro/benchmarks/load';

const clone = () => JSON.parse(JSON.stringify(raw));

describe('the committed dataset', () => {
    it('loads, and every citation resolves to a source', () => {
        expect(BENCHMARKS.yields.length).toBeGreaterThanOrEqual(13);
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
        expect(benchmarkCommodities()).toContain('triticale');
    });
});

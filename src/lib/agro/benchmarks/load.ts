/**
 * Load and VALIDATE the national yields and support rates — agrent-ios#638.
 *
 * Validated once at module load, as the calendar is: a bad merge fails at boot
 * rather than per request. The zod schema catches a malformed entry; the
 * cross-document checks below catch what reads as working:
 *
 *   - a citation naming a source the map does not hold — a figure that looks
 *     sourced and resolves to nothing;
 *   - a commodity or scheme listed twice — the client picks one of two
 *     national averages for the same crop and nothing says which;
 *   - an "over 30 ha" rate HIGHER than the first-30 rate. Every order so far
 *     degresses, so an inversion is a transposed pair, not a policy;
 *   - an ALIAS where the product has a canonical slug (`canola` for
 *     `rapeseed`). Clients join on `commodity-vocabulary`'s canonical values,
 *     so an alias is a figure no crop ever finds. A crop outside that
 *     vocabulary (chickpeas) is fine: it has no slug to clash with.
 */
import { BenchmarksDatasetSchema, type BenchmarksDataset, type BenchmarkYield, type SupportRate } from './schema';
import { perDaEurCents } from '../calendar/costs';
import { assertCanonicalSlug } from '../reference-slugs';
import raw from './dataset.json';

export function validateBenchmarks(input: unknown): BenchmarksDataset {
    const parsed = BenchmarksDatasetSchema.safeParse(input);
    if (!parsed.success) {
        throw new Error(`agro-benchmarks dataset is malformed and will NOT be served: ${parsed.error.message}`);
    }
    const data = parsed.data;

    const unresolved: string[] = [];
    const check = (where: string, source: string) => {
        if (!(source in data.sources)) unresolved.push(`${where} -> ${source}`);
    };

    const commodities = new Set<string>();
    for (const y of data.yields) {
        check(`yield ${y.commodity}`, y.cite.source);
        assertCanonicalSlug('agro-benchmarks', `yield ${y.commodity}`, y.commodity);
        if (commodities.has(y.commodity)) {
            throw new Error(`agro-benchmarks: yield for ${y.commodity} is listed twice`);
        }
        commodities.add(y.commodity);
    }

    const schemes = new Set<string>();
    for (const r of data.supportRates) {
        check(`rate ${r.scheme}`, r.cite.source);
        if (schemes.has(r.scheme)) {
            throw new Error(`agro-benchmarks: support scheme ${r.scheme} is listed twice`);
        }
        schemes.add(r.scheme);
        for (const c of r.commodities ?? []) assertCanonicalSlug('agro-benchmarks', `rate ${r.scheme}`, c);
        if (r.perHaOver30Stotinki !== undefined && r.perHaOver30Stotinki > r.perHaStotinki) {
            throw new Error(
                `agro-benchmarks: ${r.scheme} pays more above 30 ha (${r.perHaOver30Stotinki}) than for the `
                    + `first 30 (${r.perHaStotinki}) — the pair is transposed`,
            );
        }
    }

    if (unresolved.length > 0) {
        throw new Error(
            `agro-benchmarks: ${unresolved.length} citation(s) name a source that is not in the sources map: `
                + unresolved.slice(0, 5).join('; '),
        );
    }
    return data;
}

/** Validated once per process. */
export const BENCHMARKS: BenchmarksDataset = validateBenchmarks(raw);

/** Every commodity with a national yield, for refusing an unknown one. */
export function benchmarkCommodities(): string[] {
    return BENCHMARKS.yields.map((y) => y.commodity);
}

export interface BenchmarksQuery {
    /** One commodity: its yield, and the support schemes that list it. */
    commodity?: string;
}

/**
 * A rate as served: the published figure untouched, plus euro cents per
 * DECARE derived here (owner, 2026-11-17: "convert, mark it", as the vine
 * card). Derived on the server so no client holds the lev peg and no two
 * clients round differently. 1 ha is 10 дка exactly, so the hectare figure
 * goes through the calendar's converter with an area of 10.
 */
export type ServedSupportRate = SupportRate & {
    perDaEurCents: number | null;
    perDaOver30EurCents: number | null;
};

function perDaEur(perHaMinor: number, currency: SupportRate['currency']): number | null {
    if (currency === 'BGN') return perDaEurCents(perHaMinor, 10);
    // Already euro: per hectare to per decare, half up, integer only.
    return Math.floor((2 * perHaMinor + 10) / 20);
}

export function served(rate: SupportRate): ServedSupportRate {
    return {
        ...rate,
        perDaEurCents: perDaEur(rate.perHaStotinki, rate.currency),
        perDaOver30EurCents:
            rate.perHaOver30Stotinki === undefined ? null : perDaEur(rate.perHaOver30Stotinki, rate.currency),
    };
}

/** The yields and rates for a query; everything when none is given. */
export function benchmarksFor(q: BenchmarksQuery = {}): { yields: BenchmarkYield[]; supportRates: ServedSupportRate[] } {
    const rates = q.commodity
        ? BENCHMARKS.supportRates.filter((r) => r.commodities?.includes(q.commodity!))
        : BENCHMARKS.supportRates;
    return {
        yields: q.commodity ? BENCHMARKS.yields.filter((y) => y.commodity === q.commodity) : BENCHMARKS.yields,
        supportRates: rates.map(served),
    };
}

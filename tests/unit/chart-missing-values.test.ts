/**
 * A series with no value at a date must leave a GAP, not plot zero.
 *
 * Two pieces of care cancelled each other out in production. `buildMergedData`
 * goes to real trouble to OMIT a series' key outside its own reporting span,
 * so a feed that stopped reporting visibly stops instead of running flat to
 * today. Then the consumer coerced the absent key:
 *
 *     valueAccessor: (d) => d.values[k] ?? 0
 *
 * which turned "no data" into a real zero. Observed on 2026-08-13: two EC
 * wheat series that stopped on 2026-07-20 plunged from ~190 to 0 at the right
 * edge, and because a genuine 0 enters the domain, the Y axis rendered 0–200
 * for data spanning 175–200 — squashing every real price movement into the top
 * tenth of the chart.
 *
 * `computeYDomain` was already correct (`if (v != null)` at layout.ts). It was
 * never given the chance: the accessor handed it a number.
 */
import { buildMergedData, chartValueAccessor } from '@/components/trends/trends-helpers';
import type { TrendSeries } from '@/components/trends/trends-helpers';
import { computeYDomain } from '@/components/ui/charts/layout';
import type { Data, Series } from '@/components/ui/charts';

function series(stage: string, points: Array<[string, number]>): TrendSeries {
    return {
        source: 'ec-agrifood',
        region: 'BG',
        stage,
        unit: 'EUR/t',
        currency: 'EUR',
        label: 'Breadmaking common wheat',
        lastObservedAt: points.at(-1)?.[0] ?? null,
        points: points.map(([date, price]) => ({ date, price })),
    };
}

describe('chartValueAccessor', () => {
    it('returns undefined for a date the series never reported', () => {
        const d = { date: new Date('2026-08-03'), values: { a: 190 } };
        expect(chartValueAccessor('a')(d)).toBe(190);
        expect(chartValueAccessor('b')(d)).toBeUndefined();
    });

    it('does not turn a missing value into zero', () => {
        // The whole bug in one assertion. `?? 0` here is what produced the
        // cliff and dragged the axis to the floor.
        const d = { date: new Date('2026-08-03'), values: {} };
        expect(chartValueAccessor('gone')(d)).not.toBe(0);
    });

    it('passes a genuine zero through — a real price of 0 is not missing', () => {
        const d = { date: new Date('2026-08-03'), values: { free: 0 } };
        expect(chartValueAccessor('free')(d)).toBe(0);
    });
});

describe('a dead series does not drag the y-axis to zero', () => {
    it('keeps the domain on the live range when one series stops early', () => {
        // The production shape: a series ending 2026-07-20 alongside one that
        // runs to 2026-08-03. Before the fix the domain was [0, …]; the real
        // prices never go near it.
        const group = {
            key: 'BG|EUR|EUR/t',
            region: 'BG',
            currency: 'EUR',
            unit: 'EUR/t',
            series: [
                series('Burgas - DEPPROD', [
                    ['2026-07-06', 186],
                    ['2026-07-20', 191],
                ]),
                series('National Average - Not Specified', [
                    ['2026-07-06', 178],
                    ['2026-07-20', 188],
                    ['2026-08-03', 181],
                ]),
            ],
        };
        const data = buildMergedData(group) as unknown as Data<Record<string, number>>;
        const chartSeries: Series<Record<string, number>>[] = group.series.map((s) => ({
            id: `${s.source}|${s.region}|${s.stage}`,
            isActive: true,
            valueAccessor: chartValueAccessor(`${s.source}|${s.region}|${s.stage}`),
        }));

        const { minY, maxY } = computeYDomain({ data, series: chartSeries, type: 'area' });

        expect(minY).toBe(178);
        expect(maxY).toBe(191);
        // The assertion that actually failed in production.
        expect(minY).not.toBe(0);
    });
});

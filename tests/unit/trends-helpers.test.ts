/**
 * Pure helpers for the Trends Prices tab — grouping by unit, dense chart-data
 * assembly, and stat-tile derivations. No DOM / visx involved.
 */
import {
    groupSeriesByRegionUnit,
    buildMergedData,
    seriesKey,
    sourceLabelKey,
    findEcSeries,
    findListingsSeries,
    findReferenceSeries,
    latestPoint,
    weekOverWeekDelta,
    isEmptyPayload,
    formatPrice,
    formatPriceWithCurrency,
    formatDelta,
    SOURCE_EC,
    SOURCE_AV,
    SOURCE_LISTINGS,
    type TrendSeries,
    isDelayedSource,
    isOwnMarketplaceSource,
    isStale,
    stalenessDays,
    STALE_AFTER_DAYS,
    SOURCE_BARCHART,
} from '@/components/trends/trends-helpers';

const GENERATED_AT = '2026-03-20T09:00:00.000Z';

function ecSeries(
    region: string,
    points: Array<[string, number]>,
    stage: string | null = 'delivered',
): TrendSeries {
    return {
        source: SOURCE_EC,
        region,
        stage,
        unit: 'EUR/t',
        currency: 'EUR',
        label: 'Wheat',
        // Derived from the fixture's own points so a series is never described
        // as having reported later than it did.
        lastObservedAt: points.length > 0 ? points[points.length - 1][0] : null,
        points: points.map(([date, price]) => ({ date, price })),
    };
}

describe('trends-helpers', () => {
    describe('sourceLabelKey', () => {
        it('maps known sources to their i18n keys', () => {
            expect(sourceLabelKey(SOURCE_EC)).toBe('official');
            expect(sourceLabelKey(SOURCE_AV)).toBe('reference');
            expect(sourceLabelKey(SOURCE_LISTINGS)).toBe('listings');
            expect(sourceLabelKey('something-new')).toBe('other');
        });
    });

    describe('groupSeriesByRegionUnit', () => {
        it('never puts different currency/unit series in one group', () => {
            const series: TrendSeries[] = [
                ecSeries('BG', [['2026-01-01', 200]]),
                ecSeries('RO', [['2026-01-01', 190]]),
                {
                    source: SOURCE_LISTINGS,
                    region: 'BG',
                    stage: null,
                    unit: 'BGN/t',
                    currency: 'BGN',
                    label: 'Own-listings median',
                    lastObservedAt: '2026-01-01',
                    points: [{ date: '2026-01-01', price: 380, count: 7 }],
                },
                {
                    source: SOURCE_AV,
                    region: 'GLOBAL',
                    stage: null,
                    unit: 'USD/bu',
                    currency: 'USD',
                    label: 'Reference',
                    lastObservedAt: '2026-01-01',
                    points: [{ date: '2026-01-01', price: 6.2 }],
                },
            ];
            const groups = groupSeriesByRegionUnit(series);
            for (const g of groups) {
                const units = new Set(g.series.map((s) => `${s.currency}|${s.unit}`));
                expect(units.size).toBe(1);
            }
        });

        it('splits same-currency regions into separate per-region charts', () => {
            // BG and EL are BOTH EUR/t now (Bulgaria's euro adoption), but must
            // still render as two charts, not one merged EUR/t chart.
            const groups = groupSeriesByRegionUnit([
                ecSeries('BG', [['2026-01-01', 512]]),
                ecSeries('EL', [['2026-01-01', 400]]),
            ]);
            expect(groups).toHaveLength(2);
            expect(groups.map((g) => g.region).sort()).toEqual(['BG', 'EL']);
            expect(groups.every((g) => g.series.length === 1)).toBe(true);
        });

        it('overlays a region’s own stages in one group', () => {
            // Same region + currency + unit, two stages → one chart, two lines.
            const groups = groupSeriesByRegionUnit([
                ecSeries('BG', [['2026-01-01', 512]], 'FGATE'),
                ecSeries('BG', [['2026-01-01', 505]], 'Not Defined'),
            ]);
            expect(groups).toHaveLength(1);
            expect(groups[0].series).toHaveLength(2);
        });

        it('drops series with no points', () => {
            const groups = groupSeriesByRegionUnit([ecSeries('BG', [])]);
            expect(groups).toHaveLength(0);
        });
    });

    describe('buildMergedData', () => {
        it('does NOT back-fill before a series first reported', () => {
            // Two stages of the same region (a real in-group overlay), the
            // second starting a week later.
            const group = groupSeriesByRegionUnit([
                ecSeries(
                    'BG',
                    [
                        ['2026-01-01', 200],
                        ['2026-01-08', 210],
                    ],
                    'FGATE',
                ),
                ecSeries('BG', [['2026-01-08', 195]], 'DEPSILO'),
            ])[0];
            const rows = buildMergedData(group);
            expect(rows).toHaveLength(2);
            const aKey = seriesKey({ source: SOURCE_EC, region: 'BG', stage: 'FGATE' });
            const bKey = seriesKey({ source: SOURCE_EC, region: 'BG', stage: 'DEPSILO' });

            // The late-starting stage has NOTHING to say about 01-01. It used
            // to be back-filled with its first-known price, drawing a flat line
            // across a week it never reported — a fabricated observation that
            // looks identical to a real one. The line must simply start later.
            expect(rows[0].values[bKey]).toBeUndefined();
            expect(rows[0].values[aKey]).toBe(200);
            expect(rows[1].values[bKey]).toBe(195);
            expect(rows[1].values[aKey]).toBe(210);
        });

        it('ends a dead series at its last observation instead of running it to today', () => {
            // One series stops reporting; the other keeps going. The dead one
            // used to be forward-filled to the newest date ANY series in the
            // group reported, so a feed that went silent in January rendered as
            // a confident flat line through March.
            const group = groupSeriesByRegionUnit([
                ecSeries(
                    'BG',
                    [
                        ['2026-01-01', 200],
                        ['2026-02-01', 205],
                        ['2026-03-01', 210],
                    ],
                    'FGATE',
                ),
                ecSeries('BG', [['2026-01-01', 195]], 'DEPSILO'),
            ])[0];
            const rows = buildMergedData(group);
            const liveKey = seriesKey({ source: SOURCE_EC, region: 'BG', stage: 'FGATE' });
            const deadKey = seriesKey({ source: SOURCE_EC, region: 'BG', stage: 'DEPSILO' });

            expect(rows[0].values[deadKey]).toBe(195);
            expect(rows[1].values[deadKey]).toBeUndefined();
            expect(rows[2].values[deadKey]).toBeUndefined();
            // The live series is unaffected.
            expect(rows[2].values[liveKey]).toBe(210);
        });

        it('forward-fills a mid-series gap instead of dipping to zero', () => {
            const group = groupSeriesByRegionUnit([
                ecSeries(
                    'BG',
                    [
                        ['2026-01-01', 200],
                        ['2026-01-15', 220],
                    ],
                    'FGATE',
                ),
                ecSeries(
                    'BG',
                    [
                        ['2026-01-01', 190],
                        ['2026-01-08', 195], // the FGATE stage has no 01-08 point
                        ['2026-01-15', 205],
                    ],
                    'DEPSILO',
                ),
            ])[0];
            const rows = buildMergedData(group);
            const aKey = seriesKey({ source: SOURCE_EC, region: 'BG', stage: 'FGATE' });
            const midRow = rows.find((r) => r.date.getTime() === Date.parse('2026-01-08T00:00:00Z'));
            expect(midRow?.values[aKey]).toBe(200); // carried forward, not 0
        });
    });

    describe('formatPriceWithCurrency', () => {
        it('appends the ISO currency', () => {
            expect(formatPriceWithCurrency(512, 'EUR')).toBe('512 EUR');
            expect(formatPriceWithCurrency(512.5, 'EUR')).toBe('512.50 EUR');
        });
        it('omits the suffix when currency is empty', () => {
            expect(formatPriceWithCurrency(512, '')).toBe('512');
        });
    });

    describe('stat-tile derivations', () => {
        const series: TrendSeries[] = [
            ecSeries('BG', [
                ['2026-01-01', 200],
                ['2026-01-10', 212],
            ]),
            {
                source: SOURCE_LISTINGS,
                region: 'BG',
                stage: null,
                unit: 'BGN/t',
                currency: 'BGN',
                label: 'Own-listings median',
                lastObservedAt: '2026-01-10',
                points: [{ date: '2026-01-10', price: 400, count: 9 }],
            },
        ];

        it('finds the BG official + listings series', () => {
            expect(findEcSeries(series, 'BG')?.region).toBe('BG');
            expect(findListingsSeries(series)?.source).toBe(SOURCE_LISTINGS);
            expect(findReferenceSeries(series)).toBeNull();
        });

        it('latestPoint returns the most recent point', () => {
            expect(latestPoint(series[0])?.price).toBe(212);
            expect(latestPoint(series[1])?.count).toBe(9);
        });

        it('weekOverWeekDelta compares against a point >=5 days back', () => {
            expect(weekOverWeekDelta(series[0])).toBe(12); // 212 - 200
        });

        it('weekOverWeekDelta is null with fewer than two points', () => {
            expect(weekOverWeekDelta(series[1])).toBeNull();
        });
    });

    describe('formatting + emptiness', () => {
        it('formatPrice trims integer vs decimal', () => {
            expect(formatPrice(200)).toBe('200');
            expect(formatPrice(212.5)).toBe('212.50');
        });

        it('formatDelta carries a sign', () => {
            expect(formatDelta(12)).toBe('+12.00');
            expect(formatDelta(-3.2)).toBe('−3.20');
        });

        it('isEmptyPayload is true only when no series has points', () => {
            expect(isEmptyPayload(undefined)).toBe(false);
            expect(
                isEmptyPayload({ commodity: 'wheat', range: '3m', generatedAt: GENERATED_AT, series: [] }),
            ).toBe(true);
            expect(
                isEmptyPayload({
                    commodity: 'wheat',
                    range: '3m',
                    generatedAt: GENERATED_AT,
                    series: [ecSeries('BG', [])],
                }),
            ).toBe(true);
            expect(
                isEmptyPayload({
                    commodity: 'wheat',
                    range: '3m',
                    generatedAt: GENERATED_AT,
                    series: [ecSeries('BG', [['2026-01-01', 200]])],
                }),
            ).toBe(false);
        });
    });
});

describe('provenance helpers', () => {
    it('names Barchart as futures instead of collapsing it to "other"', () => {
        // The pull already computes 'Futures (Barchart, delayed)' and ships it
        // as TrendSeries.label; the vocabulary just had no case for it, so a
        // licensed exchange feed rendered as "Other source".
        expect(sourceLabelKey(SOURCE_BARCHART)).toBe('futures');
        expect(sourceLabelKey('something-new')).toBe('other');
    });

    it('flags Barchart as delayed and listings as our own noticeboard', () => {
        // Both disclosures are load-bearing: the first is a licence term, the
        // second stops asking prices reading as market quotes.
        expect(isDelayedSource(SOURCE_BARCHART)).toBe(true);
        expect(isDelayedSource(SOURCE_LISTINGS)).toBe(false);
        expect(isOwnMarketplaceSource(SOURCE_LISTINGS)).toBe(true);
        expect(isOwnMarketplaceSource(SOURCE_BARCHART)).toBe(false);
    });

    it('measures staleness in whole days against the payload timestamp', () => {
        const generatedAt = '2026-03-20T09:00:00.000Z';
        expect(stalenessDays({ lastObservedAt: '2026-03-20' }, generatedAt)).toBe(0);
        expect(stalenessDays({ lastObservedAt: '2026-03-13' }, generatedAt)).toBe(7);
        expect(stalenessDays({ lastObservedAt: null }, generatedAt)).toBeNull();
    });

    it('tolerates one missed weekly publication but flags two', () => {
        // The pull is weekly, so a single late publication is routine — a
        // warning that fires every time the feed slips a day is a warning
        // nobody reads.
        const generatedAt = '2026-03-20T09:00:00.000Z';
        const daysAgo = (n: number) =>
            new Date(Date.UTC(2026, 2, 20) - n * 86_400_000).toISOString().slice(0, 10);

        expect(isStale({ lastObservedAt: daysAgo(8) }, generatedAt)).toBe(false);
        expect(isStale({ lastObservedAt: daysAgo(STALE_AFTER_DAYS) }, generatedAt)).toBe(false);
        expect(isStale({ lastObservedAt: daysAgo(STALE_AFTER_DAYS + 1) }, generatedAt)).toBe(true);
        // Never reported at all is "unknown", not "stale".
        expect(isStale({ lastObservedAt: null }, generatedAt)).toBe(false);
    });
});

describe('findEcSeries stage pinning', () => {
    it('prefers ex-farm over an alphabetically earlier stage', () => {
        // DEPPORT sorts before FGATE, and the DB query orders by stage asc, so
        // the headline tile used to silently show a delivered-to-port price —
        // materially different from what a farmer receives at the gate.
        const chosen = findEcSeries([
            ecSeries('BG', [['2026-01-01', 200]], 'DEPPORT'),
            ecSeries('BG', [['2026-01-01', 180]], 'FGATE'),
        ]);
        expect(chosen?.stage).toBe('FGATE');
    });

    it('is deterministic for stages it does not know', () => {
        const input = [
            ecSeries('BG', [['2026-01-01', 200]], 'ZULU'),
            ecSeries('BG', [['2026-01-01', 180]], 'ALPHA'),
        ];
        expect(findEcSeries(input)?.stage).toBe('ALPHA');
        expect(findEcSeries([...input].reverse())?.stage).toBe('ALPHA');
    });
});

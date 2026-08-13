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
    staleAfterDaysForSource,
    SOURCE_BARCHART,
    SOURCE_MANUAL,
    SOURCE_OIL_BULLETIN,
    SOURCE_WORLD_BANK,
    firstInterestedCommodity,
    selectPrimaryGroup,
    leadSeriesOf,
    chartSeriesFor,
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

    it('tolerates lateness up to the source’s own bound and flags past it', () => {
        // A warning that fires every time a feed slips a day is a warning
        // nobody reads. The BOUNDARY is what this pins; which number the
        // boundary sits at is a per-source property, asked for rather than
        // restated — EC's moved from the generic 15 to 25 once the chart
        // switched to the national average, which trails by a cycle.
        const generatedAt = '2026-03-20T09:00:00.000Z';
        const daysAgo = (n: number) =>
            new Date(Date.UTC(2026, 2, 20) - n * 86_400_000).toISOString().slice(0, 10);

        const ec = (lastObservedAt: string | null) => ({ lastObservedAt, source: SOURCE_EC });
        const bound = staleAfterDaysForSource(SOURCE_EC);
        expect(isStale(ec(daysAgo(8)), generatedAt)).toBe(false);
        expect(isStale(ec(daysAgo(bound)), generatedAt)).toBe(false);
        expect(isStale(ec(daysAgo(bound + 1)), generatedAt)).toBe(true);
        // Never reported at all is "unknown", not "stale".
        expect(isStale(ec(null), generatedAt)).toBe(false);
    });

    // Break: a false alarm on EVERY view. The World Bank feed is MONTHLY with
    // a ~1-month publication lag, so a urea point is 30-60 days old at all
    // times — under the weekly bound it would render permanently orange, which
    // is how a warning stops being read at all.
    it('judges a monthly source by its own cadence, not the weekly one', () => {
        const generatedAt = '2026-03-20T09:00:00.000Z';
        const daysAgo = (n: number) =>
            new Date(Date.UTC(2026, 2, 20) - n * 86_400_000).toISOString().slice(0, 10);

        const wb = (n: number) => ({ lastObservedAt: daysAgo(n), source: 'world-bank' });
        expect(isStale(wb(45), generatedAt)).toBe(false); // routine for monthly data
        expect(isStale(wb(76), generatedAt)).toBe(true); // two cycles missed
        expect(staleAfterDaysForSource('world-bank')).toBeGreaterThan(STALE_AFTER_DAYS);
    });

    it('does not nag about a hand-entered series, whose age is already stated', () => {
        const generatedAt = '2026-03-20T09:00:00.000Z';
        const daysAgo = (n: number) =>
            new Date(Date.UTC(2026, 2, 20) - n * 86_400_000).toISOString().slice(0, 10);
        expect(isStale({ lastObservedAt: daysAgo(120), source: 'manual' }, generatedAt)).toBe(false);
    });

    it('falls back to the weekly bound for a source it does not know', () => {
        expect(staleAfterDaysForSource('some-future-feed')).toBe(STALE_AFTER_DAYS);
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

/**
 * A warning that fires on every view is not a warning.
 *
 * `STALE_AFTER_DAYS_BY_SOURCE` exists because 15 days — two weekly cycles —
 * is meaningless for a monthly feed. World Bank and manual got exemptions.
 * Alpha Vantage, which is the SAME monthly IMF cadence (its commodity
 * endpoints are a FRED/IMF passthrough), was missed: on 2026-08-13 its newest
 * observation was 73 days old and its tile had been amber continuously.
 *
 * And EC's bound became too tight when the chart switched to the national
 * average (#550/#551): the country-wide row trails its own per-market rows by
 * a week, so the displayed series carries a full extra cycle of lag under a
 * threshold written for the per-market ones.
 *
 * Ages below are measured against real production data on 2026-08-13.
 */
describe('staleness bounds match each source’s real cadence', () => {
    const GENERATED = '2026-08-13T12:00:00.000Z';
    const at = (source: string, lastObservedAt: string) => ({ source, lastObservedAt });

    it('does not cry wolf over the monthly Alpha Vantage reference', () => {
        // Newest AV observation on the day: 2026-06-01 → 73 days. The series
        // is monthly with a ~6-week publication lag, so it can never be
        // fresher than about 45 days and was permanently orange.
        expect(isStale(at(SOURCE_AV, '2026-06-01'), GENERATED)).toBe(false);
    });

    it('still calls a genuinely dead Alpha Vantage feed stale', () => {
        // The bound has to stay a bound. Two missed monthly publications on
        // top of the normal lag is a real outage.
        expect(isStale(at(SOURCE_AV, '2026-04-01'), GENERATED)).toBe(true);
    });

    it('does not cry wolf over EC’s national average, which trails by a week', () => {
        // 2026-07-27 → 17 days. EC's per-market rows were at 2026-08-03 the
        // same day; the country-wide row is simply one cycle behind.
        expect(isStale(at(SOURCE_EC, '2026-07-27'), GENERATED)).toBe(false);
    });

    it('still calls a genuinely dead EC feed stale', () => {
        // The nine orphaned per-market series stopped on 2026-07-20 and never
        // resumed. A month of silence on a weekly feed is real.
        expect(isStale(at(SOURCE_EC, '2026-07-06'), GENERATED)).toBe(true);
    });

    it('leaves the weekly own-listings bound alone', () => {
        // Our own noticeboard publishes weekly with no lag — nothing about
        // this change should loosen it.
        expect(staleAfterDaysForSource(SOURCE_LISTINGS)).toBe(STALE_AFTER_DAYS);
        expect(isStale(at(SOURCE_LISTINGS, '2026-07-27'), GENERATED)).toBe(true);
    });

    it('orders the bounds by cadence — weekly tightest, monthly loosest', () => {
        // Guards against someone "simplifying" them back to one number.
        expect(staleAfterDaysForSource(SOURCE_LISTINGS)).toBeLessThan(
            staleAfterDaysForSource(SOURCE_EC),
        );
        expect(staleAfterDaysForSource(SOURCE_EC)).toBeLessThan(
            staleAfterDaysForSource(SOURCE_WORLD_BANK),
        );
        expect(staleAfterDaysForSource(SOURCE_WORLD_BANK)).toBeLessThan(
            staleAfterDaysForSource(SOURCE_AV),
        );
    });
});

describe('firstInterestedCommodity', () => {
    it('resolves a stated interest to the commodity Prices should open on', () => {
        // UserInterest persisted and synced across devices, but its only
        // consumer was the news For-You filter — so a farmer who told us they
        // grow sunflower still landed on wheat every time.
        expect(firstInterestedCommodity(['sunflower'])).toBe('sunflower');
        expect(firstInterestedCommodity(['Barley'])).toBe('barley');
    });

    it('reuses the canonical vocabulary, so Bulgarian keywords work', () => {
        // The keywords are free text typed for news filtering; someone who
        // typed пшеница means the wheat series.
        expect(firstInterestedCommodity(['пшеница'])).toBe('wheat');
        expect(firstInterestedCommodity(['царевица'])).toBe('maize');
    });

    it('skips interests that are real but not tradeable commodities', () => {
        // "subsidies" is a legitimate news interest and not something the
        // Prices tab can open on.
        expect(firstInterestedCommodity(['subsidies', 'weather', 'maize'])).toBe('maize');
    });

    it('ignores commodities with no price series', () => {
        // Lentils are in the exchange vocabulary but have no TrendCommodity
        // series — opening on them would show an empty chart.
        expect(firstInterestedCommodity(['lentils'])).toBeNull();
    });

    it('returns null for no interests, so the caller keeps its default', () => {
        expect(firstInterestedCommodity([])).toBeNull();
        expect(firstInterestedCommodity(undefined)).toBeNull();
        expect(firstInterestedCommodity(['nonsense'])).toBeNull();
    });
});

/**
 * The tab renders ONE chart, and this is what picks it.
 *
 * Before this, every (region, currency, unit) group got its own card — and the
 * pull job fetches EC prices for BG, RO, EL and EU, all of them EUR/t since
 * Bulgaria's euro adoption. So wheat drew four near-identical cards, three of
 * them about countries a Bulgarian operator is not paid in.
 */
describe('selectPrimaryGroup', () => {
    /** A non-EC series in an arbitrary region, for the fallback cases. */
    function otherSeries(
        source: string,
        region: string,
        unit: string,
        currency: string,
        points: Array<[string, number]>,
    ): TrendSeries {
        return {
            source,
            region,
            stage: null,
            unit,
            currency,
            label: source,
            lastObservedAt: points.length > 0 ? points[points.length - 1][0] : null,
            points: points.map(([date, price]) => ({ date, price })),
        };
    }

    it('prefers Bulgaria over every other member state', () => {
        // The whole point: RO and EL are noise for a Bulgarian farmer, and EU
        // is an average rather than the market they sell into.
        const groups = groupSeriesByRegionUnit([
            ecSeries('EU', [['2026-01-01', 205]]),
            ecSeries('RO', [['2026-01-01', 190]]),
            ecSeries('BG', [['2026-01-01', 512]]),
            ecSeries('EL', [['2026-01-01', 400]]),
        ]);
        expect(selectPrimaryGroup(groups)?.region).toBe('BG');
    });

    it('falls back to the EU average when Bulgaria has no data', () => {
        const groups = groupSeriesByRegionUnit([
            ecSeries('RO', [['2026-01-01', 190]]),
            ecSeries('EU', [['2026-01-01', 205]]),
            ecSeries('EL', [['2026-01-01', 400]]),
        ]);
        expect(selectPrimaryGroup(groups)?.region).toBe('EU');
    });

    it('falls back to the most recently observed group when neither exists', () => {
        // Fertilizer is World Bank region GLOBAL and nothing else — without
        // this arm the tab would render no chart at all for urea.
        const groups = groupSeriesByRegionUnit([
            otherSeries(SOURCE_WORLD_BANK, 'GLOBAL', 'USD/t', 'USD', [
                ['2026-01-01', 340],
                ['2026-02-01', 355],
            ]),
            otherSeries(SOURCE_MANUAL, 'XX', 'BGN/t', 'BGN', [['2025-06-01', 900]]),
        ]);
        expect(selectPrimaryGroup(groups)?.region).toBe('GLOBAL');
    });

    it('returns null when there is nothing to draw', () => {
        expect(selectPrimaryGroup([])).toBeNull();
    });

    it('never leads with our own noticeboard when a real quote exists', () => {
        // A region can hold two groups — EC in EUR/t and the own-listings
        // median in BGN/t are both region BG. Taking "the first BG group"
        // would resolve on backend ordering, and the losing outcome is the
        // page presenting the median of our own users' ASKING prices as the
        // official price. Order-independent by construction.
        const ec = ecSeries('BG', [['2026-01-10', 212]]);
        const listings = otherSeries(SOURCE_LISTINGS, 'BG', 'BGN/t', 'BGN', [
            ['2026-01-10', 400],
        ]);
        expect(selectPrimaryGroup(groupSeriesByRegionUnit([ec, listings]))?.unit).toBe('EUR/t');
        expect(selectPrimaryGroup(groupSeriesByRegionUnit([listings, ec]))?.unit).toBe('EUR/t');
    });

    it('still draws the noticeboard when it is the only thing there is', () => {
        const groups = groupSeriesByRegionUnit([
            otherSeries(SOURCE_LISTINGS, 'BG', 'BGN/t', 'BGN', [['2026-01-10', 400]]),
        ]);
        expect(selectPrimaryGroup(groups)?.unit).toBe('BGN/t');
    });

    it('keeps both diesel tax stages on the one chart it picks', () => {
        // with-tax and without-tax are the SAME (region, currency, unit) and
        // genuinely different numbers — narrowing to one CARD must not narrow
        // to one LINE.
        const groups = groupSeriesByRegionUnit([
            otherSeries(SOURCE_OIL_BULLETIN, 'BG', 'EUR/1000l', 'EUR', [['2026-01-05', 1820]]),
            {
                ...otherSeries(SOURCE_OIL_BULLETIN, 'BG', 'EUR/1000l', 'EUR', [
                    ['2026-01-05', 1490],
                ]),
                stage: 'without-tax',
            },
            otherSeries(SOURCE_OIL_BULLETIN, 'RO', 'EUR/1000l', 'EUR', [['2026-01-05', 1750]]),
        ]);
        const chosen = selectPrimaryGroup(groups);
        expect(chosen?.region).toBe('BG');
        expect(chosen?.series).toHaveLength(2);
    });
});

/**
 * How many LINES the one chart draws.
 *
 * Narrowing to one CARD was not the whole job. EC publishes wheat per market
 * — Burgas, Plovdiv, Varna, Ruse, Dobrich… — and the pull keys series on
 * stageName while dropping marketName, so a single (BG, EUR, EUR/t) group
 * held TWELVE series in production: one National Average, nine per-market
 * rows under EC's old stage naming, and two under its new naming. The card
 * count was 1 and the line count was 12.
 *
 * Ten of those twelve were dead ends. EC moved the market out of `stageName`
 * (`"Burgas - DEPPROD"` → `"Departure from farm…"` + `marketName: "Burgas"`),
 * which changed the series key, so the old rows stopped receiving points and
 * flatline at their last pre-change observation while the new ones carry on.
 */
describe('chartSeriesFor', () => {
    function ec(stage: string, points: Array<[string, number]>, label = 'Breadmaking common wheat') {
        return { ...ecSeries('BG', points, stage), label };
    }

    it('draws only the National Average when EC publishes one', () => {
        // The nine per-market rows measure THE SAME quantity in different
        // places; the national average is the answer to "what is wheat worth
        // in Bulgaria". Overlaying all ten says nothing the one line does not.
        const group = groupSeriesByRegionUnit([
            ec('Burgas - DEPPROD', [['2026-07-20', 191]]),
            ec('Plovdiv - DEPPROD', [['2026-07-20', 188]]),
            ec('National Average - Not Specified', [['2026-07-27', 190]]),
            ec('Departure from farm or from production area', [['2026-08-03', 193]], 'BLTPAN|PAN'),
        ])[0];
        const drawn = chartSeriesFor(group);
        expect(drawn).toHaveLength(1);
        expect(drawn[0].stage).toBe('National Average - Not Specified');
    });

    it('falls back to the freshest EC series when no national average exists', () => {
        // EC restructures its vocabulary — it just did. If the national
        // average disappears, one live line beats twelve overlapping ones,
        // and the freshest is the only defensible choice among equivalents.
        const group = groupSeriesByRegionUnit([
            ec('Burgas - DEPPROD', [['2026-07-20', 191]]),
            ec('Departure from farm or from production area', [['2026-08-03', 193]], 'BLTPAN|PAN'),
        ])[0];
        const drawn = chartSeriesFor(group);
        expect(drawn).toHaveLength(1);
        expect(drawn[0].stage).toBe('Departure from farm or from production area');
    });

    it('keeps every line for a non-EC group', () => {
        // Diesel's with-tax and without-tax are DIFFERENT quantities and both
        // are wanted. Collapsing by count rather than by source would have
        // silently dropped one of them.
        const withTax: TrendSeries = {
            source: SOURCE_OIL_BULLETIN,
            region: 'BG',
            stage: 'with-tax',
            unit: 'EUR/1000l',
            currency: 'EUR',
            label: 'diesel',
            lastObservedAt: '2026-08-10',
            points: [{ date: '2026-08-10', price: 1820 }],
        };
        const withoutTax: TrendSeries = { ...withTax, stage: 'without-tax', points: [{ date: '2026-08-10', price: 1490 }] };
        const group = groupSeriesByRegionUnit([withTax, withoutTax])[0];
        expect(chartSeriesFor(group)).toHaveLength(2);
    });

    it('is a no-op on a single-series group', () => {
        const group = groupSeriesByRegionUnit([ec('National Average - Not Specified', [['2026-07-27', 190]])])[0];
        expect(chartSeriesFor(group)).toHaveLength(1);
    });

    it('matches the national average however EC cases or pads the stage', () => {
        // The stage text is EC's, not ours, and they have already renamed it
        // once. Matching a literal would break on the next rename.
        for (const stage of ['National Average - Not Specified', 'national average', '  National Average  ']) {
            const group = groupSeriesByRegionUnit([
                ec('Burgas - DEPPROD', [['2026-08-03', 191]]),
                ec(stage, [['2026-07-27', 190]]),
            ])[0];
            expect(chartSeriesFor(group)).toHaveLength(1);
            expect(chartSeriesFor(group)[0].stage).toBe(stage);
        }
    });
});

/**
 * The headline tile reads THIS, so it can never disagree with the chart.
 *
 * It used to read `findEcSeries(series, 'BG')` with the region hard-coded,
 * which the moment the chart falls back to EU would print "no data" directly
 * above a populated line.
 */
describe('leadSeriesOf', () => {
    it('applies the EC stage preference inside the chosen group', () => {
        const groups = groupSeriesByRegionUnit([
            ecSeries('BG', [['2026-01-01', 200]], 'DEPPORT'),
            ecSeries('BG', [['2026-01-01', 180]], 'FGATE'),
        ]);
        expect(leadSeriesOf(groups[0]).stage).toBe('FGATE');
    });

    it('takes the most recently observed series when the group is not EC', () => {
        const stale: TrendSeries = {
            source: SOURCE_OIL_BULLETIN,
            region: 'BG',
            stage: 'with-tax',
            unit: 'EUR/1000l',
            currency: 'EUR',
            label: 'diesel',
            lastObservedAt: '2025-11-01',
            points: [{ date: '2025-11-01', price: 1700 }],
        };
        const fresh: TrendSeries = {
            ...stale,
            stage: 'without-tax',
            lastObservedAt: '2026-01-05',
            points: [{ date: '2026-01-05', price: 1490 }],
        };
        const groups = groupSeriesByRegionUnit([stale, fresh]);
        expect(leadSeriesOf(groups[0]).stage).toBe('without-tax');
    });
});

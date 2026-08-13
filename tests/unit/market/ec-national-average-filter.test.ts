/**
 * What the EC pull is allowed to store.
 *
 * EC publishes cereals PER MARKET — Burgas, Plovdiv, Varna, Ruse, Dobrich,
 * Pleven, Stara Zagora — alongside a country-wide "National Average" row. The
 * job keys a series on stageName and DROPS marketName, so ingesting everything
 * produced twelve series in one Bulgarian wheat chart group: the national
 * average, nine per-market rows under EC's old stage naming, and two under its
 * new naming that are silently a median across seven markets.
 *
 * Only the national average is ever charted, so only the national average is
 * worth storing. The fallback below is the load-bearing part: EC restructures
 * its vocabulary — it did exactly that shortly before 2026-08-10, which is
 * what orphaned the nine — so a filter that can return NOTHING would turn a
 * rename into a silent, total loss of a commodity.
 */
import { nationalAverageOnly } from '@/app-layer/jobs/market-prices-pull';
import type { EcObservation } from '@/lib/market/ec-agrifood-client';

function obs(
    region: string,
    market: string | null,
    stage: string | null,
    price = 190,
): EcObservation {
    return {
        memberStateCode: region,
        productName: 'Breadmaking common wheat',
        stage,
        market,
        beginDate: '03/08/2026',
        price,
        unit: 'EUR/t',
        currency: 'EUR',
    };
}

describe('nationalAverageOnly', () => {
    it('drops the per-market rows when a national average exists', () => {
        const kept = nationalAverageOnly([
            obs('BG', 'Burgas', 'Departure from farm or from production area', 191),
            obs('BG', 'Plovdiv', 'Departure from farm or from production area', 188),
            obs('BG', 'National Average', 'National Average - Not Specified', 190),
        ]);
        expect(kept).toHaveLength(1);
        expect(kept[0].market).toBe('National Average');
    });

    it('keeps everything for a region that has no national average', () => {
        // Sunflower comes from the oilseeds endpoint, which publishes no
        // country-wide row at all. Returning nothing here would delete the
        // sunflower feed outright.
        const kept = nationalAverageOnly([
            obs('BG', 'Dobrich', 'FGATE', 512),
            obs('BG', 'Varna', 'DEPSILO', 505),
        ]);
        expect(kept).toHaveLength(2);
    });

    it('decides per region, not for the whole payload', () => {
        // One request covers BG, RO, EL and EU. A region with a national
        // average must not cause a region without one to be emptied, and vice
        // versa — EC coverage genuinely differs by member state.
        const kept = nationalAverageOnly([
            obs('BG', 'National Average', 'National Average - Not Specified'),
            obs('BG', 'Burgas', 'Departure from farm'),
            obs('EL', 'Ioannina', 'FGATE'),
            obs('EL', 'Boetia', 'FGATE'),
        ]);
        expect(kept.filter((o) => o.memberStateCode === 'BG')).toHaveLength(1);
        expect(kept.filter((o) => o.memberStateCode === 'EL')).toHaveLength(2);
    });

    it('recognises the country-wide row from the market OR the stage', () => {
        // EC has already moved this text once. Reading both fields, loosely,
        // survives it moving again.
        expect(nationalAverageOnly([
            obs('BG', 'Burgas', 'Departure from farm'),
            obs('BG', 'National Average', null),
        ])).toHaveLength(1);
        expect(nationalAverageOnly([
            obs('BG', 'Burgas', 'Departure from farm'),
            obs('BG', null, 'national average - not specified'),
        ])).toHaveLength(1);
    });

    it('keeps every date of the national-average series, not just one row', () => {
        // The filter selects SERIES, not observations — dropping history would
        // be a far worse bug than the noise it is removing.
        const weeks = ['06/07/2026', '13/07/2026', '20/07/2026', '27/07/2026'].map((d) => ({
            ...obs('BG', 'National Average', 'National Average - Not Specified'),
            beginDate: d,
        }));
        const kept = nationalAverageOnly([...weeks, obs('BG', 'Burgas', 'Departure from farm')]);
        expect(kept).toHaveLength(4);
    });

    it('is a no-op on an empty payload', () => {
        expect(nationalAverageOnly([])).toEqual([]);
    });
});

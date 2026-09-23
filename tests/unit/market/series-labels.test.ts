/**
 * Market series labels, localised at READ time.
 *
 * Three properties carry weight here, and none is visible from the map:
 *
 *  • **Codes and prose for one instrument resolve to ONE name.** The EC feed
 *    puts `Breadmaking common wheat` in `productName` for some rows and the
 *    raw code `BLTPAN|PAN` for others. A farmer must not see two different
 *    names for the same thing depending on which row the feed sent.
 *
 *  • **Unknown labels pass through.** A commodity or grade the feed adds
 *    later shows the feed's own words, not a blank and not a dotted key.
 *
 *  • **A missing message falls back to the feed's words, not to the key.**
 *    `translateFor` returns the KEY on a miss — a plausible-looking non-empty
 *    string — so the naive implementation ships `trends.seriesLabel.dap`
 *    onto a chart and every "is it non-empty" assertion passes.
 */
import { localiseSeriesLabel, KNOWN_SERIES_LABELS } from '@/lib/market/series-labels';

describe('localising a series label', () => {
    it('translates the feed prose', async () => {
        expect(await localiseSeriesLabel('Breadmaking common wheat', 'bg')).toBe('Хлебна пшеница');
        expect(await localiseSeriesLabel('Feed barley', 'bg')).toBe('Фуражен ечемик');
    });

    it('gives a CODE the same name as its prose sibling', async () => {
        // BLTPAN / MAI / ORGFOUR are our own product codes, documented on
        // EC_PRODUCT_CODES. Two names for one instrument would be worse than
        // the English.
        for (const [code, prose] of [
            ['BLTPAN|PAN', 'Breadmaking common wheat'],
            ['MAI|FEED', 'Feed maize'],
            ['ORGFOUR|FEED', 'Feed barley'],
        ] as const) {
            expect(await localiseSeriesLabel(code, 'bg')).toBe(
                await localiseSeriesLabel(prose, 'bg'),
            );
        }
    });

    it('keeps the two diesel tax bases distinct', async () => {
        // Measured 639.68 EUR/1000l apart on production. Collapsing them to
        // one "diesel" would put a fuel budget out by half.
        const excl = await localiseSeriesLabel('Automotive gas oil (excluding duties and taxes)', 'bg');
        const incl = await localiseSeriesLabel('Automotive gas oil (with duties and taxes)', 'bg');
        expect(excl).not.toBe(incl);
        expect(excl).toMatch(/без/);
        expect(incl).toMatch(/с /);
    });

    it('translates labels WE authored, not just the feed’s', async () => {
        // `Reference (Alpha Vantage)` is written by market-prices-pull.ts in
        // English — the same class of defect as the journal titles (#1073),
        // hiding in a field that looks like it belongs to the feed.
        const bg = await localiseSeriesLabel('Reference (Alpha Vantage)', 'bg');
        expect(bg).not.toBe('Reference (Alpha Vantage)');
        expect(bg).toMatch(/[А-Яа-я]/);
    });

    it('passes an unknown label through unchanged', async () => {
        expect(await localiseSeriesLabel('Durum wheat, milling', 'bg')).toBe('Durum wheat, milling');
    });

    it('leaves a delivery-point sentence alone', async () => {
        // Deliberately not in the table: stages are sentences, not a
        // vocabulary, and a table that swallows sentences rots.
        const stage = 'Departure from farm or from production area - on truck or other transport means';
        expect(await localiseSeriesLabel(stage, 'bg')).toBe(stage);
    });

    it('null in, null out', async () => {
        // A series with no label is a real state; "null" on a chart is not.
        expect(await localiseSeriesLabel(null, 'bg')).toBeNull();
        expect(await localiseSeriesLabel(undefined, 'bg')).toBeNull();
    });

    it('trims before matching', async () => {
        expect(await localiseSeriesLabel('  Feed maize  ', 'bg')).toBe('Фуражна царевица');
    });

    it('renders English for an English reader', async () => {
        expect(await localiseSeriesLabel('Feed maize', 'en')).toBe('Feed maize');
    });
});

describe('every known label resolves in BOTH locales', () => {
    // The coverage check. A key added to the map but not to `messages/`
    // would otherwise ship the dotted key onto a chart, and the fallback
    // hides it as the feed's own words — correct behaviour, but it would
    // mean the translation silently did nothing.
    it.each(KNOWN_SERIES_LABELS)('%s', async (label) => {
        for (const locale of ['bg', 'en'] as const) {
            const out = await localiseSeriesLabel(label, locale);
            expect(out).toBeTruthy();
            expect(out).not.toMatch(/^trends\.seriesLabel\./);
        }
        // And bg must actually differ from the raw feed string, or the entry
        // is in the map for nothing.
        expect(await localiseSeriesLabel(label, 'bg')).not.toBe(label);
    });
});

describe('the miss branch — when NO locale has the message', () => {
    /**
     * Unreachable by mutating a message file: `translateFor` falls back
     * `locale → DEFAULT_LOCALE`, so deleting a key from `bg.json` still
     * resolves through `en.json`. Only a translator that misses in both
     * exercises this, which is why the function takes one.
     *
     * The branch matters because `translateFor` returns THE KEY on a miss.
     * Without the guard a chart shows `trends.seriesLabel.dap` — a non-empty
     * string that satisfies every "did it render" assertion.
     */
    const alwaysMisses = async (_l: 'bg' | 'en', key: string) => key;

    it('falls back to the feed’s own words, never the dotted key', async () => {
        const out = await localiseSeriesLabel('Feed maize', 'bg', alwaysMisses);
        expect(out).toBe('Feed maize');
        expect(out).not.toMatch(/^trends\./);
    });

    it('still passes an unknown label through', async () => {
        expect(await localiseSeriesLabel('Something new', 'bg', alwaysMisses)).toBe('Something new');
    });
});

/**
 * The МЗХ purchase-price ingest — #3136.
 *
 * The fetch and the PDF extraction are INJECTED, so this runs with no network
 * and no poppler: what is under test is the verdict logic and the write shape,
 * and both are decided by what the parser returned. The parser itself is
 * tested against the real bulletin in `tests/unit/market/mzh-parse.test.ts`.
 *
 * The four verdicts are the point. `received/actioned/skipped` cannot say WHY
 * zero happened, and the three zero-causes want different responses — an
 * unpublished week is normal, an unreadable bulletin means the shape changed
 * or `pdftotext` is missing from the image, and a renamed row means a figure
 * stopped being recognised.
 */
const upsertSeries = jest.fn();
const upsertPoint = jest.fn();
jest.mock('@/lib/prisma', () => ({
    prisma: {
        marketPriceSeries: { upsert: (...a: unknown[]) => upsertSeries(...a) },
        marketPricePoint: { upsert: (...a: unknown[]) => upsertPoint(...a) },
    },
}));

const invalidate = jest.fn();
jest.mock('@/app-layer/usecases/trends', () => ({
    invalidatePriceTrendsCache: (...a: unknown[]) => invalidate(...a),
}));

const warn = jest.fn();
const error = jest.fn();
const info = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: (...a: unknown[]) => warn(...a),
        error: (...a: unknown[]) => error(...a),
        info: (...a: unknown[]) => info(...a),
    },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { runMzhPricesPull } from '@/app-layer/jobs/mzh-prices-pull';
import { MZH_STAGE, MZH_SOURCE, MZH_UNIT, MZH_CURRENCY, MZH_REGION } from '@/app-layer/jobs/mzh-prices-pull';

const BULLETIN = readFileSync(
    join(process.cwd(), 'tests/fixtures/mzh/operativen-analiz-2026-10-07.txt'),
    'utf8',
);

const INDEX_HTML = `
    <a href="/media/filer_public/2026/10/08/operativen_analiz_2026-10-07.pdf">07.10.2026</a>
    <a href="/media/filer_public/2026/09/24/operativen_analiz_2026-09-23_qUiH6H4.pdf">23.09.2026</a>
`;

/** A fetch double: HTML for the index, bytes for the PDF. */
function fetchDouble(html: string, pdfOk = true): typeof fetch {
    return (async (url: string) => {
        if (String(url).endsWith('.pdf')) {
            if (!pdfOk) return { ok: false, status: 404 } as unknown as Response;
            return {
                ok: true,
                status: 200,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            } as unknown as Response;
        }
        return { ok: true, status: 200, text: async () => html } as unknown as Response;
    }) as unknown as typeof fetch;
}

beforeEach(() => {
    jest.clearAllMocks();
    upsertSeries.mockImplementation(async () => ({ id: 'series-1' }));
    upsertPoint.mockResolvedValue({ id: 'point-1' });
    invalidate.mockResolvedValue(3);
});

describe('a healthy run', () => {
    const run = () =>
        runMzhPricesPull({
            fetchImpl: fetchDouble(INDEX_HTML),
            extractText: async () => BULLETIN,
        });

    it('stores the five grain series the owner ruled in scope', async () => {
        const r = await run();
        expect(r.verdict).toBe('clean');
        expect(r.pointsWritten).toBe(5);
        expect(r.seriesTouched).toBe(5);
        const commodities = upsertSeries.mock.calls.map(
            (c) => (c[0] as { create: { commodity: string } }).create.commodity,
        );
        expect(commodities).toEqual(['wheat', 'barley', 'maize', 'sunflower', 'rapeseed']);
    });

    it('writes the series tuple the contract fixes', async () => {
        await run();
        const first = (upsertSeries.mock.calls[0][0] as {
            create: Record<string, string>;
        }).create;
        expect(first).toMatchObject({
            source: MZH_SOURCE,
            region: MZH_REGION,
            stage: MZH_STAGE,
            currency: MZH_CURRENCY,
            unit: MZH_UNIT,
        });
        // NOT null. `stage` is part of the natural key, so a null would upsert
        // a second МЗХ series into the same row.
        expect(MZH_STAGE).toBe('PURCHASE');
    });

    it('dates the point on the table«s own «към» date, never the read time', async () => {
        await run();
        const dates = upsertPoint.mock.calls.map(
            (c) => (c[0] as { create: { date: Date } }).create.date.toISOString().slice(0, 10),
        );
        // The 7 October bulletin carries figures «към 30.09.2026». Storing the
        // read time would file week-old averages as today's price.
        expect(new Set(dates)).toEqual(new Set(['2026-09-30']));
    });

    it('stores the price as a Decimal built from the string, never a float', async () => {
        await run();
        const wheat = upsertPoint.mock.calls[0][0] as { create: { price: unknown } };
        expect(String(wheat.create.price)).toBe('188');
    });

    it('points sourceUrl at the ISSUE the figure came from', async () => {
        await run();
        const create = (upsertSeries.mock.calls[0][0] as {
            create: { sourceUrl: string };
        }).create;
        expect(create.sourceUrl).toBe(
            'https://www.mzh.government.bg/media/filer_public/2026/10/08/operativen_analiz_2026-10-07.pdf',
        );
    });

    it('invalidates the trends cache for the commodities ACTUALLY written', async () => {
        const r = await run();
        expect(invalidate).toHaveBeenCalledWith([
            'wheat',
            'barley',
            'maize',
            'sunflower',
            'rapeseed',
        ]);
        expect(r.cacheKeysInvalidated).toBe(3);
        expect(r.cacheInvalidationFailed).toBe(false);
    });

    it('takes the NEWEST bulletin, not the first one it can parse', async () => {
        await run();
        expect((await run()).bulletinDate).toBe('2026-10-07');
    });
});

describe('the three verdicts that are not success', () => {
    it('no-bulletin — the index listed nothing placeable in time', async () => {
        const r = await runMzhPricesPull({
            fetchImpl: fetchDouble('<html>нищо</html>'),
            extractText: async () => BULLETIN,
        });
        expect(r.verdict).toBe('no-bulletin');
        expect(r.pointsWritten).toBe(0);
        expect(upsertSeries).not.toHaveBeenCalled();
        // Logged, because an unpublished week and a moved page look identical
        // in the result triple.
        expect(warn).toHaveBeenCalledWith('mzh.no_bulletin', expect.anything());
    });

    it('unreadable — the PDF arrived and held no grain table', async () => {
        // The verdict that must NOT read as "no prices this week": a bulletin
        // whose shape changed, or `pdftotext` missing from the image.
        const r = await runMzhPricesPull({
            fetchImpl: fetchDouble(INDEX_HTML),
            extractText: async () => 'not a bulletin at all',
        });
        expect(r.verdict).toBe('unreadable');
        expect(r.pointsWritten).toBe(0);
        expect(error).toHaveBeenCalledWith('mzh.unreadable_bulletin', expect.anything());
        // And it does NOT silently invalidate a cache it wrote nothing into.
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('partial — a row was renamed, and the label is NAMED', async () => {
        const renamed = BULLETIN.replace('Хлебна пшеница', 'Хлебна пшеничка');
        const r = await runMzhPricesPull({
            fetchImpl: fetchDouble(INDEX_HTML),
            extractText: async () => renamed,
        });
        expect(r.verdict).toBe('partial');
        // The other four still land — one renamed row must not cost the week.
        expect(r.pointsWritten).toBe(4);
        expect(r.unmappedLabels).toEqual(['Хлебна пшеничка']);
    });
});

describe('a commodity that goes missing — the catch-all', () => {
    const table = (body: string) =>
        `Средни изкупни цени на основни зърнени и маслодайни култури\n`
        + `към 30.09.2026 г., евро/тон без ДДС\n\n`
        + body
        + `\nИзточник: САПИ ЕООД\n`;

    it('reports a row whose figures are UNREADABLE, which the parser skips silently', () => {
        // The gap this check exists for. `Ечемик 166 176 n/a - -` fails the
        // parser's line pattern, so it is not unmapped and not no-data — it is
        // simply not there. Without this comparison the run would report
        // `clean` over four commodities and nothing would ever say which one
        // stopped arriving.
        return runMzhPricesPull({
            fetchImpl: fetchDouble(INDEX_HTML),
            extractText: async () =>
                table(
                    'Хлебна пшеница   176   189   188   6,9   -0,5\n'
                    + 'Ечемик           166   176   n/a   -     -\n'
                    + 'Царевица         196   192   195   -0,7  1,6\n'
                    + 'Слънчоглед       482   488   486   0,8   -0,4\n'
                    + 'Рапица           424   487   475   11,9  -2,5\n',
                ),
        }).then((r) => {
            expect(r.verdict).toBe('partial');
            expect(r.pointsWritten).toBe(4);
            expect(r.missingCommodities).toEqual(['barley']);
            // NOT reported as a renamed row, because it was not renamed.
            expect(r.unmappedLabels).toEqual([]);
            expect(r.noDataLabels).toEqual([]);
        });
    });

    it('CONTROL — reports nothing missing when all five arrive', async () => {
        // Without this the assertion above is satisfied by a check that always
        // reports something missing.
        const r = await runMzhPricesPull({
            fetchImpl: fetchDouble(INDEX_HTML),
            extractText: async () => BULLETIN,
        });
        expect(r.missingCommodities).toEqual([]);
        expect(r.verdict).toBe('clean');
    });
});

describe('failure handling', () => {
    it('a failed cache drop does not undo the prices', async () => {
        invalidate.mockRejectedValue(new Error('redis is down'));
        const r = await runMzhPricesPull({
            fetchImpl: fetchDouble(INDEX_HTML),
            extractText: async () => BULLETIN,
        });
        expect(r.pointsWritten).toBe(5);
        expect(r.cacheInvalidationFailed).toBe(true);
        expect(r.verdict).toBe('clean');
    });

    it('a 404 on the PDF throws rather than reporting a clean empty run', async () => {
        await expect(
            runMzhPricesPull({
                fetchImpl: fetchDouble(INDEX_HTML, false),
                extractText: async () => BULLETIN,
            }),
        ).rejects.toThrow(/404/);
    });

    it('CONTROL — nothing is written when the table yields no rows', async () => {
        // A grain table that parses but holds only «няма данни». Distinct from
        // `unreadable`: the parser found its subject and the subject was empty.
        const empty =
            'Средни изкупни цени на основни зърнени и маслодайни култури\n'
            + 'към 30.09.2026 г., евро/тон без ДДС\n\n'
            + 'Царевица                   196   192   *   -   -\n'
            + 'Източник: САПИ ЕООД\n';
        const r = await runMzhPricesPull({
            fetchImpl: fetchDouble(INDEX_HTML),
            extractText: async () => empty,
        });
        // `partial`, not `clean`. This expectation said `clean` until the
        // missing-commodity check landed, and `clean` was the wrong answer: a
        // week that stored NOTHING is a finding whatever the cause, and the
        // four commodities the table did not even print are named.
        expect(r.verdict).toBe('partial');
        expect(r.pointsWritten).toBe(0);
        expect(r.noDataLabels).toEqual(['Царевица']);
        expect(r.missingCommodities.sort()).toEqual(
            ['barley', 'maize', 'rapeseed', 'sunflower', 'wheat'].sort(),
        );
        expect(upsertPoint).not.toHaveBeenCalled();
        // No write, so no cache drop — invalidating here would be work for
        // nothing and would hide a genuinely empty week behind a busy log.
        expect(invalidate).not.toHaveBeenCalled();
    });
});

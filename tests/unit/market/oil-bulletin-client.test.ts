/**
 * EC Weekly Oil Bulletin client — road diesel.
 *
 * Every assertion runs against a RECORDED 14 KB fixture, never the live API:
 * a test that reaches the network fails on a Monday when DG ENER replaces the
 * file, and passes for the wrong reason when it doesn't.
 *
 * The failure this client exists to prevent is not an exception — it is
 * charting CRUDE at a farmer budgeting fuel, because "нафта" was read as oil
 * rather than as diesel. The next-worst is storing a real number under the
 * wrong unit or the wrong date.
 *
 * Each `it()` names the production break it catches.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import {
    OIL_BULLETIN_CURRENCY,
    OIL_BULLETIN_UNIT,
    OilBulletinRateLimitError,
    fetchDieselPrices,
    parseDieselWorkbook,
} from '@/lib/market/oil-bulletin-client';

const FIXTURE = path.join(__dirname, '../../fixtures/market/oil-bulletin-weekly.xlsx');
const bytes = () => new Uint8Array(readFileSync(FIXTURE));

/** A `fetch` that serves the fixture for any URL. */
function fixtureFetch(overrides: Partial<Response> = {}) {
    return jest.fn(async (_url: RequestInfo | URL) =>
        ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            arrayBuffer: async () => {
                const b = readFileSync(FIXTURE);
                return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
            },
            ...overrides,
        }) as unknown as Response,
    );
}

describe('parsing a real bulletin', () => {
    it('extracts Bulgarian diesel with its own unit and currency', async () => {
        const obs = await parseDieselWorkbook(bytes(), 'with-tax');
        const bg = obs.find((o) => o.region === 'BG');
        expect(bg).toBeDefined();
        expect(bg!.price).toBeGreaterThan(500);
        expect(bg!.unit).toBe(OIL_BULLETIN_UNIT);
        expect(bg!.currency).toBe(OIL_BULLETIN_CURRENCY);
        expect(bg!.stage).toBe('with-tax');
    });

    // Break: rendering 27 charts on a Bulgarian farm's Trends tab. The
    // bulletin carries every member state; the product wants four regions,
    // matching the cereal feed's own EC_MEMBER_STATES scope.
    it('keeps only the four regions the product charts', async () => {
        const obs = await parseDieselWorkbook(bytes(), 'with-tax');
        const regions = [...new Set(obs.map((o) => o.region))].sort();
        expect(regions).toEqual(['BG', 'EL', 'EU', 'RO']);
    });

    // Break: deriving the date from the URL or the content-disposition
    // filename — which, verified, says 2024-02-19 on a file containing
    // 2026-08-03 data.
    it('takes the observation date from the workbook, and stamps every row with it', async () => {
        const obs = await parseDieselWorkbook(bytes(), 'with-tax');
        const dates = [...new Set(obs.map((o) => o.date.toISOString()))];
        expect(dates).toHaveLength(1);
        expect(obs[0].date.getUTCFullYear()).toBeGreaterThanOrEqual(2024);
        // Day-granular, so it keys against (seriesId, date) like every other source.
        expect(obs[0].date.toISOString()).toMatch(/T00:00:00\.000Z$/);
    });

    it('labels the tax stage in prose, since the chart shows two lines', async () => {
        const withTax = await parseDieselWorkbook(bytes(), 'with-tax');
        const withoutTax = await parseDieselWorkbook(bytes(), 'without-tax');
        expect(withTax[0].label).toMatch(/with duties and taxes/);
        expect(withoutTax[0].label).toMatch(/excluding duties and taxes/);
        expect(withoutTax[0].stage).toBe('without-tax');
    });
});

describe('refusing to guess', () => {
    // Break: THE quiet one. If DG ENER ever republished in EUR/litre, a
    // single-epoch reader would store 1.74 under a 'EUR/1000l' label and the
    // chart would show a 1000x collapse that looks like a market event.
    it('throws when the unit row is not per-1000-litres', async () => {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>');
        zip.file(
            'xl/worksheets/sheet1.xml',
            `<worksheet><sheetData>
                <row r="1"><c r="A1" t="inlineStr"><is><t>in EUR</t></is></c><c r="C1" t="inlineStr"><is><t>Automotive gas oil</t></is></c></row>
                <row r="2"><c r="A2"><v>46237</v></c><c r="C2" t="inlineStr"><is><t>litre</t></is></c></row>
                <row r="3"><c r="A3" t="inlineStr"><is><t>Bulgaria</t></is></c><c r="C3"><v>1.74</v></c></row>
            </sheetData></worksheet>`,
        );
        const bad = await zip.generateAsync({ type: 'uint8array' });
        await expect(parseDieselWorkbook(bad, 'with-tax')).rejects.toThrow(/expected diesel unit '1000 l'/);
    });

    it('throws, naming the headers, when no diesel column is present', async () => {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>');
        zip.file(
            'xl/worksheets/sheet1.xml',
            `<worksheet><sheetData>
                <row r="1"><c r="A1" t="inlineStr"><is><t>in EUR</t></is></c><c r="B1" t="inlineStr"><is><t>Euro-super 95</t></is></c></row>
                <row r="2"><c r="A2"><v>46237</v></c><c r="B2" t="inlineStr"><is><t>1000 l</t></is></c></row>
                <row r="3"><c r="A3" t="inlineStr"><is><t>Bulgaria</t></is></c><c r="B3"><v>1533.3</v></c></row>
            </sheetData></worksheet>`,
        );
        await expect(parseDieselWorkbook(await zip.generateAsync({ type: 'uint8array' }), 'with-tax')).rejects.toThrow(
            /no automotive-gas-oil column.*euro-super 95/i,
        );
    });
});

describe('the network half', () => {
    it('fetches both tax files and returns both stages', async () => {
        const f = fixtureFetch();
        const obs = await fetchDieselPrices({ fetchImpl: f });
        expect(f).toHaveBeenCalledTimes(2);
        const stages = [...new Set(obs.map((o) => o.stage))].sort();
        expect(stages).toEqual(['with-tax', 'without-tax']);
    });

    it('honours a base-URL override so an operator can repoint a moved document', async () => {
        const f = fixtureFetch();
        await fetchDieselPrices({
            fetchImpl: f,
            withTaxUrl: 'https://example.test/with',
            withoutTaxUrl: 'https://example.test/without',
        });
        expect(f.mock.calls[0][0]).toBe('https://example.test/with');
        expect(f.mock.calls[1][0]).toBe('https://example.test/without');
    });

    // Break: a burst of requests silently returning nothing. Three rapid
    // requests to this host were observed returning 429 with retry-after: 10.
    it('raises a typed rate-limit error carrying retry-after', async () => {
        const f = jest.fn(async (_url: RequestInfo | URL) =>
            ({
                ok: false,
                status: 429,
                headers: { get: (h: string) => (h === 'retry-after' ? '10' : null) },
            }) as unknown as Response,
        );
        await expect(fetchDieselPrices({ fetchImpl: f })).rejects.toBeInstanceOf(OilBulletinRateLimitError);
        await expect(fetchDieselPrices({ fetchImpl: f })).rejects.toMatchObject({ retryAfterSeconds: 10 });
    });

    // Break: a moved document node degrading to "no data". The URLs carry no
    // published permanence guarantee, so a 404 must be loud.
    it('throws loudly on a 404 rather than returning an empty result', async () => {
        const f = jest.fn(async (_url: RequestInfo | URL) =>
            ({ ok: false, status: 404, headers: { get: () => null } }) as unknown as Response,
        );
        await expect(fetchDieselPrices({ fetchImpl: f })).rejects.toThrow(/404/);
    });
});

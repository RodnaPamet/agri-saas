/**
 * World Bank Pink Sheet client — fertilizer prices.
 *
 * The fixture is REAL DATA, reduced: it was generated from the actual
 * 578 KB monthly workbook by keeping its title rows, its header and units
 * rows, and a slice of its data rows verbatim. So the bytes under test carry
 * the upstream's own oddities — the header is `'Urea '` WITH a trailing
 * space, the unit is `'($/mt)'`, the missing marker is the literal `'...'`
 * — rather than my guesses about them. Checking in all 578 KB would have
 * been seven times the entire fixtures directory.
 *
 * The failure this client exists to prevent is not an exception. It is
 * serving prices that are seven months old with no error anywhere, because
 * the Pink Sheet's URL rolls annually and the OLD url still returns 200.
 *
 * Each `it()` names the production break it catches.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import {
    PINK_SHEET_CURRENCY,
    PINK_SHEET_REGION,
    PINK_SHEET_UNIT,
    PinkSheetStaleError,
    WorldBankRateLimitError,
    fetchFertilizerPrices,
    parsePinkSheetPeriod,
    parsePinkSheetWorkbook,
} from '@/lib/market/world-bank-client';

const FIXTURE = path.join(__dirname, '../../fixtures/market/pink-sheet-monthly.xlsx');
const bytes = () => new Uint8Array(readFileSync(FIXTURE));

/**
 * A clock just after the fixture's newest period (2026M07). Pinned so this
 * suite does not become a calendar bomb the moment the fixture ages past the
 * staleness bound it is meant to be testing.
 */
const NOW = new Date('2026-08-12T00:00:00Z');

describe('period labels', () => {
    it.each([
        ['1960M01', '1960-01-01'],
        ['2026M07', '2026-07-01'],
        ['2026M12', '2026-12-01'],
    ])('parses %p to the first of the month (%p)', (raw, iso) => {
        expect(parsePinkSheetPeriod(raw)!.toISOString().slice(0, 10)).toBe(iso);
    });

    it.each([null, '', '2026', '2026M', '2026M13', '2026M00', 'Jul 2026'])(
        'returns null for %p rather than inventing a date',
        (raw) => {
            expect(parsePinkSheetPeriod(raw as string | null)).toBeNull();
        },
    );
});

describe('parsing the real workbook', () => {
    it('returns urea and DAP, and nothing else', async () => {
        const obs = await parsePinkSheetWorkbook(bytes(), { now: NOW, maxMonths: 1200 });
        const slugs = [...new Set(obs.map((o) => o.commodity))].sort();
        expect(slugs).toEqual(['dap', 'urea']);
    });

    // Break: binding 'Urea ' (trailing space, verbatim upstream) as a
    // different commodity from 'urea', which silently splits one series.
    it("resolves the header 'Urea ' through the vocabulary despite its trailing space", async () => {
        const obs = await parsePinkSheetWorkbook(bytes(), { now: NOW, maxMonths: 1200 });
        expect(obs.some((o) => o.commodity === 'urea')).toBe(true);
    });

    it('stores USD/mt as reported, at global scope', async () => {
        const obs = await parsePinkSheetWorkbook(bytes(), { now: NOW });
        for (const o of obs) {
            expect(o.unit).toBe(PINK_SHEET_UNIT);
            expect(o.currency).toBe(PINK_SHEET_CURRENCY);
            expect(o.region).toBe(PINK_SHEET_REGION);
        }
    });

    // Break: a monthly observation pinned to a varying day, so a re-run
    // writes a second point for the same month.
    it('pins every observation to the first of its month', async () => {
        const obs = await parsePinkSheetWorkbook(bytes(), { now: NOW });
        for (const o of obs) expect(o.date.getUTCDate()).toBe(1);
    });

    // Break: the literal '...' marker read as 0 — a fertiliser priced at
    // nothing, which on a chart is a collapse rather than a gap.
    it("skips the '...' missing marker instead of storing zero", async () => {
        const obs = await parsePinkSheetWorkbook(bytes(), { now: NOW, maxMonths: 1200 });
        // 1960M01-03 carry '...' for DAP but a real price for urea.
        const early = obs.filter((o) => o.date.getUTCFullYear() === 1960);
        expect(early.length).toBeGreaterThan(0);
        expect(early.every((o) => o.commodity === 'urea')).toBe(true);
        expect(obs.every((o) => o.price > 0)).toBe(true);
    });

    it('records the price basis in the label, since it is part of the meaning', async () => {
        const obs = await parsePinkSheetWorkbook(bytes(), { now: NOW });
        expect(obs.find((o) => o.commodity === 'dap')!.label).toMatch(/f\.o\.b\. US Gulf/);
        expect(obs.find((o) => o.commodity === 'urea')!.label).toMatch(/Middle East/);
    });

    // Break: re-upserting 66 years of monthly points every run, for data no
    // range selector shows.
    it('ingests only recent history by default', async () => {
        const recent = await parsePinkSheetWorkbook(bytes(), { now: NOW });
        const all = await parsePinkSheetWorkbook(bytes(), { now: NOW, maxMonths: 1200 });
        expect(recent.length).toBeLessThan(all.length);
        expect(recent.every((o) => o.date.getUTCFullYear() >= 2021)).toBe(true);
    });
});

describe('the stale-URL trap', () => {
    // Break: THE one. The doc-id segment rolls annually and the PREVIOUS
    // generation still returns HTTP 200 with a frozen file — verified: last
    // period 2025M12, seven months stale, no redirect, no 404. Freshness is
    // therefore asserted from the DATA, because the response cannot tell us.
    it('throws when the newest period is older than the bound', async () => {
        const muchLater = new Date('2027-06-01T00:00:00Z');
        await expect(parsePinkSheetWorkbook(bytes(), { now: muchLater })).rejects.toBeInstanceOf(
            PinkSheetStaleError,
        );
    });

    it('names the age and the likely cause, since the fix is repointing a URL', async () => {
        const muchLater = new Date('2027-06-01T00:00:00Z');
        await expect(parsePinkSheetWorkbook(bytes(), { now: muchLater })).rejects.toThrow(
            /months old \(2026-07\).*doc-id URL segment rolls annually/s,
        );
    });

    it('accepts a workbook inside the bound', async () => {
        await expect(parsePinkSheetWorkbook(bytes(), { now: NOW })).resolves.toBeDefined();
    });
});

describe('refusing to guess', () => {
    async function workbook(rows: string): Promise<Uint8Array> {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        zip.file(
            'xl/workbook.xml',
            '<workbook><sheets><sheet name="Monthly Prices" sheetId="1" r:id="rId1"/></sheets></workbook>',
        );
        zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${rows}</sheetData></worksheet>`);
        return zip.generateAsync({ type: 'uint8array' });
    }

    it('throws when the unit is no longer $/mt', async () => {
        const wb = await workbook(
            `<row r="1"><c r="B1" t="inlineStr"><is><t>DAP</t></is></c></row>
             <row r="2"><c r="B2" t="inlineStr"><is><t>($/lb)</t></is></c></row>
             <row r="3"><c r="A3" t="inlineStr"><is><t>2026M07</t></is></c><c r="B3"><v>0.35</v></c></row>`,
        );
        await expect(parsePinkSheetWorkbook(wb, { now: NOW })).rejects.toThrow(/expected dap in \(\$\/mt\)/);
    });

    it('throws when no fertiliser column is present at all', async () => {
        const wb = await workbook(
            `<row r="1"><c r="B1" t="inlineStr"><is><t>Crude oil, Brent</t></is></c></row>
             <row r="2"><c r="B2" t="inlineStr"><is><t>($/bbl)</t></is></c></row>`,
        );
        await expect(parsePinkSheetWorkbook(wb, { now: NOW })).rejects.toThrow(/no fertiliser column/);
    });

    // Break: quietly starting a SECOND cereal series alongside the EC one.
    // The Pink Sheet carries maize, wheat, barley and soybeans, and the
    // vocabulary recognises all of them.
    it('ignores the cereals the Pink Sheet also publishes', async () => {
        const wb = await workbook(
            `<row r="1"><c r="B1" t="inlineStr"><is><t>Maize</t></is></c><c r="C1" t="inlineStr"><is><t>DAP</t></is></c></row>
             <row r="2"><c r="B2" t="inlineStr"><is><t>($/mt)</t></is></c><c r="C2" t="inlineStr"><is><t>($/mt)</t></is></c></row>
             <row r="3"><c r="A3" t="inlineStr"><is><t>2026M07</t></is></c><c r="B3"><v>200</v></c><c r="C3"><v>781.3</v></c></row>`,
        );
        const obs = await parsePinkSheetWorkbook(wb, { now: NOW });
        expect(obs.map((o) => o.commodity)).toEqual(['dap']);
    });
});

describe('the network half', () => {
    function fetchOk() {
        return jest.fn(async (_url: RequestInfo | URL) =>
            ({
                ok: true,
                status: 200,
                headers: { get: () => null },
                arrayBuffer: async () => {
                    const b = readFileSync(FIXTURE);
                    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
                },
            }) as unknown as Response,
        );
    }

    it('fetches and parses', async () => {
        const obs = await fetchFertilizerPrices({ fetchImpl: fetchOk(), now: NOW });
        expect(obs.length).toBeGreaterThan(0);
    });

    it('honours a URL override, which is how a rolled doc-id gets repointed', async () => {
        const f = fetchOk();
        await fetchFertilizerPrices({ fetchImpl: f, now: NOW, url: 'https://example.test/pink.xlsx' });
        expect(f.mock.calls[0][0]).toBe('https://example.test/pink.xlsx');
    });

    it('raises a typed rate-limit error', async () => {
        const f = jest.fn(async (_url: RequestInfo | URL) =>
            ({
                ok: false,
                status: 429,
                headers: { get: (h: string) => (h === 'retry-after' ? '30' : null) },
            }) as unknown as Response,
        );
        await expect(fetchFertilizerPrices({ fetchImpl: f, now: NOW })).rejects.toBeInstanceOf(
            WorldBankRateLimitError,
        );
    });

    it('throws on a non-OK response rather than returning nothing', async () => {
        const f = jest.fn(async (_url: RequestInfo | URL) =>
            ({ ok: false, status: 503, headers: { get: () => null } }) as unknown as Response,
        );
        await expect(fetchFertilizerPrices({ fetchImpl: f, now: NOW })).rejects.toThrow(/503/);
    });
});

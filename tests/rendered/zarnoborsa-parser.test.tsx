/**
 * #3081 — the ZarnoBorsa parser, against saved markup.
 *
 * Under the jsdom project because `extractZarnoBorsaRows` is written against
 * the DOM: the job runs a headless Chromium (a plain fetch cannot hold the
 * site's session), so a real DOM is already present and Playwright
 * stringifies that function into the page. Running it here under jsdom means
 * the tests exercise the same function body the browser executes, rather than
 * a Node-side reimplementation that could drift from it.
 *
 * ## The fixtures are SYNTHETIC and that is load-bearing
 *
 * Markup, class names, whitespace, the `?p=graph` ids and the row dates are
 * real; every price and change is a made-up number. This repository is public
 * and ZarnoBorsa's prices are a paid product, so a real capture here would
 * republish them. The split is the right one anyway: the markup is what a
 * parser must survive and is ours to test, the numbers are the source's.
 *
 * So these tests assert SHAPE — which ids, which cells, which dates — and
 * never that a particular price is correct, because the prices here are
 * fiction.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
    extractZarnoBorsaRows,
    isZarnoBorsaLocked,
} from '@/lib/market/zarnoborsa-extract';
import {
    parseZarnoBorsaRows,
    parseZarnoBorsaDate,
    parseZarnoBorsaPrice,
    parseZarnoBorsaChange,
} from '@/lib/market/zarnoborsa-parse';

const DIR = join(process.cwd(), 'tests/fixtures/zarnoborsa');

function load(name: string): Document {
    const html = readFileSync(join(DIR, name), 'utf8');
    const doc = document.implementation.createHTMLDocument('fixture');
    doc.body.innerHTML = html;
    return doc;
}

describe('#3081 — extracting ZarnoBorsa rows', () => {
    it('EXTRACTION CONTROL — the fixtures yield rows at all', () => {
        // First, because every assertion below is about a population. An
        // extraction that quietly empties makes each of them pass over
        // nothing, which is the shape a negated assertion hides best.
        expect(extractZarnoBorsaRows(load('exw.html'))).toHaveLength(17);
        expect(extractZarnoBorsaRows(load('fob.html'))).toHaveLength(9);
    });

    it('keys every row on its own (market, product) ids, not on a section header', () => {
        const rows = extractZarnoBorsaRows(load('exw.html'));
        // Five regions in one table, and no state machine: each row carries
        // its own `m`, so the rows for Bulgaria are identifiable without
        // having tracked which header we passed.
        const markets = [...new Set(rows.map((r) => r.marketId))].sort();
        expect(markets).toEqual([1044, 1045, 1050, 1121, 1122]);

        const bg = rows.filter((r) => r.marketId === 1044);
        expect(bg).toHaveLength(9);
        expect(bg.map((r) => r.productId).sort((a, b) => a - b))
            .toEqual([1005, 1006, 1007, 1008, 1009, 1010, 1012, 1182, 1183]);
    });

    it('reads the FOB page too, where the cell COUNT differs', () => {
        const rows = extractZarnoBorsaRows(load('fob.html'));
        const markets = [...new Set(rows.map((r) => r.marketId))].sort();
        expect(markets).toEqual([1051, 1054, 1055, 1129]);

        // A FOB row has five cells against EXW's four, so the date is the
        // fifth here and the fourth there. Taking the LAST cell is what makes
        // one parser serve both.
        const wheatBg = rows.find((r) => r.marketId === 1129 && r.productId === 1032);
        expect(wheatBg?.dateText).toBe('Nov, 13 2026');
    });

    it('never mistakes the forward-curve link for the market link', () => {
        // The `colHidde` cell can hold a SECOND anchor, to
        // `/forwardcurves/<otherMarketId>/<productId>` — and that first path
        // segment is a DIFFERENT market id (1141 for FOB RU). A parser taking
        // the row's last anchor would read 1141 as the market.
        const rows = extractZarnoBorsaRows(load('fob.html'));
        expect(rows.map((r) => r.marketId)).not.toContain(1141);
        expect(rows.map((r) => r.marketId)).not.toContain(1215);

        // And the row that HAS one still parses correctly.
        const ru = rows.find((r) => r.marketId === 1055 && r.productId === 1006);
        expect(ru).toBeDefined();
        expect(ru?.dateText).toBe('Nov, 14 2026');
    });

    it('keeps the label as written, double space and all', () => {
        const rows = extractZarnoBorsaRows(load('fob.html'));
        const ru = rows.find((r) => r.marketId === 1055 && r.productId === 1026);
        // «Пшеница  12.5%» carries a DOUBLE space in FOB RU. Stored for
        // display; never matched on, which is the whole reason the ids are
        // the key.
        expect(ru?.label).toBe('Пшеница  12.5%');
    });

    it('carries a row-level date, so one table holds several days', () => {
        const rows = extractZarnoBorsaRows(load('fob.html'));
        const bg = rows.filter((r) => r.marketId === 1129).map((r) => r.dateText);
        // Three rows, three different days — which is why a point is keyed on
        // the ROW's date and never on the read time.
        expect(new Set(bg).size).toBeGreaterThan(1);
    });
});

describe('#3081 — the lock-out control', () => {
    it('detects the paywalled page, which parses PERFECTLY otherwise', () => {
        const locked = load('locked.html');
        expect(isZarnoBorsaLocked(locked)).toBe(true);
        // The damning part: the locked page's markup is the same, so rows DO
        // come out of it. Without the banner check they would be upserted.
        expect(extractZarnoBorsaRows(locked).length).toBeGreaterThan(0);
    });

    it('does NOT fire on a logged-in page — the control must discriminate', () => {
        expect(isZarnoBorsaLocked(load('exw.html'))).toBe(false);
        expect(isZarnoBorsaLocked(load('fob.html'))).toBe(false);
    });

    it('A DATE CHECK COULD NOT HAVE BEEN THIS CONTROL', () => {
        // The reason the banner is the gate rather than freshness: a
        // legitimately old row exists. EXW Украйна carries «Aug, 03 2026» on
        // a page we are properly logged into — so "I see an old date" is true
        // in both worlds and separates nothing.
        const rows = extractZarnoBorsaRows(load('exw.html'));
        const stale = rows.find((r) => r.dateText === 'Aug, 03 2026');
        expect(stale).toBeDefined();
        expect(stale?.marketId).toBe(1121);
        expect(isZarnoBorsaLocked(load('exw.html'))).toBe(false);
    });
});

describe('#3081 — interpreting the printed strings', () => {
    it('parses the date format the page prints', () => {
        expect(parseZarnoBorsaDate('Nov, 14 2026')).toBe('2026-11-14');
        expect(parseZarnoBorsaDate('Aug, 03 2026')).toBe('2026-08-03');
        // Single-digit day, padded.
        expect(parseZarnoBorsaDate('Nov, 6 2026')).toBe('2026-11-06');
        // Not a date — skipped, never guessed at.
        expect(parseZarnoBorsaDate('14.11.2026')).toBeNull();
        expect(parseZarnoBorsaDate('Xxx, 14 2026')).toBeNull();
        expect(parseZarnoBorsaDate('')).toBeNull();
    });

    it('STRIPS the thousands comma rather than reading it as a decimal mark', () => {
        // Getting this backwards turns a tonne of sunflower oil into the
        // price of a coffee.
        expect(parseZarnoBorsaPrice('1,155.55')).toBe('1155.55');
        expect(parseZarnoBorsaPrice('145.45')).toBe('145.45');
        expect(parseZarnoBorsaPrice('1,150.70')).toBe('1150.70');
    });

    it('refuses a non-price instead of storing zero', () => {
        for (const bad of [' ', '', '-', 'n/a', '€145.45', '145,45,45']) {
            expect(parseZarnoBorsaPrice(bad)).toBeNull();
        }
    });

    it('REFUSES a European decimal comma rather than inflating it 100x', () => {
        // The reason comma POSITIONS are validated instead of stripped.
        // Blind stripping turns «145,45» into 14545 — a hundredfold
        // overstatement that is a plausible number, stored silently, in a
        // figure the grain calculator uses. A two-digit group is not a
        // thousands group, so this is refused and COUNTED instead.
        expect(parseZarnoBorsaPrice('145,45')).toBeNull();
        expect(parseZarnoBorsaPrice('1,45')).toBeNull();
        expect(parseZarnoBorsaChange('-145,45')).toBeNull();
        // A real thousands group still works, in both directions.
        expect(parseZarnoBorsaPrice('1,155.55')).toBe('1155.55');
        expect(parseZarnoBorsaChange('-1,155.55')).toBe('-1155.55');
    });

    it('reads the sign from the TEXT, including the unsigned case', () => {
        expect(parseZarnoBorsaChange('-146.46')).toBe('-146.46');
        expect(parseZarnoBorsaChange('+150.50')).toBe('150.50');
        // `black` in the page's classes — unsigned, which is not the same
        // claim as "no change", so it is stored as printed.
        expect(parseZarnoBorsaChange('156.56')).toBe('156.56');
        expect(parseZarnoBorsaChange(' ')).toBeNull();
    });

    it('a price is a DECIMAL STRING, never a float', () => {
        const { rows } = parseZarnoBorsaRows(extractZarnoBorsaRows(load('exw.html')));
        // `MarketPricePoint.price` is Decimal(12,2) and these figures reach
        // the grain calculator, so nothing may put a binary float in between.
        for (const r of rows) expect(typeof r.price).toBe('string');
        const oil = rows.find((r) => r.marketId === 1044 && r.productId === 1182);
        expect(oil?.price).toBe('1155.55');
    });

    it('skips an unparsable row and COUNTS it, rather than failing the run', () => {
        const doc = load('exw.html');
        // One cell reformatted: the rest of the day's prices must still land,
        // and the skip must be visible rather than silent.
        const firstDate = doc.querySelectorAll('tr td:last-child')[0];
        firstDate.textContent = '09.11.2026';

        const { rows, skipped } = parseZarnoBorsaRows(extractZarnoBorsaRows(doc));
        expect(skipped).toBe(1);
        expect(rows).toHaveLength(16);
    });

    it('rows:0 with skipped:0 is a different finding from rows:0 with skipped:N', () => {
        // The denominator the job's reading needs. An empty page and a page
        // whose shape changed both yield no rows, and they want opposite
        // responses — so the pair is reported, never just the total.
        const empty = document.implementation.createHTMLDocument('empty');
        const a = parseZarnoBorsaRows(extractZarnoBorsaRows(empty));
        expect(a).toEqual({ rows: [], skipped: 0 });

        const doc = load('exw.html');
        doc.querySelectorAll('tr td:last-child').forEach((td) => {
            td.textContent = 'not a date';
        });
        const b = parseZarnoBorsaRows(extractZarnoBorsaRows(doc));
        expect(b.rows).toHaveLength(0);
        expect(b.skipped).toBe(17);
    });
});

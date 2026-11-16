/**
 * Reading МЗХ's «Оперативен анализ» — #3136.
 *
 * Both parsers run against the REAL artefact: the grain-table fixture is
 * carved out of the 7 Oct 2026 bulletin's `pdftotext -layout` output, and it
 * deliberately INCLUDES the fruit-and-vegetable table that follows, because
 * that neighbour is what makes the slice's end bound load-bearing — «картофи»
 * at 0,62 евро/кг has the same row shape as a grain price in евро/тон.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
    COMMODITY_BY_LABEL,
    SKIPPED_LABELS,
    parseBgDate,
    parseBulletinList,
    parsePurchasePrices,
    sliceGrainTable,
} from '@/lib/market/mzh-parse';

const BULLETIN = readFileSync(
    join(process.cwd(), 'tests/fixtures/mzh/operativen-analiz-2026-10-07.txt'),
    'utf8',
);

describe('parseBgDate', () => {
    it('reads a printed Bulgarian date', () => {
        expect(parseBgDate('30.09.2026')).toBe('2026-09-30');
        expect(parseBgDate(' 01.10.2025 ')).toBe('2025-10-01');
    });

    it('REFUSES a day that does not exist, rather than rolling it forward', () => {
        // A pattern is not a validator: `31.02.2026` matches `DD.MM.YYYY`
        // perfectly, and `Date.UTC` would quietly answer 3 March.
        expect(parseBgDate('31.02.2026')).toBeNull();
        expect(parseBgDate('30.02.2026')).toBeNull();
        expect(parseBgDate('32.01.2026')).toBeNull();
        expect(parseBgDate('01.13.2026')).toBeNull();
    });

    it('refuses anything that is not the printed shape', () => {
        for (const bad of ['2026-09-30', '1.9.2026', '30/09/2026', '', 'към']) {
            expect(parseBgDate(bad)).toBeNull();
        }
    });
});

describe('parseBulletinList', () => {
    // The six real href shapes, measured from the live listing page. Two
    // hazards in one sample: the directory is the PUBLISH date (2026/10/08 for
    // the 2026-10-07 bulletin), and some filenames carry a random suffix.
    const html = `
        <a href="/media/filer_public/2026/11/11/operativen_analiz_2026-11-11.pdf">11.11.2026</a>
        <a href="/media/filer_public/2026/10/29/operativen_analiz_2026-10-28.pdf">28.10.2026</a>
        <a href="/media/filer_public/2026/10/08/operativen_analiz_2026-10-07.pdf">07.10.2026</a>
        <a href="/media/filer_public/2026/09/24/operativen_analiz_2026-09-23_qUiH6H4.pdf">23.09.2026</a>
        <a href="/media/filer_public/2026/06/24/operativen_analiz_2026-06-24_g3XHLKR.pdf">24.06.2026</a>
        <a href="/media/filer_public/2026/01/01/nothing_to_do_with_us.pdf">irrelevant</a>
    `;

    it('takes the date from the FILENAME, never the directory', () => {
        const list = parseBulletinList(html);
        const oct = list.find((l) => l.href.includes('2026-10-07'));
        // The directory says the 8th. The bulletin is the 7th. Reading the
        // directory would be a day out most weeks.
        expect(oct).toEqual({
            date: '2026-10-07',
            href: '/media/filer_public/2026/10/08/operativen_analiz_2026-10-07.pdf',
        });
    });

    it('keeps a random suffix in the href', () => {
        const list = parseBulletinList(html);
        const sep = list.find((l) => l.date === '2026-09-23');
        // The suffix is part of the real URL — dropping it 404s.
        expect(sep?.href).toBe(
            '/media/filer_public/2026/09/24/operativen_analiz_2026-09-23_qUiH6H4.pdf',
        );
    });

    it('preserves the page ORDER, newest first', () => {
        expect(parseBulletinList(html).map((l) => l.date)).toEqual([
            '2026-11-11',
            '2026-10-28',
            '2026-10-07',
            '2026-09-23',
            '2026-06-24',
        ]);
    });

    it('ignores unrelated PDFs on the same page', () => {
        expect(parseBulletinList(html).some((l) => l.href.includes('nothing_to_do'))).toBe(false);
    });

    it('dedupes a link the page prints twice', () => {
        const twice = html + html;
        expect(parseBulletinList(twice)).toHaveLength(5);
    });

    it('is empty rather than throwing on a page with no bulletins', () => {
        expect(parseBulletinList('<html><body>нищо</body></html>')).toEqual([]);
    });
});

describe('sliceGrainTable', () => {
    it('stops at the source line, BEFORE the fruit and vegetable table', () => {
        const slice = sliceGrainTable(BULLETIN);
        expect(slice).toBeTruthy();
        // The end bound is what stops «картофи» at 0,62 евро/кг being read as
        // a grain price in евро/тон. The fixture contains that table.
        expect(BULLETIN).toContain('картофи');
        expect(slice).not.toContain('картофи');
        expect(slice).toContain('Хлебна пшеница');
    });

    it('returns null when either bound is missing', () => {
        expect(sliceGrainTable('Средни изкупни цени, and then nothing')).toBeNull();
        expect(sliceGrainTable('Източник: САПИ ЕООД')).toBeNull();
        expect(sliceGrainTable('')).toBeNull();
    });
});

describe('parsePurchasePrices — against the real bulletin', () => {
    const parsed = parsePurchasePrices(BULLETIN)!;

    it('reads the week-ENDING date the table is «към»', () => {
        expect(parsed.asOf).toBe('2026-09-30');
    });

    it('reads the five stored commodities at their printed figures', () => {
        // Verbatim from the 7 Oct 2026 bulletin's 30.09.2026 column.
        expect(parsed.rows).toEqual([
            { label: 'Хлебна пшеница', commodity: 'wheat', price: '188' },
            { label: 'Ечемик', commodity: 'barley', price: '176' },
            { label: 'Царевица', commodity: 'maize', price: '195' },
            { label: 'Слънчоглед', commodity: 'sunflower', price: '486' },
            { label: 'Рапица', commodity: 'rapeseed', price: '475' },
        ]);
    });

    it('takes the CURRENT column, not the year-ago or previous-week one', () => {
        // The row reads `176  189  188  6,9  -0,5`. Taking the first figure
        // would store last year's price as today's, and every number would
        // look plausible.
        const wheat = parsed.rows.find((r) => r.commodity === 'wheat');
        expect(wheat?.price).toBe('188');
        expect(wheat?.price).not.toBe('176');
        expect(wheat?.price).not.toBe('189');
    });

    it('SKIPS «Фуражна пшеница» without calling it unmapped', () => {
        // The owner's ruling, and the distinction that matters: a skipped row
        // is a decision, an unmapped row means the bulletin changed and
        // somebody must look.
        expect(BULLETIN).toContain('Фуражна пшеница');
        expect(parsed.rows.some((r) => r.label === 'Фуражна пшеница')).toBe(false);
        expect(parsed.unmappedLabels).not.toContain('Фуражна пшеница');
        expect(Object.keys(SKIPPED_LABELS)).toContain('Фуражна пшеница');
    });

    it('reports nothing unmapped for a bulletin in its current shape', () => {
        // The control on the whole reading: a parser that matched nothing
        // would also report nothing unmapped, so this is asserted beside a
        // non-empty row count.
        expect(parsed.unmappedLabels).toEqual([]);
        expect(parsed.rows.length).toBe(Object.keys(COMMODITY_BY_LABEL).length);
    });
});

describe('parsePurchasePrices — the cases the real bulletin does not show', () => {
    const table = (body: string) =>
        `Средни изкупни цени на основни зърнени и маслодайни култури\n`
        + `към 30.09.2026 г., евро/тон без ДДС\n\n`
        + `                        01.10.2025   23.09.2026   30.09.2026   год.   седм.\n`
        + body
        + `\nИзточник: САПИ ЕООД\n`;

    it('treats «*» in the current column as NO DATA, never as zero', () => {
        // The table footer says `* няма данни`. A zero purchase price renders
        // as a market collapse — the one wrong answer worse than no answer.
        const parsed = parsePurchasePrices(table('Царевица                   196   192   *   -   -\n'))!;
        expect(parsed.rows).toEqual([]);
        expect(parsed.noDataLabels).toEqual(['Царевица']);
    });

    it('still stores the OTHER rows when one has no data', () => {
        const parsed = parsePurchasePrices(
            table(
                'Царевица                   196   192   *     -     -\n'
                + 'Ечемик                     166   176   176   5,9   0,0\n',
            ),
        )!;
        expect(parsed.rows.map((r) => r.commodity)).toEqual(['barley']);
        expect(parsed.noDataLabels).toEqual(['Царевица']);
    });

    it('REPORTS a label no rule covers', () => {
        // The failure this parser cannot otherwise see: a renamed row looks
        // exactly like a week when МЗХ published fewer commodities.
        const parsed = parsePurchasePrices(
            table('Хлебна пшеничка            176   189   188   6,9   -0,5\n'),
        )!;
        expect(parsed.rows).toEqual([]);
        expect(parsed.unmappedLabels).toEqual(['Хлебна пшеничка']);
    });

    it('reads a Bulgarian decimal comma', () => {
        const parsed = parsePurchasePrices(
            table('Рапица                     424   487   475,50   11,9   -2,5\n'),
        )!;
        expect(parsed.rows[0]?.price).toBe('475.50');
    });

    it('returns null when the table is absent, rather than an empty reading', () => {
        // An empty reading is indistinguishable from a bulletin with no
        // prices; null says the parser could not find its subject.
        expect(parsePurchasePrices('4. Цени\n\nнищо тук\n')).toBeNull();
    });

    it('returns null when the «към» date is missing or impossible', () => {
        const noDate = 'Средни изкупни цени\nевро/тон без ДДС\nЕчемик 1 2 3\nИзточник\n';
        expect(parsePurchasePrices(noDate)).toBeNull();
        const badDate = 'Средни изкупни цени\nкъм 31.02.2026 г.\nЕчемик 1 2 3\nИзточник\n';
        expect(parsePurchasePrices(badDate)).toBeNull();
    });
});

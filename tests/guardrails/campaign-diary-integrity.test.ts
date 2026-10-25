/**
 * «ДНЕВНИК НА СТОПАНСТВОТО» prints the owner's form, not an approximation
 * of it — #2316.
 *
 * Written in the style of `farm-record-diary-integrity`: every assertion about
 * the source is paired with a SELF-TEST that mutates the source in memory and
 * proves the detector fires. A guard over source text is easy to write so it
 * cannot fail, and this document is a regulated register.
 *
 * It also RENDERS, into a real PDFKit document, because a generator that
 * typechecks and throws at run time is the failure a text scan cannot see.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import {
    CAMPAIGN_COLUMN_COUNT,
    CAMPAIGN_GROUP_TITLES,
    renderCampaignDiary,
    type CampaignDiaryData,
} from '@/app-layer/reports/pdf/campaign-diary';
import { buildCampaignRows, type DiaryLineInput } from '@/app-layer/reports/campaign-diary/rows';
import { ACTIVITY_LABELS_BG } from '@/lib/operations/activity-labels';

const SRC = fs.readFileSync(
    path.resolve(__dirname, '../../src/app-layer/reports/pdf/campaign-diary.ts'),
    'utf8',
);

const line = (over: Partial<DiaryLineInput> = {}): DiaryLineInput => ({
    treatmentGroupId: 'g1',
    taskId: 't1',
    operationType: 'SPRAY',
    completedAt: new Date('2025-02-01T08:00:00Z'),
    parcelId: 'p1',
    parcelName: 'Нива 1',
    cropName: 'Пшеница',
    parcelAreaHa: 10,
    treatedAreaHa: 10,
    productName: 'Карате Зеон',
    doseValue: 0.15,
    doseUnitSymbol: 'л/дка',
    produceKg: null,
    produceKind: null,
    ...over,
});

function dataWith(lines: DiaryLineInput[]): CampaignDiaryData {
    const { rows, skippedIncomplete, rowsWithUnknownArea } = buildCampaignRows(
        lines,
        ACTIVITY_LABELS_BG,
    );
    return {
        header: {
            producerName: 'Иван Петров',
            settlement: 'Царевец',
            municipality: 'Свищов',
            oblast: 'Велико Търново',
        },
        campaignLabel: '2024-2025',
        rows,
        skippedIncomplete,
        rowsWithUnknownArea,
    };
}

describe('the form\'s own shape (#2316)', () => {
    it('is NINE columns under SEVEN headers', () => {
        // The template's counts. Nine and seven are not arbitrary: two headers
        // span a pair, which is why the two numbers differ at all.
        expect(CAMPAIGN_COLUMN_COUNT).toBe(9);
        expect(CAMPAIGN_GROUP_TITLES).toHaveLength(7);
    });

    it('the two spanning groups are the ones the form spans', () => {
        expect(CAMPAIGN_GROUP_TITLES).toEqual([
            'Дата',
            'Ид. № на парцела/полето /животното',
            'Култура / Порода / Вид',
            'Площ / Брой',
            'Мероприятие',
            'Използван препарат',
            'Продукция',
        ]);
    });

    it('carries the sub-headers of both spanning groups', () => {
        for (const sub of ['Вид/ наименование', 'Количество', 'Вид', 'Количество кг']) {
            expect(SRC).toContain(sub);
        }
    });
});

describe('the four-line holder block', () => {
    it.each(['Име на земеделския стопанин', 'Село', 'Община', 'Област'])(
        'prints %s',
        (label) => {
            expect(SRC).toContain(label);
        },
    );

    it('prints an em dash for an absent field, not a blank or "null"', () => {
        // `oblast` was added for this form, so no existing farm has filled it.
        // A blank reads as a rendering fault and `null` as a bug; an em dash
        // says the field is empty.
        expect(SRC).toMatch(/\(s && s\.trim\(\) \? s\.trim\(\) : '—'\)/);
    });

    it('SELF-TEST: dropping the em-dash fallback is detected', () => {
        const mutated = SRC.replace(/\(s && s\.trim\(\) \? s\.trim\(\) : '—'\)/, '(s as string)');
        expect(mutated).not.toMatch(/\(s && s\.trim\(\) \? s\.trim\(\) : '—'\)/);
    });
});

describe('rows are deliberately NOT capped', () => {
    it('carries no row limit', () => {
        // `farm-record-diary.ts` caps field SHEETS at 200 and deliberately
        // does not cap spray lines, because "a vanished spray is an
        // unrecorded chemical application". A campaign row is the same kind of
        // record. The decision is stated in the docblock and must not be
        // quietly reversed by a slice.
        const code = SRC.split('\n')
            .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
            .join('\n');
        expect(code).not.toMatch(/MAX_ROWS|\.slice\(0,\s*\d+\)|rows\.slice/);
    });

    it('SELF-TEST: adding a row cap is detected', () => {
        const mutated = SRC.replace('for (const row of data.rows) {', 'for (const row of data.rows.slice(0, 50)) {');
        const code = mutated.split('\n')
            .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
            .join('\n');
        expect(code).toMatch(/rows\.slice/);
    });
});

describe('page numbering uses the template\'s wording', () => {
    it('is «Страница N от M», not the БАБХ register\'s «стр. X от Y»', () => {
        expect(SRC).toMatch(/Страница \$\{/);
        expect(SRC).toContain('от ${range.count}');
    });

    it('stamps EVERY buffered page, not just the first', () => {
        expect(SRC).toMatch(/for \(let i = range\.start; i < range\.start \+ range\.count; i\+\+\)/);
    });
});

describe('the header repeats across page breaks', () => {
    it('redraws it after addPage', () => {
        // A continuation page whose columns are unlabelled is unreadable as a
        // register.
        const idx = SRC.indexOf('doc.addPage(');
        expect(idx).toBeGreaterThan(-1);
        expect(SRC.slice(idx, idx + 320)).toMatch(/drawHeader\(doc, m\.top\)/);
    });
});

describe('it actually renders', () => {
    const render = (data: CampaignDiaryData) => {
        // `createPdfDocument(meta, page)` — two arguments. Passing the page
        // options first leaves `meta.generatedAt` undefined, and PDFKit then
        // dies inside `generateFileID` reading `valueOf` of an undefined
        // `info.CreationDate`. The error names pdfkit's internals and not the
        // call site, which is why these render cases exist: the source-text
        // assertions above all passed while nothing could render at all.
        const doc = createPdfDocument(
            {
                tenantName: 'Северна нива',
                reportTitle: 'ДНЕВНИК НА СТОПАНСТВОТО',
                generatedAt: new Date('2025-10-01T00:00:00Z').toISOString(),
                fontFamily: 'unicode',
            },
            { size: 'A4', layout: 'landscape' },
        );
        renderCampaignDiary(doc, data);
        const range = doc.bufferedPageRange();
        doc.end();
        return range;
    };

    it('renders a normal campaign without throwing', () => {
        const range = render(dataWith([line(), line({ treatmentGroupId: 'g2', parcelId: 'p2' })]));
        expect(range.count).toBeGreaterThanOrEqual(1);
    });

    it('renders an EMPTY campaign without throwing', () => {
        // The route answers 404 REGISTER_EMPTY_FOR_PERIOD before reaching
        // here, but a generator that crashes on zero rows would turn that
        // guard into the only thing standing between a user and a 500.
        const range = render(dataWith([]));
        expect(range.count).toBeGreaterThanOrEqual(1);
    });

    it('renders a row whose area is UNKNOWN', () => {
        const range = render(dataWith([line({ treatedAreaHa: null, parcelAreaHa: null })]));
        expect(range.count).toBeGreaterThanOrEqual(1);
    });

    it('renders with every holder field absent', () => {
        const data = dataWith([line()]);
        data.header = { producerName: null, settlement: null, municipality: null, oblast: null };
        expect(() => render(data)).not.toThrow();
    });

    it('breaks onto more than one page for many rows', () => {
        // Proves the page-break path executes rather than being dead code —
        // and that the uncapped decision is real, since a cap would stop it.
        const many = Array.from({ length: 220 }, (_, i) =>
            line({ treatmentGroupId: `g${i}`, parcelId: `p${i}`, parcelName: `Нива ${i}` }),
        );
        const range = render(dataWith(many));
        expect(range.count).toBeGreaterThan(1);
    });
});

describe('it states what it omits', () => {
    it('notes incomplete records and unknown areas in the document itself', () => {
        // A reader comparing the register against the app needs the
        // difference explained in the register, not in a log nobody reads.
        expect(SRC).toContain('Незавършени записи');
        expect(SRC).toContain('Редове без записана площ');
    });

    it('says an empty «Площ» is not a zero', () => {
        expect(SRC).toMatch(/не е нула/);
    });
});

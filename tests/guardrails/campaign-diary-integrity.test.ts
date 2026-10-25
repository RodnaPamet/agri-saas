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

import { blankNonCode } from '../helpers/blank-non-code';

const RAW = fs.readFileSync(
    path.resolve(__dirname, '../../src/app-layer/reports/pdf/campaign-diary.ts'),
    'utf8',
);

/**
 * Comments blanked, positions preserved (#1774, #1387).
 *
 * Every assertion below asks a question about CODE — a label in `GROUPS`, a
 * fallback expression, a loop bound. This file's docblocks discuss all of
 * them at length, so a raw scan would be satisfied by the prose explaining a
 * mechanism rather than the mechanism.
 *
 * `a-source-scanning-guard-blanks-its-comments` caught this on arrival, which
 * is what its debt register is for: it failed because the guard was new and
 * unblanked, not because it was listed. Registering it would have been the
 * wrong fix — the register is a debt list, and this had no debt to record.
 */
const SRC = blankNonCode(RAW);

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
        const mutated = blankNonCode(
            RAW.replace(/\(s && s\.trim\(\) \? s\.trim\(\) : '—'\)/, '(s as string)'),
        );
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
        // `SRC` is already blanked, so no hand-rolled stripper here — that is
        // the thing `comment-stripper-order` exists to distrust.
        expect(SRC).not.toMatch(/MAX_ROWS|\.slice\(0,\s*\d+\)|rows\.slice/);
    });

    it('SELF-TEST: adding a row cap is detected', () => {
        const mutated = blankNonCode(
            RAW.replace('for (const row of data.rows) {', 'for (const row of data.rows.slice(0, 50)) {'),
        );
        expect(mutated).toMatch(/rows\.slice/);
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

/**
 * The «Продукция / Вид» column never shows a `LogQuantity.label` again.
 *
 * ## What shipped, and why the unit test was green
 *
 * `recordHarvestTotal` (backend-1's #2356) writes the activity's single kg
 * total onto ONE line's entry, with `label: 'Общо за мероприятието'` — a note
 * saying the figure is the activity's total and not that parcel's yield. Its
 * own docblock names the cost it was accepting: "a line read in isolation
 * could be misread as that parcel's yield."
 *
 * The gatherer read that label as the produce KIND:
 *
 *     const kind = e.quantities.find((q) => q.label)?.label ?? e.title;
 *
 * so every harvest row printed «Общо за мероприятието» under a column headed
 * «Вид» — the note itself, in a typed cell, on a register a farmer signs.
 *
 * `campaign-diary-rows` asserted `produceKind` was `'Пшеница'` and passed,
 * because the FIXTURE supplied `produceKind: 'Пшеница'` — a value production
 * never writes. A fixture that invents the field under test cannot fail on its
 * content, so the only thing that could have caught this was reading the
 * writer. It was found when backend-1 relayed the label they had chosen.
 *
 * ## Why this is a source assertion and not a row assertion
 *
 * The field is GONE from `DiaryLineInput`, so no row-level test can express
 * the defect any more — there is nowhere to put the label. What remains
 * reachable is the gatherer growing the read back, which is a question about
 * the query, so this reads the query.
 */
describe('the gatherer does not read a quantity label (#2316)', () => {
    const GATHER = blankNonCode(
        fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/reports/campaign-diary/gather.ts'),
            'utf8',
        ),
        { strings: true },
    );

    /**
     * EVERY `quantities: { … }` block in the source.
     *
     * Plural because the first version took `indexOf('quantities:')` and got
     * the «Продукция» query's WHERE filter — `quantities: { some: { measure:
     * 'WEIGHT' } }` — which appears earlier in the file than the `select`. It
     * reported `{ some: { measure: } }` and the positive control below failed
     * on the missing `value`, which is the only reason the aim was noticed: a
     * guard pointed one level off still runs, still passes its negated
     * assertions, and grades nothing.
     *
     * Checking all of them is also the better claim. A label must not be
     * selected in any of them, and a future second query cannot slip past by
     * being the one this does not look at.
     */
    const quantitiesBlocks = (src: string): string[] => {
        const out: string[] = [];
        // Brace-matched, not line-counted: these blocks nest inside `select`
        // and `where`, so a fixed window clips or over-reads.
        for (let at = src.indexOf('quantities:'); at !== -1; at = src.indexOf('quantities:', at + 1)) {
            const open = src.indexOf('{', at);
            if (open === -1) continue;
            let depth = 0;
            for (let i = open; i < src.length; i++) {
                if (src[i] === '{') depth++;
                else if (src[i] === '}' && --depth === 0) {
                    out.push(src.slice(open, i + 1));
                    break;
                }
            }
        }
        return out;
    };

    /** The one that projects columns, as opposed to the one that filters rows. */
    const selectBlock = (src: string): string =>
        quantitiesBlocks(src).find((b) => /\bselect\b/.test(b)) ?? '';

    it('[campaign-produce] the blocks it examines are really the query', () => {
        const all = quantitiesBlocks(GATHER);
        const sel = selectBlock(GATHER);
        for (const b of all) {
            console.log(`[campaign-produce] block: ${b.replace(/\s+/g, ' ').trim()}`);
        }
        console.log(`[campaign-produce] ${all.length} block(s); select block found: ${sel !== ''}`);
        // An extraction that returned nothing would pass every negated
        // assertion below over an empty string — the shape that makes an empty
        // window look clean.
        expect(all.length).toBeGreaterThanOrEqual(1);
        expect(sel).not.toBe('');
        // The projection, so `value` must be in it. This is what caught the
        // aim being one level off: the filter block has no `value` and the
        // assertion failed rather than passing over the wrong block.
        expect(sel).toMatch(/\bvalue\b/);
        // `measure`, not `'WEIGHT'`. The source is blanked with
        // `strings: true`, so the literal is spaces by the time this reads it.
        expect(all.join(' ')).toMatch(/\bmeasure\b/);
    });

    it('selects the quantity VALUE and not its label', () => {
        for (const b of quantitiesBlocks(GATHER)) {
            expect(b).not.toMatch(/\blabel\b/);
        }
    });

    it('derives no produce kind anywhere in the gatherer', () => {
        // The field is gone from the line shape, so its reappearance here is
        // the regression — by that name or by reading `q.label` under any other.
        expect(GATHER).not.toMatch(/produceKind|kindByLine/);
        // Deliberately NOT a blanket ban on `.label`: the first version of
        // this assertion failed on `campaignLabel: window.label`, the campaign
        // window's own label and nothing to do with a quantity. A guard that
        // forbids an unrelated legitimate read is a false alarm waiting for
        // the next reader to silence it.
        //
        // The select assertion above is the stronger claim anyway. Prisma's
        // `select` is exhaustive, so a field that is not selected is not on
        // the returned object: no code CAN read a label that the query does
        // not ask for, whatever it calls the variable.
    });

    describe('self-test: the detector fires on the code that shipped', () => {
        const SHIPPED = blankNonCode(
            `
            const produce = await db.logEntry.findMany({
                where: {
                    operationParcelId: { in: lines.map((l) => l.id) },
                    type: 'HARVEST',
                    deletedAt: null,
                    quantities: { some: { measure: 'WEIGHT' } },
                },
                select: {
                    operationParcelId: true,
                    title: true,
                    quantities: {
                        where: { measure: 'WEIGHT' },
                        select: { value: true, label: true },
                    },
                },
            });
            const kindByLine = new Map<string, string>();
            const kind = e.quantities.find((q) => q.label)?.label ?? e.title;
        `,
            { strings: true },
        );

        it('the label select is detected', () => {
            expect(selectBlock(SHIPPED)).toMatch(/\blabel\b/);
        });

        it('the filter block is not mistaken for the projection', () => {
            // The aiming error, pinned. `SHIPPED` has a `where` filter on
            // `quantities` before its `select`, exactly as the real query
            // does, so a `indexOf`-first extractor returns the filter.
            const sel = selectBlock(SHIPPED);
            expect(sel).toMatch(/\bselect\b/);
            expect(sel).toMatch(/\bvalue\b/);
            expect(quantitiesBlocks(SHIPPED).length).toBeGreaterThanOrEqual(2);
        });

        it('the derivation is detected', () => {
            expect(SHIPPED).toMatch(/produceKind|kindByLine/);
        });

        it('a commented-out label select does NOT read as code', () => {
            // The fifth time an assertion of mine matched my own prose would
            // have been here: the explanation above quotes the defective line
            // verbatim, so an unblanked scan of this very file would fail.
            const commented = blankNonCode(
                `quantities: {\n    // select: { value: true, label: true },\n    select: { value: true },\n}`,
                { strings: true },
            );
            for (const b of quantitiesBlocks(commented)) {
                expect(b).not.toMatch(/\blabel\b/);
            }
            expect(quantitiesBlocks(commented).length).toBeGreaterThanOrEqual(1);
        });
    });
});

/**
 * Unit tests — БАБХ ДНЕВНИК generator (PR2).
 *   - pure row builders (дка = ha×10, earliest-harvest = completedAt + PHI)
 *   - full render smoke: Cyrillic renders (no throw), embeds DejaVu, valid PDF
 *   - blank-profile tolerance
 * DB-free: exercises the pure `renderFarmRecordDiary` over fixture data.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import {
    renderFarmRecordDiary,
    buildChemicalRows,
    buildFertilizerRows,
    buildObservationRows,
    buildChemFieldHeaderRow,
    buildObsFieldHeaderRow,
    groupSprayLinesByField,
    MAX_FIELD_SHEETS,
    BG_LABELS,
    type FarmRecordData,
    type FieldHeaderData,
    type SprayLineData,
    type FertilizeLineData,
    type FarmProfileData,
} from '@/app-layer/reports/pdf/farm-record-diary';

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
}

const PROFILE: FarmProfileData = {
    producerName: 'ЕТ „Иван Петров“',
    egn: '7501011234',
    eik: '203456789',
    address: 'с. Труд, ул. Роза 5',
    municipality: 'Марица',
    settlement: 'Труд',
    agricultureDirectorateCity: 'Пловдив',
    registrationPlace: 'Пловдив',
    registrationEkatte: '73242',
    odbhCity: 'Пловдив',
};

const SPRAY: SprayLineData[] = [
    {
        parcelId: 'parcel-1',
        completedAt: new Date('2026-05-10T08:00:00Z'),
        targetNote: 'Житна пиявица',
        productName: 'Карате Зеон',
        dose: '0.15 л/дка',
        areaHa: 3.5,
        applicationTechnique: 'Наземна пръскачка',
        quarantineDays: 30,
        operatorCertNo: 'APP-123',
        agronomistName: 'Мария Иванова',
        agronomistCertNo: 'AGR-456',
    },
    {
        parcelId: 'parcel-2',
        completedAt: new Date('2026-05-20T08:00:00Z'),
        targetNote: 'Брашнеста мана',
        productName: 'Топас 100 ЕК',
        dose: '0.5 л/дка',
        areaHa: 2,
        applicationTechnique: null,
        quarantineDays: 14,
        operatorCertNo: null,
        agronomistName: null,
        agronomistCertNo: null,
    },
];

const FIELDS: FieldHeaderData[] = [
    {
        parcelId: 'parcel-1',
        fieldNo: '001',
        cadastralId: '73242.15.8',
        landDistrict: 'Труд',
        locality: 'Каменица',
        produceStore: 'Склад №1',
        cropType: 'Пшеница',
        variety: 'Енола',
        areaHa: 3.5,
        predecessor: 'Слънчоглед',
        sowDate: new Date('2025-10-05T00:00:00Z'),
    },
    {
        parcelId: 'parcel-2',
        fieldNo: '002',
        cadastralId: null,
        landDistrict: null,
        locality: null,
        produceStore: null,
        cropType: 'Царевица',
        variety: null,
        areaHa: 2,
        predecessor: null,
        sowDate: null,
    },
];

const FERT: FertilizeLineData[] = [
    {
        completedAt: new Date('2026-04-01T08:00:00Z'),
        productName: 'Амониев нитрат',
        activeIngredient: 'N 34.4%',
        dose: '25 кг/дка',
        areaHa: 3.5,
    },
];

function fixture(profile: FarmProfileData): FarmRecordData {
    return {
        locationName: 'Северна нива',
        from: '2026-01-01T00:00:00Z',
        to: '2026-12-31T23:59:59Z',
        profile,
        sprayLines: SPRAY,
        fertilizeLines: FERT,
        observations: [],
        fields: FIELDS,
    };
}

/** Render `data` and return how many pages it produced. */
async function pageCount(data: FarmRecordData): Promise<number> {
    const doc = createPdfDocument({
        tenantName: 'Северна нива',
        reportTitle: 'Дневник',
        generatedAt: new Date(0).toISOString(),
        fontFamily: 'unicode',
    });
    renderFarmRecordDiary(doc, data, BG_LABELS);
    const count = doc.bufferedPageRange().count;
    await collect(doc);
    return count;
}

describe('farm-record-diary — Cyrillic font invariant (guard)', () => {
    // The ДНЕВНИК is Bulgarian: it MUST be built with fontFamily:'unicode'
    // so createPdfDocument remaps Helvetica → DejaVu Sans. Without it the
    // built-in AFM Helvetica renders tofu (or throws) for Cyrillic. This
    // structural guard fails if a refactor drops the unicode opt-in.
    test('the generator creates its document with fontFamily: "unicode"', () => {
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/reports/pdf/farm-record-diary.ts'),
            'utf8',
        );
        expect(src).toMatch(/fontFamily:\s*'unicode'/);
    });
});

describe('farm-record-diary — pure row builders', () => {
    test('buildChemicalRows: one row per spray line, дка = ha×10, earliest-harvest = completedAt + PHI', () => {
        const rows = buildChemicalRows(SPRAY);
        expect(rows).toHaveLength(2);
        // Row 1: area 3.5 ha → 35 дка; PHI 30d from 2026-05-10 → 2026-06-09.
        expect(rows[0][0]).toBe('1');
        expect(rows[0][5]).toBe('35'); // дка column
        expect(rows[0][8]).toBe('09.06.2026'); // earliest harvest
        expect(rows[0][9]).toBe('APP-123'); // operator cert (чл. 84 ал. 2)
        expect(rows[0][10]).toBe('Мария Иванова / AGR-456'); // agronomist (ал. 1)
        expect(rows[0][11]).toBe(''); // Подпис blank
        // Row 2: area 2 ha → 20 дка; blank certs.
        expect(rows[1][5]).toBe('20');
        expect(rows[1][9]).toBe('');
    });

    test('buildFertilizerRows: дка conversion + composition', () => {
        const rows = buildFertilizerRows(FERT);
        expect(rows).toHaveLength(1);
        expect(rows[0][2]).toBe('Амониев нитрат; N 34.4%');
        expect(rows[0][4]).toBe('35'); // 3.5 ha → 35 дка
    });

    test('buildObservationRows: 11 cells, disease/pest at their columns, blanks elsewhere', () => {
        const rows = buildObservationRows([
            {
                occurredAt: new Date('2026-05-01T08:00:00Z'),
                phenophase: 'BBCH 32',
                disease: 'Брашнеста мана',
                pest: 'Листни въшки',
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toHaveLength(BG_LABELS.obsCols.length);
        expect(rows[0][0]).toBe('01.05.2026');
        expect(rows[0][1]).toBe('BBCH 32');
        expect(rows[0][2]).toBe('Брашнеста мана'); // Болест
        expect(rows[0][6]).toBe('Листни въшки'); // Неприятел
        // Manually-filled survey columns stay blank (ruled for hand entry).
        for (const i of [3, 4, 5, 7, 8, 9, 10]) expect(rows[0][i]).toBe('');
    });
});

describe('farm-record-diary — render smoke', () => {
    test('renders a multi-section Cyrillic PDF that embeds DejaVu (no tofu, no throw)', async () => {
        const doc = createPdfDocument({
            tenantName: 'Северна нива',
            reportTitle: 'Дневник',
            generatedAt: new Date(0).toISOString(),
            fontFamily: 'unicode',
        });
        expect(() => renderFarmRecordDiary(doc, fixture(PROFILE), BG_LABELS)).not.toThrow();
        const pdf = await collect(doc);
        expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
        expect(pdf.length).toBeGreaterThan(1000);
        // DejaVu embedded → real Cyrillic glyphs, not Helvetica tofu.
        expect(pdf.includes(Buffer.from('DejaVu'))).toBe(true);
    });

    test('tolerates an all-blank FarmProfile (dotted lines, no throw)', async () => {
        const blank: FarmProfileData = {
            producerName: null,
            egn: null,
            eik: null,
            address: null,
            municipality: null,
            settlement: null,
            agricultureDirectorateCity: null,
            registrationPlace: null,
            registrationEkatte: null,
            odbhCity: null,
        };
        const doc = createPdfDocument({
            tenantName: 'Farm',
            reportTitle: 'Дневник',
            generatedAt: new Date(0).toISOString(),
            fontFamily: 'unicode',
        });
        expect(() => renderFarmRecordDiary(doc, fixture(blank), BG_LABELS)).not.toThrow();
        const pdf = await collect(doc);
        expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
    });
});

describe('ДНЕВНИК per-field header — the strip the form is built around', () => {
    test('buildChemFieldHeaderRow: 11 cells in the form\u2019s order, дка = ha\u00d710', () => {
        const row = buildChemFieldHeaderRow(FIELDS[0], PROFILE.settlement);
        expect(row).toHaveLength(BG_LABELS.chemFieldHeader.length);
        expect(row).toHaveLength(11);
        expect(row[0]).toBe('Труд'); // Населено място — holding-level
        expect(row[1]).toBe('Труд'); // Землище
        expect(row[2]).toBe('Склад №1'); // Склад за растителна продукция
        expect(row[3]).toBe('Каменица'); // Местност
        expect(row[4]).toBe('73242.15.8'); // Кадастрален №
        expect(row[5]).toBe('001'); // Поле №
        expect(row[6]).toBe('Пшеница'); // Култура
        expect(row[7]).toBe('Енола'); // Сорт/хибрид
        expect(row[8]).toBe('35'); // Засята площ, 3.5 ha → 35 дка
        expect(row[9]).toBe('Слънчоглед'); // Предшественик
        expect(row[10]).toBe('05.10.2025'); // Дата на сеитба
    });

    test('buildObsFieldHeaderRow: 5 cells, field number first', () => {
        const row = buildObsFieldHeaderRow(FIELDS[0]);
        expect(row).toHaveLength(BG_LABELS.obsFieldHeader.length);
        expect(row).toHaveLength(5);
        expect(row[0]).toBe('001');
        expect(row[1]).toBe('Пшеница');
        expect(row[2]).toBe('Енола');
        expect(row[3]).toBe('35');
        expect(row[4]).toBe('Слънчоглед');
    });

    test('a null field yields a full-width EMPTY strip — never an invented value', () => {
        const chem = buildChemFieldHeaderRow(null, null);
        expect(chem).toHaveLength(BG_LABELS.chemFieldHeader.length);
        expect(chem.every((c) => c === '')).toBe(true);
        const obs = buildObsFieldHeaderRow(null);
        expect(obs).toHaveLength(BG_LABELS.obsFieldHeader.length);
        expect(obs.every((c) => c === '')).toBe(true);
    });

    test('missing per-field values print blank, they do not fall back to another field', () => {
        const row = buildChemFieldHeaderRow(FIELDS[1], PROFILE.settlement);
        // parcel-2 has no cadastral id, землище, местност, склад, сорт,
        // предшественик or sow date — every one of them must be empty rather
        // than borrowed from parcel-1.
        for (const i of [1, 2, 3, 4, 7, 9, 10]) expect(row[i]).toBe('');
        expect(row[5]).toBe('002');
        expect(row[6]).toBe('Царевица');
    });
});

describe('ДНЕВНИК per-field register — one chemical sheet per field', () => {
    test('each extra field adds exactly one sheet', async () => {
        // No spray lines, so the field list is the ONLY thing varying. With
        // lines present, dropping a field does not remove its sheet — the
        // orphan guard turns it into a blank-strip sheet instead, which is
        // the point of that guard and would mask the effect measured here.
        const base = { ...fixture(PROFILE), sprayLines: [] };
        const one = await pageCount({ ...base, fields: [FIELDS[0]] });
        const two = await pageCount({ ...base, fields: FIELDS });
        expect(two - one).toBe(1);
    });

    test('a treatment on an unknown field still prints, on a sheet of its own', async () => {
        // The orphan guard: a legal register may not silently drop a
        // treatment just because its field is not in `fields`.
        const base = await pageCount({ ...fixture(PROFILE), sprayLines: [], fields: FIELDS });
        const orphaned = await pageCount({
            ...fixture(PROFILE),
            sprayLines: [{ ...SPRAY[0], parcelId: 'parcel-does-not-exist' }],
            fields: FIELDS,
        });
        expect(orphaned - base).toBe(1);
    });

    test('a period with no fields and no treatments still prints its section', async () => {
        const empty = await pageCount({
            ...fixture(PROFILE),
            sprayLines: [],
            fields: [],
        });
        const one = await pageCount({ ...fixture(PROFILE), sprayLines: [], fields: [FIELDS[0]] });
        // One blank sheet, exactly as a single field would get.
        expect(empty).toBe(one);
    });
});

describe('ДНЕВНИК per-field register — no treatment disappears from a legal document', () => {
    test('a treatment on a field beyond the sheet cap still appears in the register', () => {
        // gatherFarmRecordData caps the FIELD list at MAX_FIELD_SHEETS; the
        // spray lines are not capped. So a treatment carried out on a field
        // past the bound arrives carrying a parcelId that no field matches.
        // It has to print anyway: an unprinted spray is an unrecorded
        // chemical application on a register the ministry reads.
        const cappedFields = Array.from({ length: MAX_FIELD_SHEETS }, (_, i) => ({
            ...FIELDS[0],
            parcelId: `parcel-${i}`,
            fieldNo: String(i + 1),
        }));
        const beyondTheCap = { ...SPRAY[0], parcelId: 'parcel-past-the-cap' };
        const printed = groupSprayLinesByField(cappedFields, [beyondTheCap]).flatMap(
            (g) => g.lines,
        );
        expect(printed).toContain(beyondTheCap);
    });

    test('every treatment is printed, whatever the field list', () => {
        for (const fields of [FIELDS, [FIELDS[0]], []]) {
            const printed = groupSprayLinesByField(fields, SPRAY).flatMap((g) => g.lines);
            expect(printed).toHaveLength(SPRAY.length);
            for (const line of SPRAY) expect(printed).toContain(line);
        }
    });

    test('no treatment is printed twice', () => {
        // A duplicated line claims an application that never happened — as
        // wrong as a missing one, and easier to introduce.
        const printed = groupSprayLinesByField(FIELDS, SPRAY).flatMap((g) => g.lines);
        expect(new Set(printed).size).toBe(printed.length);
    });

    test('lines land under THEIR field, not a neighbour\u2019s', () => {
        const groups = groupSprayLinesByField(FIELDS, SPRAY);
        const first = groups.find((g) => g.field?.parcelId === 'parcel-1');
        const second = groups.find((g) => g.field?.parcelId === 'parcel-2');
        expect(first?.lines).toEqual([SPRAY[0]]);
        expect(second?.lines).toEqual([SPRAY[1]]);
    });
});

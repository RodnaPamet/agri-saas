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
    fmtDate,
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
    isRegisterEmpty,
    type ObservationData,
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
        treatedAreaHa: null,   // the whole parcel
        phenophase: null,
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
        treatedAreaHa: null,   // the whole parcel
        phenophase: null,
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
        treatedAreaHa: null,   // the whole parcel
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

    it('«Третирани площи» prints the TREATED area, falling back to the parcel (#2072)', () => {
        const line = SPRAY[0];
        // Column 6 of the 12-column ХИМИЧНИ ОБРАБОТКИ table, in декари.
        const AREA_COL = 5;

        // areaHa 3.5 ha = 35 дка, and the fixture treats the whole parcel.
        const [whole] = buildChemicalRows([{ ...line, treatedAreaHa: null }]);
        expect(whole[AREA_COL]).toBe('35');

        // Partly treated: 1.2 ha = 12 дка. The PARCEL is still 3.5 ha, so a
        // row printing 35 here would overstate what was sprayed on a document
        // the farmer submits to БАБХ.
        const [part] = buildChemicalRows([{ ...line, treatedAreaHa: 1.2 }]);
        expect(part[AREA_COL]).toBe('12');

        // The whole parcel stated explicitly must read the same as null —
        // otherwise the fallback and the explicit value disagree.
        const [exact] = buildChemicalRows([{ ...line, treatedAreaHa: 3.5 }]);
        expect(exact[AREA_COL]).toBe(whole[AREA_COL]);
    });

    it('the Техника column renders a slug in Bulgarian and passes anything else through', () => {
        // `applicationTechnique` is free text on a legally-filed register and
        // the column used to print RAW — production held `Dron` and `dron`,
        // neither of which is the vocabulary slug. Known slugs are now
        // localised; everything else is shown exactly as recorded, because a
        // filed register must report what was entered rather than a guess.
        const line = { ...SPRAY[0] };
        const [slug] = buildChemicalRows([{ ...line, applicationTechnique: 'drone' }]);
        expect(slug[6]).toBe('Дрон');

        // Case-folded — rows predate the write-side normalisation.
        const [upper] = buildChemicalRows([{ ...line, applicationTechnique: 'Drone' }]);
        expect(upper[6]).toBe('Дрон');

        // Unknown value: unchanged, not blanked.
        const [freeText] = buildChemicalRows([
            { ...line, applicationTechnique: 'самоделна пръскачка' },
        ]);
        expect(freeText[6]).toBe('самоделна пръскачка');

        // Absent: an empty cell, not the string "null".
        const [absent] = buildChemicalRows([{ ...line, applicationTechnique: null }]);
        expect(absent[6]).toBe('');
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
                derived: false,   // a real observation, recorded by a person
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

    test('an unparseable period does not throw the render (#1575)', async () => {
        // A smoke test only, and labelled as such: PDFKit writes text as GLYPH
        // INDICES once a Unicode font is embedded, so searching the buffer for
        // "NaN" finds nothing whether `fmtDate` guards or not. A version of
        // this test did exactly that and passed with the guard REMOVED.
        //
        // The guard's real test is on `fmtDate` directly, below.
        const doc = createPdfDocument({
            tenantName: 'Северна нива',
            reportTitle: 'Дневник',
            generatedAt: new Date(0).toISOString(),
            fontFamily: 'unicode',
        });
        const broken: FarmRecordData = { ...fixture(PROFILE), from: 'abcd', to: 'not-a-date' };
        expect(() => renderFarmRecordDiary(doc, broken, BG_LABELS)).not.toThrow();
        const pdf = await collect(doc);
        expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
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
    /**
     * REVERSED, 2026-10-23 (#2183 ask 4). The arms below are unchanged; the
     * EXPECTATION was 1 and is now 0, because this case was asserting the
     * defect. Its own note explained the behaviour it was pinning — "the
     * second field is untreated and still gets its own blank-strip sheet,
     * because the register is filed per field" — and that blank sheet is
     * exactly what the owner ruled out: "only parcels sprayed in the period
     * get a spraying sheet. Blank parcel sheets go as well."
     *
     * Kept rather than deleted, with the same arms, because the measurement
     * was right and only the expected answer was wrong. Reading the two
     * together says what changed.
     */
    test('an extra UNSPRAYED field adds NO sheet (#2183 ask 4)', async () => {
        const base = { ...fixture(PROFILE), sprayLines: [SPRAY[0]] };
        const one = await pageCount({ ...base, fields: [FIELDS[0]] });
        const two = await pageCount({ ...base, fields: FIELDS });
        expect(two - one).toBe(0);
    });

    test('an extra SPRAYED field DOES add exactly one sheet', async () => {
        // The other direction, and the positive control for the case above: a
        // filter that dropped every per-field sheet would satisfy "adds no
        // sheet" while destroying the register. The document is filed per
        // field and that is still true for the fields that were sprayed.
        const base = { ...fixture(PROFILE), fields: FIELDS };
        const oneSprayed = await pageCount({ ...base, sprayLines: [SPRAY[0]] });
        const twoSprayed = await pageCount({ ...base, sprayLines: SPRAY });
        expect(twoSprayed - oneSprayed).toBe(1);
    });

    test('a treatment on an unknown field still prints, on a sheet of its own', async () => {
        // The orphan guard: a legal register may not silently drop a treatment
        // just because its field is not in `fields`.
        //
        // The NO-LINES baseline is usable again. This case had moved away from
        // it, noting that "the section is absent from it entirely, and the
        // measured difference became 3 rather than 1" — 3 because two empty
        // per-field sheets rode along with the orphan's. #2183 ask 4 removes
        // those two, so the difference is back to the 1 sheet the orphan
        // itself contributes, and the comparison says what it means again.
        const noLines = await pageCount({
            ...fixture(PROFILE),
            sprayLines: [],
            fields: FIELDS,
        });
        const orphanOnly = await pageCount({
            ...fixture(PROFILE),
            sprayLines: [{ ...SPRAY[0], parcelId: 'parcel-does-not-exist' }],
            fields: FIELDS,
        });
        expect(orphanOnly - noLines).toBe(1);
    });

    test('a period with no treatments OMITS the section, rather than filing a blank sheet', async () => {
        // REVERSED by #2183 (owner ruling 2026-10-23). This test was called
        // 'a period with no fields and no treatments still prints its section'
        // and asserted `empty === one` — one blank sheet either way, "exactly
        // as a single field would get".
        //
        // That stopped being true and, worse, the old assertion kept PASSING:
        // with the section omitted both sides render 0 sheets, so `empty ===
        // one` holds for a reason opposite to the one its name gave. A test
        // that passes because its subject disappeared is the shape worth
        // naming.
        const noTreatments = await pageCount({
            ...fixture(PROFILE),
            sprayLines: [],
            fields: [],
        });
        const sprayed = await pageCount({
            ...fixture(PROFILE),
            sprayLines: [SPRAY[0]],
            fields: [FIELDS[0]],
        });
        expect(sprayed - noTreatments).toBe(1);
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

    /**
     * #2183 ask 4, the owner's fourth ruling of 2026-10-22: "only parcels
     * sprayed in the period get a spraying sheet. Blank parcel sheets go as
     * well."
     *
     * This only ever affected the BLOCK register. `fields` is built from a
     * parcel query scoped two ways: a treatment-scoped document limits it to
     * the parcels the treatment touched (#1740), a block-scoped one takes
     * every live parcel of the block. So the ruling is about the second.
     */
    test('gives NO sheet to a field with no line in the period (#2183 ask 4)', () => {
        const groups = groupSprayLinesByField(FIELDS, [SPRAY[0]]);
        expect(groups.map((g) => g.field?.parcelId)).toEqual(['parcel-1']);
    });

    test('still prints one sheet PER sprayed field — the filter is not a cap of one', () => {
        // Without this, a filter that collapsed everything to a single group
        // would satisfy the case above. The register is filed per field.
        const groups = groupSprayLinesByField(FIELDS, SPRAY);
        expect(groups.map((g) => g.field?.parcelId).sort()).toEqual(['parcel-1', 'parcel-2']);
    });

    test('an ORPHAN line keeps its blank-strip sheet even though it has no field', () => {
        // The one group that must survive the filter: a line whose parcel is
        // past MAX_FIELD_SHEETS has no `field`, and dropping it would be an
        // unrecorded chemical application. Asserted here beside the filter so
        // the two rules are read together.
        const orphan = { ...SPRAY[0], parcelId: 'parcel-nowhere' };
        const groups = groupSprayLinesByField(FIELDS, [orphan]);
        expect(groups).toHaveLength(1);
        expect(groups[0].field).toBeNull();
        expect(groups[0].lines).toEqual([orphan]);
    });
});

describe('fmtDate — an Invalid Date must not render digits (#1575)', () => {
    // `fmtDate` builds its string from `getUTCDate()` / `getUTCMonth()` /
    // `getUTCFullYear()`, and `String(NaN).padStart(2, '0')` is the string
    // "NaN". So without a guard an Invalid Date rendered "NaN.NaN.NaN" into
    // the ДНЕВНИК header at `:695` — a compliance document headed
    // "Период: NaN.NaN.NaN – NaN.NaN.NaN", returned with a 200.
    //
    // Unreachable in production since #1575 validates the period at the route,
    // and the Prisma query at `:910` throws before the header renders anyway.
    // This is defence in depth: the hazard is ORDERING, not behaviour.

    it('renders a valid date normally — the positive control', () => {
        expect(fmtDate(new Date('2026-10-08T00:00:00Z'))).toBe('08.10.2026');
    });

    it('renders BLANK for an Invalid Date, not "NaN.NaN.NaN"', () => {
        // Blank is deliberate rather than a throw: it is what this function
        // already gives a MISSING date, so a malformed one reads the same
        // instead of inventing digits.
        expect(fmtDate(new Date('abcd'))).toBe('');
        expect(fmtDate(new Date('2026-13-45'))).toBe('');
    });

    it('the un-guarded arithmetic really did produce "NaN.NaN.NaN" — the premise', () => {
        // Asserted rather than described, so the reason the guard exists
        // survives somebody deciding it looks redundant.
        const d = new Date('abcd');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        expect(`${dd}.${mm}.${d.getUTCFullYear()}`).toBe('NaN.NaN.NaN');
    });

    it('still renders blank for null and undefined', () => {
        expect(fmtDate(null)).toBe('');
        expect(fmtDate(undefined)).toBe('');
    });
});

/**
 * An empty DATA section is left out; the two blank forms stay (#2183).
 *
 * ## Why these count PAGES
 *
 * The obvious test — render, then search the buffer for «ПРОВЕДЕНИ ХИМИЧНИ
 * ОБРАБОТКИ» — cannot work, and the `fmtDate` suite above already paid for
 * finding out: once a Unicode font is embedded PDFKit writes text as GLYPH
 * INDICES, so a buffer search finds nothing whether the section rendered or
 * not. Each section opens with `doc.addPage(...)`, so the page count is a real
 * observable — and it is what a farmer sees, because the difference is pages
 * they hold.
 *
 * ## The distinction the ruling turns on
 *
 * Five sections. THREE carry data: observations, chemical treatments,
 * fertilizers. TWO are ruled forms that arrive EMPTY on purpose — the sampling
 * sheet and the ОДБХ inspector result — for completion by hand. Nothing in the
 * phrase "omit empty sections" distinguishes them, which is why the last case
 * here exists.
 */
describe('ДНЕВНИК omits an empty data section (#2183)', () => {
    const OBS: ObservationData[] = [
        {
            occurredAt: new Date('2026-05-02T08:00:00Z'),
            phenophase: null,
            disease: null,
            pest: 'Житна пиявица',
            derived: false,
        },
    ];

    /**
     * The COVER alone. It was 3 — cover plus the sampling and ОДБХ sheets —
     * until the owner ruled those two out as well (#2183, 2026-10-23).
     */
    const STRUCTURAL_PAGES = 1;

    const only = (over: Partial<FarmRecordData>): FarmRecordData => ({
        ...fixture(PROFILE),
        sprayLines: [],
        fertilizeLines: [],
        observations: [],
        fields: FIELDS,
        ...over,
    });

    test('drops the OBSERVATIONS page when nothing was observed', async () => {
        const withObs = await pageCount(only({ sprayLines: [SPRAY[0]], observations: OBS }));
        const without = await pageCount(only({ sprayLines: [SPRAY[0]] }));
        expect(withObs - without).toBe(1);
    });

    test('drops the FERTILIZER page when nothing was applied', async () => {
        const withFert = await pageCount(only({ sprayLines: [SPRAY[0]], fertilizeLines: FERT }));
        const without = await pageCount(only({ sprayLines: [SPRAY[0]] }));
        expect(withFert - without).toBe(1);
    });

    test('drops every CHEMICAL sheet when nothing was sprayed', async () => {
        // BOTH fields in both arms now. This case used to pass ONE field with
        // a note explaining why: "with the fixture's two fields the difference
        // is 2, which is correct and measures the per-field split rather than
        // the omission". That difference of 2 WAS the defect in #2183 ask 4 —
        // the unsprayed field was getting a sheet with an empty table — so the
        // workaround is gone and the case now runs on the shape a block
        // register actually has.
        const sprayed = await pageCount(
            only({ sprayLines: [SPRAY[0]], observations: OBS, fields: FIELDS }),
        );
        const notSprayed = await pageCount(only({ observations: OBS, fields: FIELDS }));
        expect(sprayed - notSprayed).toBe(1);
    });

    test('DROPS the sampling and ОДБХ sheets too, which never had data to print', async () => {
        // REVERSED on 2026-10-23. This test asserted the opposite — that the
        // two ruled forms stay "because an inspector writes on them" — which
        // is a real argument and one the owner heard and declined, twice, with
        // both pages named. Their original complaint was that pages 4-6 are
        // redundant for a one-parcel spraying.
        //
        // The distinction that matters: nothing in this product records a
        // sample or an inspector's finding, so those pages were not "empty
        // this period" but empty BY CONSTRUCTION — pages a farmer prints and
        // throws away. The three data sections can be full or empty; these two
        // could only ever be empty.
        //
        // So a document with one observation and nothing else is exactly two
        // pages: the cover, and the observations.
        expect(await pageCount(only({ observations: OBS }))).toBe(STRUCTURAL_PAGES + 1);
    });

    test('a register with all three data sections carries no blank form pages', async () => {
        // cover + observations + one chemical sheet + fertilizers. Nothing else.
        const full = await pageCount(
            only({
                sprayLines: [SPRAY[0]],
                fertilizeLines: FERT,
                observations: OBS,
                fields: [FIELDS[0]],
            }),
        );
        expect(full).toBe(STRUCTURAL_PAGES + 3);
    });
});

describe('isRegisterEmpty (#2183)', () => {
    const OBS: ObservationData[] = [
        { occurredAt: new Date(0), phenophase: null, disease: null, pest: 'x', derived: false },
    ];
    const bare = (over: Partial<FarmRecordData> = {}): FarmRecordData => ({
        ...fixture(PROFILE),
        sprayLines: [],
        fertilizeLines: [],
        observations: [],
        ...over,
    });

    test('is true when all three data sections are empty', () => {
        expect(isRegisterEmpty(bare())).toBe(true);
    });

    test('does NOT count `fields` — a block has parcels whether or not anything happened', () => {
        // Counting them would make every register non-empty and the check
        // inert, which is a gate that cannot fail.
        expect(isRegisterEmpty(bare({ fields: FIELDS }))).toBe(true);
    });

    test('is false when any ONE data section has a row', () => {
        expect(isRegisterEmpty(bare({ sprayLines: [SPRAY[0]] }))).toBe(false);
        expect(isRegisterEmpty(bare({ fertilizeLines: FERT }))).toBe(false);
        expect(isRegisterEmpty(bare({ observations: OBS }))).toBe(false);
    });
});

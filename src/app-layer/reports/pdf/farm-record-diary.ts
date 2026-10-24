/**
 * БАБХ "ДНЕВНИК за проведените растителнозащитни мероприятия и торене"
 * (Приложение 1 към заповед № РД 11-3194/31.12.2021 г.) PDF generator.
 *
 * Structure mirrors the other generators (`year-on-farm.ts`): data is
 * pulled INSIDE the usecase and the built doc is returned WITHOUT calling
 * `.end()` (the route's collectPdfBuffer finalises).
 *
 * The document language is Bulgarian regardless of UI locale, so every
 * label is an inline literal in the `L` map below.
 *
 * Cyrillic: the doc is created with `fontFamily: 'unicode'`, so
 * `createPdfDocument` registers DejaVu Sans under UNICODE_FONT /
 * UNICODE_FONT_BOLD; every `.font(...)` here uses those names (registering
 * over the built-in 'Helvetica' name is unreliable in pdfkit 0.19.x and
 * silently tofus Cyrillic).
 *
 * Layout: the shared table/section/layout helpers are A4-portrait-locked,
 * so the wide (landscape) tables are drawn by the small orientation-aware
 * helpers in this file (`drawRuledTable`, cover primitives).
 */
import type { RequestContext } from '@/app-layer/types';
import { assertCanRead } from '@/app-layer/policies/common';
import { codedNotFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { resolveOperationType } from '@/app-layer/usecases/field-operation';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { createPdfDocument, UNICODE_FONT, UNICODE_FONT_BOLD } from '@/lib/pdf/pdfKitFactory';
import { getStorageProvider, buildTenantObjectKey } from '@/lib/storage';
import type { ReportMeta } from '@/lib/pdf/types';
import { techniqueLabelBg } from '@/lib/agro/application-techniques';
import { collectPdfBuffer } from '@/app-layer/reports/pdf/collect-buffer';

// ─────────────────────────────────────────────────────────────────────
// Bulgarian labels (document language is BG regardless of UI locale)
// ─────────────────────────────────────────────────────────────────────

export interface DiaryLabels {
    appendixLine: string;
    title1: string;
    title2: string;
    municipality: string;
    settlement: string;
    producer: string;
    producerHint: string;
    address: string;
    eik: string;
    urn: string;
    agriDirectorate: string;
    registrationPlace: string;
    ekatte: string;
    odbh: string;
    legalLine: string;
    observationSection: string;
    /**
     * The footnote under the scouting table, printed only when a derived row
     * is present (#2072, #1740 Q2).
     *
     * On the interface because `DiaryLabels` IS the contract the drawing code
     * reads through — `L.derivedNote` does not compile without it. There is
     * only one implementation (`BG_LABELS`), and rightly so: this is a
     * Bulgarian regulatory form, not localised copy.
     */
    derivedNote: string;
    chemicalSection: string;
    fertilizerSection: string;
    samplingSection: string;
    inspectorSection: string;
    field: string;
    culture: string;
    variety: string;
    sownArea: string;
    predecessor: string;
    landDistrict: string;
    produceStore: string;
    locality: string;
    cadastralNo: string;
    fieldNo: string;
    sowDate: string;
    page: string;
    of: string;
    period: string;
    // column header groups
    obsCols: string[];
    chemCols: string[];
    fertCols: string[];
    sampleCols: string[];
    inspectorCols: string[];
    // per-field header strips (label order IS the form's)
    obsFieldHeader: string[];
    chemFieldHeader: string[];
}

export const BG_LABELS: DiaryLabels = {
    appendixLine:
        'Приложение 1 към заповед № РД 11-3194/31.12.2021 г. на изпълнителния директор на БАБХ',
    title1: 'Д Н Е В Н И К',
    title2: 'ЗА ПРОВЕДЕНИТЕ РАСТИТЕЛНОЗАЩИТНИ МЕРОПРИЯТИЯ И ТОРЕНЕ',
    municipality: 'Община',
    settlement: 'Населено място',
    producer: 'Земеделски производител',
    producerHint: '/ име презиме фамилия / фирма /',
    address: 'Адрес',
    eik: 'ЕИК',
    urn: 'УРН',
    agriDirectorate: 'Областна дирекция „Земеделие“ гр.',
    registrationPlace: 'Място на регистриране',
    ekatte: 'ЕКАТТЕ на регистрация',
    odbh: 'Областна дирекция по безопасност на храните (ОДБХ) гр.',
    legalLine:
        'Записите в дневника се водят на основание чл. 115 а и чл. 142, ал. 3 от Закона за защита на растенията',
    observationSection:
        'ПОЯВА, РАЗВИТИЕ, ПЛЪТНОСТ ИЛИ СТЕПЕН НА НАПАДЕНИЕ ОТ ВРЕДИТЕЛИ',
    // Printed under the scouting table, and ONLY when a derived row is
    // present. A footnote marker with nothing marked would be noise, and a
    // document that explains a convention it never uses reads as careless.
    derivedNote:
        '* Редовете, отбелязани със звездичка, са изведени от проведените химични обработки и не представляват самостоятелно обследване.',
    chemicalSection: 'ПРОВЕДЕНИ ХИМИЧНИ ОБРАБОТКИ',
    fertilizerSection: 'УПОТРЕБЕНИ МИНЕРАЛНИ И ОРГАНИЧНИ ТОРОВЕ',
    samplingSection: 'ВЗЕТИ ПРОБИ',
    inspectorSection: 'РЕЗУЛТАТ ОТ ПРОВЕРКАТА НА ИНСПЕКТОР ОТ ОДБХ',
    field: '№ на полето според единния регистър на площите',
    culture: 'Култура',
    variety: 'Сорт/хибрид',
    sownArea: 'Засята площ (дка)',
    predecessor: 'Предшественик',
    landDistrict: 'Землище',
    produceStore: 'Склад за растителна продукция',
    locality: 'Местност',
    cadastralNo: 'Кадастрален №',
    fieldNo: 'Поле №',
    sowDate: 'Дата на сеитба (засаждане)',
    page: 'стр.',
    of: 'от',
    period: 'Период',
    obsCols: [
        'Дата, месец, година',
        'Фенофаза/BBCH',
        'Болест',
        'Обследвана площ (дка)',
        'Нападната площ (дка)',
        'Степен на нападение %',
        'Неприятел',
        'Обследвана площ (дка)',
        'Нападната площ (дка)',
        'Стадии на развитие',
        'Плътност',
    ],
    chemCols: [
        'Пореден №',
        'Дата, месец, година',
        'Вредител',
        'Употребено средство за РЗ /търговско наименование/',
        'Доза на приложение',
        'Третирани площи (дка)',
        'Техника за приложение',
        'Карантинен срок на ПРЗ',
        'Най-ранна дата за прибиране',
        'Име и фамилия на лицето и № на сертификат по чл. 83 от ЗЗР, във връзка с чл. 84, ал. 2 от ЗЗР',
        'Име и фамилия на лицето* и № на сертификат по чл. 83 от ЗЗР, във връзка с чл. 84, ал. 1 от ЗЗР',
        'Подпис на специалиста',
    ],
    fertCols: [
        '№',
        'Дата',
        'Търговско наименование (състав; акт. в-во %)',
        'Употребено количество (кг/дка)',
        'Наторени площи (дка)',
    ],
    sampleCols: [
        '№',
        'Дата',
        'Култура',
        'Проба от',
        'Вид анализ',
        'Лаборатория',
        'Резултат',
        'Мярка',
        'МДГ',
        'Съответствие',
        'Забележка',
        'Подпис',
    ],
    inspectorCols: ['Дата', 'Констатации', 'Предписания', 'Подпис на инспектор'],
    obsFieldHeader: [
        '№ на полето според единния регистър на площите',
        'Култура',
        'Сорт/хибрид',
        'Засята площ (дка)',
        'Предшественик',
    ],
    chemFieldHeader: [
        'Населено място',
        'Землище',
        'Склад за растителна продукция',
        'Местност',
        'Кадастрален №',
        'Поле №',
        'Култура',
        'Сорт/хибрид',
        'Засята площ',
        'Предшественик',
        'Дата на сеитба (засаждане)',
    ],
};

// ─────────────────────────────────────────────────────────────────────
// Data shapes (the render function is pure over these — DB-free, testable)
// ─────────────────────────────────────────────────────────────────────

export interface FarmProfileData {
    producerName: string | null;
    eik: string | null;
    urn: string | null;
    address: string | null;
    municipality: string | null;
    settlement: string | null;
    agricultureDirectorateCity: string | null;
    registrationPlace: string | null;
    registrationEkatte: string | null;
    odbhCity: string | null;
}

/**
 * Identity of ONE field, as the form's per-field header strip prints it.
 * Every member is nullable: the register must show an empty cell rather
 * than invent one, exactly as the pre-printed paper form does.
 */
export interface FieldHeaderData {
    parcelId: string;
    /** Поле № — the holding's own field number (Parcel.name). */
    fieldNo: string | null;
    /** Кадастрален № */
    cadastralId: string | null;
    /** Землище */
    landDistrict: string | null;
    /** Местност */
    locality: string | null;
    /** Склад за растителна продукция */
    produceStore: string | null;
    /** Култура */
    cropType: string | null;
    /** Сорт/хибрид */
    variety: string | null;
    /** Засята площ — stored in ha, PRINTED in дка. */
    areaHa: number | null;
    /** Предшественик — the crop grown on this parcel before the current one. */
    predecessor: string | null;
    /** Дата на сеитба (засаждане) */
    sowDate: Date | null;
}

export interface SprayLineData {
    /**
     * Which field this treatment was carried out on. The chemical section
     * is GROUPED by it: a per-field header strip above a table of other
     * fields' rows would misattribute them, which is the whole defect this
     * shape exists to prevent.
     */
    parcelId: string | null;
    completedAt: Date | null;
    targetNote: string | null;
    productName: string;
    dose: string;
    areaHa: number | null;
    /**
     * Третирани/Наторени площи — how much of the parcel this line covered
     * (#2072 part B). NULL means THE WHOLE PARCEL, so a row prints
     * `treatedAreaHa ?? areaHa` and every line written before the column
     * existed renders exactly as it did before.
     *
     * Kept separate from `areaHa` rather than overwriting it: `areaHa` is
     * the PARCEL's area, which the per-field header strips print, and a
     * treated area would be wrong there.
     */
    treatedAreaHa: number | null;
    /**
     * Фенофаза/BBCH recorded on this line (#2072 part A). Not printed in the
     * ХИМИЧНИ ОБРАБОТКИ table — that table's 12 columns are fixed by заповед
     * РД 11-3194/31.12.2021 and include no such cell. It is here because the
     * SCOUTING table's column 2 is «Фенофаза/BBCH», and #1740 Q2 ruled that
     * table should be derived from the treatments.
     */
    phenophase: string | null;
    applicationTechnique: string | null;
    quarantineDays: number | null;
    operatorCertNo: string | null;
    agronomistName: string | null;
    agronomistCertNo: string | null;
}

export interface FertilizeLineData {
    completedAt: Date | null;
    productName: string;
    activeIngredient: string | null;
    dose: string;
    areaHa: number | null;
    /**
     * Третирани/Наторени площи — how much of the parcel this line covered
     * (#2072 part B). NULL means THE WHOLE PARCEL, so a row prints
     * `treatedAreaHa ?? areaHa` and every line written before the column
     * existed renders exactly as it did before.
     *
     * Kept separate from `areaHa` rather than overwriting it: `areaHa` is
     * the PARCEL's area, which the per-field header strips print, and a
     * treated area would be wrong there.
     */
    treatedAreaHa: number | null;
}

export interface ObservationData {
    occurredAt: Date | null;
    phenophase: string | null;
    disease: string | null;
    pest: string | null;
    /**
     * TRUE when this row was derived from a treatment rather than recorded by
     * a person (#2072, #1740 Q2).
     *
     * It exists so the document can SAY so. A regulator reads Приложение 1's
     * «ПОЯВА, РАЗВИТИЕ…» rows as observations — somebody walked the field and
     * wrote down what they saw. A row inferred from a spraying is a different
     * assertion, and printing it unmarked would make the register claim an
     * inspection that never happened.
     */
    derived: boolean;
}

export interface FarmRecordData {
    locationName: string;
    from: string;
    to: string;
    profile: FarmProfileData;
    sprayLines: SprayLineData[];
    fertilizeLines: FertilizeLineData[];
    observations: ObservationData[];
    /**
     * The fields this register covers, in print order — one header strip
     * and one chemical table each. Empty when nothing was treated in the
     * period; the section still prints, blank, like the paper form.
     */
    fields: FieldHeaderData[];
}

// ─────────────────────────────────────────────────────────────────────
// Pure row builders (unit-tested directly)
// ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * Upper bound on printed observation rows. A legal register must not
 * silently truncate: this is generous headroom (a very active season logs
 * tens of scouting entries, not hundreds), and the bound exists only to
 * keep the query guardrail-compliant / the PDF finite.
 */
export const MAX_OBSERVATION_ROWS = 500;

/**
 * Upper bound on per-field sheets in one location's register. Generous:
 * a holding works tens of fields, not hundreds. Treatments on a field
 * past the bound are NOT lost — renderFarmRecordDiary prints them under a
 * blank header strip rather than dropping them.
 */
export const MAX_FIELD_SHEETS = 200;

/**
 * `dd.mm.yyyy`, or '' for no date — exported for its own test.
 *
 * Exported because the behaviour cannot be observed through the rendered PDF:
 * PDFKit writes text as GLYPH INDICES once a Unicode font is embedded, so a
 * buffer search for "NaN" finds nothing whether the guard is present or not.
 * A test written that way passed with the guard removed — measured, and it is
 * the reason this is exported rather than tested through `renderFarmRecordDiary`.
 */
export function fmtDate(d: Date | null | undefined): string {
    if (!d) return '';
    // An Invalid Date renders as "NaN.NaN.NaN" without this, because
    // `String(NaN).padStart(2, '0')` is the string "NaN" — measured, not
    // assumed. `:695` puts this straight into the БАБХ ДНЕВНИК header, so a
    // compliance document would be headed
    // "Период: NaN.NaN.NaN – NaN.NaN.NaN" and returned with a 200.
    //
    // Unreachable as of #1575, which validates the period at the route — the
    // Prisma query at `:910` throws first anyway. Defence in depth, because
    // the hazard is ORDERING, not behaviour: if that query were removed,
    // reordered or made lazy, the PDF would start rendering garbage silently.
    // Blank is the rendering this function already gives a missing date, so a
    // malformed one reads the same rather than inventing digits.
    if (Number.isNaN(d.getTime())) return '';
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

/** Decares (дка) = hectares × 10. Rounded to 2 decimals; blank when unset. */
function toDka(areaHa: number | null): string {
    if (areaHa == null) return '';
    return String(Math.round(areaHa * 10 * 100) / 100);
}

/**
 * Journal `notes` are stored as SANITIZED RICH-TEXT HTML (Epic C.5 —
 * `sanitizeRichTextHtml` at the usecase boundary), but a PDF table cell
 * renders text verbatim: `<p>` tags would print literally in the legal
 * ДНЕВНИК. Convert to plain text for print: block/line-break boundaries
 * become separators FIRST (so `<p>Мана</p><p>по листата</p>` reads
 * "Мана по листата", not "Манапо листата"), then strip the remaining
 * tags + decode entities via the shared `sanitizePlainText`, then
 * collapse runs of whitespace. Null/blank in → null out (the row builder
 * renders '' for null).
 */
export function htmlNotesToPlainText(html: string | null | undefined): string | null {
    if (html == null) return null;
    const withBreaks = html
        .replace(/<\s*br\s*\/?\s*>/gi, ' ')
        .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote|tr)\s*>/gi, ' ');
    const text = sanitizePlainText(withBreaks).replace(/\s+/g, ' ').trim();
    return text.length ? text : null;
}

/** One 12-column row per completed spray line (химични обработки). */
/**
 * «Третирани площи (дка)» prints the LINE's treated area, falling back to the
 * parcel's (#2072 part B). The fallback is not a default for missing data — it
 * is the correct value for a line that covered the whole parcel, which is what
 * every line meant before the column existed.
 */
export function buildChemicalRows(lines: SprayLineData[]): string[][] {
    return lines.map((l, i) => {
        const earliestHarvest =
            l.completedAt && l.quarantineDays != null
                ? fmtDate(new Date(l.completedAt.getTime() + l.quarantineDays * DAY_MS))
                : '';
        const agronomist = [l.agronomistName, l.agronomistCertNo]
            .filter(Boolean)
            .join(' / ');
        return [
            String(i + 1),
            fmtDate(l.completedAt),
            l.targetNote ?? '',
            l.productName,
            l.dose,
            toDka(l.treatedAreaHa ?? l.areaHa),
            techniqueLabelBg(l.applicationTechnique),
            l.quarantineDays != null ? String(l.quarantineDays) : '',
            earliestHarvest,
            l.operatorCertNo ?? '',
            agronomist,
            '', // Подпис — always wet-signed by hand
        ];
    });
}

/** One 5-column row per completed fertilize line (торове). */
export function buildFertilizerRows(lines: FertilizeLineData[]): string[][] {
    return lines.map((l, i) => [
        String(i + 1),
        fmtDate(l.completedAt),
        [l.productName, l.activeIngredient].filter(Boolean).join('; '),
        l.dose,
        toDka(l.treatedAreaHa ?? l.areaHa),
    ]);
}

/** Best-effort 11-column observation rows from OBSERVATION journal entries. */
export function buildObservationRows(obs: ObservationData[]): string[][] {
    return obs.map((o) => [
        // The asterisk is the form's own footnote convention — it already
        // carries `*` and `**` markers in two column headers — and the caption
        // under the table explains it. Marking the DATE cell rather than the
        // phenophase because the whole ROW is derived, not one of its values.
        o.derived ? `${fmtDate(o.occurredAt)} *` : fmtDate(o.occurredAt),
        o.phenophase ?? '',
        o.disease ?? '',
        '',
        '',
        '',
        o.pest ?? '',
        '',
        '',
        '',
        '',
    ]);
}

/**
 * Scouting rows derived from treatments — #1740 Q2, #2072 part A.
 *
 * The owner's ruling was "derive the observation table from the treatments,
 * like PRZ", and PRZ's manual says its scouting section «става изцяло
 * автоматично и зависи пряко от проведените химични обработки». This is that
 * derivation, which had never been built: `buildObservationRows` only ever
 * received OBSERVATION journal entries, and a treatment-scoped document
 * carried none at all.
 *
 * ## Only when there is something to say
 *
 * One row per spray line that HAS a phenophase. A line without one would
 * derive a row carrying a date and nothing else — asserting that an
 * inspection happened and found nothing worth recording, which is not what a
 * missing field means. The table stays blank in that case, exactly as before.
 *
 * ## «Болест» and «Неприятел» are left BLANK, deliberately
 *
 * A treatment records `targetNote`, the form's «Вредител» — one free-text
 * field naming whatever the product was applied against. The scouting table
 * has TWO separate columns, «Болест» (3) and «Неприятел» (7), and nothing in
 * a treatment says which one a given note belongs in. Guessing would put a
 * fungus in the pest column half the time.
 *
 * The deeper reason is that they are different assertions. "A product was
 * applied against X" is not "X was observed on this field at this density",
 * and columns 4-6 and 8-11 — обследвана площ, нападната площ, степен,
 * плътност — are measurements nobody took. A register that filled them from a
 * spraying would be inventing survey data.
 *
 * So a derived row carries exactly what the treatment actually knows: WHEN,
 * and the GROWTH STAGE the person recorded at the time.
 */
export function deriveObservationsFromSprays(lines: SprayLineData[]): ObservationData[] {
    return lines
        .filter((l) => l.phenophase != null && l.phenophase !== '')
        .map((l) => ({
            occurredAt: l.completedAt,
            phenophase: l.phenophase,
            disease: null,
            pest: null,
            derived: true,
        }));
}

// ─────────────────────────────────────────────────────────────────────
// Orientation-aware drawing primitives (this file only)
// ─────────────────────────────────────────────────────────────────────

const INK = '#0f172a';
/**
 * The chemical section's 11-cell per-field header strip, in the form's
 * exact column order. `settlement` is holding-level (it is also on the
 * cover); everything else is the field's own.
 */
export function buildChemFieldHeaderRow(
    f: FieldHeaderData | null,
    settlement: string | null,
): string[] {
    return [
        settlement ?? '',
        f?.landDistrict ?? '',
        f?.produceStore ?? '',
        f?.locality ?? '',
        f?.cadastralId ?? '',
        f?.fieldNo ?? '',
        f?.cropType ?? '',
        f?.variety ?? '',
        f ? toDka(f.areaHa) : '',
        f?.predecessor ?? '',
        fmtDate(f?.sowDate),
    ];
}

/** The observation section's 5-cell per-field header strip. */
export function buildObsFieldHeaderRow(f: FieldHeaderData | null): string[] {
    return [
        f?.fieldNo ?? '',
        f?.cropType ?? '',
        f?.variety ?? '',
        f ? toDka(f.areaHa) : '',
        f?.predecessor ?? '',
    ];
}

/** One field's sheet: its header strip, and the treatments carried out on it. */
export interface FieldSprayGroup {
    field: FieldHeaderData | null;
    lines: SprayLineData[];
}

/**
 * Split the period's treatments into one sheet per SPRAYED field.
 *
 * Three properties, because this feeds a legally-filed register. The first two
 * are why the orphan group below cannot be simplified away; the third is the
 * owner's fourth ruling on #2183.
 *
 *   • NO LINE IS LOST. A treatment whose field is not in `fields` — the
 *     field list is capped at MAX_FIELD_SHEETS, the spray lines are not —
 *     lands in a trailing group with a BLANK strip rather than being
 *     filtered away. A vanished spray is an unrecorded chemical application.
 *   • NO LINE IS DUPLICATED. Printing one treatment under two fields would
 *     claim an application that never happened.
 *   • NO SHEET WITHOUT A LINE. A parcel of the block that was not sprayed in
 *     the period gets no sheet at all (owner ruling, #2183 ask 4: "only
 *     parcels sprayed in the period get a spraying sheet. Blank parcel sheets
 *     go as well").
 *
 * `tests/pdf/farm-record-diary.test.ts` asserts all three directly.
 *
 * ## The third does not endanger the first
 *
 * `.filter((g) => g.lines.length > 0)` drops only groups built from `fields`,
 * never the orphan group — and a group can be empty only when no line names
 * its parcel, which is precisely the case where that line is somewhere else.
 * Concretely: if `groups` comes back empty while lines exist, then no line
 * matched any field, so every line is an orphan and the branch below carries
 * all of them. Dropping empty groups can therefore never drop a line.
 *
 * ## Why a BLOCK register had blank sheets and a TREATMENT one never did
 *
 * `fields` is built from `parcels`, and that query is scoped two different
 * ways (`:1379-1388`): a treatment-scoped document limits it to the parcels
 * the treatment touched, while a block-scoped one takes EVERY live parcel of
 * the block. So the per-treatment ДНЕВНИК already honoured this ruling via
 * #1740 and only the block register printed sheets for untreated parcels.
 */
export function groupSprayLinesByField(
    fields: FieldHeaderData[],
    sprayLines: SprayLineData[],
): FieldSprayGroup[] {
    const groups: FieldSprayGroup[] = fields
        .map((f) => ({
            field: f,
            lines: sprayLines.filter((l) => l.parcelId === f.parcelId),
        }))
        // #2183 ask 4. See the docblock for why this cannot lose a line.
        .filter((g) => g.lines.length > 0);
    const knownFields = new Set(fields.map((f) => f.parcelId));
    const orphanLines = sprayLines.filter((l) => !l.parcelId || !knownFields.has(l.parcelId));
    // `!groups.length` is the no-line-lost net, NOT a blank sheet for an idle
    // period: this used to be described as giving an idle period its one blank
    // sheet "so the section is never absent", which stopped being true twice
    // over. The caller gates on `sprayLines.length > 0` (#2183 asks 1-2, an
    // empty section is now omitted), and ruling 5 refuses a block that
    // recorded nothing at all — so an idle period never reaches here, and if
    // it did, a lone empty sheet is the thing the ruling removes.
    if (orphanLines.length || !groups.length) {
        groups.push({ field: null, lines: orphanLines });
    }
    return groups;
}

const MUTED = '#64748b';
const GRID = '#cbd5e1';
const HEADER_BG = '#e2e8f0';

interface RuledColumn {
    weight: number;
    align?: 'left' | 'center' | 'right';
}

/**
 * Draw a ruled table (header + data rows + optional blank ruled rows) that
 * fits the CURRENT page's orientation. Repeats the header on page breaks
 * (preserving orientation) and wraps long Cyrillic cell text.
 */
function drawRuledTable(
    doc: PDFKit.PDFDocument,
    startY: number,
    headers: string[],
    columns: RuledColumn[],
    rows: string[][],
    blankRows: number,
): number {
    const pad = 3;
    const fontSize = 7;
    const isLandscape = doc.page.width > doc.page.height;
    const m = doc.page.margins;
    const availW = doc.page.width - m.left - m.right;
    const totalWeight = columns.reduce((s, c) => s + c.weight, 0);
    const widths = columns.map((c) => (c.weight / totalWeight) * availW);

    const drawHeaderRow = (y: number): number => {
        doc.font(UNICODE_FONT_BOLD).fontSize(fontSize);
        let hh = 0;
        headers.forEach((h, i) => {
            const measured = doc.heightOfString(h, { width: widths[i] - 2 * pad });
            if (measured > hh) hh = measured;
        });
        hh += 2 * pad;
        let x = m.left;
        headers.forEach((h, i) => {
            doc.rect(x, y, widths[i], hh).fillAndStroke(HEADER_BG, '#94a3b8');
            doc.fillColor(INK).text(h, x + pad, y + pad, {
                width: widths[i] - 2 * pad,
                align: columns[i].align ?? 'left',
                lineBreak: true,
            });
            x += widths[i];
        });
        return y + hh;
    };

    const pageBottom = () => doc.page.height - m.bottom;

    let y = drawHeaderRow(startY);

    const drawCells = (cells: string[], minHeight: number): void => {
        doc.font(UNICODE_FONT).fontSize(fontSize);
        let rh = 0;
        cells.forEach((txt, i) => {
            const measured = doc.heightOfString(String(txt ?? ''), {
                width: widths[i] - 2 * pad,
            });
            if (measured > rh) rh = measured;
        });
        rh = Math.max(rh + 2 * pad, minHeight);
        if (y + rh > pageBottom()) {
            doc.addPage({
                size: 'A4',
                layout: isLandscape ? 'landscape' : 'portrait',
            });
            y = drawHeaderRow(m.top);
        }
        let x = m.left;
        cells.forEach((txt, i) => {
            doc.rect(x, y, widths[i], rh).stroke(GRID);
            doc.fillColor(INK).text(String(txt ?? ''), x + pad, y + pad, {
                width: widths[i] - 2 * pad,
                align: columns[i].align ?? 'left',
                lineBreak: true,
            });
            x += widths[i];
        });
        y += rh;
    };

    for (const row of rows) drawCells(row, 14);
    for (let i = 0; i < blankRows; i++) drawCells(headers.map(() => ''), 16);

    return y;
}

/**
 * The form's per-field header: one ruled strip of label over value. It is
 * drawn with the table drawer because on the paper form that is exactly
 * what it is — a one-row table above the register it describes.
 */
function drawFieldHeaderStrip(
    doc: PDFKit.PDFDocument,
    startY: number,
    headers: string[],
    values: string[],
): number {
    return drawRuledTable(
        doc,
        startY,
        headers,
        headers.map(() => ({ weight: 1 })),
        [values],
        0,
    );
}

/** A row of `count` small boxed cells (ЕГН/ЕИК/ЕКАТТЕ), digits filled from `value`. */
function drawBoxedCells(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    count: number,
    value: string | null,
): void {
    const cw = 14;
    const ch = 16;
    const digits = (value ?? '').replace(/\s/g, '').slice(0, count).split('');
    doc.font(UNICODE_FONT).fontSize(9).fillColor(INK);
    for (let i = 0; i < count; i++) {
        const cx = x + i * cw;
        doc.rect(cx, y, cw, ch).stroke(GRID);
        if (digits[i]) {
            doc.text(digits[i], cx, y + 3, { width: cw, align: 'center', lineBreak: false });
        }
    }
}

/** "Label ......value......" — value when set, else a dotted rule. */
function drawLabeledLine(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    width: number,
    label: string,
    value: string | null,
): number {
    doc.font(UNICODE_FONT).fontSize(10).fillColor(INK);
    const labelText = `${label}: `;
    const labelW = doc.widthOfString(labelText);
    doc.text(labelText, x, y, { lineBreak: false });
    const valueX = x + labelW;
    const valueW = width - labelW;
    if (value && value.trim()) {
        doc.text(value, valueX, y, { width: valueW, lineBreak: false });
    } else {
        // dotted fill
        doc.fillColor(MUTED).text('.'.repeat(Math.max(3, Math.floor(valueW / 3))), valueX, y, {
            width: valueW,
            lineBreak: false,
        });
        doc.fillColor(INK);
    }
    return y + 20;
}

// ─────────────────────────────────────────────────────────────────────
// Pure render (DB-free) — draws the whole form from shaped data
// ─────────────────────────────────────────────────────────────────────

export function renderFarmRecordDiary(
    doc: PDFKit.PDFDocument,
    data: FarmRecordData,
    L: DiaryLabels,
    // When composing several locations into ONE document (season diary),
    // pass false and call stampPageNumbers once at the end instead.
    stampPages = true,
): void {
    const p = data.profile;

    // ── PORTRAIT COVER ──────────────────────────────────────────────
    const m = doc.page.margins;
    const contentW = doc.page.width - m.left - m.right;
    let y = m.top;

    doc.font(UNICODE_FONT).fontSize(9).fillColor(MUTED);
    doc.text(L.appendixLine, m.left, y, { width: contentW, align: 'center' });
    y = doc.y + 14;

    doc.font(UNICODE_FONT_BOLD).fontSize(20).fillColor(INK);
    doc.text(L.title1, m.left, y, { width: contentW, align: 'center' });
    y = doc.y + 2;
    doc.fontSize(12).text(L.title2, m.left, y, { width: contentW, align: 'center' });
    y = doc.y + 20;

    y = drawLabeledLine(doc, m.left, y, contentW, L.municipality, p.municipality);
    y = drawLabeledLine(doc, m.left, y, contentW, L.settlement, p.settlement);
    y = drawLabeledLine(doc, m.left, y, contentW, L.producer, p.producerName);
    doc.font(UNICODE_FONT).fontSize(8).fillColor(MUTED).text(L.producerHint, m.left, y - 4, {
        width: contentW,
    });
    y += 8;
    y = drawLabeledLine(doc, m.left, y, contentW, L.address, p.address);

    // Boxed ЕИК (13), then УРН on a ruled line.
    //
    // The prescribed form (Прил. 1 към заповед РД 11-3194/31.12.2021) puts a
    // boxed ЕГН (10 cells) above the ЕИК here, and this cover printed one
    // until #2257. It is GONE on the owner's ruling of 2026-10-24: the product
    // holds no national identity number, so there is no value to print and a
    // row of ten empty boxes on a regulator-facing document would invite
    // somebody to fill it in by hand.
    //
    // УРН takes its place rather than leaving a gap, and that is not
    // decoration: a producer who is a natural person may have no ЕИК at all,
    // so without УРН their cover would identify them by name alone. УРН prints
    // as a ruled line, not boxed cells — the form prescribes no cell count for
    // it, and inventing one would assert a fixed length the register does not
    // guarantee.
    doc.font(UNICODE_FONT).fontSize(10).fillColor(INK).text(`${L.eik}:`, m.left, y, { lineBreak: false });
    drawBoxedCells(doc, m.left + 40, y - 3, 13, p.eik);
    y += 28;
    y = drawLabeledLine(doc, m.left, y, contentW, L.urn, p.urn);

    y = drawLabeledLine(doc, m.left, y, contentW, L.agriDirectorate, p.agricultureDirectorateCity);
    y = drawLabeledLine(doc, m.left, y, contentW, L.registrationPlace, p.registrationPlace);
    doc.font(UNICODE_FONT).fontSize(10).fillColor(INK).text(`${L.ekatte}:`, m.left, y, { lineBreak: false });
    drawBoxedCells(doc, m.left + 130, y - 3, 5, p.registrationEkatte);
    y += 26;
    y = drawLabeledLine(doc, m.left, y, contentW, L.odbh, p.odbhCity);
    y += 8;

    doc.font(UNICODE_FONT).fontSize(8).fillColor(MUTED);
    doc.text(L.legalLine, m.left, y, { width: contentW });
    y = doc.y + 8;
    doc.fontSize(9).fillColor(INK).text(
        `${L.period}: ${fmtDate(new Date(data.from))} – ${fmtDate(new Date(data.to))}   •   ${data.locationName}`,
        m.left,
        y,
        { width: contentW },
    );

    // ── LANDSCAPE: observation section ──────────────────────────────
    //
    // OMITTED ENTIRELY when there is nothing to report (#2183, owner ruling
    // 2026-10-23). Only the three DATA sections behave this way; the sampling
    // and ОДБХ sheets below are blank by DESIGN — ruled forms an inspector
    // writes on by hand — so "empty" is not a thing that can be true of them
    // and dropping them would remove the parts of the document that are
    // supposed to arrive unfilled.
    if (data.observations.length > 0) {
        doc.addPage({ size: 'A4', layout: 'landscape' });
        doc.font(UNICODE_FONT_BOLD).fontSize(11).fillColor(INK);
        doc.text(L.observationSection, doc.page.margins.left, doc.page.margins.top, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            align: 'center',
        });
        // Scouting entries are LOCATION-scoped — LogEntry carries no parcel link
        // — so they cannot be split per field the way treatments can. The strip is
        // therefore filled only when the location has exactly ONE field, where the
        // attribution is unambiguous; with several it prints blank for completion
        // by hand, which is how the pre-printed form arrives anyway. Filling it
        // from an arbitrary field would be the misattribution this work removes.
        const obsField = data.fields.length === 1 ? data.fields[0] : null;
        const obsHeaderBottom = drawFieldHeaderStrip(
            doc,
            doc.y + 8,
            L.obsFieldHeader,
            buildObsFieldHeaderRow(obsField),
        );
        const obsRows = buildObservationRows(data.observations);
        const obsCols: RuledColumn[] = L.obsCols.map(() => ({ weight: 1 }));
        drawRuledTable(
            doc,
            obsHeaderBottom + 6,
            L.obsCols,
            obsCols,
            obsRows,
            Math.max(0, 8 - obsRows.length),
        );

        // The disclosure (#2072, #1740 Q2). A derived row is not an observation a
        // person made, and this document is read by a regulator who would
        // otherwise have no way to tell. Only printed when at least one row is
        // actually derived.
        if (data.observations.some((o) => o.derived)) {
            doc.fontSize(7).fillColor(MUTED).text(L.derivedNote, doc.page.margins.left, doc.y + 4, {
                width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            });
            doc.fillColor(INK);
    }
    }

    // ── LANDSCAPE: chemical treatments (the core) ───────────────────
    // The register is PER FIELD: one header strip and one table each, on its
    // own sheet, as the paper form is filed. A single combined table under one
    // strip would state that every row was carried out on that one field.
    // Column weights ~ the form's relative widths.
    const chemWeights = [0.6, 1.1, 1.3, 2.2, 1.1, 1, 1.3, 1, 1.3, 2, 2, 1];
    const chemCols: RuledColumn[] = chemWeights.map((w, i) => ({
        weight: w,
        align: i === 0 ? 'center' : 'left',
    }));
    // Same rule. `groupSprayLinesByField` still manufactures one blank group
    // for an idle period — see its own note — but that branch is now only
    // reached when the section is printed at all, i.e. when there IS a spray
    // line somewhere. A block with none skips the section rather than filing
    // a sheet that says nothing happened.
    const chemGroups = data.sprayLines.length > 0
        ? groupSprayLinesByField(data.fields, data.sprayLines)
        : [];
    for (const group of chemGroups) {
        doc.addPage({ size: 'A4', layout: 'landscape' });
        doc.font(UNICODE_FONT_BOLD).fontSize(11).fillColor(INK);
        doc.text(L.chemicalSection, doc.page.margins.left, doc.page.margins.top, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            align: 'center',
        });
        const headerBottom = drawFieldHeaderStrip(
            doc,
            doc.y + 8,
            L.chemFieldHeader,
            buildChemFieldHeaderRow(group.field, p.settlement),
        );
        const chemRows = buildChemicalRows(group.lines);
        drawRuledTable(
            doc,
            headerBottom + 6,
            L.chemCols,
            chemCols,
            chemRows,
            Math.max(0, 6 - chemRows.length),
        );
    }

    // ── PORTRAIT: fertilizers ───────────────────────────────────────
    if (data.fertilizeLines.length > 0) {
        doc.addPage({ size: 'A4', layout: 'portrait' });
        doc.font(UNICODE_FONT_BOLD).fontSize(11).fillColor(INK);
        doc.text(L.fertilizerSection, doc.page.margins.left, doc.page.margins.top, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            align: 'center',
        });
        const fertRows = buildFertilizerRows(data.fertilizeLines);
        const fertCols: RuledColumn[] = [
            { weight: 0.5, align: 'center' },
            { weight: 1.2 },
            { weight: 3 },
            { weight: 1.6, align: 'right' },
            { weight: 1.4, align: 'right' },
        ];
        drawRuledTable(
            doc,
            doc.y + 8,
            L.fertCols,
            fertCols,
            fertRows,
            Math.max(0, 6 - fertRows.length),
        );
    }

    // ── ВЗЕТИ ПРОБИ and РЕЗУЛТАТ ОТ ПРОВЕРКАТА: NOT RENDERED ────────
    //
    // Приложение 1 contains both pages, and this renderer printed them as
    // ruled tables with no rows. They are gone (#2183, owner ruling
    // 2026-10-23), and the reasoning for keeping them is recorded here because
    // it was put to the owner and declined.
    //
    // The argument FOR printing them: they are the parts of the form an
    // inspector writes on, so a register that arrives without them cannot be
    // completed by hand on the spot — unlike the three data sections, "empty"
    // is their normal state rather than a sign of a quiet period.
    //
    // The ruling against it, twice and with these two pages named: the owner's
    // original complaint was that "pages 4, 5 and 6 are redundant" for a
    // one-parcel spraying, and when asked specifically whether the blank
    // sampling page and the blank inspector page should go — including on the
    // per-block ДНЕВНИК — the answer was to drop them. Nothing in this product
    // records a sample or an inspector's finding, so they were ALWAYS blank:
    // not "empty this period" but empty by construction, which makes them
    // pages a farmer prints and throws away.
    //
    // `samplingSection`, `sampleCols`, `inspectorSection` and `inspectorCols`
    // are KEPT in `DiaryLabels` on purpose. They are the official form's own
    // wording, `farm-record-diary-integrity` pins their column counts, and the
    // day `FarmRecordData` carries samples or an inspection result the section
    // comes back — gated on that data, which is the gate the other three have
    // and these two never could.

    if (stampPages) stampPageNumbers(doc, L);
}

/** Stamp "стр. X от Y" in the bottom margin of every buffered page. */
export function stampPageNumbers(doc: PDFKit.PDFDocument, L: DiaryLabels): void {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const w = doc.page.width;
        const h = doc.page.height;
        const mp = doc.page.margins;
        doc.font(UNICODE_FONT).fontSize(8).fillColor(MUTED).text(
            `${L.page} ${i - range.start + 1} ${L.of} ${range.count}`,
            mp.left,
            h - mp.bottom + 12,
            { width: w - mp.left - mp.right, align: 'center', lineBreak: false, height: 12 },
        );
    }
}

// ─────────────────────────────────────────────────────────────────────
// Data gathering (DB) + public entry point
// ─────────────────────────────────────────────────────────────────────

interface CertSnapshot {
    operatorCertNo?: string | null;
    agronomistName?: string | null;
    agronomistCertNo?: string | null;
    applicationTechnique?: string | null;
}

const EMPTY_PROFILE: FarmProfileData = {
    producerName: null,
    eik: null,
    urn: null,
    address: null,
    municipality: null,
    settlement: null,
    agricultureDirectorateCity: null,
    registrationPlace: null,
    registrationEkatte: null,
    odbhCity: null,
};

/**
 * What a ДНЕВНИК document covers.
 *
 * Two scopes, ONE gatherer and one renderer. The alternative — a second
 * gatherer for the per-entry document — would be two spellings of a register
 * a farmer submits to БАБХ, and "same layout so it can be certified" (#1740)
 * stops being true the first time one of them changes.
 */
export type FarmRecordScope =
    | { kind: 'location'; locationId: string; from: string; to: string }
    /** One treatment, across every block it touched (#1740 item 3). */
    | { kind: 'treatment'; treatmentGroupId: string };

/**
 * The per-block register over a period — the original entry point, kept so
 * its callers and tests are untouched by the scope refactor.
 */
export async function gatherFarmRecordData(
    ctx: RequestContext,
    locationId: string,
    from: string,
    to: string,
): Promise<FarmRecordData> {
    return gatherFarmRecord(ctx, { kind: 'location', locationId, from, to });
}

export async function gatherFarmRecord(
    ctx: RequestContext,
    scope: FarmRecordScope,
): Promise<FarmRecordData> {
    const locationId = scope.kind === 'location' ? scope.locationId : null;
    const from = scope.kind === 'location' ? scope.from : null;
    const to = scope.kind === 'location' ? scope.to : null;
    // Report read-gate (same privilege model as year-on-farm). Read the
    // FarmProfile directly (NOT via getFarmProfile, which requires
    // admin-settings permission) — the Epic B extension still decrypts
    // eik/urn transparently on this read.
    assertCanRead(ctx);
    // A treatment-scoped document's period is the treatment's own DAY, which
    // is only known once its lines are read — so these are assigned below for
    // that scope. `toD` is load-bearing beyond the line filter: it also picks
    // which planting each field sheet is about ("current by the end of the
    // reported period"), and for one treatment that is its own day.
    let fromD = from != null ? new Date(from) : new Date(0);
    let toD = to != null ? new Date(to) : new Date(0);

    return runInTenantContext(ctx, async (db) => {
        // A treatment spans blocks, so there is no ONE block to head the
        // document with. The per-field header strips each name their own
        // block, which is where the paper form puts it anyway, so the farm
        // header's block line is left empty rather than naming one of
        // several — printing the first would be wrong, and silently.
        const location =
            locationId != null
                ? await db.location.findFirst({
                      where: { id: locationId, tenantId: ctx.tenantId },
                      select: { name: true },
                  })
                : null;

        const profileRow = await db.farmProfile.findUnique({
            where: { tenantId: ctx.tenantId },
        });
        const profile: FarmProfileData = profileRow
            ? {
                  producerName: profileRow.producerName ?? null,
                  eik: profileRow.eik ?? null,
                  urn: profileRow.urn ?? null,
                  address: profileRow.address ?? null,
                  municipality: profileRow.municipality ?? null,
                  settlement: profileRow.settlement ?? null,
                  agricultureDirectorateCity: profileRow.agricultureDirectorateCity ?? null,
                  registrationPlace: profileRow.registrationPlace ?? null,
                  registrationEkatte: profileRow.registrationEkatte ?? null,
                  odbhCity: profileRow.odbhCity ?? null,
              }
            : { ...EMPTY_PROFILE };

        // Which tasks the document covers.
        //
        // By BLOCK: every task linked to that location, then its DONE lines
        // within the period. By TREATMENT: the tasks carrying the handle —
        // one per block, which is why a treatment-scoped document spans
        // blocks without needing a location at all.
        const taskIds =
            locationId != null
                ? (
                      await db.taskLink.findMany({
                          where: {
                              tenantId: ctx.tenantId,
                              entityType: 'LOCATION',
                              entityId: locationId,
                          },
                          select: { taskId: true },
                      })
                  ).map((l) => l.taskId)
                : (
                      await db.task.findMany({
                          where: {
                              tenantId: ctx.tenantId,
                              treatmentGroupId:
                                  scope.kind === 'treatment' ? scope.treatmentGroupId : undefined,
                              deletedAt: null,
                          },
                          select: { id: true },
                      })
                  ).map((t) => t.id);

        const lines = taskIds.length
            ? await db.operationParcel.findMany({
                  where: {
                      tenantId: ctx.tenantId,
                      taskId: { in: taskIds },
                      status: 'DONE',
                        // A deleted treatment is GONE from the register, as if
                        // it had never been recorded (owner ruling 2026-10-22,
                        // #2175).
                        //
                        // Filtered HERE rather than where the task ids are
                        // resolved, because the two branches above resolve them
                        // differently and only ONE of them filters: the
                        // treatment-scoped branch queries `task` with
                        // `deletedAt: null`, while the BLOCK branch maps
                        // `taskLink` rows and never looks at the task. So a
                        // deleted treatment would vanish from its own PDF and
                        // keep printing in the block register — the document a
                        // БАБХ inspector actually reads.
                        //
                        // `OperationParcel` carries no `deletedAt` of its own,
                        // and a DONE line is deliberately left DONE on delete,
                        // so the task is the only thing that can say the
                        // treatment is withdrawn. That also makes a restore
                        // exact: clearing `Task.deletedAt` brings the lines back
                        // untouched.
                        task: { deletedAt: null },
                      // The period narrows a BLOCK register. A treatment is
                      // already one day's work by construction, so filtering
                      // it by a range it defines would be circular.
                      ...(locationId != null
                          ? { completedAt: { gte: fromD, lte: toD } }
                          : {}),
                  },
                  include: {
                      task: {
                          select: {
                              operationType: true,
                              applicationTechnique: true,
                              title: true,
                              key: true,
                              assigneeUserId: true,
                          },
                      },
                      product: {
                          select: {
                              name: true,
                              quarantinePeriodDays: true,
                              activeIngredient: true,
                              pppRegistrationNo: true,
                          },
                      },
                      doseUnit: { select: { symbol: true } },
                      parcel: { select: { name: true, cropType: true, areaHa: true } },
                  },
                  orderBy: { completedAt: 'asc' },
              })
            : [];

        // A treatment-scoped document's period IS the treatment's day, known
        // only now. Every line of one treatment shares a `completedAt` — the
        // write stamps them all with the same day — so the first is the day.
        // Falls back to the epoch-wide bounds when a handle resolves to
        // nothing, which the route turns into a 404 before rendering.
        if (locationId == null) {
            const stamped = lines.find((l) => l.completedAt != null)?.completedAt ?? null;
            if (stamped) {
                fromD = stamped;
                toD = stamped;
            }
        }

        // Cert snapshots (frozen at completion) keyed by operationParcelId.
        // diary-allow: soft-deleted — deliberate. The spray line itself prints
        // from OperationParcel regardless of the journal entry's lifecycle, and
        // the snapshot frozen at completion is the factual record of who held
        // which certificate at that moment; falling back to LIVE membership
        // certs (which may have changed since) would be LESS accurate.
        const lineIds = lines.map((l) => l.id);
        const logs = lineIds.length
            ? await db.logEntry.findMany({
                  where: {
                      tenantId: ctx.tenantId,
                      type: 'INPUT_APPLICATION',
                      operationParcelId: { in: lineIds },
                  },
                  select: { operationParcelId: true, conditionsJson: true },
              })
            : [];
        const condByLine = new Map<string, CertSnapshot>();
        for (const le of logs) {
            if (le.operationParcelId && le.conditionsJson && typeof le.conditionsJson === 'object') {
                condByLine.set(le.operationParcelId, le.conditionsJson as CertSnapshot);
            }
        }

        // Live-membership fallback for legacy lines with no snapshot.
        const fallbackUserIds = [
            ...new Set(
                lines
                    .filter((l) => !condByLine.get(l.id))
                    .map((l) => l.task.assigneeUserId)
                    .filter((v): v is string => Boolean(v)),
            ),
        ];
        const memberByUser = new Map<
            string,
            { applicatorCertNo: string | null; agronomistCertNo: string | null; agronomistName: string | null }
        >();
        if (fallbackUserIds.length) {
            const members = await db.tenantMembership.findMany({
                where: { tenantId: ctx.tenantId, userId: { in: fallbackUserIds } },
                select: {
                    userId: true,
                    applicatorCertNo: true,
                    agronomistCertNo: true,
                    agronomistName: true,
                },
            });
            for (const mem of members) memberByUser.set(mem.userId, mem);
        }

        const sprayLines: SprayLineData[] = [];
        const fertilizeLines: FertilizeLineData[] = [];
        for (const l of lines) {
            const opType = resolveOperationType(l.task);
            const cond = condByLine.get(l.id);
            const fb = l.task.assigneeUserId ? memberByUser.get(l.task.assigneeUserId) : undefined;
            const dose = `${Number(l.doseValue)} ${l.doseUnit?.symbol ?? ''}`.trim();
            const areaHa = l.parcel?.areaHa != null ? Number(l.parcel.areaHa) : null;
            const treatedAreaHa = l.treatedAreaHa != null ? Number(l.treatedAreaHa) : null;

            if (opType === 'FERTILIZE') {
                fertilizeLines.push({
                    completedAt: l.completedAt,
                    productName: l.product?.name ?? '',
                    activeIngredient: l.product?.activeIngredient ?? null,
                    dose,
                    areaHa,
                    treatedAreaHa,
                });
            } else {
                sprayLines.push({
                    parcelId: l.parcelId,
                    completedAt: l.completedAt,
                    targetNote: l.targetNote,
                    productName: l.product?.name ?? '',
                    dose,
                    areaHa,
                    treatedAreaHa,
                    phenophase: l.phenophase ?? null,
                    applicationTechnique:
                        cond?.applicationTechnique ?? l.task.applicationTechnique ?? null,
                    // The line's OWN period first (#1775) — what applied on
                    // the day. The product is the fallback for every line
                    // written before that column existed, which is the
                    // behaviour those lines were created under. A null on the
                    // line means "not captured", never zero.
                    quarantineDays:
                        l.quarantinePeriodDays ?? l.product?.quarantinePeriodDays ?? null,
                    operatorCertNo: cond?.operatorCertNo ?? fb?.applicatorCertNo ?? null,
                    agronomistName: cond?.agronomistName ?? fb?.agronomistName ?? null,
                    agronomistCertNo: cond?.agronomistCertNo ?? fb?.agronomistCertNo ?? null,
                });
            }
        }

        // Observations for the per-field register. Three correctness rules
        // (each locked by tests/guardrails/farm-record-diary-integrity.test.ts):
        //   • `deletedAt: null` — a soft-deleted (mistaken) observation must
        //     NEVER print in the legally-filed ДНЕВНИК.
        //   • Location scope — entries explicitly linked to ANOTHER field are
        //     excluded from this field's register; entries with no location
        //     link are farm-wide notes and stay included (best-effort).
        //   • Bounded but roomy: MAX_OBSERVATION_ROWS is headroom, not a
        //     cliff — a season of scouting entries fits far below it.
        const obs = await db.logEntry.findMany({
            where: {
                tenantId: ctx.tenantId,
                type: 'OBSERVATION',
                deletedAt: null,
                occurredAt: { gte: fromD, lte: toD },
                OR: [
                    { locations: { none: {} } },
                    // A treatment-scoped document carries no RECORDED
                    // observations — the issue asks for "only this entry's
                    // rows", and an observation is a different entry. `''`
                    // matches no location rather than every one, which is what
                    // dropping the clause would do.
                    //
                    // It is no longer blank, though: since #2072 such a
                    // document DERIVES its own scouting rows from its
                    // treatments (#1740 Q2), so the section shows that
                    // treatment's growth stage and says that the row was
                    // derived rather than observed.
                    { locations: { some: { locationId: locationId ?? '' } } },
                ],
            },
            select: { occurredAt: true, title: true, notes: true },
            orderBy: { occurredAt: 'asc' },
            take: MAX_OBSERVATION_ROWS,
        });
        const recorded: ObservationData[] = obs.map((o) => ({
            occurredAt: o.occurredAt,
            // `title` is already plain text (sanitizePlainText at the journal
            // usecase boundary); `notes` is sanitized RICH-TEXT HTML and must
            // be flattened before it lands in a printed cell.
            phenophase: o.title ?? null,
            disease: htmlNotesToPlainText(o.notes),
            pest: null,
            derived: false,
        }));

        // Recorded observations and rows derived from this document's own
        // treatments, oldest first — the section is a chronology, and
        // interleaving by date is what makes it read as one.
        //
        // This is why the note above about a treatment-scoped document
        // carrying no observations is no longer the whole story: it carries no
        // RECORDED ones, and now derives its own.
        const observations: ObservationData[] = [
            ...recorded,
            ...deriveObservationsFromSprays(sprayLines),
        ].sort((a, b) => (a.occurredAt?.getTime() ?? 0) - (b.occurredAt?.getTime() ?? 0));

        // ── Per-field header data ───────────────────────────────────
        // Every field of the location gets a sheet, blank when nothing was
        // applied to it — on this form that blank sheet IS the record that
        // nothing was.
        //
        // Ordered by `name, id` so a regenerated register is stable (#1742).
        // The comment here used to say "ordered by name so a regenerated
        // register is stable", which was a property the code did not deliver:
        // parcel names are not unique and Postgres does not order ties, so two
        // fields sharing a name could swap SHEETS between generations of the
        // same ДНЕВНИК. That is a register a farmer submits to БАБХ, so
        // stability is worth more here than in a picker.
        // Which fields get a header strip.
        //
        // A BLOCK register sheets every parcel in the block, treated or not —
        // that is the paper form. A TREATMENT document sheets only the
        // parcels it touched, which is what "a field header strip for each
        // treated parcel" (#1740) asks for, and is why the strips can carry
        // the block when the farm header cannot.
        const treatedParcelIds =
            locationId == null ? [...new Set(lines.map((l) => l.parcelId))] : null;
        const parcels = await db.parcel.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                ...(locationId != null
                    ? { locationId }
                    : { id: { in: treatedParcelIds ?? [] } }),
            },
            select: {
                id: true,
                name: true,
                cropType: true,
                cadastralId: true,
                areaHa: true,
                landDistrict: true,
                locality: true,
                produceStore: true,
            },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take: MAX_FIELD_SHEETS,
        });

        // Култура / Сорт / Дата на сеитба / Предшественик come from the
        // planting history, not the parcel: Parcel.cropType is a single
        // current-crop label with no variety, date or previous crop.
        const parcelIds = parcels.map((pc) => pc.id);
        const plantings = parcelIds.length
            ? await db.planting.findMany({
                  where: {
                      tenantId: ctx.tenantId,
                      parcelId: { in: parcelIds },
                      deletedAt: null,
                  },
                  select: {
                      parcelId: true,
                      sowDate: true,
                      transplantDate: true,
                      variety: { select: { name: true } },
                      cropPlan: {
                          select: {
                              cropType: { select: { name: true } },
                              variety: { select: { name: true } },
                          },
                      },
                  },
              })
            : [];

        type PlantingRow = (typeof plantings)[number];
        /** A transplanted crop has no sowDate; the form wants the date it went in. */
        const sownOn = (pl: PlantingRow): Date | null => pl.sowDate ?? pl.transplantDate ?? null;

        const historyByParcel = new Map<string, PlantingRow[]>();
        for (const pl of plantings) {
            if (!pl.parcelId) continue;
            const arr = historyByParcel.get(pl.parcelId) ?? [];
            arr.push(pl);
            historyByParcel.set(pl.parcelId, arr);
        }
        // Newest first, undated last — sorted here rather than in the query
        // because the ordering key is sowDate-or-transplantDate, not a column.
        for (const arr of historyByParcel.values()) {
            arr.sort((a, b) => (sownOn(b)?.getTime() ?? -Infinity) - (sownOn(a)?.getTime() ?? -Infinity));
        }

        const fields: FieldHeaderData[] = parcels.map((pc) => {
            const history = historyByParcel.get(pc.id) ?? [];
            // The crop this sheet is about: the most recent planting that had
            // gone in BY THE END of the reported period. A later one belongs
            // to the next season's register, not this one.
            const current =
                history.find((h) => {
                    const d = sownOn(h);
                    return d !== null && d <= toD;
                }) ?? null;
            const cropName = current?.cropPlan?.cropType?.name ?? pc.cropType ?? null;
            // Предшественик — the most recent DIFFERENT crop before it. With
            // nothing currently planted, the last crop grown IS the
            // predecessor, which is why the scan starts at 0 in that case.
            let predecessor: string | null = null;
            for (let i = current ? history.indexOf(current) + 1 : 0; i < history.length; i++) {
                const name = history[i].cropPlan?.cropType?.name ?? null;
                if (name && name !== cropName) {
                    predecessor = name;
                    break;
                }
            }
            return {
                parcelId: pc.id,
                fieldNo: pc.name || null,
                cadastralId: pc.cadastralId,
                landDistrict: pc.landDistrict,
                locality: pc.locality,
                produceStore: pc.produceStore,
                cropType: cropName,
                variety: current?.variety?.name ?? current?.cropPlan?.variety?.name ?? null,
                areaHa: pc.areaHa != null ? Number(pc.areaHa) : null,
                predecessor,
                sowDate: current ? sownOn(current) : null,
            };
        });

        return {
            locationName: location?.name ?? '',
            // Days, not the raw inputs: a treatment-scoped document's period is
            // derived above rather than passed in, and the header must print what
            // the document actually covers.
            from: fromD.toISOString().slice(0, 10),
            to: toD.toISOString().slice(0, 10),
            profile,
            sprayLines,
            fertilizeLines,
            observations,
            fields,
        };
    });
}

export async function generateFarmRecordDiaryPdf(
    ctx: RequestContext,
    opts: { locationId: string; from: string; to: string },
): Promise<PDFKit.PDFDocument> {
    const doc = await generateFarmRecordDiaryPdfScoped(ctx, { kind: 'location', ...opts });
    // ## SUPERSEDED, 2026-10-23 (#2183)
    //
    // This assertion read, verbatim:
    //
    //   > A block register is never null: the emptiness check applies to a
    //   > treatment handle only, because a block with no work in the period
    //   > still prints — blank, like the paper form. Asserted rather than cast
    //   > away, so if that ever stops holding it says so instead of returning
    //   > undefined.
    //
    // Kept because it is the better argument and may well be re-adopted: the
    // paper БАБХ form prints its sections whether or not they have rows, and a
    // blank register is a document a farmer can file to show a clean period.
    //
    // The owner ruled the other way, twice — once on 2026-10-22 choosing "say
    // nothing was recorded" over both "cover page only" and "keep the blank
    // form", and again on 2026-10-23 when the question was put back as a
    // possible reversal with the declined options named. A register that
    // exists only to say nothing happened was judged worse than an honest
    // refusal the client can phrase.
    if (!doc) {
        // The code is written as a LITERAL here, not as the constant above,
        // and the duplication is deliberate. `a-new-code-ships-with-its-entry`
        // scans throw sites to check a new code arrives with its Bulgarian
        // entry, and it can only do that for a code it can READ — an
        // identifier makes the site opaque, which the guard then wants
        // DECLARED as an opt-out. Opting out of the check that the farmer sees
        // Bulgarian is a worse trade than one repeated string, and the two
        // cannot drift: the integration test asserts this literal while the
        // job's predicate compares the constant.
        throw codedNotFound(
            'REGISTER_EMPTY_FOR_PERIOD',
            'Nothing was recorded for this block in this period.',
            { reference: 'locationId' },
        );
    }
    return doc;
}

/**
 * The same document, for either scope (#1740 item 3).
 *
 * ONE renderer. A per-entry document produced by a second renderer would stop
 * being "the same layout, so it can be certified" the first time one of them
 * changed — which is the whole requirement.
 *
 * Returns `null` when a treatment handle resolves to no DONE lines, so the
 * route can answer 404 rather than render an empty register that looks like a
 * real document with nothing in it.
 */
/**
 * The refusal code for a register with nothing in its period (#2183).
 *
 * Its OWN code rather than a bare 404, because one status would collapse
 * three situations a client must tell apart: no such block, not this tenant's
 * block, and a block that exists and simply had a quiet period. The third is
 * the only GOOD-NEWS case and it is the common one — an untreated block in a
 * period is normal — so a client that cannot recognise it shows an error for
 * the most ordinary outcome there is.
 */
export const REGISTER_EMPTY_FOR_PERIOD = 'REGISTER_EMPTY_FOR_PERIOD';

/**
 * Whether a gathered register has anything to report.
 *
 * The three DATA sections only. `fields` is deliberately not counted: a block
 * has parcels whether or not anything happened on them, so counting it would
 * make every block non-empty and the check inert — the shape of a gate that
 * cannot fail.
 */
export function isRegisterEmpty(data: FarmRecordData): boolean {
    return (
        data.sprayLines.length === 0 &&
        data.fertilizeLines.length === 0 &&
        data.observations.length === 0
    );
}

/** True when `err` is this module's empty-register refusal. */
export function isRegisterEmptyRefusal(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: unknown }).code === REGISTER_EMPTY_FOR_PERIOD
    );
}

export async function generateFarmRecordDiaryPdfScoped(
    ctx: RequestContext,
    scope: FarmRecordScope,
): Promise<PDFKit.PDFDocument | null> {
    const data = await gatherFarmRecord(ctx, scope);
    if (scope.kind === 'treatment' && data.sprayLines.length === 0 && data.fertilizeLines.length === 0) {
        return null;
    }
    // A LOCATION-scoped register with nothing in its period is now refused
    // too (owner ruling 2026-10-22, confirmed 2026-10-23) — see the
    // SUPERSEDED note on `generateFarmRecordDiaryPdf`.
    if (scope.kind === 'location' && isRegisterEmpty(data)) {
        return null;
    }

    const meta: ReportMeta = {
        tenantName: data.locationName || 'Farm',
        reportTitle: 'Дневник за проведените растителнозащитни мероприятия и торене',
        reportSubtitle: data.locationName,
        generatedAt: new Date().toISOString(),
        watermark: 'NONE',
        fontFamily: 'unicode',
    };

    const doc = createPdfDocument(meta);
    renderFarmRecordDiary(doc, data, BG_LABELS);

    // NOTE: do NOT call doc.end() — the route's collectPdfBuffer finalises.
    return doc;
}

/**
 * Combined SEASON diary — one section-set per Location that had a completed
 * operation in the season window, page-break between, rendered into a SINGLE
 * document (the same generator). Backs the seasons-page row action. Page
 * numbers are stamped ONCE across the whole document at the end.
 */
export async function generateSeasonDiaryPdf(
    ctx: RequestContext,
    opts: { seasonId: string },
): Promise<PDFKit.PDFDocument> {
    assertCanRead(ctx);

    const { from, to, seasonName, locationIds } = await runInTenantContext(ctx, async (db) => {
        const season = await db.season.findFirst({
            where: { id: opts.seasonId, tenantId: ctx.tenantId },
            select: { name: true, startDate: true, endDate: true },
        });
        if (!season) throw codedNotFound('SEASON_NOT_FOUND', 'Season not found');
        const f = season.startDate.toISOString().slice(0, 10);
        const t = season.endDate.toISOString().slice(0, 10);

        // Locations with ≥1 DONE operation line in the season window.
        const doneLines = await db.operationParcel.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: 'DONE',
                completedAt: { gte: season.startDate, lte: season.endDate },
            },
            select: { taskId: true },
        });
        const taskIds = [...new Set(doneLines.map((l) => l.taskId))];
        const links = taskIds.length
            ? await db.taskLink.findMany({
                  where: { tenantId: ctx.tenantId, entityType: 'LOCATION', taskId: { in: taskIds } },
                  select: { entityId: true },
              })
            : [];
        const ids = [...new Set(links.map((l) => l.entityId))];
        // ## SUPERSEDED, 2026-10-23 (#2183)
        //
        // There was a fallback here, and its reasoning was:
        //
        //   > Fallback: no completed ops → still produce a per-location
        //   > register over the tenant's fields (empty ruled tables), so the
        //   > file is a usable blank ДНЕВНИК rather than a single empty page.
        //
        // It took up to 25 locations and rendered each as blank ruled tables.
        // That stopped working the moment empty sections began to be omitted:
        // with no data and no blank forms, each location contributes a COVER
        // and nothing else, so the fallback's own purpose — a usable blank
        // register — became 25 cover pages.
        //
        // Owner ruling 2026-10-23: refuse, with the same code a block uses. A
        // farmer who wants a blank form to fill in is better served by the
        // printed Приложение 1 than by a PDF of covers.
        return { from: f, to: t, seasonName: season.name, locationIds: ids };
    });

    const meta: ReportMeta = {
        tenantName: seasonName,
        reportTitle: 'Дневник за проведените растителнозащитни мероприятия и торене',
        reportSubtitle: seasonName,
        generatedAt: new Date().toISOString(),
        watermark: 'NONE',
        fontFamily: 'unicode',
    };
    const doc = createPdfDocument(meta);

    let first = true;
    let rendered = 0;
    for (const locationId of locationIds) {
        const data = await gatherFarmRecordData(ctx, locationId, from, to);
        // A location is picked from `operationParcel` rows that are DONE in the
        // window, so it normally has lines to print. One case makes it empty
        // anyway, and it is reachable because of #2184: `gatherFarmRecord`
        // filters `task.deletedAt`, so a season whose only work was a
        // treatment later WITHDRAWN still selects the location and then
        // gathers nothing. Without this it would contribute a lone cover page.
        //
        // COVERED, #2201: `season ДНЕВНИК skips an EMPTY location without
        // dropping the rest` in `tests/integration/farm-record-diary.test.ts`.
        // Deleting this line takes the composed document from 2 pages to 3 —
        // the extra one is this location's lone cover.
        //
        // The test needs TWO locations and that is not incidental. With the
        // empty one alone, `rendered` reaches 0 and the refusal below fires,
        // which is indistinguishable from the skip: the case passes with this
        // line deleted. It took a second location that really prints for the
        // assertion to have teeth.
        if (isRegisterEmpty(data)) continue;
        if (!first) doc.addPage({ size: 'A4', layout: 'portrait' });
        renderFarmRecordDiary(doc, data, BG_LABELS, false);
        first = false;
        rendered += 1;
    }
    if (rendered === 0) {
        throw codedNotFound(
            'REGISTER_EMPTY_FOR_PERIOD',
            'Nothing was recorded for this season.',
            { reference: 'seasonId' },
        );
    }
    stampPageNumbers(doc, BG_LABELS);

    // NOTE: do NOT call doc.end() — the route's collectPdfBuffer finalises.
    return doc;
}

/**
 * Generate the ДНЕВНИК and PERSIST it as a FileRecord (domain 'reports') —
 * the single save seam shared by the manual route (`save:true`) and the
 * auto-generation BullMQ job. The filename encodes the location + range +
 * an `-auto` suffix so the register can list, filter, and label rows without
 * a side table: `dnevnik-<locationId>-<from>_<to>[-auto].pdf`.
 *
 * `uploadedByUserId` is a REQUIRED User FK — the job passes a real user
 * (the task assignee/creator), never a synthetic 'system' id.
 */
export async function saveFarmRecordDiary(
    ctx: RequestContext,
    opts: { locationId: string; from: string; to: string; auto?: boolean; uploadedByUserId?: string },
): Promise<{ fileRecordId: string; fileName: string }> {
    const doc = await generateFarmRecordDiaryPdf(ctx, {
        locationId: opts.locationId,
        from: opts.from,
        to: opts.to,
    });
    const pdfBuffer = await collectPdfBuffer(doc);
    const fileName = `dnevnik-${opts.locationId}-${opts.from}_${opts.to}${opts.auto ? '-auto' : ''}.pdf`;

    const storage = getStorageProvider();
    const pathKey = buildTenantObjectKey(ctx.tenantId, 'reports', fileName);
    // storage.write accepts a Buffer directly — pass the PDF bytes as-is.
    // (A dynamic `await import('stream')` for Readable resolved to undefined
    // in the Next server bundle, throwing on Readable.from.)
    const writeResult = await storage.write(pathKey, pdfBuffer, {
        mimeType: 'application/pdf',
    });
    const fileRecord = (await runInTenantContext(ctx, (db) =>
        db.fileRecord.create({
            data: {
                tenantId: ctx.tenantId,
                pathKey,
                originalName: fileName,
                mimeType: 'application/pdf',
                sizeBytes: writeResult.sizeBytes,
                sha256: writeResult.sha256,
                status: 'STORED',
                uploadedByUserId: opts.uploadedByUserId ?? ctx.userId,
                storedAt: new Date(),
                storageProvider: storage.name,
                domain: 'reports',
                scanStatus: 'SKIPPED',
            },
        }),
    )) as { id: string };

    return { fileRecordId: fileRecord.id, fileName };
}

/** The farm-record filename prefix for a location (register list filter). */
export function farmRecordNamePrefix(locationId: string): string {
    return `dnevnik-${locationId}-`;
}

/**
 * Parse a farm-record `originalName` back into its period + auto flag.
 * Returns null when the name isn't a farm-record diary for this location.
 * Shape: `dnevnik-<locationId>-<from>_<to>[-auto].pdf` (locationId is a cuid,
 * no hyphens, so the split is unambiguous).
 */
export function parseFarmRecordFileName(
    originalName: string,
    locationId: string,
): { from: string; to: string; auto: boolean } | null {
    const prefix = farmRecordNamePrefix(locationId);
    if (!originalName.startsWith(prefix) || !originalName.endsWith('.pdf')) return null;
    let rest = originalName.slice(prefix.length, -'.pdf'.length);
    let auto = false;
    if (rest.endsWith('-auto')) {
        auto = true;
        rest = rest.slice(0, -'-auto'.length);
    }
    const sep = rest.indexOf('_');
    if (sep < 0) return null;
    return { from: rest.slice(0, sep), to: rest.slice(sep + 1), auto };
}

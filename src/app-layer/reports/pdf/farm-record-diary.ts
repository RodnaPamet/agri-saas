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
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { resolveOperationType } from '@/app-layer/usecases/field-operation';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { createPdfDocument, UNICODE_FONT, UNICODE_FONT_BOLD } from '@/lib/pdf/pdfKitFactory';
import { getStorageProvider, buildTenantObjectKey } from '@/lib/storage';
import type { ReportMeta } from '@/lib/pdf/types';

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
    egn: string;
    eik: string;
    agriDirectorate: string;
    registrationPlace: string;
    ekatte: string;
    odbh: string;
    legalLine: string;
    observationSection: string;
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
    egn: 'ЕГН',
    eik: 'ЕИК',
    agriDirectorate: 'Областна дирекция „Земеделие“ гр.',
    registrationPlace: 'Място на регистриране',
    ekatte: 'ЕКАТТЕ на регистрация',
    odbh: 'Областна дирекция по безопасност на храните (ОДБХ) гр.',
    legalLine:
        'Записите в дневника се водят на основание чл. 115 а и чл. 142, ал. 3 от Закона за защита на растенията',
    observationSection:
        'ПОЯВА, РАЗВИТИЕ, ПЛЪТНОСТ ИЛИ СТЕПЕН НА НАПАДЕНИЕ ОТ ВРЕДИТЕЛИ',
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
    egn: string | null;
    eik: string | null;
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
}

export interface ObservationData {
    occurredAt: Date | null;
    phenophase: string | null;
    disease: string | null;
    pest: string | null;
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

function fmtDate(d: Date | null | undefined): string {
    if (!d) return '';
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
            toDka(l.areaHa),
            l.applicationTechnique ?? '',
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
        toDka(l.areaHa),
    ]);
}

/** Best-effort 11-column observation rows from OBSERVATION journal entries. */
export function buildObservationRows(obs: ObservationData[]): string[][] {
    return obs.map((o) => [
        fmtDate(o.occurredAt),
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
 * Split the period's treatments into one sheet per field.
 *
 * Two properties matter more than the grouping itself, because this feeds a
 * legally-filed register:
 *   • NO LINE IS LOST. A treatment whose field is not in `fields` — the
 *     field list is capped at MAX_FIELD_SHEETS, the spray lines are not —
 *     lands in a trailing group with a BLANK strip rather than being
 *     filtered away. A vanished spray is an unrecorded chemical application.
 *   • NO LINE IS DUPLICATED. Printing one treatment under two fields would
 *     claim an application that never happened.
 * `tests/pdf/farm-record-diary.test.ts` asserts both directly.
 */
export function groupSprayLinesByField(
    fields: FieldHeaderData[],
    sprayLines: SprayLineData[],
): FieldSprayGroup[] {
    const groups: FieldSprayGroup[] = fields.map((f) => ({
        field: f,
        lines: sprayLines.filter((l) => l.parcelId === f.parcelId),
    }));
    const knownFields = new Set(fields.map((f) => f.parcelId));
    const orphanLines = sprayLines.filter((l) => !l.parcelId || !knownFields.has(l.parcelId));
    // The same branch gives an idle period its one blank sheet, so the
    // section is never absent from the document.
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

    // Boxed ЕГН (10) + ЕИК (13)
    doc.font(UNICODE_FONT).fontSize(10).fillColor(INK).text(`${L.egn}:`, m.left, y, { lineBreak: false });
    drawBoxedCells(doc, m.left + 40, y - 3, 10, p.egn);
    y += 24;
    doc.text(`${L.eik}:`, m.left, y, { lineBreak: false });
    drawBoxedCells(doc, m.left + 40, y - 3, 13, p.eik);
    y += 28;

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
    const chemGroups = groupSprayLinesByField(data.fields, data.sprayLines);
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

    // ── LANDSCAPE: sampling (empty ruled) ───────────────────────────
    doc.addPage({ size: 'A4', layout: 'landscape' });
    doc.font(UNICODE_FONT_BOLD).fontSize(11).fillColor(INK);
    doc.text(L.samplingSection, doc.page.margins.left, doc.page.margins.top, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'center',
    });
    drawRuledTable(doc, doc.y + 8, L.sampleCols, L.sampleCols.map(() => ({ weight: 1 })), [], 8);

    // ── PORTRAIT: ОДБХ inspector result (empty ruled) ───────────────
    doc.addPage({ size: 'A4', layout: 'portrait' });
    doc.font(UNICODE_FONT_BOLD).fontSize(11).fillColor(INK);
    doc.text(L.inspectorSection, doc.page.margins.left, doc.page.margins.top, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'center',
    });
    drawRuledTable(
        doc,
        doc.y + 8,
        L.inspectorCols,
        [{ weight: 1 }, { weight: 3 }, { weight: 3 }, { weight: 1.5 }],
        [],
        8,
    );

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

export async function gatherFarmRecordData(
    ctx: RequestContext,
    locationId: string,
    from: string,
    to: string,
): Promise<FarmRecordData> {
    // Report read-gate (same privilege model as year-on-farm). Read the
    // FarmProfile directly (NOT via getFarmProfile, which requires
    // admin-settings permission) — the Epic B extension still decrypts
    // egn/eik transparently on this read.
    assertCanRead(ctx);
    const fromD = new Date(from);
    const toD = new Date(to);

    return runInTenantContext(ctx, async (db) => {
        const location = await db.location.findFirst({
            where: { id: locationId, tenantId: ctx.tenantId },
            select: { name: true },
        });

        const profileRow = await db.farmProfile.findUnique({
            where: { tenantId: ctx.tenantId },
        });
        const profile: FarmProfileData = profileRow
            ? {
                  producerName: profileRow.producerName ?? null,
                  egn: profileRow.egn ?? null,
                  eik: profileRow.eik ?? null,
                  address: profileRow.address ?? null,
                  municipality: profileRow.municipality ?? null,
                  settlement: profileRow.settlement ?? null,
                  agricultureDirectorateCity: profileRow.agricultureDirectorateCity ?? null,
                  registrationPlace: profileRow.registrationPlace ?? null,
                  registrationEkatte: profileRow.registrationEkatte ?? null,
                  odbhCity: profileRow.odbhCity ?? null,
              }
            : { ...EMPTY_PROFILE };

        const links = await db.taskLink.findMany({
            where: { tenantId: ctx.tenantId, entityType: 'LOCATION', entityId: locationId },
            select: { taskId: true },
        });
        const taskIds = links.map((l) => l.taskId);

        const lines = taskIds.length
            ? await db.operationParcel.findMany({
                  where: {
                      tenantId: ctx.tenantId,
                      taskId: { in: taskIds },
                      status: 'DONE',
                      completedAt: { gte: fromD, lte: toD },
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

            if (opType === 'FERTILIZE') {
                fertilizeLines.push({
                    completedAt: l.completedAt,
                    productName: l.product?.name ?? '',
                    activeIngredient: l.product?.activeIngredient ?? null,
                    dose,
                    areaHa,
                });
            } else {
                sprayLines.push({
                    parcelId: l.parcelId,
                    completedAt: l.completedAt,
                    targetNote: l.targetNote,
                    productName: l.product?.name ?? '',
                    dose,
                    areaHa,
                    applicationTechnique:
                        cond?.applicationTechnique ?? l.task.applicationTechnique ?? null,
                    quarantineDays: l.product?.quarantinePeriodDays ?? null,
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
                    { locations: { some: { locationId } } },
                ],
            },
            select: { occurredAt: true, title: true, notes: true },
            orderBy: { occurredAt: 'asc' },
            take: MAX_OBSERVATION_ROWS,
        });
        const observations: ObservationData[] = obs.map((o) => ({
            occurredAt: o.occurredAt,
            // `title` is already plain text (sanitizePlainText at the journal
            // usecase boundary); `notes` is sanitized RICH-TEXT HTML and must
            // be flattened before it lands in a printed cell.
            phenophase: o.title ?? null,
            disease: htmlNotesToPlainText(o.notes),
            pest: null,
        }));

        // ── Per-field header data ───────────────────────────────────
        // Every field of the location gets a sheet, blank when nothing was
        // applied to it — on this form that blank sheet IS the record that
        // nothing was. Ordered by name so a regenerated register is stable.
        const parcels = await db.parcel.findMany({
            where: { tenantId: ctx.tenantId, locationId, deletedAt: null },
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
            orderBy: { name: 'asc' },
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
            from,
            to,
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
    const data = await gatherFarmRecordData(ctx, opts.locationId, opts.from, opts.to);

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
        if (!season) throw notFound('Season not found');
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
        let ids = [...new Set(links.map((l) => l.entityId))];
        // Fallback: no completed ops → still produce a per-location register
        // over the tenant's fields (empty ruled tables), so the file is a
        // usable blank ДНЕВНИК rather than a single empty page.
        if (ids.length === 0) {
            const locs = await db.location.findMany({
                where: { tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true },
                orderBy: { name: 'asc' },
                take: 25,
            });
            ids = locs.map((l) => l.id);
        }
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
    for (const locationId of locationIds) {
        const data = await gatherFarmRecordData(ctx, locationId, from, to);
        if (!first) doc.addPage({ size: 'A4', layout: 'portrait' });
        renderFarmRecordDiary(doc, data, BG_LABELS, false);
        first = false;
    }
    stampPageNumbers(doc, BG_LABELS);

    // NOTE: do NOT call doc.end() — the route's collectPdfBuffer finalises.
    return doc;
}

/** Collect a PDFKit document into a Buffer (listeners first, then end()). */
function collectPdfBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
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

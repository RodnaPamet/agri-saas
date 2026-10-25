/**
 * «ДНЕВНИК НА СТОПАНСТВОТО» — the whole-farm campaign journal (#2316).
 *
 * The owner's own template, which REPLACES the БАБХ period download. The БАБХ
 * register stays per treatment; `farm-record-diary.ts` renders that and is a
 * different document, not a predecessor of this one:
 *
 *   | | `farm-record-diary` | this |
 *   | structure | one section-set PER LOCATION, page-broken | ONE landscape table |
 *   | tables | 12-column chemical + 5-column fertiliser, per block | nine columns, one table |
 *   | a row is | one spray or fertilise LINE | one ACTIVITY, dated, with its summed area |
 *
 * So «Пръскане – 17,05 ха» is one row for one spraying across several parcels
 * where the BABH register prints one row per parcel line. A different
 * aggregation, not a different layout — which is why the row building lives in
 * `../campaign-diary/rows.ts` and is tested without a PDF at all.
 *
 * ## Why the header row is drawn here rather than by `drawRuledTable`
 *
 * That helper is orientation-aware, repeats its header across page breaks and
 * wraps Cyrillic — everything this needs except the one thing the template
 * requires: **nine columns under seven headers, two of which span a pair.**
 * It takes a flat `headers: string[]` and cannot express a span.
 *
 * Extending it was the alternative and was rejected: it is the БАБХ
 * register's drawer, `farm-record-diary-integrity` pins that document's column
 * counts, and a two-tier mode would be dead weight there forever. The span is
 * specific to this form.
 *
 * ## The row cap question, answered explicitly
 *
 * `farm-record-diary.ts` caps field SHEETS at `MAX_FIELD_SHEETS = 200` and
 * deliberately does NOT cap spray lines, because *"a vanished spray is an
 * unrecorded chemical application"*.
 *
 * A campaign row is the same kind of record, so **rows are not capped here
 * either** — a decision rather than an inheritance. The consequence is real: a
 * farm with years of history can request a large PDF, and the route carries
 * `maxDuration` for it. Trading completeness for a bound would mean a
 * regulated document that silently omits work, which is the worse failure.
 */
import { UNICODE_FONT, UNICODE_FONT_BOLD } from '@/lib/pdf/pdfKitFactory';
import type { CampaignDiaryRow } from '@/app-layer/reports/campaign-diary/rows';

const INK = '#0f172a';
const MUTED = '#64748b';
const GRID = '#cbd5e1';
const HEADER_BG = '#e2e8f0';

/** The four-line header the form carries above the table. */
export interface CampaignDiaryHeader {
    /** `FarmProfile.producerName` — the holder's full name. */
    producerName: string | null;
    /** `FarmProfile.settlement` — село. */
    settlement: string | null;
    /** `FarmProfile.municipality` — община. */
    municipality: string | null;
    /** `FarmProfile.oblast` — област. Added for this form (#2316 decision 6). */
    oblast: string | null;
}

export interface CampaignDiaryData {
    header: CampaignDiaryHeader;
    /** `2024-2025`. */
    campaignLabel: string;
    rows: CampaignDiaryRow[];
    /** From the row builder, so the document can state what it omitted. */
    skippedIncomplete: number;
    rowsWithUnknownArea: number;
}

/**
 * The nine columns, in the template's order, with the seven printed headers.
 *
 * `span: 2` marks a header that sits above the NEXT TWO columns. The weights
 * are per column and sum to 100 so the table fills the page whatever the
 * paper width.
 */
interface Col {
    /** Sub-header, for a column under a spanning group. */
    sub?: string;
    weight: number;
    align?: 'left' | 'right' | 'center';
}

const GROUPS: ReadonlyArray<{ title: string; cols: Col[] }> = [
    { title: 'Дата', cols: [{ weight: 9 }] },
    { title: 'Ид. № на парцела/полето /животното', cols: [{ weight: 13 }] },
    { title: 'Култура / Порода / Вид', cols: [{ weight: 12 }] },
    { title: 'Площ / Брой', cols: [{ weight: 8, align: 'right' }] },
    { title: 'Мероприятие', cols: [{ weight: 21 }] },
    {
        title: 'Използван препарат',
        cols: [
            { sub: 'Вид/ наименование', weight: 14 },
            { sub: 'Количество', weight: 9, align: 'right' },
        ],
    },
    {
        title: 'Продукция',
        cols: [
            { sub: 'Вид', weight: 7 },
            { sub: 'Количество кг', weight: 7, align: 'right' },
        ],
    },
];

/** Flattened, in print order. The row builder emits exactly these nine. */
const COLS: Col[] = GROUPS.flatMap((g) => g.cols);

/** The row builder's fields, in the same order as `COLS`. */
function cellsOf(r: CampaignDiaryRow): string[] {
    return [
        r.date,
        r.parcelIds,
        r.crops,
        r.area,
        r.activity,
        r.productName,
        r.doseLabel,
        r.produceKind,
        r.produceKg,
    ];
}

const PAD = 3;
const FONT_SIZE = 7;

function columnWidths(doc: PDFKit.PDFDocument): number[] {
    const m = doc.page.margins;
    const avail = doc.page.width - m.left - m.right;
    const total = COLS.reduce((s, c) => s + c.weight, 0);
    return COLS.map((c) => (c.weight / total) * avail);
}

/**
 * The two-tier header. Returns the y below it.
 *
 * A group with one column spans BOTH tiers — its title is drawn through the
 * full height rather than leaving an empty cell beneath, which on the real
 * form is a single tall box and not two stacked ones.
 */
function drawHeader(doc: PDFKit.PDFDocument, y: number): number {
    const widths = columnWidths(doc);
    const m = doc.page.margins;
    doc.font(UNICODE_FONT_BOLD).fontSize(FONT_SIZE);

    // Measure both tiers before drawing anything: a spanning title and its
    // sub-labels must share one box height or the grid lines do not meet.
    let titleH = 0;
    let subH = 0;
    let i = 0;
    for (const g of GROUPS) {
        const groupW = g.cols.reduce((s, _c, k) => s + widths[i + k], 0);
        const th = doc.heightOfString(g.title, { width: groupW - 2 * PAD });
        if (th > titleH) titleH = th;
        for (const c of g.cols) {
            if (!c.sub) continue;
            const sh = doc.heightOfString(c.sub, { width: widths[i] - 2 * PAD });
            if (sh > subH) subH = sh;
        }
        i += g.cols.length;
    }
    titleH += 2 * PAD;
    subH = subH ? subH + 2 * PAD : 0;

    let x = m.left;
    i = 0;
    for (const g of GROUPS) {
        const groupW = g.cols.reduce((s, _c, k) => s + widths[i + k], 0);
        const spans = g.cols.some((c) => c.sub);
        // A single-column group occupies both tiers; a spanning one occupies
        // the first and leaves the second to its sub-labels.
        const h = spans ? titleH : titleH + subH;
        doc.rect(x, y, groupW, h).fillAndStroke(HEADER_BG, '#94a3b8');
        doc.fillColor(INK).text(g.title, x + PAD, y + PAD, {
            width: groupW - 2 * PAD,
            align: 'center',
            lineBreak: true,
        });
        if (spans) {
            let sx = x;
            g.cols.forEach((c, k) => {
                doc.rect(sx, y + titleH, widths[i + k], subH).fillAndStroke(HEADER_BG, '#94a3b8');
                doc.fillColor(INK).text(c.sub ?? '', sx + PAD, y + titleH + PAD, {
                    width: widths[i + k] - 2 * PAD,
                    align: 'center',
                    lineBreak: true,
                });
                sx += widths[i + k];
            });
        }
        x += groupW;
        i += g.cols.length;
    }
    return y + titleH + subH;
}

/** The four-line holder block above the table. */
function drawHolder(doc: PDFKit.PDFDocument, h: CampaignDiaryHeader, campaign: string): number {
    const m = doc.page.margins;
    const w = doc.page.width - m.left - m.right;
    doc.font(UNICODE_FONT_BOLD).fontSize(13).fillColor(INK);
    doc.text('ДНЕВНИК НА СТОПАНСТВОТО', m.left, m.top, { width: w, align: 'center' });
    doc.font(UNICODE_FONT).fontSize(9).fillColor(MUTED);
    doc.text(`Кампания ${campaign.replace('-', '–')}`, { width: w, align: 'center' });
    doc.moveDown(0.6);
    doc.font(UNICODE_FONT).fontSize(9).fillColor(INK);
    // An absent field prints an em dash rather than the word "null" or a blank
    // that reads as a rendering fault. `oblast` is the one most likely to be
    // empty — it was added for this form and no existing farm has filled it.
    const v = (s: string | null) => (s && s.trim() ? s.trim() : '—');
    for (const [k, value] of [
        ['Име на земеделския стопанин', v(h.producerName)],
        ['Село', v(h.settlement)],
        ['Община', v(h.municipality)],
        ['Област', v(h.oblast)],
    ] as const) {
        doc.text(`${k}: ${value}`, { width: w });
    }
    return doc.y + 8;
}

/** «Страница N от M» in the bottom margin of every buffered page. */
export function stampCampaignPageNumbers(doc: PDFKit.PDFDocument): void {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const mp = doc.page.margins;
        doc.font(UNICODE_FONT)
            .fontSize(8)
            .fillColor(MUTED)
            .text(
                `Страница ${i - range.start + 1} от ${range.count}`,
                mp.left,
                doc.page.height - mp.bottom + 12,
                {
                    width: doc.page.width - mp.left - mp.right,
                    align: 'center',
                    lineBreak: false,
                    height: 12,
                },
            );
    }
}

/**
 * Render the whole document into an already-created landscape doc.
 *
 * Takes the doc rather than creating one so the route owns the lifecycle and
 * the suite can render into a throwaway document without a route at all.
 */
export function renderCampaignDiary(doc: PDFKit.PDFDocument, data: CampaignDiaryData): void {
    const m = doc.page.margins;
    let y = drawHolder(doc, data.header, data.campaignLabel);
    y = drawHeader(doc, y);
    const widths = columnWidths(doc);

    doc.font(UNICODE_FONT).fontSize(FONT_SIZE);
    for (const row of data.rows) {
        const cells = cellsOf(row);
        let rh = 0;
        cells.forEach((t, i) => {
            const measured = doc.heightOfString(t, { width: widths[i] - 2 * PAD });
            if (measured > rh) rh = measured;
        });
        rh += 2 * PAD;
        if (y + rh > doc.page.height - m.bottom) {
            doc.addPage({ size: 'A4', layout: 'landscape' });
            // The header repeats, because a continuation page whose columns
            // are unlabelled is unreadable as a register.
            y = drawHeader(doc, m.top);
        }
        let x = m.left;
        cells.forEach((t, i) => {
            doc.rect(x, y, widths[i], rh).stroke(GRID);
            doc.fillColor(INK).text(t, x + PAD, y + PAD, {
                width: widths[i] - 2 * PAD,
                align: COLS[i].align ?? 'left',
                lineBreak: true,
            });
            x += widths[i];
        });
        y += rh;
    }

    // What the document does NOT contain, stated in it. A reader comparing the
    // register against the app needs the difference explained in the register,
    // not in a log nobody reads.
    const notes: string[] = [];
    if (data.skippedIncomplete > 0) {
        notes.push(
            `Незавършени записи, невключени в дневника: ${data.skippedIncomplete}. `
                + 'Дневникът отразява извършената работа.',
        );
    }
    if (data.rowsWithUnknownArea > 0) {
        notes.push(
            `Редове без записана площ: ${data.rowsWithUnknownArea}. `
                + 'Колона «Площ» е празна, когато площта не е записана — не е нула.',
        );
    }
    if (notes.length) {
        doc.moveDown(0.8);
        doc.font(UNICODE_FONT).fontSize(7).fillColor(MUTED);
        for (const n of notes) doc.text(n, m.left, doc.y, { width: doc.page.width - m.left - m.right });
    }

    stampCampaignPageNumbers(doc);
}

/** Exported for the suite: the printed header titles, in order. */
export const CAMPAIGN_GROUP_TITLES = GROUPS.map((g) => g.title);
/** Exported for the suite: nine columns is the form's own count. */
export const CAMPAIGN_COLUMN_COUNT = COLS.length;

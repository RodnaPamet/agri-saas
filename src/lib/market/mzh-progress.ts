/**
 * The field campaign's progress from МЗХ's «Оперативен анализ» (#3173,
 * Табло line of agrent-ios#635): how much of each crop is harvested, and how
 * much is sown against last year.
 *
 * Owner ruling 2026-11-17: harvest as a SHARE (harvested ÷ area to harvest),
 * sowing as hectares and the change on last year — the sowing table gives no
 * plan to divide by, so a share there would be invented.
 *
 * ## Two table kinds, and the season decides which are present
 *
 *   - «Реколта от … към DD.MM.YYYY г.» — eight figures and four changes per
 *     crop: area to harvest, harvested area, production, yield, each for last
 *     year and this year, then the four year-on-year changes. Summer carries
 *     the winter crops (wheat, barley, rapeseed…), autumn sunflower and maize.
 *   - «Засети площи с … към DD.MM.YYYY г.» — sown hectares last year and this
 *     year and the change. «-» where a year has no figure.
 *
 * Anything else in section 1 (vegetables, tobacco, permanent crops, «Площи за
 * реколтиране» before a harvest starts) is not read.
 *
 * ## Why every reading is checked against the table's own arithmetic
 *
 * `pdftotext -layout` keeps columns apart with runs of spaces, but the
 * thousands separator is ALSO a space, and two adjacent columns are sometimes
 * one space apart: «1 484 916 2 436 796» is two numbers, and nothing in the
 * text says where the first ends. So a row is split every way the digit groups
 * allow, and a reading is kept only if the row's own figures agree with it —
 * harvested never above the area, the yield equal to production over area, and
 * every printed change equal to the change the figures make. Exactly one
 * reading must survive; none, or two that disagree, and the row is REFUSED
 * and reported, never guessed. A wrong 99% on a farmer's dashboard is worse
 * than no line.
 */

export type ProgressKind = 'HARVEST' | 'SOWING';

/** One crop in a harvest table. */
export interface HarvestProgressRow {
    /** The label as printed, wrapped lines joined: «царевица за зърно». */
    label: string;
    /** A canonical commodity slug, or null for a crop with no mapping. */
    commodity: string | null;
    /** This year's area to harvest, ha. */
    areaHa: number;
    /** This year's harvested area, ha. */
    harvestedHa: number;
    /** harvested ÷ area, whole percent, rounded half up. */
    harvestedPct: number;
    /** This year's production, t. */
    productionT: number;
    /** This year's average yield, kg/дка, as printed. */
    yieldKgPerDa: number;
}

/** One crop in a sowing table. */
export interface SowingProgressRow {
    label: string;
    commodity: string | null;
    /** This year's sown area, ha. */
    sownHa: number;
    /** Last year's at the same date, ha; null where the table prints «-». */
    lastYearHa: number | null;
    /**
     * The year-on-year change AS PRINTED, as a decimal string with a point:
     * «16,6%» → "16.6". Null where the table prints «-». A string, because it
     * is a printed figure shown back as printed, not a quantity to compute on.
     */
    changePct: string | null;
}

export interface ProgressTable<Row> {
    /** The table's own «към» date, `YYYY-MM-DD`. */
    asOf: string;
    /** The comparison year — the first date column's year. */
    lastYear: number;
    /** The title as printed, for the log. */
    title: string;
    rows: Row[];
}

export interface RefusedProgressRow {
    table: string;
    label: string;
    reason: 'no-reading' | 'ambiguous' | 'shape';
}

export interface MzhCampaignProgress {
    harvest: ProgressTable<HarvestProgressRow>[];
    sowing: ProgressTable<SowingProgressRow>[];
    refused: RefusedProgressRow[];
    /** Labels read correctly that carry no commodity mapping — reported. */
    unmappedLabels: string[];
}

/**
 * Labels → commodity slugs. A label not here is still SHOWN (the bulletin's
 * own word is the label), and reported, so a new crop is noticed.
 */
export const PROGRESS_COMMODITY_BY_LABEL: Readonly<Record<string, string>> = {
    пшеница: 'wheat',
    ечемик: 'barley',
    'ечемик (вкл. пролетен)': 'barley',
    'пролетен ечемик': 'barley',
    'маслодайна рапица': 'rapeseed',
    рапица: 'rapeseed',
    слънчоглед: 'sunflower',
    'маслодаен слънчоглед': 'sunflower',
    царевица: 'maize',
    'царевица за зърно': 'maize',
    ръж: 'rye',
    тритикале: 'triticale',
    овес: 'oats',
};

/**
 * Rows the sowing tables print that are not field crops the line speaks
 * about. Skipped by decision, not by failure, so they are not reported.
 */
const SKIPPED_PREFIXES = ['тютюн'];

const TITLE = /^\s*((?:Реколта от|Засети площи с) .+?) към (\d{2})\.(\d{2})\.(\d{4}) г\./;
const DATE_ROW = /\d{2}\.\d{2}\.(\d{4})\s+\d{2}\.\d{2}\.\d{4}/;
const SOURCE = /^\s*Източник:/;
const PCT = /^-?\d+(?:,\d+)?%$/;
const HAS_LETTER = /\p{L}/u;

function isoDate(d: string, m: string, y: string): string | null {
    const stamp = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (stamp.getUTCDate() !== Number(d) || stamp.getUTCMonth() !== Number(m) - 1) return null;
    return `${y}-${m}-${d}`;
}

/** «16,6%» → 16.6. */
function pctValue(token: string): number {
    return Number(token.replace('%', '').replace(',', '.'));
}

/**
 * Every way to read a run of value text as exactly `count` numbers.
 *
 * Runs of two or more spaces are hard boundaries; within a chunk, a number is
 * one group of 1–3 digits followed by any number of 3-digit groups. A `-`
 * stands for a missing figure (null).
 */
export function readings(text: string, count: number): Array<Array<number | null>> {
    const chunks = text.trim().split(/\s{2,}/).filter(Boolean).map((c) => c.split(/\s/));
    const out: Array<Array<number | null>> = [];

    const walkChunk = (
        ci: number,
        ti: number,
        acc: Array<number | null>,
    ): void => {
        if (acc.length > count) return;
        if (ci === chunks.length) {
            if (acc.length === count) out.push(acc);
            return;
        }
        const chunk = chunks[ci];
        if (ti === chunk.length) return walkChunk(ci + 1, 0, acc);
        const first = chunk[ti];
        if (first === '-') return walkChunk(ci, ti + 1, [...acc, null]);
        if (!/^\d{1,3}$/.test(first)) return;
        // Extend the number one 3-digit group at a time; branch at each length.
        let digits = first;
        for (let end = ti + 1; ; end += 1) {
            walkChunk(ci, end, [...acc, Number(digits)]);
            const next = chunk[end];
            if (next === undefined || !/^\d{3}$/.test(next)) break;
            digits += next;
        }
    };
    walkChunk(0, 0, []);
    return out;
}

const near = (computed: number, printed: number) => Math.abs(computed - printed) <= 0.15;
const change = (from: number, to: number) => ((to - from) / from) * 100;

/** Does an eight-figure reading agree with the four printed changes? */
function harvestHolds(n: number[], pcts: number[]): boolean {
    const [areaA, areaB, harvA, harvB, prodA, prodB, yldA, yldB] = n;
    if (harvA > areaA || harvB > areaB) return false;
    for (const [prod, harv, yld] of [[prodA, harvA, yldA], [prodB, harvB, yldB]]) {
        if (harv === 0) {
            if (prod !== 0) return false;
            continue;
        }
        // kg/дка = t × 1000 / (ha × 10)
        if (Math.abs((prod * 100) / harv - yld) > 1) return false;
    }
    const pairs: Array<[number, number, number]> = [
        [areaA, areaB, pcts[0]],
        [harvA, harvB, pcts[1]],
        [prodA, prodB, pcts[2]],
    ];
    for (const [a, b, p] of pairs) {
        if (a === 0 || !near(change(a, b), p)) return false;
    }
    // The yield change is printed from the rounded yields or the unrounded
    // ratio; either is the table agreeing with itself.
    if (yldA === 0) return false;
    const exact = harvA && harvB ? change((prodA * 100) / harvA, (prodB * 100) / harvB) : NaN;
    return near(change(yldA, yldB), pcts[3]) || near(exact, pcts[3]);
}

interface RawRow {
    label: string;
    values: string;
}

/**
 * The rows of one table body: a figure line with its label, where a long
 * label wraps onto a line above and a line below the figures
 * («царевица за» / figures / «зърно»).
 */
function rawRows(body: string[]): RawRow[] {
    const rows: RawRow[] = [];
    let prefix: string | null = null;
    for (let i = 0; i < body.length; i += 1) {
        const line = body[i];
        if (!line.trim()) continue;
        const firstDigit = line.search(/[\d-]/);
        const hasFigures = /\d/.test(line);
        if (!hasFigures) {
            // A label fragment: the start of a wrapped label.
            prefix = prefix ? `${prefix} ${line.trim()}` : line.trim();
            continue;
        }
        const lead = firstDigit > 0 ? line.slice(0, firstDigit).trim() : '';
        const values = line.slice(Math.max(firstDigit, 0));
        if (lead && HAS_LETTER.test(lead)) {
            rows.push({ label: lead, values });
            prefix = null;
            continue;
        }
        // Figures with no label: the label wraps around them.
        let label = prefix ?? '';
        const next = body[i + 1];
        if (next !== undefined && next.trim() && !/\d/.test(next)) {
            label = `${label} ${next.trim()}`.trim();
            i += 1;
        }
        rows.push({ label, values });
        prefix = null;
    }
    return rows;
}

/** The table bodies in the text: title, date row, then rows until «Източник:». */
function tables(text: string): Array<{ title: string; asOf: string; lastYear: number; body: string[] }> {
    const lines = text.split(/\r?\n/);
    const out: Array<{ title: string; asOf: string; lastYear: number; body: string[] }> = [];
    for (let i = 0; i < lines.length; i += 1) {
        const t = TITLE.exec(lines[i]);
        if (!t) continue;
        const asOf = isoDate(t[2], t[3], t[4]);
        if (!asOf) continue;
        // The header ends at the row of dates. A chart caption has the same
        // words but no date row before its source line, so it is skipped.
        // Bounded: a caption must not reach down into the NEXT table's header
        // and adopt its rows. A real header is under fifteen lines.
        let j = i + 1;
        let lastYear: number | null = null;
        for (; j < Math.min(lines.length, i + 15) && !SOURCE.test(lines[j]) && !TITLE.test(lines[j]); j += 1) {
            const d = DATE_ROW.exec(lines[j]);
            if (d) {
                lastYear = Number(d[1]);
                break;
            }
        }
        if (lastYear === null) continue;
        const body: string[] = [];
        for (j += 1; j < lines.length && !SOURCE.test(lines[j]) && !TITLE.test(lines[j]); j += 1) {
            body.push(lines[j]);
        }
        out.push({ title: t[1].trim(), asOf, lastYear, body });
        i = j - 1;
    }
    return out;
}

function commodityOf(label: string, unmapped: Set<string>): string | null {
    const c = PROGRESS_COMMODITY_BY_LABEL[label.toLowerCase()] ?? null;
    if (!c) unmapped.add(label);
    return c;
}

export function parseCampaignProgress(text: string): MzhCampaignProgress {
    const result: MzhCampaignProgress = { harvest: [], sowing: [], refused: [], unmappedLabels: [] };
    const unmapped = new Set<string>();

    for (const table of tables(text)) {
        const harvest = table.title.startsWith('Реколта');
        const harvestRows: HarvestProgressRow[] = [];
        const sowingRows: SowingProgressRow[] = [];

        for (const raw of rawRows(table.body)) {
            const label = raw.label.replace(/\s+/g, ' ').trim();
            if (SKIPPED_PREFIXES.some((p) => label.toLowerCase().startsWith(p))) continue;
            const tokens = raw.values.trim().split(/\s+/);
            const pctTokens = tokens.filter((x) => PCT.test(x));
            const valueText = raw.values.replace(/-?\d+(?:,\d+)?%/g, ' ');

            if (harvest) {
                if (!label || pctTokens.length !== 4) {
                    result.refused.push({ table: table.title, label, reason: 'shape' });
                    continue;
                }
                const pcts = pctTokens.map(pctValue);
                const held = readings(valueText, 8)
                    .filter((r): r is number[] => r.every((v) => v !== null))
                    .filter((r) => harvestHolds(r, pcts));
                const distinct = new Set(held.map((r) => r.join(',')));
                if (distinct.size !== 1) {
                    result.refused.push({ table: table.title, label, reason: distinct.size ? 'ambiguous' : 'no-reading' });
                    continue;
                }
                const [, areaB, , harvB, , prodB, , yldB] = held[0];
                harvestRows.push({
                    label,
                    commodity: commodityOf(label, unmapped),
                    areaHa: areaB,
                    harvestedHa: harvB,
                    harvestedPct: areaB > 0 ? Math.floor((harvB * 200 + areaB) / (areaB * 2)) : 0,
                    productionT: prodB,
                    yieldKgPerDa: yldB,
                });
            } else {
                // The change column is the last token: a % or «-».
                const last = tokens[tokens.length - 1];
                const printed = PCT.test(last) ? pctValue(last) : last === '-' ? null : undefined;
                if (!label || printed === undefined) {
                    result.refused.push({ table: table.title, label, reason: 'shape' });
                    continue;
                }
                const beforeChange = raw.values.trim().replace(/\s+(?:-?\d+(?:,\d+)?%|-)$/, '');
                const held = readings(beforeChange, 2).filter(([a, b]) => {
                    if (b === null) return false;
                    if (a === null) return printed === null;
                    return printed !== null && a > 0 && near(change(a, b), printed);
                });
                const distinct = new Set(held.map((r) => r.join(',')));
                if (distinct.size !== 1) {
                    result.refused.push({ table: table.title, label, reason: distinct.size ? 'ambiguous' : 'no-reading' });
                    continue;
                }
                const [a, b] = held[0];
                sowingRows.push({
                    label,
                    commodity: commodityOf(label, unmapped),
                    sownHa: b as number,
                    lastYearHa: a,
                    changePct: printed === null ? null : last.replace('%', '').replace(',', '.'),
                });
            }
        }

        const base = { asOf: table.asOf, lastYear: table.lastYear, title: table.title };
        if (harvest && harvestRows.length) result.harvest.push({ ...base, rows: harvestRows });
        if (!harvest && sowingRows.length) result.sowing.push({ ...base, rows: sowingRows });
    }

    result.unmappedLabels = [...unmapped];
    return result;
}

/**
 * The «ДНЕВНИК НА СТОПАНСТВОТО» row builder — #2316.
 *
 * Pure. Takes lines already read from the database and produces the nine
 * columns the owner's template prints. Separated from the query so every
 * decision below is testable without a database, because the decisions are
 * the hard part and the query is not.
 *
 * ## One row is an ACTIVITY, not a line
 *
 * This is the difference from `farm-record-diary.ts`, and it is a difference
 * of aggregation rather than formatting. There, a row is one spray line on one
 * parcel. Here, «Пръскане – 17,05 ха» is **one row for one spraying across
 * several parcels** — the sum of the parcels actually treated. No amount of
 * adding sections to the existing generator produces that.
 *
 * ## The grouping key, and why it is not (date, kind)
 *
 * `Task.treatmentGroupId` — the handle one write shares across the several
 * Tasks it creates, one per block. It exists already, is indexed
 * (`@@index([tenantId, treatmentGroupId])`), and despite the name is
 * activity-agnostic: a bare activity carries one too.
 *
 * Inferring the activity from `(date, operationType)` instead would merge two
 * separate prunings on the same day into one row, understating the work and
 * misstating the area.
 *
 * **Falls back to `taskId` when the group is null.** Lines written before
 * groups existed have no `treatmentGroupId`, and grouping them all under
 * `null` would collapse every historical activity of a campaign into a single
 * row. One task is its own group.
 *
 * ## `treatedAreaHa` NULL means THE WHOLE PARCEL
 *
 * Not zero. The schema says so at `OperationParcel.treatedAreaHa`: *"the
 * register prints `treatedAreaHa ?? parcel.areaHa`, so an absent value"* means
 * the parcel's own area. Every line written before #2072 is NULL, so summing
 * with `?? 0` would silently under-report historical rows — and it would look
 * like a data problem rather than a code one.
 *
 * ## ХЕКТАРИ, never декари
 *
 * The БАБХ register converts to дка for display; this document does not. The
 * owner's template reads `ха`, two decimals, comma separator. `toDka` must not
 * be reused here, and nothing in this module imports it.
 */
import type { FieldOperationType } from '@prisma/client';

/** One `OperationParcel` line, joined to what the row needs from its parents. */
export interface DiaryLineInput {
    /** `Task.treatmentGroupId`, or null for a line written before groups. */
    treatmentGroupId: string | null;
    taskId: string;
    operationType: FieldOperationType | null;
    /** `Task.completedAt`. A line with no completion is not in the register. */
    completedAt: Date | null;
    parcelId: string;
    /** `Parcel.name` — what the БАБХ register's «№ на полето» already prints. */
    parcelName: string;
    /** `Parcel.cropType`, or null. */
    cropName: string | null;
    /** `Parcel.areaHa` — the fallback when the line treated the whole parcel. */
    parcelAreaHa: number;
    /** NULL means the whole parcel, NOT zero. */
    treatedAreaHa: number | null;
    /** Trade name, when the line applies a product. */
    productName: string | null;
    /** The dose as recorded, in its OWN unit (`г/дка`, `мл/дка`). */
    doseValue: number | null;
    doseUnitSymbol: string | null;
    /** From `LogQuantity` on the line's completion entry — kg, already. */
    produceKg: number | null;
    produceKind: string | null;
}

export interface CampaignDiaryRow {
    /** `01.02.2025`, or `01-05.02.2025` for work spread over days. */
    date: string;
    /** Column 2 — «Ид. № на парцела/полето /животното». */
    parcelIds: string;
    /** Column 3 — «Култура / Порода / Вид». */
    crops: string;
    /** Column 4 — «Площ / Брой», in ха. */
    area: string;
    /** Column 5 — «Мероприятие», one string: `<name> – <area> ха`. */
    activity: string;
    /** Column 6a — «Използван препарат → Вид/наименование». */
    productName: string;
    /** Column 6b — «Използван препарат → Количество», the dose as recorded. */
    doseLabel: string;
    /** Column 7a — «Продукция → Вид». */
    produceKind: string;
    /** Column 7b — «Продукция → Количество кг». */
    produceKg: string;
    /** Not printed. The earliest completion, for ordering. */
    sortKey: number;
}

/** Two decimals, comma separator — the form's own convention. */
export function formatHa(ha: number): string {
    return ha.toFixed(2).replace('.', ',');
}

/** `01.02.2025`, Bulgarian order. */
function formatDay(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/**
 * The date cell: one day, or a range.
 *
 * `01-05.02.2025` collapses only when the month and year match, which is what
 * the owner's example shows. Across a month boundary both ends are spelled in
 * full (`28.02-03.03.2025`) rather than producing `28-03.03.2025`, which reads
 * as a single impossible date.
 */
export function formatDateCell(from: Date, to: Date): string {
    if (formatDay(from) === formatDay(to)) return formatDay(from);
    const sameMonth =
        from.getUTCMonth() === to.getUTCMonth() && from.getUTCFullYear() === to.getUTCFullYear();
    if (sameMonth) {
        const p = (n: number) => String(n).padStart(2, '0');
        return `${p(from.getUTCDate())}-${formatDay(to)}`;
    }
    return `${formatDay(from)}-${formatDay(to)}`;
}

/** Unique, order-preserving, blank-free. */
function uniq(values: ReadonlyArray<string | null>): string[] {
    const out: string[] = [];
    for (const v of values) {
        const t = v?.trim();
        if (t && !out.includes(t)) out.push(t);
    }
    return out;
}

/**
 * The area a line covers: what it treated, or the whole parcel when it did not
 * say. See the module docblock — `?? 0` would under-report every pre-#2072 row.
 */
export function lineAreaHa(line: DiaryLineInput): number {
    return line.treatedAreaHa ?? line.parcelAreaHa;
}

/**
 * Group lines into activity rows.
 *
 * Lines with no `completedAt` are DROPPED: the register records work that was
 * done, and a planned activity has not happened. Returned separately rather
 * than silently, so a caller can say how many were skipped — an unexplained
 * difference between what the user sees in the app and what the document
 * prints is the kind of thing nobody can debug.
 */
export function buildCampaignRows(
    lines: ReadonlyArray<DiaryLineInput>,
    labels: Readonly<Record<string, string>>,
): { rows: CampaignDiaryRow[]; skippedIncomplete: number } {
    const complete = lines.filter((l) => l.completedAt !== null);
    const skippedIncomplete = lines.length - complete.length;

    const groups = new Map<string, DiaryLineInput[]>();
    for (const line of complete) {
        // `taskId` fallback, not `null` — see the module docblock.
        const key = line.treatmentGroupId ?? `task:${line.taskId}`;
        const bucket = groups.get(key);
        if (bucket) bucket.push(line);
        else groups.set(key, [line]);
    }

    const rows: CampaignDiaryRow[] = [];
    for (const bucket of groups.values()) {
        const stamps = bucket
            .map((l) => l.completedAt as Date)
            .sort((a, b) => a.getTime() - b.getTime());
        const from = stamps[0];
        const to = stamps[stamps.length - 1];

        // Summed over DISTINCT parcels. One parcel can carry several lines in
        // one activity — a tank mix is several products on the same parcel —
        // and summing per line would count its area once per product.
        const byParcel = new Map<string, number>();
        for (const l of bucket) {
            if (!byParcel.has(l.parcelId)) byParcel.set(l.parcelId, lineAreaHa(l));
        }
        const areaHa = [...byParcel.values()].reduce((a, b) => a + b, 0);

        const kind = bucket.find((l) => l.operationType)?.operationType ?? null;
        const label = (kind && labels[kind]) || labels.OTHER || '';

        const doses = uniq(
            bucket.map((l) =>
                l.doseValue != null && l.doseUnitSymbol
                    ? `${formatHa(l.doseValue)} ${l.doseUnitSymbol}`
                    : null,
            ),
        );
        const kgTotal = bucket.reduce((sum, l) => sum + (l.produceKg ?? 0), 0);
        const anyKg = bucket.some((l) => l.produceKg != null);

        rows.push({
            date: formatDateCell(from, to),
            parcelIds: uniq(bucket.map((l) => l.parcelName)).join(', '),
            crops: uniq(bucket.map((l) => l.cropName)).join(', '),
            area: formatHa(areaHa),
            // The composed cell. `<label> – <area> ха` with an EN DASH, as the
            // template shows, and the area repeated here deliberately: the form
            // carries it in both «Площ» and «Мероприятие».
            activity: label ? `${label} – ${formatHa(areaHa)} ха` : '',
            productName: uniq(bucket.map((l) => l.productName)).join(', '),
            doseLabel: doses.join(', '),
            produceKind: uniq(bucket.map((l) => l.produceKind)).join(', '),
            // Empty, not "0", when nothing was recorded. A zero asserts that a
            // harvest produced nothing; an empty cell says nobody wrote it down,
            // and in a register those are different claims.
            produceKg: anyKg ? formatHa(kgTotal) : '',
            sortKey: from.getTime(),
        });
    }

    rows.sort((a, b) => a.sortKey - b.sortKey || a.parcelIds.localeCompare(b.parcelIds, 'bg'));
    return { rows, skippedIncomplete };
}

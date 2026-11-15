/**
 * Turning ZarnoBorsa's printed strings into values we can store (#3081).
 *
 * Separate from `zarnoborsa-extract.ts` on purpose: that file is stringified
 * into a browser and may reference nothing outside itself, while everything
 * here runs in Node on the strings it returned and is free to import.
 */
import { ZarnoBorsaRawRow } from './zarnoborsa-extract';

/** A row, interpreted. `null` fields mean "printed, but not understood". */
export interface ZarnoBorsaRow {
    marketId: number;
    productId: number;
    label: string;
    /**
     * A DECIMAL STRING, never a number.
     *
     * `MarketPricePoint.price` is `Decimal(12,2)`, and the repo's rule is that
     * money is integer cents or basis points and never a float. Parsing to
     * `number` here would put a binary float between the page and a
     * `Decimal` column for no reason — and these figures reach the grain
     * calculator and the net-worth number, so the rounding nobody asked for
     * would be in money a farmer acts on.
     */
    price: string;
    /** `YYYY-MM-DD`, the row's OWN date. */
    date: string;
    /** Signed decimal string, or null when the page printed none. */
    change: string | null;
}

/** `Nov` → 11. English months, which is what the page prints. */
const MONTHS: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * `"Nov, 14 2026"` → `"2026-11-14"`.
 *
 * Returns null rather than throwing, and the caller SKIPS a null — a single
 * unparsable row must not cost the whole run, because the alternative is one
 * reformatted cell stopping every price for the day.
 *
 * A day key string rather than a `Date`: `MarketPricePoint.date` is `@db.Date`,
 * and building a `Date` here would invite a timezone to decide which day a
 * price belongs to. The page states the day; there is nothing to convert.
 */
export function parseZarnoBorsaDate(text: string): string | null {
    const m = /^([A-Za-z]{3}),\s*(\d{1,2})\s+(\d{4})$/.exec(text.trim());
    if (!m) return null;
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) return null;
    const day = m[2].padStart(2, '0');
    return `${m[3]}-${month}-${day}`;
}

/**
 * `"1,150.70"` -> `"1150.70"`.
 *
 * Thousands separators are commas and the decimal mark is a point.
 *
 * ## The comma POSITIONS are validated, not merely stripped
 *
 * The first version stripped every comma and then checked the result was a
 * decimal. A test caught what that accepts: `"145,45,45"` became `1454545` — a
 * price of one and a half million euros a tonne, reported as valid.
 *
 * The dangerous case is subtler and runs the other way. If the page ever
 * prints a EUROPEAN decimal comma, `"145,45"`, blind stripping yields `14545`:
 * a HUNDREDFOLD overstatement that is a perfectly plausible number and would
 * be stored without complaint. These figures reach the grain calculator and
 * the net-worth figure, so a silent 100x is the worst thing this function
 * could do.
 *
 * Requiring commas to sit in genuine groups of three refuses both. A group of
 * two digits does not match, so `"145,45"` returns null, the row is SKIPPED,
 * and it is COUNTED in the run's `skipped` denominator — visible, rather than
 * a confident wrong price. If their format ever changes, the job reports every
 * row skipped instead of quietly inflating them all.
 *
 * Anything else — a non-breaking space, a dash placeholder, a currency
 * symbol — yields null for the same reason, rather than becoming a price of
 * zero.
 */
export function parseZarnoBorsaPrice(text: string): string | null {
    const cleaned = text.replace(/\u00a0/g, ' ').trim();
    const grouped = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/;
    const plain = /^\d+(?:\.\d{1,2})?$/;
    if (!grouped.test(cleaned) && !plain.test(cleaned)) return null;
    return cleaned.replace(/,/g, '');
}

/**
 * The change cell: `"-146.46"`, `"+150.50"`, `"156.56"`.
 *
 * The page carries the sign in the TEXT and the direction in the cell's class
 * (`red` / `green` / `black`). The text is authoritative and the class is not
 * consulted: a sign is unambiguous while a colour is a rendering choice, and
 * `black` covers both "no change" and "unsigned", which are not the same
 * claim.
 *
 * Commas are validated in groups of three exactly as in
 * `parseZarnoBorsaPrice` — a change is a money figure too, and a silent 100x
 * in it would show a farmer a day's move that never happened.
 */
export function parseZarnoBorsaChange(text: string): string | null {
    const cleaned = text.replace(/\u00a0/g, ' ').trim();
    const m = /^([+-]?)(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)$/
        .exec(cleaned);
    if (!m) return null;
    const digits = m[2].replace(/,/g, '');
    return m[1] === '-' ? `-${digits}` : digits;
}

export interface ZarnoBorsaParseResult {
    rows: ZarnoBorsaRow[];
    /** Rows the page printed that could not be interpreted. */
    skipped: number;
}

/**
 * Interpret every extracted row, skipping the ones that do not parse.
 *
 * `skipped` is returned rather than logged here, because the job's reading is
 * where a denominator belongs: `rows: 0, skipped: 17` and `rows: 0, skipped: 0`
 * mean entirely different things — a page that changed shape versus a page
 * with nothing on it — and a single count cannot tell them apart.
 */
export function parseZarnoBorsaRows(raw: ZarnoBorsaRawRow[]): ZarnoBorsaParseResult {
    const rows: ZarnoBorsaRow[] = [];
    let skipped = 0;

    for (const r of raw) {
        const price = parseZarnoBorsaPrice(r.priceText);
        const date = parseZarnoBorsaDate(r.dateText);
        if (price === null || date === null) {
            skipped += 1;
            continue;
        }
        rows.push({
            marketId: r.marketId,
            productId: r.productId,
            label: r.label,
            price,
            date,
            // A missing change is not a reason to drop a price.
            change: parseZarnoBorsaChange(r.changeText),
        });
    }

    return { rows, skipped };
}

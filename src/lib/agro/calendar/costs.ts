/**
 * Published МЗХ cost figures, and the one place a lev→euro peg is allowed —
 * #637.
 *
 * ## Why this file exists rather than reusing the cost path
 *
 * It cannot reuse it: **there is no converter left to reuse.** `1.95583`
 * exists nowhere as live code in this repo. #2793 removed it from four places
 * on the owner's 2026-11-08 ruling — the cost rollup, rent basis, rent units
 * and the lease path — and `normaliseCostToEur` now answers a `BGN` amount
 * with `refusal: 'FOREIGN'`, the same answer a dollar gets, while
 * `COST_ENTRY_CURRENCY_NOT_EUR` refuses a non-euro cost on write.
 *
 * ## So why is a peg permitted here at all
 *
 * Because these are not the farm's money. Owner ruling 2026-11-16: the МЗХ
 * technology-card figures may be converted and shown in euro. They are
 * PUBLISHED REFERENCE DATA — nobody entered them, they describe a ministry
 * document, and their traceability is the PDF rather than a row anybody owns.
 *
 * That is why re-admitting a peg here falsifies none of the four removals:
 * each makes a scoped claim about the FARM's own money ("a lev lease is
 * refused", "a lev cost refuses"), and nothing below writes a `CostEntry`, a
 * `ParcelLease` or a `Contract`. A lev figure is still unsavable everywhere it
 * was unsavable yesterday.
 *
 * **The boundary to keep:** the moment a farmer ACCEPTS one of these as their
 * own cost it stops being reference data, and what gets written is the
 * converted EURO figure with no МЗХ marker on it. A stored cost citing a
 * ministry card would claim МЗХ backs that farm's number, which it does not.
 *
 * ## What is stored, and what is derived
 *
 * Stored: the figure **as printed**, in integer стотинки, for the area the
 * card states (100 дка). Nothing is pre-divided and nothing is pre-converted —
 * the dataset's own third convention is that units are as the source writes
 * them, and a converted figure is a number no cited page supports.
 *
 * Derived, at response time: euro cents per decare. One implementation, so the
 * phone and the web cannot round differently and disagree by a cent — the
 * same reason the calendar has one `windowCovers` rather than a copy per
 * client.
 */

/**
 * The lev's legally fixed rate against the euro.
 *
 * Scoped to published reference figures BY INTENT — see the docblock above.
 * Do not import this into a cost, lease or contract path: those refuse lev,
 * deliberately, and this constant existing is not permission to convert the
 * farm's own money.
 */
export const BGN_PER_EUR = 1.95583;

/** The cost lines the МЗХ technology cards publish, as a closed set. */
export const CALENDAR_COST_LINES = [
    'fuel',
    'materials',
    'wagesWorkers',
    'wagesMachineOperators',
    'services',
] as const;
export type CalendarCostLine = (typeof CALENDAR_COST_LINES)[number];

/**
 * The peg as an integer numerator over {@link PEG_SCALE} — 1.95583 exactly.
 *
 * The house rule is "money is integer CENTS and rates are BASIS POINTS —
 * never a float". Basis points are the wrong unit here: 1.95583 is 19 558.3
 * of them, so the peg needs a 1/100 000 scale to be exact. These two integers
 * are that; {@link BGN_PER_EUR} above exists so the rate is readable and
 * assertable in one place, and is not used in arithmetic.
 */
const PEG_NUMERATOR = 195583;
const PEG_SCALE = 100000;

/**
 * The largest published figure this can convert exactly.
 *
 * Past it the intermediate would exceed `Number.MAX_SAFE_INTEGER` and the
 * arithmetic would stop being exact — which is the one property integer
 * arithmetic is here for, so `perDaEurCents` refuses rather than silently
 * losing precision. The vine card's largest figure is its total, 11 109 297,
 * against this bound of 45 035 996 273 — a margin of about 4 000x.
 */
export const MAX_PUBLISHED_STOTINKI = Math.floor(Number.MAX_SAFE_INTEGER / (PEG_SCALE * 2));

/**
 * Euro cents per decare, from a published стотинки figure for an area.
 *
 * INTEGER ARITHMETIC THROUGHOUT, with one round-half-up at the end —
 * `floor((2·num + den) / (2·den))`, the same shape `quotePremium` uses for
 * insurance premiums and for the same reason: the house rule forbids a float
 * in a money path, so nobody has to reason about whether a division landed a
 * hair under a rounding boundary.
 *
 * It changes no number today. Measured equal to the float form on every
 * figure the vine card publishes — 2136, 16590, 30260, 2600, 5215, total
 * 56801 — and the agrent-ios session reached the same six independently with
 * Decimal arithmetic. What it removes is the need to trust that it never will.
 */
export function perDaEurCents(publishedStotinki: number, areaDa: number): number | null {
    if (!Number.isInteger(publishedStotinki) || publishedStotinki < 0) return null;
    if (!Number.isInteger(areaDa) || areaDa <= 0) return null;
    if (publishedStotinki > MAX_PUBLISHED_STOTINKI) return null;
    const numerator = publishedStotinki * PEG_SCALE;
    const denominator = areaDa * PEG_NUMERATOR;
    // Half UP, matching how the card presents its own figures.
    return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

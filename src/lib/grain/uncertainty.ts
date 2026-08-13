/**
 * ONE vocabulary for "this number is not what it appears".
 *
 * The grain calculator spoke four dialects at once — an em-dash plus a
 * server-authored English sentence for a refusal, a badge plus a sentence
 * for an allocation, a count plus an accordion for exclusions, and a
 * header-description takeover for truncation. Each was defensible alone.
 * Together they were four languages on one screen, and a reader had to
 * learn each of them separately to know which figures to trust.
 *
 * These states are that vocabulary. Every surface — the headline, the
 * lines of the sum, a table cell — expresses a given state the SAME way,
 * so it is learned once.
 *
 * ── Why there are two bounded states and not one ────────────────────
 *
 * When a consumption could not be priced, `cashCostTotal` is a FLOOR: the
 * cost is AT LEAST X. Net worth is assets minus cost, so the same cause
 * makes the net AT MOST Y. The bound points the other way on the other
 * number, and calling a floor "at most" would be plainly wrong — so the
 * cost line and the headline carry opposite bounds from one cause.
 *
 * That direction is the whole point of the fix. The page used to print
 * the headline as a definite figure and put the caveat under a panel's
 * cost line two surfaces away: a farmer reading the big number was being
 * told a bound and shown a value.
 *
 * @module lib/grain/uncertainty
 */

export const UNCERTAINTY = {
    /** Nothing qualifies this figure. */
    EXACT: 'exact',
    /** A floor — the true value is this or more (an incomplete cost). */
    AT_LEAST: 'atLeast',
    /** A ceiling — the true value is this or less (a net over a floor cost). */
    AT_MOST: 'atMost',
    /** Apportioned by a rule, not measured against this crop. */
    ALLOCATED: 'allocated',
    /** Records were left out of the figure, and are named. */
    PARTIAL: 'partial',
    /** Withheld, with a reason. Never a blank and never a zero. */
    REFUSED: 'refused',
} as const;

export type UncertaintyState = (typeof UNCERTAINTY)[keyof typeof UNCERTAINTY];

/** The row fields the vocabulary reads — nothing more, so it stays pure. */
export interface UncertaintyInput {
    unvaluedNoUnitCost: number;
    unvaluedUnitMismatch: number;
    payrollAllocated: boolean;
    netWorth: number | null;
}

/**
 * True when the cost total is incomplete — consumptions the usecase could
 * not price. They change no figure; they make `cashCostTotal` a floor.
 */
export function costIsFloor(
    row: Pick<UncertaintyInput, 'unvaluedNoUnitCost' | 'unvaluedUnitMismatch'>,
): boolean {
    return row.unvaluedNoUnitCost > 0 || row.unvaluedUnitMismatch > 0;
}

/**
 * How to qualify the headline net worth.
 *
 * REFUSED outranks the bound: there is no figure to put a ceiling on, and
 * "at most —" is noise stacked on a refusal.
 */
export function netWorthUncertainty(row: UncertaintyInput): UncertaintyState {
    if (row.netWorth == null) return UNCERTAINTY.REFUSED;
    if (costIsFloor(row)) return UNCERTAINTY.AT_MOST;
    return UNCERTAINTY.EXACT;
}

/**
 * How to qualify the cost total.
 *
 * The BOUND outranks the allocation when both apply: an apportioned share
 * of a total that is itself incomplete is, first, incomplete. The
 * allocation is still stated in its own treatment beside the line — this
 * picks which qualifier rides the NUMBER.
 */
export function costUncertainty(row: UncertaintyInput): UncertaintyState {
    if (costIsFloor(row)) return UNCERTAINTY.AT_LEAST;
    if (row.payrollAllocated) return UNCERTAINTY.ALLOCATED;
    return UNCERTAINTY.EXACT;
}

// ─── Refusal reason codes ────────────────────────────────────────────

/**
 * Every reason `getGrainNetWorth` can withhold net worth for.
 *
 * The usecase returns a CODE plus parameters so the client can translate;
 * it also returns the English sentence it always did, and that is not
 * redundancy. A client meeting a code it does not recognise — an older
 * bundle against a newer server — must still be able to explain itself,
 * because "a refusal is always explained" is the property this page is
 * built around. An untranslated explanation beats a bare em-dash.
 */
export const NET_WORTH_REFUSAL_CODES = [
    /** No market price for the commodity. Params: `{ commodity }`. */
    'NO_MARKET_PRICE',
    /** Costs recorded in more than one currency; blending would misstate. */
    'MIXED_COST_CURRENCY',
    /** `ParcelLease` has no currency column, so rent cannot be combined. */
    'RENT_CURRENCY_UNRECORDED',
    /** Cost currency ≠ price currency. Params: `{ costCurrency, priceCurrency }`. */
    'COST_PRICE_CURRENCY_MISMATCH',
] as const;

export type NetWorthRefusalCode = (typeof NET_WORTH_REFUSAL_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(NET_WORTH_REFUSAL_CODES);

/** Narrowing guard — an unknown code sends the caller to the English fallback. */
export function isKnownRefusalCode(
    code: string | null | undefined,
): code is NetWorthRefusalCode {
    return code != null && CODE_SET.has(code);
}

/**
 * The sentence to show for a withheld net worth.
 *
 * Pure, and takes its translator as an argument, so the FALLBACK PATH can
 * be proven without a render: this is the function that guarantees no
 * refusal ever appears bare, and that guarantee should not depend on a
 * component tree to demonstrate.
 *
 * A recognised code is translated. Anything else — an unrecognised code,
 * a null code from an older payload — returns the server's English. Only
 * a refusal with no reason at all yields null, and the usecase's own
 * contract forbids that (see the invariant in its tests).
 */
export function explainRefusal(
    code: string | null | undefined,
    params: Record<string, string> | null | undefined,
    fallbackEnglish: string | null,
    translate: (key: string, values?: Record<string, string>) => string,
): string | null {
    if (isKnownRefusalCode(code)) return translate(`refusal.${code}`, params ?? {});
    return fallbackEnglish;
}

/**
 * ISO-4217 currency codes offered for contract pricing.
 *
 * `Contract.priceCurrency` was a free-text input, and the org portfolio
 * labels a whole farm's money with the first contract's raw string — so
 * one operator typing "eur", another "EUR" and a third "€" produced
 * three currencies as far as every rollup was concerned, and the KPI
 * subtitle rendered whatever landed first.
 *
 * Deliberately a SHORT list, not all ~180 ISO codes: these are the
 * currencies grain is actually contracted in for this product's markets,
 * and a 180-item dropdown is its own usability problem. The set is
 * additive — an unrecognised stored value is preserved and shown rather
 * than silently dropped (see `currencyOptions`), so widening the list
 * never invalidates existing rows.
 */


/** Code + the symbol/name shown beside it in the picker. */
export const CONTRACT_CURRENCIES: ReadonlyArray<{ code: string; symbol: string }> = [
    { code: 'EUR', symbol: '€' },
];

const KNOWN = new Set(CONTRACT_CURRENCIES.map((c) => c.code));

/** True for a code this product offers in the picker. */
export function isKnownCurrency(code: string | null | undefined): boolean {
    return code != null && KNOWN.has(code.toUpperCase());
}

/**
 * Picker options, with `current` preserved at the top when it is a value
 * we do not offer.
 *
 * Dropping an unknown stored currency would silently rewrite the row's
 * price basis the next time anyone edited an unrelated field — the kind
 * of quiet data change nobody reviews.
 */
export function currencyOptions(
    current?: string | null,
): Array<{ value: string; label: string }> {
    const base = CONTRACT_CURRENCIES.map((c) => ({
        value: c.code,
        label: `${c.code} · ${c.symbol}`,
    }));
    const trimmed = current?.trim();
    if (trimmed && !isKnownCurrency(trimmed)) {
        return [{ value: trimmed, label: trimmed }, ...base];
    }
    return base;
}

/**
 * The calculator is EUR-only — owner ruling 2026-10-26.
 *
 * ## Why this exists, and why it is not FX
 *
 * `Калкулатор` was refusing with `COST_CURRENCY_MIXED` on the owner's own
 * farm. The live `CostEntry` rows were: 10 × `'EUR'`, 3 × `'EURO'` (the
 * phone's old free-text «Валута» field), 1 × `'BGN'`. Three spellings of two
 * currencies, one of which is pegged to the other.
 *
 * `cost-rollup` states that "there is no FX table anywhere in this product …
 * so amounts in different currencies CANNOT be converted", and that is the
 * posture again. It was briefly not: a `bgnToEur` helper converted at the
 * legally fixed 1.95583 peg, because one production `CostEntry` carried
 * `'BGN'` and the calculator called that farm's costs "mixed". That row is
 * gone (deleted 2026-11-06), `COST_ENTRY_CURRENCY_NOT_EUR` refuses a non-euro
 * cost on write, `CONTRACT_CURRENCIES` is EUR-only, and #2793 removed the
 * peg — so every spelling below is a spelling of EURO, and a lev code is as
 * foreign as a dollar one.
 *
 * ## What is deliberately NOT done
 *
 * Stored rows are not rewritten. A farmer's `'EURO'` row stays `'EURO'` in the
 * database; only the SUM treats it as euro. The ruling was explicit, and it is
 * the right call twice over: an UPDATE over money rows to fix a display
 * problem is the kind of migration that is discovered to have been wrong after
 * it cannot be undone, and the save path below stops new ones arriving anyway.
 */

/**
 * Spellings that mean euro. `'EURO'` is the phone's historical free-text
 * value; the rest are the shapes a free-text field produces.
 */
/**
 * Every spelling of euro this product has stored.
 *
 * `CostEntry.currency` was free text («Валута») before the EUR-only save path,
 * so one currency exists under several labels and the owner's «Торове» read
 * «11 119,50 EUR и 10,00 EURO» as two rows (#2707).
 *
 * EXPORTED since #2707 so `cost-summary.ts` can fold the same spellings inside
 * its SQL. It cannot call `canonicalCostCurrency` from a `GROUP BY`, and
 * retyping this list into a query string is how the two drift — which is the
 * argument this module's own docblock already makes against private copies.
 * One list, two readers.
 *
 * Note what this set does NOT contain: lev. Nothing in this module folds it
 * any more (#2793) — a BGN label is foreign, and a consumer that folded the
 * LABEL without converting the AMOUNT would add lev to euros as the same
 * unit. That is now the same answer every function here gives.
 */
export const EURO_SPELLINGS_LIST = ['EUR', 'EURO', 'EUROS', '€', 'E'] as const;

const EURO_SPELLINGS = new Set<string>(EURO_SPELLINGS_LIST);

/** What a cost row contributes to a EUR total, and whether it could be read. */
export interface NormalisedCost {
    /** The amount in euro, or null when this row cannot be converted. */
    eur: number | null;
    /**
     * Why it could not be, for the caller's refusal code. `null` on success.
     *
     * `FOREIGN` is a genuinely different currency — USD, GBP — which needs a
     * market quote this product has none of. It is NOT folded into euro: the
     * ruling named euro spellings, blanks and lev, and quietly relabelling a
     * dollar row as euro would misstate money by whatever the rate happens to
     * be. None exist in production today; the save path keeps it that way.
     */
    refusal: 'FOREIGN' | null;
}

/**
 * One cost row's contribution to a euro total.
 *
 * - euro in any spelling, or unrecorded  → the amount unchanged
 * - anything else                        → refused, amount withheld
 *
 * THE LEV ARM IS GONE (#2793). It converted at the fixed peg, and it is dead:
 * measured on production 2026-11-06, the one `BGN` cost row (1.00) was deleted
 * and the three `EURO` rows relabelled, so every `CostEntry` is euro;
 * `COST_ENTRY_CURRENCY_NOT_EUR` refuses a non-euro cost on write; and
 * `CONTRACT_CURRENCIES` is EUR-only. A lev code now refuses like any other
 * foreign currency, which is the same answer a USD row has always had.
 *
 * Unrecorded counts as euro because the app is EUR-only: a blank currency on a
 * farm that can only record euro is a missing label, not an unknown unit.
 */
export function normaliseCostToEur(
    amount: number | null | undefined,
    currency: string | null | undefined,
): NormalisedCost {
    if (amount == null || !Number.isFinite(amount)) return { eur: null, refusal: null };
    const code = currency?.trim().toUpperCase() ?? '';
    if (code === '' || EURO_SPELLINGS.has(code)) return { eur: amount, refusal: null };

    return { eur: null, refusal: 'FOREIGN' };
}

/**
 * The currency code to put in a SET, rather than the raw string a row stored.
 *
 * `normaliseCostToEur` converts AMOUNTS and has always been used for them.
 * Nothing did the same for currency SETS, and that asymmetry was the whole of
 * the owner-visible defect: `Калкулатор` refused a farm whose 14 cost rows
 * read `10 x 'EUR'`, `3 x 'EURO'` and `1 x 'BGN'` — three spellings of two
 * currencies, all of which this module already resolves to euro — because the
 * sets carried the raw strings and `size > 1` called that mixed.
 *
 * So: every currency that RESOLVES to euro collapses to `'EUR'`, and anything
 * foreign keeps its own uppercased code. A set built this way can be counted,
 * which is what the callers were already doing and getting wrong.
 *
 * `cost-rollup.ts` has had an equivalent private helper (`resolvedCurrency`)
 * since it was written, which is why ITS currency sets were always correct.
 * `grain-net-worth.ts` reads the same `CostEntry.currency` column and had no
 * counterpart — it normalised the amounts and added the raw strings. This is
 * that missing counterpart, exported so there is one rule rather than a second
 * private copy.
 *
 * Since #2793 this is the same predicate as `isStoredAsEuro` — the lev arm is
 * gone from both, so "resolves to euro" and "is already euro" now name one
 * set. The two functions are kept apart because they answer different
 * QUESTIONS and one of them has a caller that must keep refusing: this one
 * builds a SET for a rollup, `isStoredAsEuro` gates the EUR-only save path.
 * They were deliberately different while the peg existed (lev was addable for
 * a rollup and lockable for the save path), and collapsing them to one export
 * would make a future divergence a rewrite rather than an edit.
 */
export function canonicalCostCurrency(currency: string | null | undefined): string {
    const code = currency?.trim().toUpperCase() ?? '';
    if (code === '' || EURO_SPELLINGS.has(code)) return 'EUR';
    return code;
}

/**
 * Is this currency ALREADY euro — as opposed to merely convertible to it?
 *
 * Distinct from `allResolveToEur` in QUESTION, and since #2793 identical in
 * ANSWER. That function asks "can the rollup total this row"; this one asks
 * "may the save path edit it". The peg is what made them disagree — lev was
 * convertible (so `allResolveToEur(['BGN'])` was `true`) and NOT already euro
 * (so a lock predicate built on the first would have relabelled 1.00 BGN as
 * 1.00 EUR, overstating it by 1.95583×, which is #2398). With the peg gone
 * there are two states, not three:
 *
 *   - stored as euro  EUR / EURO / EUROS / € / E / blank   editable
 *   - foreign         BGN / ЛВ / ЛВ. / BGL / USD / GBP …   locked, and refused
 *                                                          by the rollup
 *
 * Blank counts as euro for the same reason `normaliseCostToEur` does: on a farm
 * that can only record euro, a missing label is a missing label, not an unknown
 * unit.
 */
export function isStoredAsEuro(currency: string | null | undefined): boolean {
    const code = currency?.trim().toUpperCase() ?? '';
    return code === '' || EURO_SPELLINGS.has(code);
}

/** True when every row in `currencies` resolves to euro — no FOREIGN among them. */
export function allResolveToEur(currencies: readonly (string | null | undefined)[]): boolean {
    return currencies.every((c) => normaliseCostToEur(1, c).refusal === null);
}

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

import { bgnToEur } from '@/lib/exchange/currency';

/** Code + the symbol/name shown beside it in the picker. */
export const CONTRACT_CURRENCIES: ReadonlyArray<{ code: string; symbol: string }> = [
    { code: 'BGN', symbol: 'лв.' },
    { code: 'EUR', symbol: '€' },
    { code: 'USD', symbol: '$' },
    { code: 'GBP', symbol: '£' },
    { code: 'RON', symbol: 'lei' },
    { code: 'PLN', symbol: 'zł' },
    { code: 'HUF', symbol: 'Ft' },
    { code: 'CHF', symbol: 'CHF' },
    { code: 'UAH', symbol: '₴' },
    { code: 'TRY', symbol: '₺' },
    { code: 'CAD', symbol: 'CA$' },
    { code: 'AUD', symbol: 'A$' },
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
 * `cost-rollup` states — correctly, when it was written — that "there is no FX
 * table anywhere in this product … so amounts in different currencies CANNOT
 * be converted". That argument has since expired on one axis:
 * `src/lib/exchange/currency.ts` exists, the lev has been pegged at exactly
 * 1.95583/€ since 1999, and the grain exchange already converted its stored
 * BGN listings at that rate in a SQL migration. `bgnToEur` is reused here so
 * the calculator and the exchange cannot drift to two different pegs, and so
 * the rounding matches the `Decimal(12,2)` column both sides store.
 *
 * Converting at a legally fixed peg is arithmetic. Converting USD is a market
 * quote this product still does not have — hence the asymmetry below.
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
const EURO_SPELLINGS = new Set(['EUR', 'EURO', 'EUROS', '€', 'E']);

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
 * - lev                                  → converted at the fixed peg
 * - anything else                        → refused, amount withheld
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
    if (code === 'BGN' || code === 'ЛВ' || code === 'ЛВ.' || code === 'BGL') {
        return { eur: bgnToEur(amount), refusal: null };
    }
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
 * Deliberately NOT `isStoredAsEuro`. That function answers a different and
 * narrower question — "is this ALREADY euro, as opposed to merely convertible"
 * — and says NO to lev, because the EUR-only save path must lock a BGN row
 * rather than relabel it. For a rollup, lev is addable: `normaliseCostToEur`
 * converts it at the fixed peg and refuses nothing. Using the save path's
 * predicate here would keep BGN in the set and keep refusing the farm.
 */
export function canonicalCostCurrency(currency: string | null | undefined): string {
    const code = currency?.trim().toUpperCase() ?? '';
    if (code === '' || EURO_SPELLINGS.has(code)) return 'EUR';
    if (code === 'BGN' || code === 'ЛВ' || code === 'ЛВ.' || code === 'BGL') return 'EUR';
    return code;
}

/**
 * Is this currency ALREADY euro — as opposed to merely convertible to it?
 *
 * Distinct from `allResolveToEur`, and the distinction is load-bearing. That
 * function answers "can the rollup total this row", and it says **yes** to lev:
 * `normaliseCostToEur` converts BGN at the fixed peg and returns
 * `refusal: null`. So `allResolveToEur(['BGN'])` is `true`.
 *
 * Which makes it the wrong question for the EUR-only save path (#2398). A lock
 * predicate built on it would treat the one production BGN row as euro, pin its
 * field to EUR, and relabel 1.00 BGN as 1.00 EUR on the next save — overstating
 * it by 1.95583×. Three states, not two:
 *
 *   - stored as euro      EUR / EURO / EUROS / € / E / blank   editable
 *   - convertible at peg  BGN / ЛВ / ЛВ. / BGL                 locked
 *   - foreign             USD / GBP …                          locked, and
 *                                                              refused by the
 *                                                              rollup
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

/**
 * What a superuser types a price IN, per commodity (#1587 contract §3).
 *
 * ## Why this is server-side and never accepted from a client
 *
 * The #1587 contract §5(d) is explicit, and the reasoning is worth repeating
 * where the table lives rather than only on the issue:
 *
 *   > Unit and currency are derived server-side from §3 per commodity and are
 *   > deliberately NOT accepted from the client: a caller that could choose the
 *   > unit could put a per-tonne figure into the litre series, and the
 *   > six-column key would dutifully create it.
 *
 * That is not hypothetical. The first implementation took `unit` and `currency`
 * from the request body, guarded only by a lookup against an existing series —
 * so the denomination was chosen by the first write after creation AND again
 * after every clear, and one caller sending `unit: 'EUR/t'` for diesel would
 * mint an EUR/t diesel override that wins for every farm. Diesel is ~1.95 EUR/l
 * or ~1950 EUR/t: a factor of a thousand, rendering as a plausible number.
 *
 * ## Why the table is here and not duplicated in each client
 *
 * `entryUnit` is surfaced on the admin form read precisely so the phone and the
 * web do not hold their own copies (contract v1.2, adopting agrent-ios'
 * suggestion). A cross-repo copy of a UNIT is strictly worse than an in-repo
 * one: no guard can see both sides, and when they disagree the failure is not an
 * error — it is a price wrong by 1000× that renders as a number. The same defect
 * class as `CROP_PICKER_VALUES` and `COST_ALLOCATION_BASES`, both of which had
 * to be extracted after a list drifted between the places that restated it.
 *
 * ## Why diesel is stored EUR/l and NOT converted to the bulletin's EUR/1000l
 *
 * The conversion is exactly ×1000 and lossless, which is what makes converting
 * tempting and wrong. Storing in the bulletin's unit would put the typed point
 * in the SAME six-column series key as the API's, where points upsert on
 * `(seriesId, date)` — so a typed entry would silently OVERWRITE that day's API
 * point. The value being overridden would be lost, the admin form could not show
 * it beside the typed one, and "cleared" would become indistinguishable from
 * "never typed". A separate series keeps both; the ×1000 relationship is a
 * presentation concern.
 *
 * @module lib/market/price-override-denominations
 */
import { normalizeAnyCommodity, type AnyCommodity } from './commodity-vocabulary';

/**
 * The commodities a superuser may override — owner decision 3, 2026-10-10.
 *
 * TEN, and deliberately not every slug the vocabulary knows. `oats`, `rye`,
 * `soybean`, `peas` and `lentils` are in `AnyCommodity` and have no feed either,
 * so they would be defensible additions — but they are not on the owner's list,
 * and silently widening a surface that sets the price for every farm is not a
 * decision to take by implication. Add them here when the owner asks.
 */
export const OVERRIDE_COMMODITIES = [
    'wheat',
    'barley',
    'maize',
    'sunflower',
    'rapeseed',
    'urea',
    'ammonium-nitrate',
    'map',
    'dap',
    'diesel',
] as const satisfies readonly AnyCommodity[];

export type OverrideCommodity = (typeof OVERRIDE_COMMODITIES)[number];

export interface EntryDenomination {
    /** What to TYPE in, and what the point is STORED under. */
    unit: string;
    /** ISO 4217. */
    currency: string;
}

/**
 * Total over {@link OverrideCommodity}, so adding a commodity to the list above
 * without naming its denomination is a COMPILE error rather than a runtime
 * default. A default would be EUR/t — correct for nine of ten and wrong by a
 * factor of a thousand for the tenth, which is the single worst place in this
 * feature for a silent fallback.
 */
export const OVERRIDE_ENTRY: Readonly<Record<OverrideCommodity, EntryDenomination>> = {
    wheat: { unit: 'EUR/t', currency: 'EUR' },
    barley: { unit: 'EUR/t', currency: 'EUR' },
    maize: { unit: 'EUR/t', currency: 'EUR' },
    sunflower: { unit: 'EUR/t', currency: 'EUR' },
    rapeseed: { unit: 'EUR/t', currency: 'EUR' },
    // EUR/t, which DIFFERS from the Pink Sheet's USD/mt for urea and DAP. That
    // is fine and is not a conversion: a typed series and a feed series are
    // different rows by construction, and the override SUPPRESSES the feed
    // rather than being combined with it, so no exchange rate is ever needed.
    urea: { unit: 'EUR/t', currency: 'EUR' },
    'ammonium-nitrate': { unit: 'EUR/t', currency: 'EUR' },
    map: { unit: 'EUR/t', currency: 'EUR' },
    dap: { unit: 'EUR/t', currency: 'EUR' },
    // THE one that differs. Owner, asked directly 2026-10-10, after #1587 had
    // recorded "EUR per tonne, diesel included" via a relay.
    diesel: { unit: 'EUR/l', currency: 'EUR' },
};

/** True when `slug` is a canonical commodity a superuser may override. */
export function isOverridable(slug: string): slug is OverrideCommodity {
    return (OVERRIDE_COMMODITIES as readonly string[]).includes(slug);
}

/**
 * Resolve any accepted spelling to its canonical slug and entry denomination.
 *
 * `null` for a spelling the vocabulary does not know AND for a commodity the
 * vocabulary knows but the owner has not opened to overrides — the caller
 * distinguishes those two in its refusal, because "not a commodity" and "not
 * overridable" are different things to fix.
 */
export function resolveOverrideCommodity(
    raw: string | null | undefined,
): { commodity: OverrideCommodity; entry: EntryDenomination } | null {
    const canonical = normalizeAnyCommodity(raw);
    if (canonical == null || !isOverridable(canonical)) return null;
    return { commodity: canonical, entry: OVERRIDE_ENTRY[canonical] };
}

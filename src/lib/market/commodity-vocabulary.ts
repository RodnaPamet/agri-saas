/**
 * The canonical commodity vocabulary — one spelling of "wheat" for the whole
 * product.
 *
 * Four surfaces name commodities today and none of them agreed:
 *
 *   | surface                    | spelling            |
 *   |----------------------------|---------------------|
 *   | `TrendCommodity` enum      | `'wheat'`           |
 *   | `ExchangeListing.commodity`| free text, `'Wheat'`|
 *   | `Contract.commodity`       | free text           |
 *   | tenant crop catalogue      | free text, any lang |
 *
 * That disagreement was not cosmetic. `getPriceTrends` matches
 * `where: { commodity }` — exact and case-sensitive — while
 * `CreateOfferModal` seeds Title-Case, and nothing normalised anywhere in
 * between. So the own-listings median was computed every Monday, written to
 * the database, and never once read: `findListingsSeries` returned null
 * forever and the Listings tile showed "—" from the day it shipped.
 *
 * This module is the single answer. It is deliberately PURE and dependency-free
 * (no Prisma, no i18n) so it can sit at the boundary of the pull job, the write
 * schemas and the read path alike, and so its behaviour is unit-testable in
 * memory.
 *
 * ## Adding a commodity
 *
 * Decide first WHICH LIST it belongs to, because the two are not
 * interchangeable:
 *
 *   - a crop the farm SELLS → {@link CANONICAL_COMMODITIES}. This list is
 *     what the exchange offers and accepts.
 *   - an input the farm BUYS (fuel, fertiliser) → {@link INPUT_COMMODITIES}.
 *     Prices are tracked; the commodity is NOT listable on the exchange.
 *
 * Then add its spellings to {@link COMMODITY_ALIASES} and classify it in
 * `COMMODITY_META` (the compiler will insist on the latter). A missing alias
 * silently splits a group rather than failing loudly — the alias table is the
 * thing to check when a commodity looks under-represented.
 *
 * ## Two resolvers, and which one you want
 *
 * {@link normalizeCommodity} resolves CROPS ONLY and returns null for an
 * input. It is the safe default and what every user-text write path uses.
 * {@link normalizeAnyCommodity} resolves both and is for the price feeds.
 * Reaching for the second one is a deliberate act; getting the first one by
 * accident cannot put diesel on a grain exchange.
 *
 * @module lib/market/commodity-vocabulary
 */

/**
 * Every commodity the farm SELLS, lowercase slug form.
 *
 * A SUPERSET of `TrendCommodity` (which lists only those with price series).
 * The exchange trades more than we can quote prices for, and a listing must
 * not be un-nameable just because no market feed covers it.
 *
 * NOT every commodity the product can name — inputs the farm buys live in
 * {@link INPUT_COMMODITIES} and are deliberately absent from here, because
 * this array IS the exchange's offer vocabulary: `CreateOfferModal` maps it
 * to dropdown options and the write schema quotes it back in its 400.
 */
export const CANONICAL_COMMODITIES = [
    'wheat',
    'maize',
    'barley',
    'sunflower',
    'rapeseed',
    'oats',
    'rye',
    'soybean',
    'peas',
    'lentils',
] as const;

export type CanonicalCommodity = (typeof CANONICAL_COMMODITIES)[number];

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_COMMODITIES);

/**
 * Commodities the farm BUYS, kept deliberately OUTSIDE
 * {@link CANONICAL_COMMODITIES}.
 *
 * Extending the canonical list would have been one line, and would have put
 * diesel and urea in the seller's dropdown on the grain exchange
 * (`CreateOfferModal` maps that array straight to options) and in the
 * exchange write schema's accept-set. A farmer must never be able to list a
 * tonne of fertiliser as a crop for sale. So inputs are a SEPARATE list, and
 * the split is load-bearing rather than tidy-minded.
 *
 * The prices are still worth tracking: fuel and fertiliser are the two
 * largest cash costs in an arable budget, and a farmer deciding when to buy
 * urea needs the same trend line a farmer deciding when to sell wheat does.
 */
export const INPUT_COMMODITIES = [
    'diesel',
    'urea',
    'dap',
    'map',
    'ammonium-nitrate',
] as const;

export type InputCommodity = (typeof INPUT_COMMODITIES)[number];

/** Anything the vocabulary can name, bought or sold. */
export type AnyCommodity = CanonicalCommodity | InputCommodity;

/** Which side of the farm's ledger a commodity sits on. */
export type CommodityKind = 'output' | 'input';

/** The grouping Trends offers as its first-level picker. */
export type CommodityCategory = 'grain' | 'fuel' | 'fertilizer';

/**
 * The upstream that publishes a commodity's price, if any does.
 *
 * `'none'` is a STATEMENT, not a gap. MAP and ammonium nitrate have no free
 * feed anywhere, and oats / rye / peas / lentils are named by the exchange
 * vocabulary but quoted by nothing we pull — so the only price they can ever
 * have is one an admin typed. Saying that is useful; leaving the reader to
 * infer it from an empty chart is not.
 *
 * This exists because the Prices tab's operator hint used to name
 * `EC_AGRIFOOD_BASE_URL` and `ALPHA_VANTAGE_API_KEY` for EVERY commodity.
 * Neither can populate urea — that is the World Bank Pink Sheet — and the
 * first is not a credential at all, just an optional base-URL override. An
 * operator following that hint would configure two irrelevant things and
 * still see an empty chart.
 */
export type CommodityFeed = 'ec-agrifood' | 'oil-bulletin' | 'world-bank' | 'none';

export interface CommodityMeta {
    kind: CommodityKind;
    category: CommodityCategory;
    /** Which upstream actually publishes this price — see {@link CommodityFeed}. */
    feed: CommodityFeed;
}

/**
 * Kind + category for every slug.
 *
 * Typed as a total `Record` over {@link AnyCommodity} on purpose: adding a
 * slug to either list without classifying it here is a COMPILE error, not a
 * runtime surprise. That matters because the categories drive a UI picker —
 * an unclassified commodity would simply never appear, and nothing would
 * say so.
 *
 * Every output is `'grain'`. Sunflower, rapeseed and soybean are oilseeds
 * and peas and lentils are pulses, so the label is loose botanically — but
 * the category exists to answer "grain, fuel or fertiliser?" for a farmer
 * choosing a price chart, and зърно is the word they use for the whole
 * sold-crop group. Splitting oilseeds out is a UI decision that can be made
 * later without touching a consumer.
 */
const COMMODITY_META: Readonly<Record<AnyCommodity, CommodityMeta>> = {
    wheat: { kind: 'output', category: 'grain', feed: 'ec-agrifood' },
    maize: { kind: 'output', category: 'grain', feed: 'ec-agrifood' },
    barley: { kind: 'output', category: 'grain', feed: 'ec-agrifood' },
    sunflower: { kind: 'output', category: 'grain', feed: 'ec-agrifood' },
    rapeseed: { kind: 'output', category: 'grain', feed: 'none' },
    oats: { kind: 'output', category: 'grain', feed: 'none' },
    rye: { kind: 'output', category: 'grain', feed: 'none' },
    soybean: { kind: 'output', category: 'grain', feed: 'none' },
    peas: { kind: 'output', category: 'grain', feed: 'none' },
    lentils: { kind: 'output', category: 'grain', feed: 'none' },
    diesel: { kind: 'input', category: 'fuel', feed: 'oil-bulletin' },
    urea: { kind: 'input', category: 'fertilizer', feed: 'world-bank' },
    dap: { kind: 'input', category: 'fertilizer', feed: 'world-bank' },
    map: { kind: 'input', category: 'fertilizer', feed: 'none' },
    'ammonium-nitrate': { kind: 'input', category: 'fertilizer', feed: 'none' },
};

const INPUT_SET: ReadonlySet<string> = new Set(INPUT_COMMODITIES);

/**
 * Accepted spellings per canonical slug.
 *
 * Bulgarian names are first-class: the product is bilingual, the commodity
 * field has been free text since it shipped, and a Bulgarian farmer typing
 * `пшеница` means exactly what an English one typing `Wheat` means. Treating
 * those as different commodities is how a group fragments into three
 * sub-k-anonymity pieces and vanishes from the index entirely.
 *
 * Keys are compared after {@link foldForLookup}, so case and spacing variants
 * do not need listing.
 */
export const COMMODITY_ALIASES: Readonly<Record<string, AnyCommodity>> = {
    // wheat
    wheat: 'wheat',
    commonwheat: 'wheat',
    softwheat: 'wheat',
    durum: 'wheat',
    durumwheat: 'wheat',
    пшеница: 'wheat',
    // maize
    maize: 'maize',
    corn: 'maize',
    царевица: 'maize',
    // barley
    barley: 'barley',
    ечемик: 'barley',
    // sunflower
    sunflower: 'sunflower',
    sunflowerseed: 'sunflower',
    слънчоглед: 'sunflower',
    // rapeseed
    rapeseed: 'rapeseed',
    canola: 'rapeseed',
    рапица: 'rapeseed',
    // oats
    oats: 'oats',
    oat: 'oats',
    овес: 'oats',
    // rye
    rye: 'rye',
    ръж: 'rye',
    // soybean
    soybean: 'soybean',
    soybeans: 'soybean',
    soya: 'soybean',
    соя: 'soybean',
    // peas
    peas: 'peas',
    pea: 'peas',
    грах: 'peas',
    // lentils
    lentils: 'lentils',
    lentil: 'lentils',
    леща: 'lentils',

    // ── Inputs ───────────────────────────────────────────────────────
    //
    // Keys are stored ALREADY FOLDED (see `foldForLookup`), so multi-word
    // spellings lose their spaces here: `gas oil` is keyed `gasoil`, and
    // `амониев нитрат` is keyed `амониевнитрат`. Both spellings still
    // resolve — the caller's input is folded the same way before lookup.

    // diesel — нафта is DIESEL FUEL in Bulgarian, not crude oil. Getting
    // that wrong means charting WTI/BRENT at a farmer budgeting fuel.
    diesel: 'diesel',
    нафта: 'diesel',
    дизел: 'diesel',
    дизеловогориво: 'diesel',
    gasoil: 'diesel',
    // urea
    urea: 'urea',
    уреа: 'urea',
    карбамид: 'urea',
    // dap
    dap: 'dap',
    дап: 'dap',
    диамониевфосфат: 'dap',
    diammoniumphosphate: 'dap',
    // map
    map: 'map',
    мап: 'map',
    моноамониевфосфат: 'map',
    monoammoniumphosphate: 'map',
    // ammonium nitrate. `ammoniumnitrate` is NOT redundant with the slug:
    // the slug is hyphenated and `foldForLookup` strips the hyphen, so the
    // canonical-set fast path never matches it.
    ammoniumnitrate: 'ammonium-nitrate',
    амониевнитрат: 'ammonium-nitrate',
    амселитра: 'ammonium-nitrate',
    an: 'ammonium-nitrate',
};

/**
 * The alias table as a `Map`.
 *
 * A plain object lookup inherits `Object.prototype`, so
 * `COMMODITY_ALIASES['constructor']` returns a FUNCTION and the `?? null`
 * fallback never fires — `normalizeCommodity('constructor')` handed back a
 * function typed as a commodity slug, reachable from any free-text field.
 * A `Map` has no prototype chain and cannot do that.
 */
const ALIAS_LOOKUP: ReadonlyMap<string, AnyCommodity> = new Map(Object.entries(COMMODITY_ALIASES));

/**
 * Case-, space- and punctuation-insensitive lookup form.
 *
 * `toLocaleLowerCase` without a locale is deliberate — the Turkish dotted-I
 * rule would fold `I` to `ı` under a tr locale and break `Lentils`. The
 * vocabulary is data, not user-facing text, so an invariant fold is correct.
 */
function foldForLookup(raw: string): string {
    return raw
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s._/\\-]+/g, '');
}

/**
 * Map any spelling to its slug — crop OR input — or null when unrecognised.
 *
 * This is the resolver the price FEEDS use: a bulletin spelling variant that
 * failed to resolve would silently split one series into two, which is the
 * failure this module exists to prevent.
 *
 * It is NOT the resolver for write paths that accept user text. Those want
 * {@link normalizeCommodity}, which refuses inputs.
 */
export function normalizeAnyCommodity(raw: string | null | undefined): AnyCommodity | null {
    if (!raw) return null;
    const folded = foldForLookup(raw);
    if (!folded) return null;
    if (CANONICAL_SET.has(folded)) return folded as CanonicalCommodity;
    if (INPUT_SET.has(folded)) return folded as InputCommodity;
    return ALIAS_LOOKUP.get(folded) ?? null;
}

/**
 * Map any spelling to its CROP slug, or null when unrecognised — including
 * when it resolves to an input.
 *
 * Returning null rather than the raw string is deliberate: a caller that
 * cannot name a commodity should decide what to do about it (reject the write,
 * skip the row) instead of silently creating a new one-off group.
 *
 * THE INPUT FILTER IS THE SAFE DEFAULT, and it is why adding fuel and
 * fertiliser to this module changed no call site. Every existing caller —
 * the exchange write schema, the contract canonicaliser, the listings index —
 * calls THIS function, so all of them refuse `дизел` without knowing inputs
 * exist. A new caller that genuinely wants inputs has to reach for
 * {@link normalizeAnyCommodity} by name, which is a visible, reviewable act.
 */
export function normalizeCommodity(raw: string | null | undefined): CanonicalCommodity | null {
    const slug = normalizeAnyCommodity(raw);
    return slug !== null && isCanonicalCommodity(slug) ? slug : null;
}

/** True when `value` is already a canonical (crop) slug. */
export function isCanonicalCommodity(value: string): value is CanonicalCommodity {
    return CANONICAL_SET.has(value);
}

/** True when `value` is an input the farm buys rather than a crop it sells. */
export function isInputCommodity(value: string): value is InputCommodity {
    return INPUT_SET.has(value);
}

/** Kind + category for a slug, or null when the slug is not in the vocabulary. */
export function commodityMeta(value: string): CommodityMeta | null {
    return isCanonicalCommodity(value) || isInputCommodity(value)
        ? COMMODITY_META[value as AnyCommodity]
        : null;
}

/**
 * Every slug in a category, in vocabulary order.
 *
 * The Trends picker builds its options from this rather than from a list
 * hardcoded in the component, so adding a commodity never means editing a
 * React file.
 */
export function commoditiesInCategory(category: CommodityCategory): readonly AnyCommodity[] {
    return [...CANONICAL_COMMODITIES, ...INPUT_COMMODITIES].filter(
        (slug) => COMMODITY_META[slug].category === category,
    );
}

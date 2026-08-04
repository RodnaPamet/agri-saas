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
 * Add the slug to {@link CANONICAL_COMMODITIES} and its spellings to
 * {@link COMMODITY_ALIASES}. Both the exchange write schema and the index
 * group by the result, so a missing alias silently splits a group rather than
 * failing loudly — the alias table is the thing to check when a commodity
 * looks under-represented.
 *
 * @module lib/market/commodity-vocabulary
 */

/**
 * Every commodity the product can name, lowercase slug form.
 *
 * A SUPERSET of `TrendCommodity` (which lists only those with price series).
 * The exchange trades more than we can quote prices for, and a listing must
 * not be un-nameable just because no market feed covers it.
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
const COMMODITY_ALIASES: Readonly<Record<string, CanonicalCommodity>> = {
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
};

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
 * Map any spelling to its canonical slug, or null when unrecognised.
 *
 * Returning null rather than the raw string is deliberate: a caller that
 * cannot name a commodity should decide what to do about it (reject the write,
 * skip the row) instead of silently creating a new one-off group.
 */
export function normalizeCommodity(raw: string | null | undefined): CanonicalCommodity | null {
    if (!raw) return null;
    const folded = foldForLookup(raw);
    if (!folded) return null;
    if (CANONICAL_SET.has(folded)) return folded as CanonicalCommodity;
    return COMMODITY_ALIASES[folded] ?? null;
}

/** True when `value` is already a canonical slug. */
export function isCanonicalCommodity(value: string): value is CanonicalCommodity {
    return CANONICAL_SET.has(value);
}

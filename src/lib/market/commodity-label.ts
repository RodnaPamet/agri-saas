/**
 * Display label for a commodity slug.
 *
 * Since #484 the stored `commodity` value is the canonical LOWERCASE SLUG
 * (`wheat`, `ammonium-nitrate`). That is correct as identity — it is what the
 * schema validates against, what the filter facet keys on, and what the
 * trends vocabulary aliases resolve to. It is wrong on screen: the Exchange
 * list rendered it verbatim, so a Bulgarian operator read **`wheat`**.
 *
 * The labels already exist. `trends.commodities.*` carries all fifteen slugs
 * in BOTH locales — measured, an exact 1:1 against `CANONICAL_COMMODITIES` +
 * `INPUT_COMMODITIES`, with no slug unlabelled and no label orphaned. Nothing
 * consumed them outside the trends pages, so this needs no new i18n key.
 *
 * Same shape as `sourceDisplayName` in `@/lib/news/feeds`, and for the same
 * reason: identity and presentation are different jobs, and the slug must
 * stay stable regardless of what is shown.
 *
 * @module lib/market/commodity-label
 */

/**
 * Minimal translator shape — `useTranslations('trends.commodities')` or
 * `getTranslations('trends.commodities')` both satisfy it, so this stays a
 * pure function usable from a client component, a server component or a test.
 */
export type CommodityTranslator = (key: string) => string;

/**
 * Title-case a slug: `ammonium-nitrate` → `Ammonium Nitrate`.
 *
 * The fallback, never the happy path. It exists because `commodity` is a
 * plain string column: a row written before #484 canonicalised the vocabulary
 * can hold a value that is in no catalogue, and a fallback that returned the
 * key path (next-intl's default) would put `trends.commodities.foo` on screen
 * where the old code at least showed `foo`.
 */
function titleCase(slug: string): string {
    return slug
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

/**
 * Resolve `slug` to its localised name, falling back to a title-cased slug
 * when the catalogue has no entry.
 *
 * `t.has` is used where available — next-intl exposes it, and the project-wide
 * test mock implements it — because a missing key otherwise *renders* as the
 * key path rather than throwing, which is the failure mode that made
 * `ag.offers.ask.consent` invisible for weeks (see #662). Where `has` is
 * absent the result is checked for the key path directly, so the fallback
 * still fires.
 */
export function commodityLabel(t: CommodityTranslator, slug: string): string {
    const raw = (slug ?? '').trim();
    if (!raw) return '';

    const has = (t as CommodityTranslator & { has?: (k: string) => boolean }).has;
    if (typeof has === 'function' && !has(raw)) return titleCase(raw);

    let label: string;
    try {
        label = t(raw);
    } catch {
        return titleCase(raw);
    }

    // Defensive: without `t.has`, next-intl returns the joined key path for a
    // miss instead of throwing.
    if (!label || label === raw || label.endsWith(`.${raw}`)) return titleCase(raw);
    return label;
}

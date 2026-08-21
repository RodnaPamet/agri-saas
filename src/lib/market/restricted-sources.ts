/**
 * Hosts this product must not pull PRICE data from.
 *
 * ## Why this is code and not a comment
 *
 * agroportal.bg's price content sits under an exclusive brokerage
 * partnership — confirmed by the maintainer, 2026-08-21. That is a
 * **commercial** restriction, not a technical one: nothing about the site
 * stops us fetching it, and no error would ever be raised if we did.
 *
 * Until now the constraint lived only as a sentence in an unmerged WIP branch,
 * and — after that branch was harvested — as a comment in
 * `@/lib/news/feeds`, which is the wrong file: that one governs the NEWS feed
 * list, while the restriction is about PRICE data. The two are separate
 * pipelines (`market-news-pull` vs `market-prices-pull`) with separate
 * sources, so the comment sat beside code that could not violate it, while the
 * code that could had nothing.
 *
 * The exposure is concrete. Four price-source URLs are operator-settable via
 * env — `EC_AGRIFOOD_BASE_URL`, `EC_OIL_BULLETIN_WITH_TAX_URL`,
 * `EC_OIL_BULLETIN_WITHOUT_TAX_URL`, `WORLD_BANK_PINK_SHEET_URL` — each
 * documented as "point it at a mirror/proxy". Any of them could be aimed at a
 * restricted host with no code change, no review, and nothing checking.
 *
 * ## What this does
 *
 * `assertPriceSourceAllowed` returns whether a URL may be used as a price
 * source. Callers SKIP the source and log rather than throwing: a
 * misconfigured override must not take down the unrelated price sources in the
 * same run, and a commercial restriction is not an availability incident.
 *
 * ## Scope, stated so it is not over-read
 *
 * This governs **price** ingestion only. Whether agroportal.bg's *news* RSS is
 * separately permissible has NOT been established — the confirmed restriction
 * is about price content. `@/lib/news/feeds` excludes it for an unrelated
 * technical reason (it serves HTML, not a feed). Do not read this module as
 * settling that question.
 *
 * @module lib/market/restricted-sources
 */

/**
 * Hosts under a commercial restriction for price data.
 *
 * Matched on registrable-domain suffix, so `www.agroportal.bg` and
 * `api.agroportal.bg` are covered without listing each. Keep lowercase.
 */
export const RESTRICTED_PRICE_HOSTS: readonly string[] = ['agroportal.bg'];

/** Does `host` fall under a restricted domain? */
function isRestrictedHost(host: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, '');
    return RESTRICTED_PRICE_HOSTS.some(
        (restricted) => h === restricted || h.endsWith(`.${restricted}`),
    );
}

/**
 * Whether `url` may be used as a price source.
 *
 * An unparseable URL is ALLOWED here rather than rejected: this function
 * answers one narrow question, and the surrounding code already validates
 * shape (`z.string().url()` in `src/env.ts`). Failing an unrelated
 * malformed-URL case in a module about commercial restrictions would put the
 * wrong reason in the log.
 */
export function isPriceSourceAllowed(url: string | null | undefined): boolean {
    if (!url) return true;
    let host: string;
    try {
        host = new URL(url).hostname;
    } catch {
        return true;
    }
    return !isRestrictedHost(host);
}

/**
 * The restricted host a URL resolves to, or null. For log messages — so an
 * operator sees WHICH restriction they tripped rather than a bare refusal.
 */
export function restrictedHostOf(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        const h = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
        return (
            RESTRICTED_PRICE_HOSTS.find((r) => h === r || h.endsWith(`.${r}`)) ?? null
        );
    } catch {
        return null;
    }
}

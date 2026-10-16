import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from '@/lib/i18n/locales';
import { bundlesFor } from '@/lib/i18n/bundles';
import { PUBLIC_SURFACE_HEADER } from '@/lib/i18n/public-surface';

/**
 * next-intl request config — resolves the active UI locale per request.
 *
 * T00: the locale is read from the `NEXT_LOCALE` cookie (set by the
 * language switcher, and seeded by the middleware from the user's
 * persisted `uiLanguage` preference). The cookie value is validated
 * against the supported `LOCALES`; anything absent or unrecognised
 * falls back to `DEFAULT_LOCALE` ('en') — which in practice only affects
 * unauthenticated pages. A first-time authenticated user gets Bulgarian via
 * `User.uiLanguage` (default 'bg'), which the middleware seeds into the
 * cookie on their first request.
 */
export default getRequestConfig(async () => {
    // `cookies()` is async in Next 15+. It may be absent (first visit,
    // static context) — default cleanly in that case.
    let locale = DEFAULT_LOCALE;
    try {
        const cookieStore = await cookies();
        const value = cookieStore.get(LOCALE_COOKIE)?.value;
        if (isLocale(value)) {
            locale = value;
        }
    } catch {
        // No request cookie store available — keep the default locale.
    }

    /**
     * Whether this request is for a PUBLIC surface — P6.4 (#1813).
     *
     * The flag comes from the middleware via a request header, the same bridge
     * the CSP nonce and the root layout use, because neither a layout nor this
     * config can see the pathname.
     *
     * An ABSENT header means the operator app and the whole catalogue, which
     * is the safe default: a missing header costs bytes, where a wrongly-set
     * one would strip copy from a real screen.
     */
    let isPublic = false;
    try {
        isPublic = (await headers()).get(PUBLIC_SURFACE_HEADER) === '1';
    } catch {
        // No request header store (a static context) — assume the app.
    }

    return {
        locale,
        messages: await loadBundles(locale, isPublic),
    };
});

/**
 * Merge the bundles this request needs — P6.4 (#1813).
 *
 * The payoff of the split: an anonymous visitor's page no longer READS the
 * operator catalogue. `bundlesFor(true)` is `['public']`, 2 namespaces, where
 * the single file was 93.
 *
 * Merged in `bundlesFor` order, and a namespace lives in exactly ONE bundle —
 * `scripts/i18n-diff.mjs` refuses a commit where one appears in two, and
 * `tests/helpers/catalogue.ts` throws on the same condition. So the spread
 * below cannot silently drop a namespace to a later bundle's copy.
 */
async function loadBundles(locale: string, isPublic: boolean) {
    const parts = await Promise.all(
        bundlesFor(isPublic).map(
            (bundle) =>
                import(`../messages/${locale}/${bundle}.json`) as Promise<{
                    default: Record<string, unknown>;
                }>,
        ),
    );
    return Object.assign({}, ...parts.map((m) => m.default)) as Record<string, unknown>;
}

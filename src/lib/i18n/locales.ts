/**
 * Shared locale contract for the UI i18n layer (T00).
 *
 * Single source of truth for the set of supported UI locales, the
 * default, the cookie name the server reads to resolve the request
 * locale, and the endonym labels shown in the language switcher.
 *
 * Consumed by:
 *   - `src/i18n.ts`       — resolves the request locale from the cookie.
 *   - `src/middleware.ts` — seeds the cookie from the JWT preference.
 *   - `src/auth.ts`       — carries `uiLanguage` on the token/session.
 *   - the account language API + the admin LanguageSetting selector.
 */

/** Every UI locale the product ships message catalogues for. */
export const LOCALES = ['en', 'bg'] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * Runtime fallback locale when nothing else resolves (no `NEXT_LOCALE`
 * cookie, no authenticated `uiLanguage`) — i.e. UNAUTHENTICATED pages
 * (login, invite preview, shared audit packs). Kept as `en`.
 *
 * "Bulgarian for first-time users" is delivered via the authenticated path
 * instead — new users get `User.uiLanguage = 'bg'` (the column default), so
 * the APP renders Bulgarian on first login; the middleware seeds the
 * `NEXT_LOCALE` cookie from that. Doing it this way (rather than flipping
 * this fallback to `bg`) keeps the pre-login pages — and the English-copy
 * E2E specs that exercise them — in English.
 */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Cookie the server reads to resolve the request locale. `NEXT_LOCALE`
 * is the de-facto next-intl / Next.js convention name.
 */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

/**
 * How long the locale cookie lives, in seconds.
 *
 * Here rather than at the two set sites, because it was declared TWICE —
 * `middleware.ts` and `api/account/language/route.ts` each had their own copy
 * of `60 * 60 * 24 * 365`. Two spellings of one lifetime drift silently, and
 * the cookie policy at `/cookies` renders this number: a page citing one copy
 * while the other sets the cookie is worse than a page with no number on it.
 */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Narrow an untrusted value (cookie, DB column, JWT claim) to a Locale. */
export function isLocale(v: unknown): v is Locale {
    return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/**
 * Display labels for each locale, written as endonyms (each language
 * names itself in its own script) so the option is recognisable
 * regardless of the currently-active UI locale.
 */
export const LOCALE_LABELS: Record<Locale, string> = {
    en: 'English',
    bg: 'Български',
};

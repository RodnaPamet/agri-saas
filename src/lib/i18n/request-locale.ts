/**
 * The locale a server-side refusal should speak (#1677).
 *
 * ## The owner's ruling, and the trap inside it
 *
 * Owner ruling on #1677: the server resolves the locale and sends `message`
 * already in the reader's language, so neither client needs a code catalogue.
 *
 * `agrent-ios` named the trap before anything was built: **do not negotiate on
 * `Accept-Language`.** The owner's phone reports `en_BG` and the app sets no
 * header, so URLSession sends the device's languages — a request-negotiated
 * message would hand the phone English sentences that pass its
 * `isHumanSentence` check and get rendered word for word. That is *worse* than
 * the bare code it replaced.
 *
 * This repo already decided the same thing independently: the only two
 * mentions of the header anywhere in `src/` are documentation strings in
 * `farm-risk.paths.ts` saying it is **deliberately ignored**, and that text is
 * published in the spec.
 *
 * ## So the sources are, in order
 *
 *   1. the session's `uiLanguage` claim — the person's own setting, already in
 *      the JWT, so no query;
 *   2. an explicit `?locale`, for unauthenticated surfaces that have no
 *      session to read. #1140's own pattern, merged at the iOS app's request;
 *   3. `bg`.
 *
 * ## Why the fallback is `bg` and `DEFAULT_LOCALE` would be a bug
 *
 * `DEFAULT_LOCALE` is `'en'`, documented in `locales.ts` as the fallback for
 * UNAUTHENTICATED surfaces. A refusal is answered to a known person whose
 * `User.uiLanguage` column defaults to `'bg'`, so reaching for the
 * unauthenticated constant would hand English to a Bulgarian farmer whose
 * claim merely failed to load — the mistake #686 fixed and
 * `statement-dispatch.ts` re-states.
 *
 * `RECIPIENT_FALLBACK_LOCALE` is the same constant for the same reason; this
 * reuses it rather than writing `'bg'` twice.
 */
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { RECIPIENT_FALLBACK_LOCALE } from '@/lib/email/recipient-locale';
import { getRequestContext } from '@/lib/observability/context';

/**
 * Resolve the locale for the request in scope.
 *
 * Returns the fallback outside a request scope — a job, a script, a test —
 * rather than throwing: a refusal that failed to resolve a language is still a
 * refusal, and failing the response to localise it would be the tail wagging
 * the dog.
 */
export function resolveRequestLocale(explicit?: string | null): Locale {
    const fromSession = getRequestContext()?.uiLanguage;
    if (isLocale(fromSession)) return fromSession;
    if (isLocale(explicit)) return explicit;
    return RECIPIENT_FALLBACK_LOCALE;
}

/**
 * The date helpers bound to the request's locale, for server components.
 *
 * The server half of `useDateFormat`. Same narrowing, same reasoning about
 * why this is hydration-safe (see that file) — next-intl resolves both from
 * the one `NEXT_LOCALE` cookie, so a server render and the client hydration
 * agree.
 *
 * NOT for background jobs or anything outside a request: `getLocale()` has no
 * request to read there. A job formatting for a specific person should use
 * `resolveRecipientLocale(user.uiLanguage)` with `createDateFormatters`, which
 * is what `src/lib/email/recipient-locale.ts` already exists for.
 */
import { getLocale } from 'next-intl/server';
import { createDateFormatters, type DateFormatters } from '@/lib/format-date';
import { DEFAULT_LOCALE, isLocale } from '@/lib/i18n/locales';

export async function getDateFormat(): Promise<DateFormatters> {
    const locale = await getLocale();
    return createDateFormatters(isLocale(locale) ? locale : DEFAULT_LOCALE);
}

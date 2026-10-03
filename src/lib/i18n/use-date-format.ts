'use client';

/**
 * The date helpers bound to the viewer's locale, for client components.
 *
 * ── why a hook and not a locale argument ──
 *
 * `format-date.ts` holds 142 call sites across 73 files. Threading a locale
 * parameter would mean editing every CALL; this changes each FILE's import
 * once and leaves the call expressions alone. Measured before choosing: 65 of
 * those 73 files are client components, and only 5 files in the whole repo
 * call a date helper from somewhere a hook cannot go.
 *
 * ── why this is still hydration-safe ──
 *
 * The header of `format-date.ts` warns that a server and browser disagreeing
 * on locale produces a mismatch, and hardcoded `en-GB` to avoid it. The
 * hazard is an AMBIENT locale — one read from the host or the browser's
 * settings, which the two sides resolve differently. `useLocale()` is not
 * ambient: next-intl resolves it from the `NEXT_LOCALE` cookie on the server
 * and hands the same value to the client through the provider, so both sides
 * render identically. That is the same argument `calendar-locale-names.ts`
 * already makes for the same reason.
 *
 * What is NOT safe, and this hook cannot fix, is a relative string computed
 * from a clock: `formatChatTime` takes `now` as an argument precisely so the
 * caller owns it, and on the client that means `useHydratedNow()`.
 */
import { useMemo } from 'react';
import { useLocale } from 'next-intl';
import { createDateFormatters, type DateFormatters } from '@/lib/format-date';
import { DEFAULT_LOCALE, isLocale } from '@/lib/i18n/locales';

export function useDateFormat(): DateFormatters {
    const locale = useLocale();
    return useMemo(
        () =>
            // `useLocale()` is typed as `string`, and the cookie it comes from
            // is user-controlled, so it is narrowed rather than asserted — an
            // unrecognised value must fall back, not reach Intl as a tag.
            createDateFormatters(isLocale(locale) ? locale : DEFAULT_LOCALE),
        [locale],
    );
}

/**
 * Locale-aware month/weekday names for the calendar grid + timeline
 * chrome (CalendarClient's month header, CalendarMonth's weekday row +
 * aria-label, GanttTimeline's axis ticks).
 *
 * `src/lib/format-date.ts` hardcodes every date VALUE it renders to
 * en-GB/UTC on purpose — that module exists to stop server/client
 * hydration mismatches caused by the HOST's OS/browser locale drifting
 * from render to render. This solves a different problem: showing
 * calendar chrome in the user's CHOSEN UI locale (next-intl's
 * `useLocale()`, resolved identically on server and client from the
 * same cookie), which carries no hydration risk — the value is already
 * stable across the render boundary.
 */

/** Jan 1, 2023 is a Sunday — the reference week used to derive names. */
const REFERENCE_YEAR = 2023;

function isNumericOnly(s: string): boolean {
    return /^\d+\.?$/.test(s.trim());
}

/**
 * 12 month names (index 0 = January), in `locale`.
 *
 * `style: 'short'` falls back to the long form when the locale's CLDR
 * data has no distinct abbreviated month form and would otherwise
 * render a bare numeral (observed for `bg`: Bulgarian's "short" month
 * field resolves to 2-digit numeric, e.g. "01" for January) — a
 * numeral alone is useless as a calendar label.
 */
export function getLocalizedMonthNames(
    locale: string,
    style: 'long' | 'short' = 'long',
): string[] {
    const fmt = new Intl.DateTimeFormat(locale, {
        month: style,
        timeZone: 'UTC',
    });
    const names = Array.from({ length: 12 }, (_, m) =>
        fmt.format(new Date(Date.UTC(REFERENCE_YEAR, m, 1))),
    );
    if (style === 'short' && names.every(isNumericOnly)) {
        return getLocalizedMonthNames(locale, 'long');
    }
    return names;
}

/**
 * 7 weekday names (index 0 = Sunday, matching `Date.getUTCDay()`), in
 * `locale`.
 */
export function getLocalizedWeekdayNames(
    locale: string,
    style: 'short' | 'long' = 'short',
): string[] {
    const fmt = new Intl.DateTimeFormat(locale, {
        weekday: style,
        timeZone: 'UTC',
    });
    return Array.from({ length: 7 }, (_, i) =>
        fmt.format(new Date(Date.UTC(REFERENCE_YEAR, 0, 1 + i))),
    );
}

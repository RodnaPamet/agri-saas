/**
 * Epic 58 — shared date-picker foundation utilities.
 *
 * These helpers are the contract every date-picker surface (single
 * picker, range picker, filter integration, URL sync, preset catalogue)
 * will build on. They are deliberately UTC-anchored so the same value
 * renders identically on server and client regardless of the user's
 * system timezone — the same posture the existing
 * `src/lib/format-date.ts` helpers take for display-side rendering.
 *
 * Why not delegate everything to `date-fns`?
 *   `date-fns` operates in *local* time, so a date constructed from
 *   an ISO string can land on a different calendar day in the UI
 *   than on the server. For stored values (URL params, request
 *   bodies, database comparisons) we always want the wall-clock day
 *   the user picked, not "the local midnight of that day in their
 *   browser". The helpers below use `Date.UTC()` directly.
 *
 * All exported helpers are pure and safe to call outside React.
 */

// ─── Type guards ───────────────────────────────────────────────────────

/** Narrow `unknown` / `Date | null` to a concrete valid Date. */
export function isValidDate(value: unknown): value is Date {
    return value instanceof Date && !Number.isNaN(value.getTime());
}

// ─── Serialisation — `YYYY-MM-DD` wire format ─────────────────────────

/**
 * Format a Date as `YYYY-MM-DD`, reading the **UTC** calendar fields.
 * Matches the native `<input type="date">` wire format the product
 * already uses, and the format consumed by the list-endpoint `q=`
 * URL params.
 *
 * Returns `null` for nullish / invalid input so callers can pipe
 * optional values through without a pre-check.
 */
export function toYMD(value: Date | null | undefined): string | null {
    if (!value || !isValidDate(value)) return null;
    const y = value.getUTCFullYear().toString().padStart(4, '0');
    const m = (value.getUTCMonth() + 1).toString().padStart(2, '0');
    const d = value.getUTCDate().toString().padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Parse a `YYYY-MM-DD` string into a UTC-midnight Date.
 * Accepts any ISO-like prefix (`2026-04-21T13:00Z`) and truncates to
 * the date portion. Returns `null` for empty / malformed input.
 */
export function parseYMD(input: string | null | undefined): Date | null {
    if (!input) return null;
    const trimmed = String(input).trim();
    if (trimmed.length < 10) return null;
    const match = trimmed.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(Date.UTC(year, month - 1, day));
    // Reject values like 2026-02-30 that `Date.UTC` silently rolls over.
    if (
        d.getUTCFullYear() !== year ||
        d.getUTCMonth() !== month - 1 ||
        d.getUTCDate() !== day
    ) {
        return null;
    }
    return d;
}

// ─── UTC-anchored day operations ──────────────────────────────────────

/**
 * Truncate a Date to the start of its UTC day (00:00:00.000 UTC).
 * Use this whenever you need a stable day-key for comparisons or
 * when handing a Date to a component that treats "the same day" as
 * equality.
 */
/**
 * A `YYYY-MM-DD` day as the RFC 3339 instant the API expects.
 *
 * Every date input in the app is the same `DatePicker`, and its `onChange`
 * stores `toYMD(next)` — a bare day. Some submit handlers then posted that
 * string raw while others called `.toISOString()` first, so one request field
 * received two different shapes depending on which form you used (#1443).
 *
 * The request schemas now declare and ENFORCE `format: date-time`, so the
 * conversion has to happen on the way out. This composes it from `parseYMD`
 * rather than `new Date(input)` on purpose: `parseYMD` rejects a rolled-over
 * date like `2026-02-30`, which `new Date` would silently accept as March 2nd,
 * and it already returns UTC midnight — the instant the server has been
 * storing for these values all along. So this changes the wire format without
 * changing any stored value.
 *
 * Returns `null` for empty or malformed input so callers can pass an optional
 * field straight through.
 */
export function ymdToInstant(input: string | null | undefined): string | null {
    const day = parseYMD(input);
    return day ? day.toISOString() : null;
}

export function startOfUtcDay(date: Date): Date {
    return new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
}

/** End of the UTC day (23:59:59.999 UTC). */
export function endOfUtcDay(date: Date): Date {
    return new Date(
        Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate(),
            23,
            59,
            59,
            999,
        ),
    );
}

/** `a` and `b` fall on the same UTC calendar day. */
export function isSameUtcDay(a: Date, b: Date): boolean {
    return (
        a.getUTCFullYear() === b.getUTCFullYear() &&
        a.getUTCMonth() === b.getUTCMonth() &&
        a.getUTCDate() === b.getUTCDate()
    );
}

/** `a` is strictly before `b`. */
export function isBefore(a: Date, b: Date): boolean {
    return a.getTime() < b.getTime();
}

/** `a` is strictly after `b`. */
export function isAfter(a: Date, b: Date): boolean {
    return a.getTime() > b.getTime();
}

/**
 * Add `days` UTC days to a date without drifting across daylight-saving
 * boundaries the way `new Date(d.getTime() + days * 86400e3)` would in
 * some locales.
 */
export function addUtcDays(date: Date, days: number): Date {
    return new Date(
        Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate() + days,
        ),
    );
}

/**
 * Clamp `date` into the `[min, max]` interval. Either bound may be
 * omitted; both omitted returns the original date.
 */
export function clampDate(
    date: Date,
    bounds: { min?: Date | null; max?: Date | null } = {},
): Date {
    if (bounds.min && isBefore(date, bounds.min)) return bounds.min;
    if (bounds.max && isAfter(date, bounds.max)) return bounds.max;
    return date;
}

// ─── Range operations ─────────────────────────────────────────────────

import type {
    DatePreset,
    DateRange,
    DateRangePreset,
    DateRangeValue,
    DateValue,
    ResolvableDatePreset,
    ResolvableDateRangePreset,
} from './types';

/**
 * Normalise a range so `from <= to`. Swaps if inverted; passes
 * through if either side is `null`. Never throws on invalid input —
 * the picker UIs use this on intermediate in-progress selections.
 */
export function normalizeRange(range: DateRangeValue): DateRangeValue {
    const { from, to } = range;
    if (!from || !to) return { from, to };
    if (isAfter(from, to)) return { from: to, to: from };
    return { from, to };
}

/** `date` sits within `[from, to]` inclusive, UTC-day-precision. */
export function isDateInRange(
    date: DateValue,
    range: DateRangeValue,
): boolean {
    if (!date) return false;
    const { from, to } = normalizeRange(range);
    if (!from && !to) return true;
    const d = startOfUtcDay(date).getTime();
    if (from && d < startOfUtcDay(from).getTime()) return false;
    if (to && d > startOfUtcDay(to).getTime()) return false;
    return true;
}

/** `a` and `b` cover exactly the same UTC days (null-tolerant). */
export function isRangeEqual(a: DateRangeValue, b: DateRangeValue): boolean {
    const na = normalizeRange(a);
    const nb = normalizeRange(b);
    return (
        sameDayOrBothNull(na.from, nb.from) &&
        sameDayOrBothNull(na.to, nb.to)
    );
}

function sameDayOrBothNull(a: DateValue, b: DateValue): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return isSameUtcDay(a, b);
}

// ─── `YYYY-MM-DD` range serialisation ─────────────────────────────────

/**
 * Serialise a range as `"YYYY-MM-DD|YYYY-MM-DD"` — the pipe-delimited
 * format the list filters already use for range tokens (see
 * `src/components/ui/filter/filter-range-utils.ts`). Either side may
 * be empty: `"2026-01-01|"`, `"|2026-03-31"`, `"|"`.
 */
export function toRangeToken(range: DateRangeValue): string {
    const from = toYMD(range.from) ?? '';
    const to = toYMD(range.to) ?? '';
    return `${from}|${to}`;
}

export function parseRangeToken(token: string | null | undefined): DateRangeValue {
    if (!token) return { from: null, to: null };
    const [rawFrom = '', rawTo = ''] = String(token).split('|');
    return {
        from: parseYMD(rawFrom),
        to: parseYMD(rawTo),
    };
}

// ─── DateRange ↔ DateRangeValue bridging ──────────────────────────────

/**
 * Re-anchor a local-midnight Date (the shape react-day-picker emits
 * on click) to a UTC-midnight Date with the SAME calendar Y/M/D.
 * This is the same fix `<DatePicker>` applies inside its own
 * single-day handler — without it, a click on May 24 in a negative
 * timezone gets stored as May 23 once `toYMD(getUTCDate(...))` reads
 * UTC components.
 */
function localMidnightToUtcMidnight(d: Date | null | undefined): Date | null {
    if (!d) return null;
    return new Date(
        Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()),
    );
}

/**
 * Inverse: take a UTC-midnight Date from app state and produce a
 * local-midnight Date with the SAME calendar Y/M/D, so RDP
 * highlights the day the user (or the URL) intended.
 */
function utcMidnightToLocalMidnight(d: Date | null | undefined): Date | undefined {
    if (!d) return undefined;
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Convert the react-day-picker `DateRange` shape (undefined-biased)
 * to our domain `DateRangeValue` (null-biased). Use at the boundary
 * where a calendar selection hands off to application state. The
 * incoming Dates are RDP's local-midnight values — re-anchor to
 * UTC-midnight so downstream `getUTCDate()` reads the day the user
 * clicked (calendar TZ-offset bug fix).
 */
export function toDateRangeValue(range: DateRange | undefined): DateRangeValue {
    if (!range) return { from: null, to: null };
    return {
        from: localMidnightToUtcMidnight(range.from),
        to: localMidnightToUtcMidnight(range.to),
    };
}

/**
 * Inverse of {@link toDateRangeValue} — hand a `DateRangeValue`
 * to react-day-picker's matcher/range machinery. RDP works in
 * local time; bridge UTC-midnight Y/M/D to local-midnight Y/M/D so
 * the highlighted day matches application state regardless of tz.
 */
export function fromDateRangeValue(range: DateRangeValue): DateRange {
    return {
        from: utcMidnightToLocalMidnight(range.from),
        to: utcMidnightToLocalMidnight(range.to),
    };
}

// ─── Preset materialisation ───────────────────────────────────────────

/**
 * Turn a resolvable single-date preset into the concrete legacy
 * shape the vendored picker renderer consumes. Pure — `now` is
 * always passed in.
 */
export function materializeDatePreset(
    preset: ResolvableDatePreset,
    now: Date,
): DatePreset {
    const resolved = preset.resolve(now);
    return {
        id: preset.id,
        label: preset.label,
        shortcut: preset.shortcut,
        tooltipContent: preset.tooltipContent,
        // The legacy renderer reads `.date`. Guarantee a Date on
        // output; callers that might resolve to `null` should filter
        // before materialising.
        date: resolved ?? now,
    };
}

/**
 * Turn a resolvable range preset into the concrete legacy shape. The
 * vendored renderer expects react-day-picker's `DateRange`
 * (`undefined`-biased), so the bridging happens here.
 */
export function materializeDateRangePreset(
    preset: ResolvableDateRangePreset,
    now: Date,
): DateRangePreset {
    const resolved = preset.resolve(now);
    return {
        id: preset.id,
        label: preset.label,
        shortcut: preset.shortcut,
        tooltipContent: preset.tooltipContent,
        dateRange: fromDateRangeValue(resolved),
    };
}

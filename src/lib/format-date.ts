/**
 * format-date.ts — Canonical Date Formatting Utilities (Epic 58)
 *
 * Every date rendered in the UI, emitted from a server route, or
 * written to a PDF MUST go through these helpers. This is the
 * single-source-of-truth date-formatting surface; there is no
 * second canonical module.
 *
 * WHY THIS EXISTS
 * ───────────────
 * React SSR hydration mismatches occur when the server locale differs
 * from the browser locale. For example, a Windows server configured
 * to Bulgarian renders dates as "16.04.2026 г., 11:04:57 ч." while
 * the browser renders "4/16/2026, 11:04:57 AM" — causing a React
 * hydration warning and a flash of incorrect content. Server-side
 * PDFs suffer the same drift across deploy regions.
 *
 * FIX
 * ───
 * Hardcode locale to `en-GB` and timezone to `UTC` on every
 * Intl.DateTimeFormat instance in this file so server and client
 * always produce identical output regardless of OS or browser
 * settings.
 *
 * PICK-A-HELPER DECISION TREE
 * ───────────────────────────
 *   formatDate         → "16 Apr 2026"                       (default — tables, detail chrome, filter pills)
 *   formatDateTime     → "16 Apr 2026, 08:00"                 (activity rows, audit events, modal detail)
 *   formatDateTimeLong → "Thursday, 16 April 2026 at 08:00:45" (PDF metadata, audit receipts — weekday + seconds)
 *   formatDateShort    → "16/04/2026"                         (compact headers, dense tables)
 *   formatDateLong     → "16 April 2026"                      (formal docs, legal-style layouts)
 *   formatDateCompact  → "16 Apr"                             (chart axes, mini-calendars — year is context)
 *   formatDateRange    → adaptive (see the function's docblock) (all range chrome — pickers, filters, legends)
 *   formatRelativeTime → "2 hours ago" / "in 3 days"           (Epic 63 — the underlying helper for <TimestampTooltip>)
 *
 * RELATIVE-TIME RENDERING (Epic 63)
 * ─────────────────────────────────
 * For "X ago" / "in X" cells in lists and tables, do NOT call
 * `formatRelativeTime` from JSX directly. Use
 * `<TimestampTooltip date={…}>` from `@/components/ui/timestamp-tooltip`
 * instead — it pairs the relative phrasing with an exact-timestamp
 * tooltip and is hydration-safe (the component handles the
 * `useHydratedNow()` dance internally). The structural ratchet at
 * `tests/guards/epic63-timestamp-rollout.test.ts` enforces this on
 * the five primary list pages (Evidence, Policies, Tasks, Vendors,
 * Risks).
 *
 * WHAT YOU MUST NOT DO
 * ────────────────────
 *   - Call `.toLocaleDateString()` / `.toLocaleString()` /
 *     `.toLocaleTimeString()` on a Date in app or component code —
 *     the date-display-consistency ratchet catches this in CI.
 *   - Use `new Date(…).toISOString().split('T')[0]` for YMD — that's
 *     a timezone foot-gun. Use `toYMD(date)` from
 *     `@/components/ui/date-picker/date-utils` instead.
 *   - Build a range string with a literal ` - ` or ` – ` separator —
 *     call `formatDateRange(from, to)` so endpoints adapt to same-
 *     month / same-year / different-years semantics.
 *   - Add a SECOND canonical formatter module. If a new variant is
 *     genuinely needed, extend this file — don't stand up a parallel
 *     surface. The dub-utils-era helpers `formatDateSmart`,
 *     `formatDateTimeSmart`, `timeAgo`, `formatPeriod`, `parseDateTime`,
 *     `getDateTimeLocal`, `getDaysDifference`, `getFirstAndLastDay`
 *     were removed on 2026-04-22; don't resurrect them.
 *
 * USAGE
 * ─────
 *   import {
 *     formatDate,
 *     formatDateTime,
 *     formatDateTimeLong,
 *     formatDateShort,
 *     formatDateLong,
 *     formatDateCompact,
 *     formatDateRange,
 *   } from '@/lib/format-date';
 *
 *   formatDate('2026-04-16T08:00:00Z')     // → "16 Apr 2026"
 *   formatDateTime('2026-04-16T08:00:00Z') // → "16 Apr 2026, 08:00"
 *   formatDateShort('2026-04-16T08:00:00Z') // → "16/04/2026"
 */

const LOCALE = 'en-GB';

/**
 * The zone every helper here renders in.
 *
 * ── why this is Europe/Sofia and not UTC ──
 *
 * It was UTC, and the reasoning in the header above is still right about the
 * HAZARD and was wrong about the FIX. The hazard is an AMBIENT zone: one
 * resolved from the host or browser, which differs between server and client
 * and produces a hydration mismatch. UTC avoided that by being explicit — and
 * so does any other named zone. "Explicit" is the property that matters;
 * "UTC" was one way to get it.
 *
 * Meanwhile UTC was wrong about the DATA. Every user of this product is a
 * Bulgarian farm, and a spray logged at 18:00 local rendered as 16:00. For a
 * journal entry that feeds re-entry intervals and pre-harvest windows, a
 * two-hour error in the displayed time is not cosmetic.
 *
 * Measured before changing it: a `@db.Date` column arrives from Postgres as
 * UTC midnight, and UTC midnight renders as the SAME calendar day in Sofia
 * (02:00 or 03:00) — including on both 2026 DST transition dates. So date-only
 * fields do not shift a day. A real `timestamptz` near midnight does shift,
 * which is correct: 23:30Z IS 01:30 the next day in Sofia.
 */
const DISPLAY_TIME_ZONE = 'Europe/Sofia';

/** Shared Intl.DateTimeFormat instances (created once, reused — fast). */
const DATE_FMT = new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: DISPLAY_TIME_ZONE,
});

const DATETIME_FMT = new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
});

const DATE_SHORT_FMT = new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: DISPLAY_TIME_ZONE,
});

const DATE_LONG_FMT = new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: DISPLAY_TIME_ZONE,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDate(value: string | Date | null | undefined): Date | null {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return isNaN(d.getTime()) ? null : d;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Format a date as "16 Apr 2026".
 * Returns the fallback string (default `'—'`) for null/invalid inputs.
 */
export function formatDate(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? DATE_FMT.format(d) : fallback;
}

/**
 * Format a date + time as "16 Apr 2026, 08:00".
 * Returns the fallback string (default `'—'`) for null/invalid inputs.
 */
export function formatDateTime(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? DATETIME_FMT.format(d) : fallback;
}

// Richer form for audit-quality timestamps (PDF metadata page,
// evidence-pack receipts): weekday + long month + seconds so the
// exact moment is preserved for downstream forensics. Locked to the
// same `en-GB` + `UTC` calendar as every other helper here so server
// and client produce identical strings regardless of host timezone.
const DATETIME_LONG_FMT = new Intl.DateTimeFormat(LOCALE, {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
});

/**
 * Format a date + time in long, audit-quality form —
 * "Thursday, 16 April 2026, 08:00:45". Use for PDF metadata pages,
 * evidence receipts, or any surface where the exact moment is
 * legally / operationally load-bearing. Returns the fallback string
 * (default `'—'`) for null/invalid inputs.
 */
export function formatDateTimeLong(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? DATETIME_LONG_FMT.format(d) : fallback;
}

// ─── Relative time (Epic 63) ─────────────────────────────────────────────────
//
// Centralised so every "2 hours ago" / "in 3 days" string in the UI
// goes through one helper. Wraps date-fns's `formatDistance` rather
// than `formatDistanceToNow` so the caller can pin "now" — this is
// what makes `<TimestampTooltip>` hydration-safe (the component
// passes the `useHydratedNow()` value as `now`).
//
// Both past and future dates supported via `addSuffix: true` —
// past becomes "X ago", future becomes "in X".
//
// Returns the fallback string (default `'—'`) when EITHER `value`
// or `now` is null / invalid; the visible text on a card with a
// missing date should not flash "less than a minute ago".

import { formatDistance } from 'date-fns';

export interface FormatRelativeTimeOptions {
    /** Show "less than a minute ago" instead of "less than a minute". Defaults to true. */
    addSuffix?: boolean;
    /** Round to seconds for sub-minute deltas. Defaults to true. */
    includeSeconds?: boolean;
}

export function formatRelativeTime(
    value: string | Date | null | undefined,
    now: Date | null | undefined,
    options: FormatRelativeTimeOptions = {},
    fallback = '—',
): string {
    const d = toDate(value);
    if (!d || !now) return fallback;
    return formatDistance(d, now, {
        addSuffix: options.addSuffix ?? true,
        includeSeconds: options.includeSeconds ?? true,
    });
}

/**
 * Format a date as "16/04/2026".
 * Returns the fallback string (default `'—'`) for null/invalid inputs.
 */
export function formatDateShort(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? DATE_SHORT_FMT.format(d) : fallback;
}

/**
 * Format a date as "16 April 2026".
 * Returns the fallback string (default `'—'`) for null/invalid inputs.
 */
export function formatDateLong(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? DATE_LONG_FMT.format(d) : fallback;
}

// ─── Compact + range formatters (Epic 58) ────────────────────────────────────

const DATE_COMPACT_FMT = new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric',
    month: 'short',
    timeZone: DISPLAY_TIME_ZONE,
});

const MONTH_FMT = new Intl.DateTimeFormat(LOCALE, {
    month: 'short',
    timeZone: DISPLAY_TIME_ZONE,
});

/**
 * Compact day + month, no year — "16 Apr". Use for chart axes,
 * mini-calendars, and anywhere the calendar context already implies
 * the year. Returns the fallback (default `'—'`) for nullish input.
 */
export function formatDateCompact(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? DATE_COMPACT_FMT.format(d) : fallback;
}

/**
 * Canonical date-range formatter. Adapts to the kind of range:
 *
 *   { from: 16 Apr, to: 16 Apr }       →  "16 Apr 2026"           (single day)
 *   { from: 16 Apr, to: 30 Apr }       →  "16 – 30 Apr 2026"      (same month)
 *   { from: 16 Apr, to: 30 Jun }       →  "16 Apr – 30 Jun 2026"  (same year)
 *   { from: 16 Apr 2025, to: 30 Jun }  →  "16 Apr 2025 – 30 Jun 2026"
 *   { from: 16 Apr, to: null }          →  "From 16 Apr 2026"
 *   { from: null, to: 30 Apr }          →  "Until 30 Apr 2026"
 *   { from: null, to: null }            →  fallback (default '—')
 *
 * The em-dash (U+2013) separator and the UTC calendar fields match the
 * rest of the date helpers. Use everywhere a range is surfaced in chrome
 * — picker triggers, filter pills, audit-cycle detail, reports legends.
 */
export function formatDateRange(
    from: string | Date | null | undefined,
    to: string | Date | null | undefined,
    fallback = '—',
): string {
    const fromD = toDate(from);
    const toD = toDate(to);

    if (!fromD && !toD) return fallback;
    if (fromD && !toD) return `From ${DATE_FMT.format(fromD)}`;
    if (!fromD && toD) return `Until ${DATE_FMT.format(toD)}`;

    // TS narrowing — both non-null here.
    const a = fromD as Date;
    const b = toD as Date;

    const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
    const sameMonth = sameYear && a.getUTCMonth() === b.getUTCMonth();
    const sameDay = sameMonth && a.getUTCDate() === b.getUTCDate();

    if (sameDay) return DATE_FMT.format(a);

    if (sameMonth) {
        // "16 – 30 Apr 2026"
        return `${a.getUTCDate()} – ${DATE_FMT.format(b)}`;
    }

    if (sameYear) {
        // "16 Apr – 30 Jun 2026": drop the year on the left endpoint.
        const leftNoYear = `${a.getUTCDate()} ${MONTH_FMT.format(a)}`;
        return `${leftNoYear} – ${DATE_FMT.format(b)}`;
    }

    // Different years — both endpoints carry their year.
    return `${DATE_FMT.format(a)} – ${DATE_FMT.format(b)}`;
}

// ─── Bulgarian chat time + quantities (P2.1) ─────────────────────────────────

/**
 * The calendar day an instant falls on, IN THE DISPLAY ZONE.
 *
 * `en-CA` because it yields `YYYY-MM-DD`, which compares as a string. Doing
 * this with `getDate()` would ask the HOST's zone and give the wrong answer on
 * a server running UTC — the same ambient-zone hazard the header describes,
 * one level down.
 */
const DAY_KEY_FMT = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
});

/** `HH:mm` in the display zone, 24-hour — the form Bulgarian users expect. */
const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: DISPLAY_TIME_ZONE,
});

/**
 * Relative phrasing for a chat or feed timestamp.
 *
 * ── why Intl.RelativeTimeFormat and not date-fns ──
 *
 * `formatRelativeTime` above calls date-fns `formatDistance`, which renders
 * ENGLISH regardless of the user's language — "2 hours ago" to a Bulgarian
 * farmer. Fixing that with date-fns means importing and switching locale
 * bundles; `Intl` already ships the data.
 *
 * It also writes the copy for us, which is the part that matters for the
 * `no-hardcoded-ui-strings` ratchet: with `numeric: 'auto'` and
 * `style: 'short'`, `bg` yields «преди 5 мин», «вчера», «преди 3 ч», and even
 * «онзи ден» / «вдругиден». Hand-writing those would have put Cyrillic UI copy
 * in a .ts file, which the ratchet refuses — correctly, because then it could
 * never be translated.
 */
function relative(locale: string, value: number, unit: Intl.RelativeTimeFormatUnit): string {
    return new Intl.RelativeTimeFormat(locale, {
        numeric: 'auto',
        style: 'short',
    }).format(value, unit);
}

/**
 * A chat/feed timestamp: «преди 5 мин», «вчера, 14:20», «15.01.2026, 14:20».
 *
 * `now` is a REQUIRED argument rather than a `new Date()` inside, for the
 * reason `formatRelativeTime` already takes it: a relative string computed on
 * the server and re-computed on the client is a hydration mismatch by
 * construction. The caller owns the clock — on the client that is
 * `useHydratedNow()`, which is why `<TimestampTooltip>` exists.
 */
export function formatChatTime(
    value: string | Date | null | undefined,
    now: Date | null | undefined,
    locale = 'bg',
    fallback = '—',
): string {
    const d = toDate(value);
    if (!d || !now) return fallback;

    const deltaMs = now.getTime() - d.getTime();
    const seconds = Math.round(deltaMs / 1000);

    // Future timestamps are possible (clock skew between a phone and the
    // server) and must not render as a huge "ago". Intl handles the sign.
    if (seconds > -60 && seconds < 60) return relative(locale, -seconds, 'second');
    const minutes = Math.round(seconds / 60);
    if (minutes > -60 && minutes < 60) return relative(locale, -minutes, 'minute');

    const today = DAY_KEY_FMT.format(now);
    const then = DAY_KEY_FMT.format(d);
    // Same calendar day in SOFIA — not "within 24 hours", which would call
    // 23:00 yesterday "today" at 01:00.
    if (today === then) return TIME_FMT.format(d);

    const yesterday = DAY_KEY_FMT.format(new Date(now.getTime() - 86_400_000));
    if (then === yesterday) return `${relative(locale, -1, 'day')}, ${TIME_FMT.format(d)}`;

    return `${DATE_SHORT_FMT.format(d)}, ${TIME_FMT.format(d)}`;
}

/**
 * A quantity with its unit: «1 234,5 т».
 *
 * ── two things Intl will not do, and the reasons they are not bugs ──
 *
 * 1. `useGrouping: 'always'` is REQUIRED. `bg` sets `minimumGroupingDigits: 2`,
 *    so a four-digit number groups only from 10000 by default — 1234.5 renders
 *    `1234,5`. The product shows tonnages in the low thousands constantly, so
 *    the separator is wanted there.
 *
 * 2. The unit is the CALLER's, from `t()`. `Intl.NumberFormat` rejects
 *    `tonne`, `metric-ton` AND `ton` outright (only `kilogram`/`gram` are in
 *    its sanctioned list, and they render Latin "kg"), so there is no way to
 *    get «т» out of Intl. Taking the translated string as an argument keeps
 *    this function pure and keeps the abbreviation in `messages/`, where it
 *    can be translated, instead of as Cyrillic in a .ts file.
 *
 * The separator between number and unit is U+00A0, a NO-BREAK space, so a
 * value never wraps away from its unit. Note bg's own group separator is also
 * U+00A0 — a test asserting a plain ASCII space passes nothing and the diff
 * looks identical, which is why the unit test spells the codepoints out.
 */
export function formatQuantity(
    value: number | null | undefined,
    unit?: string,
    locale = 'bg',
    options: { maximumFractionDigits?: number } = {},
    fallback = '—',
): string {
    if (value == null || !Number.isFinite(value)) return fallback;
    const n = new Intl.NumberFormat(locale, {
        useGrouping: 'always',
        maximumFractionDigits: options.maximumFractionDigits ?? 1,
    }).format(value);
    return unit ? `${n}\u00A0${unit}` : n;
}

/**
 * Epic 58 — consistency pass: tests for the new range + compact
 * formatters that round out the canonical date-display API
 * (`src/lib/format-date.ts`).
 *
 * These run under the node Jest project — the formatters are pure
 * `Intl.DateTimeFormat` wrappers, no DOM needed.
 */

import {
    formatDate,
    formatDateCompact,
    formatDateRange,
    formatDateTime,
} from '@/lib/format-date';

// Canonical helper — builds UTC-midnight Dates for deterministic
// comparisons, mirrors the `parseYMD` utility in the date-picker
// foundation. Keeps these tests independent of wall-clock timezones.
const d = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

describe('formatDateCompact', () => {
    it('formats as "16 Apr" (no year)', () => {
        expect(formatDateCompact(d('2026-04-16'))).toBe('16 Apr');
    });

    it('returns "—" on nullish input by default', () => {
        expect(formatDateCompact(null)).toBe('—');
        expect(formatDateCompact(undefined)).toBe('—');
        expect(formatDateCompact('')).toBe('—');
    });

    it('accepts a custom fallback', () => {
        expect(formatDateCompact(null, 'n/a')).toBe('n/a');
    });

    it('accepts ISO strings and resolves to the SOFIA day', () => {
        // Was `.toBe('16 Apr')` under the old UTC display zone, and the case
        // name said "the UTC day" — both now wrong rather than merely stale.
        // 23:59:59Z on 16 April is 02:59:59 on the 17th in Sofia (+3 in
        // April), so the 17th is the correct answer for a Bulgarian reader.
        expect(formatDateCompact('2026-04-16T23:59:59Z')).toBe('17 Apr');
        // And the same instant one hour earlier is still the 16th, which is
        // what makes the line above a boundary rather than an off-by-one.
        expect(formatDateCompact('2026-04-16T20:59:59Z')).toBe('16 Apr');
    });
});

describe('formatDateRange', () => {
    it('returns the fallback when both sides are empty', () => {
        expect(formatDateRange(null, null)).toBe('—');
        expect(formatDateRange(undefined, undefined, 'n/a')).toBe('n/a');
    });

    it('renders a same-day range as the single date', () => {
        expect(formatDateRange(d('2026-04-16'), d('2026-04-16'))).toBe('16 Apr 2026');
    });

    it('renders a same-month range with one month + year', () => {
        expect(formatDateRange(d('2026-04-16'), d('2026-04-30'))).toBe('16 – 30 Apr 2026');
    });

    it('renders a same-year range with one year', () => {
        expect(formatDateRange(d('2026-04-16'), d('2026-06-30'))).toBe(
            '16 Apr – 30 Jun 2026',
        );
    });

    it('renders a cross-year range with both years (2-digit day, matches the rest of the app)', () => {
        expect(formatDateRange(d('2025-12-20'), d('2026-01-05'))).toBe(
            '20 Dec 2025 – 05 Jan 2026',
        );
    });

    it('renders a from-only range as "From …"', () => {
        expect(formatDateRange(d('2026-04-16'), null)).toBe('From 16 Apr 2026');
    });

    it('renders a to-only range as "Until …"', () => {
        expect(formatDateRange(null, d('2026-04-30'))).toBe('Until 30 Apr 2026');
    });

    it('accepts string inputs (mirrors formatDate)', () => {
        expect(formatDateRange('2026-04-16T08:00Z', '2026-04-30T17:00Z')).toBe(
            '16 – 30 Apr 2026',
        );
    });

    it('collapses to one date only when both endpoints share a SOFIA day', () => {
        // This case previously asserted that 00:00Z–23:59Z on 16 April
        // collapses to the single date "16 Apr 2026", and its name said "the
        // same UTC day". Under the display zone those two instants are 03:00
        // on the 16th and 02:59 on the **17th** — two different days for the
        // reader — so collapsing them printed a single date while the range
        // genuinely spanned two days. The range comparison now asks the
        // display zone, and this is the case that proves it.
        expect(formatDateRange('2026-04-16T00:00Z', '2026-04-16T23:59Z')).toBe(
            '16 – 17 Apr 2026',
        );
        // Within one Sofia day it still collapses, which is what stops the
        // line above from being an off-by-one rather than a zone fix.
        expect(formatDateRange('2026-04-16T06:00Z', '2026-04-16T18:00Z')).toBe(
            '16 Apr 2026',
        );
    });

    it('passes through the em-dash separator, never a hyphen-minus', () => {
        const out = formatDateRange(d('2026-04-16'), d('2026-04-30'));
        expect(out.includes('–')).toBe(true); // U+2013
        expect(out.includes(' - ')).toBe(false); // avoid hyphen-minus
    });
});

describe('consistency — every formatter handles the same invalid-input set', () => {
    const bad: Array<string | null | undefined> = [null, undefined, '', 'not-a-date'];
    it.each(bad)('formatDate(%p) → fallback', (v) => {
        expect(formatDate(v)).toBe('—');
    });
    it.each(bad)('formatDateTime(%p) → fallback', (v) => {
        expect(formatDateTime(v)).toBe('—');
    });
    it.each(bad)('formatDateCompact(%p) → fallback', (v) => {
        expect(formatDateCompact(v)).toBe('—');
    });
    it.each(bad)('formatDateRange(%p, %p) → fallback', (v) => {
        expect(formatDateRange(v, v)).toBe('—');
    });
});

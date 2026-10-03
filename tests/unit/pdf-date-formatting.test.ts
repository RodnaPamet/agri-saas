/**
 * Epic 58 — PDF date formatting canonicalisation.
 *
 * The three PDF timestamp sites that previously used inline
 * `toLocaleDateString` / `toLocaleString` now delegate to the
 * canonical formatters in `@/lib/format-date`. This file asserts
 * the exact strings those formatters produce for a fixed UTC
 * instant, locking in:
 *
 *   1. Timezone stability — no more host-TZ drift between
 *      server regions.
 *   2. Locale stability — every string uses `en-GB` (dd Mon yyyy /
 *      dd/MM/yyyy), never falling back to the OS locale.
 *   3. Audit-quality readability — the metadata page keeps its
 *      richer weekday + seconds form; the cover page and header
 *      use their respective shorter canonical forms.
 */

import {
    formatDateTime,
    formatDateTimeLong,
    formatDateShort,
} from '@/lib/format-date';

// Anchor to a known UTC instant. 08:00:45 UTC on a Thursday so the
// long form's weekday assertion is testable.
const FIXED_INSTANT = '2026-04-16T08:00:45Z';

describe('Epic 58 — PDF date formatting', () => {
    describe('cover page "Generated:" label', () => {
        it('renders via formatDateTime — "16 Apr 2026, 11:00" (Sofia)', () => {
            // 08:00:45Z is 11:00 in Sofia (+3 in April). The PDF deliberately
            // carries LOCAL time: these documents are the БАБХ ДНЕВНИК and
            // farm receipts, read by a Bulgarian operator and an inspector,
            // and a "Generated" stamp two hours off the wall clock is a
            // defect in a regulatory record rather than a formatting detail.
            expect(formatDateTime(FIXED_INSTANT)).toBe('16 Apr 2026, 11:00');
        });

        it('is stable regardless of host timezone', () => {
            // Two Date objects constructed from the same UTC string
            // produce the same output; Intl.DateTimeFormat's `timeZone: 'UTC'`
            // bypasses the host clock entirely.
            const a = formatDateTime(new Date(FIXED_INSTANT));
            const b = formatDateTime(FIXED_INSTANT);
            expect(a).toBe(b);
        });
    });

    describe('metadata page "Generated At" label', () => {
        it('renders via formatDateTimeLong — weekday + long month + seconds', () => {
            // The richer form makes the exact moment of generation
            // legally legible: weekday + 4-digit year + seconds. The
            // " at " separator is en-GB's native output for mixed
            // date+time+seconds; we keep it rather than override the
            // locale's defaults.
            expect(formatDateTimeLong(FIXED_INSTANT)).toBe(
                'Thursday, 16 April 2026 at 11:00:45',
            );
        });

        it('includes seconds precision the short form drops', () => {
            // Evidence PDFs are audit artifacts — the metadata page
            // has to record sub-minute precision so two generations
            // ten seconds apart aren't indistinguishable.
            const early = formatDateTimeLong('2026-04-16T08:00:05Z');
            const late = formatDateTimeLong('2026-04-16T08:00:55Z');
            expect(early).not.toBe(late);
            expect(early).toMatch(/11:00:05$/);
            expect(late).toMatch(/11:00:55$/);
        });
    });

    describe('page header date', () => {
        it('renders via formatDateShort — "16/04/2026"', () => {
            expect(formatDateShort(FIXED_INSTANT)).toBe('16/04/2026');
        });

        it('is DD/MM/YYYY (en-GB) — never MM/DD/YYYY', () => {
            // Lock the ordering so a future locale flip can't silently
            // swap day and month. 05/12 must mean 5 December, not 12 May.
            expect(formatDateShort('2026-12-05T00:00:00Z')).toBe('05/12/2026');
        });
    });

    describe('null / invalid input handling', () => {
        it('falls back to em-dash by default', () => {
            expect(formatDateTime(null)).toBe('—');
            expect(formatDateTimeLong(undefined)).toBe('—');
            expect(formatDateShort('not-a-date')).toBe('—');
        });

        it('honours a caller-supplied fallback', () => {
            expect(formatDateTime(null, 'Never')).toBe('Never');
            expect(formatDateTimeLong(null, 'n/a')).toBe('n/a');
            expect(formatDateShort(null, '—')).toBe('—');
        });
    });
});

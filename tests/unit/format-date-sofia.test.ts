/**
 * The display zone is Europe/Sofia, and Bulgarian chat/quantity formatting.
 *
 * ── the control comes first, deliberately ──
 *
 * Almost every assertion below would also pass on the old UTC build if it
 * happened to pick a time of day where the two agree. So the first case proves
 * the zone actually moved, and every later case uses a time where UTC and
 * Sofia DISAGREE. A suite that silently drifted back to UTC must fail here
 * rather than report green over the thing it was written to protect.
 */
import {
    formatDate,
    formatDateTime,
    formatDateShort,
    formatChatTime,
    formatQuantity,
} from '@/lib/format-date';

describe('the display zone is Europe/Sofia, not UTC', () => {
    it('CONTROL: a time where UTC and Sofia disagree renders as Sofia', () => {
        // 22:30Z on 15 Jan is 00:30 on 16 Jan in Sofia (UTC+2 in winter).
        // Under the old UTC build this was "15 Jan 2026, 22:30".
        const at = '2026-01-15T22:30:00Z';
        expect(formatDateTime(at)).toContain('16 Jan 2026');
        expect(formatDateTime(at)).toContain('00:30');
        expect(formatDateTime(at)).not.toContain('22:30');
    });

    it('winter is UTC+2 and summer is UTC+3 — the offset is not a constant', () => {
        // If someone replaced the zone with a fixed +02:00 offset, this fails.
        expect(formatDateTime('2026-01-15T12:00:00Z')).toContain('14:00'); // +2
        expect(formatDateTime('2026-07-15T12:00:00Z')).toContain('15:00'); // +3
    });

    it.each([
        ['2026-03-29T00:30:00Z', 'before spring forward', '02:30'],
        ['2026-03-29T01:30:00Z', 'after spring forward', '04:30'],
        ['2026-10-25T00:30:00Z', 'before autumn back', '03:30'],
    ])('%s (%s) lands on the correct side of the transition', (iso, _label, expected) => {
        // The 2026 EU transitions are both at 01:00 UTC. BEFORE spring forward
        // the offset is still +2, and before autumn back it is still +3 — I
        // wrote both backwards first time and the measurement corrected me,
        // which is the case for pinning them rather than re-deriving each time.
        expect(formatDateTime(iso)).toContain(expected);
    });

    it('the autumn transition REPEATS an hour, and both instants render alike', () => {
        // 00:30Z (+3, pre-transition) and 01:30Z (+2, post) are an hour apart
        // and both read 03:30 in Sofia. Two distinct instants, one wall-clock
        // time — so a Sofia-local timestamp is NOT a unique key on that date,
        // and anything ordering or deduplicating by DISPLAYED time is wrong
        // once a year. Nothing here depends on it; the case exists so the next
        // reader meets the fact before assuming otherwise.
        expect(formatDateTime('2026-10-25T00:30:00Z')).toContain('03:30');
        expect(formatDateTime('2026-10-25T01:30:00Z')).toContain('03:30');
        expect(new Date('2026-10-25T00:30:00Z').getTime()).not.toBe(
            new Date('2026-10-25T01:30:00Z').getTime(),
        );
    });

    it('a @db.Date value (UTC midnight) keeps its calendar day', () => {
        // Measured against the live driver: Postgres `date` columns arrive as
        // UTC midnight. Rendering those in Sofia must NOT move them a day, or
        // every observation date in the product shifts.
        for (const day of ['2026-01-15', '2026-03-29', '2026-10-25', '2026-12-31']) {
            expect(formatDateShort(`${day}T00:00:00Z`)).toBe(
                day.split('-').reverse().join('/'),
            );
        }
    });

    it('a timestamp just before Sofia midnight does NOT roll into tomorrow', () => {
        // 21:59Z = 23:59 Sofia, still the 15th. One minute later it is the 16th.
        expect(formatDate('2026-01-15T21:59:00Z')).toBe('15 Jan 2026');
        expect(formatDate('2026-01-15T22:01:00Z')).toBe('16 Jan 2026');
    });
});

describe('formatChatTime — Bulgarian, from Intl rather than hand-written copy', () => {
    const now = new Date('2026-01-15T12:00:00Z'); // 14:00 Sofia

    it('renders «преди 5 мин» for a recent message', () => {
        expect(formatChatTime(new Date(now.getTime() - 5 * 60_000), now)).toBe('преди 5 мин');
    });

    it('renders «вчера, HH:mm» for yesterday', () => {
        // 12:20Z on the 14th = 14:20 Sofia — the plan's own example.
        const out = formatChatTime('2026-01-14T12:20:00Z', now);
        expect(out).toBe('вчера, 14:20');
    });

    it('renders just the time for earlier the SAME Sofia day', () => {
        expect(formatChatTime('2026-01-15T06:00:00Z', now)).toBe('08:00');
    });

    it('a day boundary is a CALENDAR day, not a rolling 24 hours', () => {
        // 22:30Z on the 14th is 00:30 on the 15th in Sofia — under 24 hours
        // before `now`, but the SAME calendar day, so it must render as a time
        // and not as «вчера». A naive `delta < 86400e3` check gets this wrong.
        expect(formatChatTime('2026-01-14T22:30:00Z', now)).toBe('00:30');
    });

    it('stays RELATIVE for 2–6 days, which is what a 10px chip can hold', () => {
        // Was `.toBe('10/01/2026, 14:20')` — a full date AND time. The
        // notifications-bell suite failed on exactly that: these strings land
        // in a 10px chip and the case there exists to keep them short tokens
        // rather than raw dates. Intl gives «преди 5 дни» and «онзи ден».
        expect(formatChatTime('2026-01-10T12:20:00Z', now)).toBe('преди 5 дни');
        expect(formatChatTime('2026-01-13T12:20:00Z', now)).toBe('онзи ден');
    });

    it('collapses to a COMPACT date beyond a week — never a date plus a time', () => {
        // "20.12" — bg renders {day:'numeric', month:'short'} numerically,
        // not as «20 дек.» which is what I assumed. Measured.
        expect(formatChatTime('2025-12-20T12:20:00Z', now)).toBe('20.12');
        // en-GB for contrast, so the case shows the shape is locale-driven.
        expect(formatChatTime('2025-12-20T12:20:00Z', now, 'en-GB')).toBe('20 Dec');
    });

    it('a FUTURE timestamp (clock skew) does not render as a huge "ago"', () => {
        // A phone a few minutes ahead of the server is ordinary. Intl renders
        // the forward direction; what must not happen is a negative delta
        // becoming a large positive one.
        const out = formatChatTime(new Date(now.getTime() + 5 * 60_000), now);
        expect(out).not.toMatch(/преди/);
        expect(out).toMatch(/след|5/);
    });

    it('honours an explicit locale, so an English user is not shown Bulgarian', () => {
        const out = formatChatTime(new Date(now.getTime() - 5 * 60_000), now, 'en-GB');
        expect(out).toMatch(/min/);
        expect(out).not.toMatch(/преди/);
    });

    it('returns the fallback rather than throwing on bad input', () => {
        expect(formatChatTime(null, now)).toBe('—');
        expect(formatChatTime('not a date', now)).toBe('—');
        expect(formatChatTime(new Date(), null)).toBe('—');
    });
});

describe('formatQuantity — «1 234,5 т»', () => {
    it('groups thousands and uses a decimal comma', () => {
        expect(formatQuantity(1234.5, 'т')).toBe('1 234,5 т');
    });

    it('the separators are NO-BREAK spaces, spelled out by codepoint', () => {
        // Both separators are U+00A0 — bg's own group separator, and the one
        // this function puts before the unit. An assertion written with a
        // plain ASCII space fails while the diff looks identical, so the
        // codepoints are asserted directly rather than typed into a literal.
        const out = formatQuantity(1234.5, 'т');
        const codes = [...out].map((c) => c.codePointAt(0));
        expect(codes.filter((c) => c === 0x00a0)).toHaveLength(2);
        expect(codes).not.toContain(0x20); // no ASCII space anywhere
    });

    it('grouping is FORCED — bg would otherwise skip it at four digits', () => {
        // `minimumGroupingDigits: 2` in bg means 1234.5 renders "1234,5"
        // without `useGrouping: "always"`. This is the case that proves the
        // option is still set.
        expect(formatQuantity(1234.5)).toBe('1 234,5');
        expect(formatQuantity(999.5)).toBe('999,5'); // three digits: no group
        expect(formatQuantity(1234567.89)).toBe('1 234 567,9');
    });

    it('omits the separator when there is no unit', () => {
        expect(formatQuantity(42)).toBe('42');
    });

    it('respects an explicit precision', () => {
        // 1,235 not 1,234: Intl's default rounding is half-expand, so the
        // trailing 5 rounds away from zero. The measured value, not the one I
        // assumed — and the anchor for this very edit first failed because the
        // literal holds U+00A0, the trap this file's own codepoint case warns
        // about.
        expect(formatQuantity(1.2345, 'т', 'bg', { maximumFractionDigits: 3 })).toBe('1,235 т');
        expect(formatQuantity(1.2345, 'т', 'bg', { maximumFractionDigits: 0 })).toBe('1 т');
    });

    it('formats for en too, where the separators differ', () => {
        expect(formatQuantity(1234.5, 't', 'en-GB')).toBe('1,234.5 t');
    });

    it('returns the fallback for null, NaN and Infinity rather than printing them', () => {
        for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
            expect(formatQuantity(bad as number)).toBe('—');
        }
    });
});

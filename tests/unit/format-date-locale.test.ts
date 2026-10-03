/**
 * The locale-bound formatters: the `en` → `en-GB` mapping, and the «г.» rule.
 *
 * Both are decisions that would be invisible if they regressed — one flips
 * every English date to month-first, the other adds three characters to every
 * Bulgarian date cell. So each has a control that fails if the decision is
 * quietly undone.
 */
import {
    createDateFormatters,
    _resetFormatterCache,
    formatDateRange,
} from '@/lib/format-date';

const AT = '2026-04-16T08:00:45Z'; // 11:00:45 in Sofia (+3 in April)

beforeEach(() => _resetFormatterCache());

describe('`en` is mapped to en-GB, never passed through', () => {
    it('CONTROL: bare `en` really is US-formatted — the mapping is load-bearing', () => {
        // If this ever stops being true the mapping becomes redundant, and
        // the assertions below would pass for the wrong reason. Asserting the
        // premise directly is what keeps them meaningful.
        const bare = new Intl.DateTimeFormat('en', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            timeZone: 'Europe/Sofia',
        }).format(new Date(AT));
        expect(bare).toBe('04/16/2026'); // month FIRST
    });

    it('renders day-first dates for the `en` locale', () => {
        const f = createDateFormatters('en');
        expect(f.formatDate(AT)).toBe('16 Apr 2026');
        expect(f.formatDate(AT)).not.toBe('Apr 16, 2026');
    });

    it('renders an UNAMBIGUOUS short form — the half that actually matters', () => {
        // `04/16/2026` vs `16/04/2026` is not a style preference: for the
        // first twelve days of a month both parse, silently, as different
        // dates. This is the assertion to keep if any other is dropped.
        expect(createDateFormatters('en').formatDateShort(AT)).toBe('16/04/2026');
    });
});

describe('the Bulgarian «г.» is stripped in compact forms and kept in formal ones', () => {
    const f = () => createDateFormatters('bg');

    it.each([
        ['formatDate', (x: string) => f().formatDate(x)],
        ['formatDateTime', (x: string) => f().formatDateTime(x)],
        ['formatDateShort', (x: string) => f().formatDateShort(x)],
        ['formatDateCompact', (x: string) => f().formatDateCompact(x)],
    ])('%s drops it — these fill table cells and chart axes', (_name, fn) => {
        const out = fn(AT);
        expect(out).not.toMatch(/г\.\s*$/);
        expect(out).toMatch(/16/);
    });

    it.each([
        ['formatDateLong', (x: string) => f().formatDateLong(x)],
        ['formatDateTimeLong', (x: string) => f().formatDateTimeLong(x)],
    ])('%s keeps it — PDFs, the ДНЕВНИК and audit receipts read formally', (_name, fn) => {
        // CONTAINS, not ends-with: bg puts the marker mid-string in the long
        // datetime form — "четвъртък, 16 април 2026 г. в 11:00:45". The
        // property is that it is kept, not where CLDR places it.
        expect(fn(AT)).toContain('г.');
    });

    it('CONTROL: Intl really does emit «г.», so the strip is doing work', () => {
        // Without this, a build where CLDR stopped emitting the marker would
        // make every "drops it" case above pass vacuously.
        const raw = new Intl.DateTimeFormat('bg-BG', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            timeZone: 'Europe/Sofia',
        }).format(new Date(AT));
        expect(raw).toMatch(/г\.$/);
    });

    it('strips only a TRAILING marker, and tolerates a no-break space before it', () => {
        expect(f().formatDateShort(AT)).toBe('16.04.2026');
    });

    it('English is untouched by the rule — there is no marker to strip', () => {
        expect(createDateFormatters('en').formatDate(AT)).toBe('16 Apr 2026');
    });
});

describe('the per-locale cache is bounded by the type, not by eviction', () => {
    it('returns the same object for the same locale', () => {
        expect(createDateFormatters('bg')).toBe(createDateFormatters('bg'));
    });

    it('returns DIFFERENT objects for different locales', () => {
        expect(createDateFormatters('bg')).not.toBe(createDateFormatters('en'));
    });

    it('cannot grow past the locale union — the key is `Locale`, not a string', () => {
        // The reason this is safe on a server: there is no caller-supplied
        // string that can mint a third entry. A cache keyed on an arbitrary
        // tag would be an unbounded-growth hazard per request.
        for (let i = 0; i < 50; i++) {
            createDateFormatters(i % 2 ? 'bg' : 'en');
        }
        expect(createDateFormatters('bg')).toBe(createDateFormatters('bg'));
    });
});

describe('the bound chat and quantity helpers follow their locale', () => {
    const now = new Date('2026-01-15T12:00:00Z');

    it('bg gives Bulgarian, en gives English, from one call shape', () => {
        const five = new Date(now.getTime() - 5 * 60_000);
        expect(createDateFormatters('bg').formatChatTime(five, now)).toBe('преди 5 мин');
        expect(createDateFormatters('en').formatChatTime(five, now)).toMatch(/min/);
    });

    it('quantities carry each locale’s separators', () => {
        // The separators are written as explicit escapes, not typed. bg's
        // group separator AND the one before the unit are both U+00A0, so a
        // literal with ASCII spaces fails while looking byte-identical in the
        // diff and in the failure output — which has now cost me three
        // debugging detours in this one feature.
        expect(createDateFormatters('bg').formatQuantity(1234.5, 'т')).toBe(
            '1\u00A0234,5\u00A0т',
        );
        expect(createDateFormatters('en').formatQuantity(1234.5, 't')).toBe(
            '1,234.5\u00A0t',
        );
    });
});

describe('formatDateRange compares in the DISPLAY zone, not UTC', () => {
    it('does not collapse endpoints that fall on different Sofia days', () => {
        // The latent bug the zone change made reachable: these two instants
        // share a UTC day and do NOT share a Sofia day, so collapsing them
        // printed one date for a two-day range.
        expect(formatDateRange('2026-04-16T00:00Z', '2026-04-16T23:59Z')).toBe(
            '16 – 17 Apr 2026',
        );
    });

    it('still collapses within one Sofia day', () => {
        expect(formatDateRange('2026-04-16T06:00Z', '2026-04-16T18:00Z')).toBe('16 Apr 2026');
    });

    it('takes translated labels for the open-ended cases', () => {
        // «От»/«До» cannot come from Intl, so they are the caller's — the only
        // prose in this function.
        const labels = { from: 'От', until: 'До' };
        expect(formatDateRange('2026-04-16T08:00Z', null, { labels })).toMatch(/^От /);
        expect(formatDateRange(null, '2026-04-16T08:00Z', { labels })).toMatch(/^До /);
    });

    it('keeps the old string-fallback call shape working', () => {
        // 142 call sites exist; the signature had to stay backwards
        // compatible or this change would have been a rewrite of all of them.
        expect(formatDateRange(null, null, 'n/a')).toBe('n/a');
        expect(formatDateRange(null, null)).toBe('—');
    });
});

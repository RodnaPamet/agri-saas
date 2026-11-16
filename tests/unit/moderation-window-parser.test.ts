/**
 * `parseModerationWindow` + `withWindowVerdict` — #3010.
 *
 * The parser had NO direct unit coverage: it was exercised only through the two
 * route suites, which assert the NUMBER it resolves. That is what let the
 * silent fallback survive being covered four times — `toHaveBeenCalledWith(30)`
 * is equally true of a door that answers 30 silently and one that says so.
 *
 * The default is preserved deliberately (owner ruling 2026-11-16: keep it,
 * report it), so every fallback case below is a PIN rather than a wish.
 */
import {
    MODERATION_DEFAULT_WINDOW_DAYS,
    MODERATION_MAX_WINDOW_DAYS,
    parseModerationWindow,
    withWindowVerdict,
} from '@/lib/validation/query-params';

describe('parseModerationWindow', () => {
    it('reports NO fallback when the caller supplied nothing', () => {
        // The asymmetry that makes `true` mean something: a reader who asked
        // for no window cannot misread the default as a window they chose.
        expect(parseModerationWindow(null)).toEqual({
            windowDays: MODERATION_DEFAULT_WINDOW_DAYS,
            windowDefaulted: false,
        });
    });

    it.each([
        ['the floor', '1'],
        ['the default spelled out', '30'],
        ['the figure the old docblock wrongly called impossible', '90'],
        ['the ceiling', String(MODERATION_MAX_WINDOW_DAYS)],
    ])('honours %s in full', (_label, raw) => {
        // 90 is INSIDE 1..365, so it is honoured — the case the superseded
        // docblock used to illustrate the defect with. The real population is
        // below.
        expect(parseModerationWindow(raw)).toEqual({
            windowDays: Number(raw),
            windowDefaulted: false,
        });
    });

    it.each([
        ['over the ceiling', '400'],
        ['far over the ceiling', '100000'],
        ['zero', '0'],
        ['negative', '-30'],
        ['fractional', '30.5'],
        ['not a number', 'ninety'],
        ['supplied with no value', ''],
        ['whitespace', '   '],
        ['exponential, which Number() accepts', '1e3'],
    ])('falls back for %s AND flags it', (_label, raw) => {
        expect(parseModerationWindow(raw)).toEqual({
            windowDays: MODERATION_DEFAULT_WINDOW_DAYS,
            windowDefaulted: true,
        });
    });

    it('never answers outside the bound, whatever it is given', () => {
        // A property over the union of both populations, so a future edit
        // cannot widen the window by relaxing one arm of the check.
        for (const raw of [null, '', '0', '1', '365', '366', '-1', 'x', '2.5', '1e3']) {
            const { windowDays } = parseModerationWindow(raw);
            expect(windowDays).toBeGreaterThanOrEqual(1);
            expect(windowDays).toBeLessThanOrEqual(MODERATION_MAX_WINDOW_DAYS);
        }
    });
});

describe('withWindowVerdict', () => {
    it('adds the verdict without disturbing the figures', () => {
        const stats = { windowDays: 30, noticesByStatus: { RECEIVED: 2 }, nested: { n: 1 } };
        const out = withWindowVerdict(stats, { windowDays: 30, windowDefaulted: true });
        expect(out).toEqual({ ...stats, windowDefaulted: true });
        // The payload is the deliverable; the verdict is one field on it.
        expect(out.nested).toBe(stats.nested);
    });

    it('carries false through as false, not as an absent field', () => {
        // An ABSENT boolean reads as "this door does not report" rather than
        // "this window was honoured", and the two must not look alike on the
        // wire — `absence-reads-as-success`.
        const out = withWindowVerdict({ windowDays: 90 }, { windowDays: 90, windowDefaulted: false });
        expect(Object.keys(out)).toContain('windowDefaulted');
        expect(out.windowDefaulted).toBe(false);
    });

    it('does not mutate the payload it is given', () => {
        const stats = { windowDays: 30 };
        withWindowVerdict(stats, { windowDays: 30, windowDefaulted: true });
        expect(stats).toEqual({ windowDays: 30 });
    });
});

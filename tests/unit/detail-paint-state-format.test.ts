/**
 * The #1076 paint-wait diagnostic must be readable on a page that is falling
 * apart.
 *
 * `formatDetailPaintState` is the testable half of that diagnostic. Its
 * collector runs `page.evaluate` against a page that has just failed and
 * cannot be exercised without a built app and a server; this function is total
 * from a plain object to a string.
 *
 * Testing it matters more than it looks. A diagnostic that throws replaces the
 * real failure with its own and destroys the evidence it exists to gather —
 * the trap `describeListState` already records in its own docblock — and the
 * inputs here are collected from a tearing-down page, which is precisely when
 * fields go missing.
 */
import {
    formatDetailPaintState,
    type DetailPaintState,
} from '../e2e/detail-paint-state';

describe('formatDetailPaintState', () => {
    it('renders an EMPTY object without printing undefined', () => {
        // The case that matters most: a page detached before any read landed.
        // A formatter that interpolated raw fields would emit "undefined" six
        // times, which reads as a broken tool rather than as missing data.
        const out = formatDetailPaintState({});

        expect(out).not.toMatch(/undefined/);
        expect(out).not.toMatch(/\[object Object\]/);
        expect(out).toContain('url at failure : ?');
        // Every line is still present, so the shape of the block does not
        // change between a full and an empty read.
        expect(out.split('\n').length).toBeGreaterThanOrEqual(9);
    });

    it('distinguishes ABSENT from PRESENT-but-hidden', () => {
        // Two different bugs. `toBeVisible` separates them only by wording,
        // and the count is the fact that settles it.
        const absent = formatDetailPaintState({ contentCount: 0 });
        const hidden = formatDetailPaintState({ contentCount: 1 });

        expect(absent).toContain('ABSENT, not hidden');
        expect(hidden).toContain('PRESENT but not visible');
        // Not the same annotation on both, which is the whole point.
        expect(absent).not.toContain('PRESENT but not visible');
        expect(hidden).not.toContain('ABSENT, not hidden');
    });

    it('calls out a RELOAD, because that is the live hypothesis', () => {
        const reloaded = formatDetailPaintState({ navigationType: 'reload' });
        const navigated = formatDetailPaintState({ navigationType: 'navigate' });

        expect(reloaded).toContain('this document is a RELOAD');
        // And says nothing of the kind when the document arrived normally —
        // an annotation printed either way carries no information.
        expect(navigated).not.toContain('RELOAD');
        expect(navigated).toContain('navigationType : navigate');
    });

    it('says NONE rather than 0 when the route was never fetched', () => {
        // "no requests for this URL" and "I did not collect requests" are
        // different answers and the issue turns on which it is: the #1076
        // capture recorded 424 requests then zero network for 29.4s.
        const none = formatDetailPaintState({ detailRequests: [] });
        const unknown = formatDetailPaintState({});

        expect(none).toContain('requests for this URL: NONE');
        expect(none).toContain('changed the URL without fetching this route');
        expect(unknown).toContain('requests for this URL: ?');
        expect(unknown).not.toContain('NONE');
    });

    it('lists the requests it did find, newest-first order preserved, capped', () => {
        const many: DetailPaintState = {
            detailRequests: Array.from({ length: 9 }, (_, i) => ({
                name: `/assets/a-1?rsc=${i}`,
                ms: i * 10 + 0.4,
            })),
        };

        const out = formatDetailPaintState(many);

        expect(out).toContain('requests for this URL: 9');
        // Capped at 6 so one failure cannot flood a job log, and the cap is
        // asserted in both directions.
        expect(out).toContain('rsc=5');
        expect(out).not.toContain('rsc=6');
        // Durations rounded — a diagnostic reporting 0.4000000001ms is noise.
        expect(out).toContain('0ms');
        expect(out).not.toMatch(/\d\.\d+ms/);
    });

    it('reports booleans as words and nothing-rendered as a flag', () => {
        const out = formatDetailPaintState({
            swControlled: true,
            nextErrorOverlay: false,
            bodyTextLength: 0,
        });

        expect(out).toContain('SW controlling : yes');
        expect(out).toContain('next error overlay: no');
        expect(out).toContain('nothing rendered at all');

        // `null` is a THIRD state here — the page has no serviceWorker API at
        // all — and must not collapse into "no", which would assert something
        // untrue about the page.
        expect(formatDetailPaintState({ swControlled: null })).toContain('SW controlling : ?');
        // And a non-zero body length carries no flag.
        expect(formatDetailPaintState({ bodyTextLength: 12 })).not.toContain('nothing rendered');
    });

    it('prints the h1 text, or says none', () => {
        expect(formatDetailPaintState({ h1: ['Трактор John Deere'] })).toContain(
            'Трактор John Deere',
        );
        expect(formatDetailPaintState({ h1: [] })).toContain('(none)');
    });
});

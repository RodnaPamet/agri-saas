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

    it('separates "nothing was aborted" from "nobody collected aborts"', () => {
        // The distinction that makes the field worth having. #1862's live
        // hypothesis is that the destination's flight request is ABORTED and
        // the App Router rolls the URL back — so "NONE" refutes it and "?"
        // means the next occurrence will not answer it either.
        //
        // It cannot come from inside the page: a Resource Timing entry is
        // created on response end, so an aborted fetch leaves none.
        const none = formatDetailPaintState({ failedRequests: [] });
        const some = formatDetailPaintState({
            failedRequests: ['GET /t/acme/assets/abc?_rsc=x — net::ERR_ABORTED'],
        });
        const unknown = formatDetailPaintState({});

        expect(none).toContain('failed/aborted requests: NONE');
        expect(none).toContain('a dropped flight request is NOT the cause');
        expect(some).toContain('failed/aborted requests: 1');
        expect(some).toContain('net::ERR_ABORTED');
        expect(unknown).toContain('failed/aborted requests: ?');
    });

    it('prints the EXPECTED url, because the one at failure is the wrong page', () => {
        // `detailRequests` is filtered on `location.pathname` read at failure
        // time, and the measured failure has the URL back on the LIST. So
        // "requests for this URL" is about the page the test navigated AWAY
        // from, and without the expected URL beside it the report cannot say
        // whether the destination was ever fetched.
        const s = formatDetailPaintState({
            url: 'http://localhost:3006/t/acme/assets',
            expectedUrl: '**/t/acme/assets/abc',
        });
        expect(s).toContain('expected url   : **/t/acme/assets/abc');
        expect(s).toContain('what the wait was FOR');
        // And absent when not supplied, rather than printing a bare label.
        expect(formatDetailPaintState({})).not.toContain('expected url');
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

    it('keeps the MOST RECENT requests, which is the end the failure is at', () => {
        // This test replaces one named "newest-first order preserved, capped"
        // that asserted the opposite: with nine oldest-first entries it
        // required `rsc=5` present and `rsc=6` absent, i.e. it pinned the
        // OLDEST six and dropped the three closest to the failure — under a
        // name claiming the newest were kept, and a comment claiming the cap
        // was "asserted in both directions".
        //
        // The cap genuinely was asserted in both directions. It was asserted
        // at the wrong END, so the diagnostic withheld the navigation's own
        // RSC fetch while reporting a count that read as the whole list.
        const many: DetailPaintState = {
            detailRequests: Array.from({ length: 15 }, (_, i) => ({
                name: `/assets/a-1?rsc=${i}`,
                ms: i * 10 + 0.4,
            })),
        };

        const out = formatDetailPaintState(many);

        expect(out).toContain('requests for this URL: 15');
        // The newest must survive: it is the one that says whether the route
        // this URL names was fetched at all before the wait expired.
        expect(out).toContain('rsc=14');
        expect(out).toContain('rsc=3');
        // And the oldest are what gets dropped, not the newest.
        expect(out).not.toContain('rsc=0?');
        for (const dropped of ['rsc=0\n', 'rsc=1\n', 'rsc=2\n']) {
            expect(out).not.toContain(dropped);
        }
        // The omission is NAMED. A bare count beside a truncated list reads as
        // the whole list, which is how the old cap went unnoticed.
        expect(out).toContain('3 earlier request(s) not shown');
        // Durations rounded — a diagnostic reporting 0.4000000001ms is noise.
        expect(out).toContain('0ms');
        expect(out).not.toMatch(/\d\.\d+ms/);
    });

    it('prints every request when there are fewer than the cap, and says nothing about omission', () => {
        // The real failure that prompted this (run 38700294675) had EIGHT
        // requests and a cap of six, so the header said 8 and the body showed
        // 6. Under the new cap that case prints in full — and must not grow a
        // spurious "0 earlier requests not shown" line, which would be a
        // different kind of lie about the same data.
        const out = formatDetailPaintState({
            detailRequests: Array.from({ length: 8 }, (_, i) => ({
                name: `/assets/a-1?rsc=${i}`,
                ms: i * 10,
            })),
        });

        expect(out).toContain('requests for this URL: 8');
        for (let i = 0; i < 8; i++) {
            expect(out).toContain(`rsc=${i}`);
        }
        expect(out).not.toContain('not shown');
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

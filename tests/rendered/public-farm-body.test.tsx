/**
 * The public farm page's images, rendered — #2251.
 *
 * ## Why this is a rendered test and not a source grep
 *
 * The claim is about what the BROWSER is told. A grep for `fetchPriority`
 * matches this component's explanatory prose as readily as an attribute — it
 * names the string four times in comments and zero times in code — so a source
 * assertion here would pass on the paragraphs after the attribute was removed,
 * and would pass on the paragraphs if someone added it back. Reading the DOM
 * cannot do either.
 *
 * ## What is pinned, and why the shape is "nothing claims it"
 *
 * The LCP element on `/f/{handle}` is a gallery thumbnail, not the logo:
 * 175x131 against 96x96, measured in 20 of 20 Lighthouse runs across four
 * jobs. The logo used to carry `fetchPriority="high"` on the stated reasoning
 * that it was "the likeliest LCP element", which was false.
 *
 * The obvious repair — move the hint to the first thumbnail — was built,
 * merged and MEASURED, and it does nothing:
 *
 *   - Chrome already assigns every media request on this page `High`. From the
 *     network records: 7 requests, `High` x7, before any hint existed.
 *   - Two Lighthouse jobs with the hint gave LCP medians of 3414 ms and
 *     3421 ms, against 3365 ms and 3331 ms without it, and the ~4,180 ms upper
 *     mode still appeared (4194 ms).
 *
 * The ~395 ms per finishing place is six route handlers, each running two
 * database queries under a 4x CPU throttle — server cost, not network
 * queueing, and a priority hint cannot touch it.
 *
 * So the contract is deliberately "the logo is eager, the gallery is lazy, and
 * NOTHING claims a priority hint". The last of those is the one worth a test:
 * it fails if someone re-adds the hint, which sends them to the measurement
 * instead of letting them repeat it.
 */
import { render, screen } from '@testing-library/react';

import {
    PublicFarmBody,
    type PublicFarmBodyLabels,
    type PublicFarmBodyProfile,
} from '@/components/public-profile/public-farm-body';

const PHOTOS = [
    '/api/public/media/aaa1',
    '/api/public/media/bbb2',
    '/api/public/media/ccc3',
    '/api/public/media/ddd4',
    '/api/public/media/eee5',
    '/api/public/media/fff6',
];
const LOGO = '/api/public/media/logo0';

function profileOf(over: Partial<PublicFarmBodyProfile> = {}): PublicFarmBodyProfile {
    return {
        displayName: 'Стопанство Победа',
        tagline: 'Зърно и слънчоглед от Добруджа',
        oblast: 'Добрич',
        crops: ['пшеница', 'слънчоглед'],
        about: 'Семейно стопанство в Добруджа, трето поколение.',
        logoUrl: LOGO,
        photoUrls: PHOTOS,
        ...over,
    };
}

const LABELS: PublicFarmBodyLabels = {
    oblastLine: 'Област: Добрич',
    cropsTitle: 'Култури',
    aboutTitle: 'За нас',
    logoAlt: 'Логото на Стопанство Победа',
    photoAlt: (n) => `Снимка ${n}`,
    morePhotos: (n) => `Още ${n} снимки`,
};

const images = () => Array.from(document.querySelectorAll('img'));
const thumbnails = () => images().filter((i) => i.getAttribute('src') !== LOGO);
const logo = () => images().find((i) => i.getAttribute('src') === LOGO);

/**
 * React lower-cases `fetchPriority` to the `fetchpriority` content attribute.
 * Both spellings are read, so a React change that keeps the camelCase form
 * cannot make these assertions quietly unobservable — which matters more for a
 * negative assertion than a positive one, because an unobservable negative
 * passes.
 */
const priorityOf = (el: Element) =>
    el.getAttribute('fetchpriority') ?? el.getAttribute('fetchPriority');

describe('PublicFarmBody images (#2251)', () => {
    it('renders the gallery it is supposed to — the positive control', () => {
        // Without this, every assertion below could range over zero
        // thumbnails and pass, and the "nothing claims a hint" assertions
        // would pass over nothing at all.
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        expect(thumbnails()).toHaveLength(PHOTOS.length);
        expect(logo()).toBeDefined();
        expect(images()).toHaveLength(PHOTOS.length + 1);
    });

    it('the logo is eager, because it is above the fold', () => {
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        expect(logo()!.getAttribute('loading')).toBe('eager');
    });

    it('every thumbnail is lazy', () => {
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        const seen = thumbnails().map((i) => i.getAttribute('loading'));
        expect(seen).toEqual(PHOTOS.map(() => 'lazy'));
    });

    it('NOTHING claims a priority hint — the measured negative result', () => {
        // The assertion that fails if the hint comes back. It was tried,
        // merged and measured: Chrome already gives all 7 media requests
        // `High`, and the LCP median did not move (3414/3421 with it against
        // 3365/3331 without). Re-adding it should fail here and send the
        // reader to the component's comment rather than to another Lighthouse
        // run.
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        const claimants = images()
            .filter((i) => priorityOf(i) !== null)
            .map((i) => `${i.getAttribute('src')} -> ${priorityOf(i)}`);
        expect(claimants).toEqual([]);
    });

    it('the negative assertion is OBSERVABLE — the control for it', () => {
        // An attribute reader that cannot see the attribute would make the
        // test above pass forever. This proves `priorityOf` observes a real
        // `fetchpriority`, so its emptiness above means something.
        render(<img alt="" src="/x" fetchPriority="high" />);
        const probe = document.querySelector('img[src="/x"]')!;
        expect(priorityOf(probe)).toBe('high');
    });

    it('holds for a photoless farm and for a logoless one', () => {
        // The two conditions are independent and neither reintroduces a hint.
        const { unmount } = render(
            <PublicFarmBody profile={profileOf({ photoUrls: [] })} labels={LABELS} />,
        );
        expect(thumbnails()).toHaveLength(0);
        expect(logo()!.getAttribute('loading')).toBe('eager');
        expect(priorityOf(logo()!)).toBeNull();
        unmount();

        render(<PublicFarmBody profile={profileOf({ logoUrl: null })} labels={LABELS} />);
        expect(logo()).toBeUndefined();
        expect(thumbnails()).toHaveLength(PHOTOS.length);
        expect(images().filter((i) => priorityOf(i) !== null)).toEqual([]);
    });

    /**
     * ── ONLY THE FIRST MOBILE ROW IS REQUESTED ── #2251
     *
     * Owner ruling 2026-10-24, after both cheap levers were measured closed:
     * caching the media route's authorisation would serve withdrawn
     * photographs from an indexable page, and running its two queries
     * concurrently would let an anonymous caller trigger an RLS-bypassing read
     * of any tenant's `FileRecord`.
     *
     * What is left is the request COUNT, which is the measured mechanism: six
     * thumbnails issued inside one millisecond, each a route handler plus two
     * database queries under a 4x CPU throttle, with LCP landing on whichever
     * of the largest-painting ones finished first at ~395 ms per place.
     *
     * The deferral works because a collapsed `<details>` gives its content no
     * box, and a `loading="lazy"` image with no box never intersects and so is
     * never fetched. That is the load-bearing claim, so it is MEASURED in a
     * real browser rather than asserted here — jsdom neither lays out nor
     * fetches. Chromium via Playwright, counting `/api/public/media/`
     * requests on this component's markup:
     *
     *     details CLOSED   2 of 6 fetched
     *     details OPEN     6 of 6 fetched
     *
     * What these jsdom cases pin is the STRUCTURE that measurement depends on:
     * two images outside the disclosure, the rest inside it, every one of them
     * lazy, and the disclosure closed by default. If any of those drifts the
     * browser result stops following.
     */
    it('renders exactly the first mobile row outside the disclosure', () => {
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        const details = screen.getByTestId('public-farm-photos-more');
        const outside = thumbnails().filter((i) => !details.contains(i));
        const inside = thumbnails().filter((i) => details.contains(i));
        // Two, because `grid-cols-2` is the mobile layout Lighthouse measures.
        expect(outside.map((i) => i.getAttribute('src'))).toEqual(PHOTOS.slice(0, 2));
        expect(inside.map((i) => i.getAttribute('src'))).toEqual(PHOTOS.slice(2));
    });

    it('the disclosure is CLOSED by default, which is what defers the fetch', () => {
        // An `open` default would put all six back on the critical path while
        // every other assertion here still passed.
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        const details = screen.getByTestId('public-farm-photos-more') as HTMLDetailsElement;
        expect(details.tagName).toBe('DETAILS');
        expect(details.open).toBe(false);
        expect(details.hasAttribute('open')).toBe(false);
    });

    it('every deferred image is lazy — an eager one would be fetched anyway', () => {
        // `display: none` defers a LAZY image. An eager image inside a closed
        // `<details>` is fetched immediately, so the deferral would silently
        // buy nothing.
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        const details = screen.getByTestId('public-farm-photos-more');
        const inside = thumbnails().filter((i) => details.contains(i));
        expect(inside).toHaveLength(PHOTOS.length - 2);
        expect(inside.map((i) => i.getAttribute('loading'))).toEqual(inside.map(() => 'lazy'));
    });

    it('the disclosure says how many it hides, and vanishes when it hides none', () => {
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        expect(screen.getByTestId('public-farm-photos-more').textContent).toContain('Още 4 снимки');

        // Exactly the eager count, or fewer: no control at all rather than an
        // empty one a reader can open onto nothing.
        const { unmount } = render(
            <PublicFarmBody profile={profileOf({ photoUrls: PHOTOS.slice(0, 2) })} labels={LABELS} />,
        );
        expect(screen.queryAllByTestId('public-farm-photos-more')).toHaveLength(1);
        unmount();
    });

    it('a single photograph renders with no disclosure', () => {
        render(<PublicFarmBody profile={profileOf({ photoUrls: [PHOTOS[0]] })} labels={LABELS} />);
        expect(thumbnails()).toHaveLength(1);
        expect(screen.queryByTestId('public-farm-photos-more')).toBeNull();
    });

    it('the size premise behind all of this is still in the markup', () => {
        // Why a thumbnail and not the logo is the LCP element is a SIZE
        // relationship, and it lives in these class names. If the logo grows
        // or the grid shrinks, every measurement quoted in this file and in
        // the component stops applying, and this is the assertion that should
        // say so.
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        const logoBox = screen.getByTestId('public-farm-logo');
        expect(logoBox.className).toContain('h-24');
        expect(logoBox.className).toContain('w-24');
        const cell = thumbnails()[0].closest('li');
        expect(cell?.className).toContain('aspect-[4/3]');
        expect(cell?.parentElement?.className).toContain('grid-cols-2');
    });
});

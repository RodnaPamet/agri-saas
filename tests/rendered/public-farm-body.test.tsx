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

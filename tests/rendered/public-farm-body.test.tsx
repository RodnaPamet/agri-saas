/**
 * The public farm page's images, rendered — #2251.
 *
 * ## Why this is a rendered test and not a source grep
 *
 * The claim is about what the BROWSER is told: which image is eager, which
 * carries the priority hint, and that exactly one does. A grep for
 * `fetchPriority` matches the explanatory comments beside each attribute as
 * readily as the attributes themselves — this component carries several
 * paragraphs naming the string — so a source assertion here would pass on the
 * prose after the code was removed. Reading the DOM cannot.
 *
 * ## What went wrong, so the assertions have a subject
 *
 * `fetchPriority="high"` sat on the logo, on the reasoning that it was "the
 * likeliest LCP element now that the page has an image at all". Measured
 * across 20 Lighthouse runs in four independent jobs, the LCP element was a
 * gallery thumbnail 20 times and the logo zero: the logo's box is `h-24 w-24`
 * (96x96 = 9,216 px^2) and a thumbnail paints 175x131 = 22,925 px^2.
 *
 * Meanwhile all six thumbnails were indistinguishable to the browser — every
 * one `loading="lazy"`, all issued inside the same millisecond at `High` — so
 * they finished staggered and LCP landed on whichever of the largest-painting
 * ones finished first, at roughly 395 ms per finishing place. That is a race,
 * and it let the page's LCP move ~800 ms with no change to a byte it served.
 *
 * So the properties worth pinning are: the hint is on a thumbnail, the first
 * thumbnail starts ahead of the rest, and only ONE element claims it — a
 * second claimant would restore the tie this exists to break.
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

function profileOf(over: Partial<PublicFarmBodyProfile> = {}): PublicFarmBodyProfile {
    return {
        displayName: 'Стопанство Победа',
        tagline: 'Зърно и слънчоглед от Добруджа',
        oblast: 'Добрич',
        crops: ['пшеница', 'слънчоглед'],
        about: 'Семейно стопанство в Добруджа, трето поколение.',
        logoUrl: '/api/public/media/logo0',
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

/** Every `<img>` the component rendered, in document order. */
function images(): HTMLImageElement[] {
    return Array.from(document.querySelectorAll('img'));
}

const thumbnails = () => images().filter((i) => i.getAttribute('src') !== '/api/public/media/logo0');
const logo = () => images().find((i) => i.getAttribute('src') === '/api/public/media/logo0');

/**
 * React lower-cases `fetchPriority` to the `fetchpriority` content attribute,
 * so the DOM is read through the attribute rather than the property. Checked
 * both spellings so a React change that keeps the camelCase form cannot make
 * these assertions quietly unobservable.
 */
const priorityOf = (el: Element) =>
    el.getAttribute('fetchpriority') ?? el.getAttribute('fetchPriority');

describe('PublicFarmBody images (#2251)', () => {
    it('renders the gallery it is supposed to — the positive control', () => {
        // Without this, every assertion below could range over zero
        // thumbnails and pass.
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        expect(thumbnails()).toHaveLength(PHOTOS.length);
        expect(logo()).toBeDefined();
        expect(images()).toHaveLength(PHOTOS.length + 1);
    });

    it('the FIRST thumbnail is eager and carries the priority hint', () => {
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        const first = thumbnails()[0];
        expect(first.getAttribute('src')).toBe(PHOTOS[0]);
        expect(first.getAttribute('loading')).toBe('eager');
        expect(priorityOf(first)).toBe('high');
    });

    it('every other thumbnail stays lazy and claims nothing', () => {
        // The rest keep `lazy` so a visitor who never scrolls does not pay for
        // all six at once — the cost the section's own move downward addressed.
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        const rest = thumbnails().slice(1);
        expect(rest).toHaveLength(PHOTOS.length - 1);
        for (const img of rest) {
            expect({
                src: img.getAttribute('src'),
                loading: img.getAttribute('loading'),
                priority: priorityOf(img),
            }).toEqual({ src: img.getAttribute('src'), loading: 'lazy', priority: null });
        }
    });

    it('exactly ONE element claims the highest priority', () => {
        // The property that makes the hint a tie-break. Two claimants is the
        // state this change exists to leave: six indistinguishable requests
        // racing, with LCP landing on whichever finished first.
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        const claimants = images().filter((i) => priorityOf(i) === 'high');
        expect(claimants.map((i) => i.getAttribute('src'))).toEqual([PHOTOS[0]]);
    });

    it('the logo is eager but does NOT outrank the element that wins', () => {
        // It is above the fold, so it loads eagerly; it is 2.5x smaller than a
        // thumbnail, so it cannot be the LCP element and must not hold the
        // ranking against one.
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        expect(logo()!.getAttribute('loading')).toBe('eager');
        expect(priorityOf(logo()!)).toBeNull();
    });

    it('with NO gallery the logo keeps the hint, rather than nothing having it', () => {
        // Deliberately conservative: nothing measures the photoless farm, so
        // that case is left as it was instead of changed silently. The hint
        // follows the only image on the page.
        render(<PublicFarmBody profile={profileOf({ photoUrls: [] })} labels={LABELS} />);
        expect(thumbnails()).toHaveLength(0);
        expect(priorityOf(logo()!)).toBe('high');
        expect(logo()!.getAttribute('loading')).toBe('eager');
    });

    it('with no logo the first thumbnail still carries it', () => {
        // The two conditions are independent, and a farm with photographs and
        // no logo must not end up with an unhinted LCP element.
        render(<PublicFarmBody profile={profileOf({ logoUrl: null })} labels={LABELS} />);
        const imgs = images();
        expect(imgs).toHaveLength(PHOTOS.length);
        expect(imgs.filter((i) => priorityOf(i) === 'high').map((i) => i.getAttribute('src'))).toEqual(
            [PHOTOS[0]],
        );
    });

    it('a single photograph is the hinted one, not an unhinted special case', () => {
        render(<PublicFarmBody profile={profileOf({ photoUrls: [PHOTOS[0]] })} labels={LABELS} />);
        expect(thumbnails()).toHaveLength(1);
        expect(priorityOf(thumbnails()[0])).toBe('high');
        expect(thumbnails()[0].getAttribute('loading')).toBe('eager');
        // And the logo yields to it even though there is only one photograph.
        expect(priorityOf(logo()!)).toBeNull();
    });

    it('the premise behind all of this is still in the markup', () => {
        // The ordering that makes a thumbnail the LCP element and not the logo
        // is a SIZE relationship, and it lives in these class names. If the
        // logo grows or the grid shrinks, the measurement above stops applying
        // and this test should be the thing that says so.
        render(<PublicFarmBody profile={profileOf()} labels={LABELS} />);
        const logoBox = screen.getByTestId('public-farm-logo');
        expect(logoBox.className).toContain('h-24');
        expect(logoBox.className).toContain('w-24');
        // The grid cells are a fixed 4:3 box, which is what paints larger than
        // 96x96 at two columns on a 390px viewport.
        const cell = thumbnails()[0].closest('li');
        expect(cell?.className).toContain('aspect-[4/3]');
        expect(cell?.parentElement?.className).toContain('grid-cols-2');
    });
});

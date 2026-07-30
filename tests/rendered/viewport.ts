/**
 * Explicit viewport control for the jsdom rendered suite.
 *
 * ── Why this module exists ──────────────────────────────────────────
 *
 * `tests/rendered/setup.ts` polyfills `matchMedia` with a stub that
 * answers `matches: false` to EVERY query. `useMediaQuery`
 * (`src/components/ui/hooks/use-media-query.ts`) derives the device
 * from two `min-width` probes:
 *
 *     matchMedia('(min-width: 1024px)').matches ? 'desktop'
 *   : matchMedia('(min-width: 640px)').matches  ? 'tablet'
 *   : 'mobile'
 *
 * Both probes answering `false` resolves to `'mobile'`. So the DEFAULT
 * jsdom viewport is a PHONE, for every rendered test, silently.
 *
 * That default is not wrong — this is a mobile-first product and the
 * operator is standing in a field. What is wrong is that it is
 * IMPLICIT: `<DataTable mobileFallback="card">` swaps its `<table>` for
 * `<MobileCardList>` on a phone, and `MobileCardList` OMITS every
 * column without `meta.mobileCard`. A test written against the desktop
 * table therefore exercises a different component than its author
 * believed, and a green run says nothing about the branch named in the
 * test's own docblock.
 *
 * ── Usage ───────────────────────────────────────────────────────────
 *
 *     import { setViewport, restoreViewport } from './viewport';
 *
 *     afterEach(restoreViewport);
 *
 *     it('renders the table on a desktop', () => {
 *         setViewport('desktop');
 *         render(<Thing />);
 *         expect(screen.getByRole('table')).toBeInTheDocument();
 *     });
 *
 * Call `setViewport` BEFORE `render`. `useMediaQuery` reads
 * `matchMedia` in a mount effect, so a change after mount only takes
 * effect on the next `resize` event.
 *
 * `restoreViewport` puts the setup-file stub back, so a suite that
 * pins one test to a desktop does not leak that viewport into the
 * next. Register it as `afterEach(restoreViewport)` — the same shape
 * `@testing-library/react`'s own `cleanup` uses.
 */

export type Viewport = 'mobile' | 'tablet' | 'desktop';

/** The `matchMedia` installed by `tests/rendered/setup.ts`. */
const SETUP_MATCH_MEDIA = typeof window !== 'undefined' ? window.matchMedia : undefined;

/** The `min-width` breakpoints `useMediaQuery` probes, widest first. */
const MIN_WIDTH_PROBE = /min-width:\s*(\d+)px/;

const VIEWPORT_WIDTH: Record<Viewport, number> = {
    // Widths chosen to sit just inside each band: a phone below the
    // 640px `sm` breakpoint, a tablet between `sm` and `lg`, a desktop
    // at or above the 1024px `lg` breakpoint.
    mobile: 390,
    tablet: 768,
    desktop: 1280,
};

function mediaQueryList(query: string, matches: boolean): MediaQueryList {
    return {
        matches,
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
    } as unknown as MediaQueryList;
}

/**
 * Answer `min-width` media queries for `kind`, so `useMediaQuery`
 * resolves to that device.
 *
 * Only `min-width` is interpreted — every other query (a
 * `prefers-reduced-motion` probe, a `print` probe) keeps the
 * setup-file default of `false`, so this helper changes the device and
 * nothing else.
 */
export function setViewport(kind: Viewport): void {
    const width = VIEWPORT_WIDTH[kind];
    window.matchMedia = ((query: string) => {
        const probe = MIN_WIDTH_PROBE.exec(query);
        const matches = probe ? width >= Number(probe[1]) : false;
        return mediaQueryList(query, matches);
    }) as unknown as typeof window.matchMedia;
    // Some consumers read `window.innerWidth` rather than a media
    // query; keep the two consistent so a component cannot observe a
    // 1280px media query on a 1024px-wide jsdom window.
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: width,
    });
}

/** Restore the `matches: false` stub from `tests/rendered/setup.ts`. */
export function restoreViewport(): void {
    if (SETUP_MATCH_MEDIA) window.matchMedia = SETUP_MATCH_MEDIA;
}

/**
 * The device the DEFAULT jsdom stub resolves to — a phone, because
 * `matches: false` fails both `min-width` probes. Exported so a test
 * can NAME the default it relies on instead of inheriting it silently.
 */
export const DEFAULT_VIEWPORT: Viewport = 'mobile';

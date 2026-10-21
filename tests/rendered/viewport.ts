/**
 * Explicit viewport practice for the jsdom rendered suite.
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

/**
 * State that a suite is mobile-only ON PURPOSE, with the reason.
 *
 * ## The distinction this exists to make
 *
 * jsdom's `matchMedia` stub answers `matches: false` to every query, so a
 * rendered test that never sets a viewport runs MOBILE — and four UI
 * primitives switch implementation on that query, not just classes:
 *
 *     ui/modal.tsx            Radix Dialog  / Vaul Drawer
 *     ui/popover.tsx          Radix Popover / Vaul Drawer
 *     ui/sheet.tsx            right Drawer  / bottom Drawer
 *     ui/DeferredOnMobile.tsx renders       / defers
 *
 * Measured 2026-10-22: 106 of 265 files in this directory transitively reach
 * one of those, and 82 of them never reach desktop. Most of that 82 is fine —
 * the component under test has no viewport-dependent behaviour and a second
 * pass would be cost without signal. What is NOT fine is that "mobile by
 * decision" and "nobody thought about it" look identical from outside.
 *
 * So this marks the decision. It is deliberately not a no-op comment: it sets
 * the viewport explicitly, so the suite states its device rather than
 * inheriting a stub's default, and `tests/guards/rendered-viewport-switchers.test.ts`
 * counts a suite carrying it as handled.
 *
 * @param reason why desktop is out of scope — the component is mobile-only,
 *               the assertion is about the drawer specifically, and so on.
 */
export function mobileOnly(reason: string): void {
    if (reason.trim().length < 15) {
        throw new Error(
            `mobileOnly() needs a real reason, got ${JSON.stringify(reason)}. ` +
                `The point of this marker is that it carries one — an empty string ` +
                `would re-create the ambiguity it exists to remove.`,
        );
    }
    setViewport('mobile');
}

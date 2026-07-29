/**
 * Rendered tests for the Tooltip primitive's COARSE-POINTER path.
 *
 * ─── WHY THIS FILE EXISTS ───
 *
 * `tests/rendered/setup.ts` leaves jsdom's `matchMedia` answering
 * `matches: false` to every query, so `useCoarsePointer()` in
 * `src/components/ui/tooltip.tsx` is permanently false under jsdom and the
 * ENTIRE touch branch added by #449 — the tap toggle, the controlled
 * `open`, the three dismissal paths — never executed in any test. The
 * structural guard (`tests/guards/tooltip-touch-uniformity.test.ts`) locks
 * the SHAPE of that code; nothing locked its BEHAVIOUR. A regression that
 * broke every tooltip-wrapped link on touch shipped through that gap.
 *
 * So every test here installs its own `matchMedia` that answers `true` to
 * `(hover: none)` / `(pointer: coarse)` BEFORE rendering, and drives the
 * primitive with real pointer events. The fine-pointer cases at the bottom
 * install the opposite stub, so the two paths are asserted against each
 * other rather than one being assumed.
 *
 * ─── THE REGRESSION THIS PINS ───
 *
 * #449 made Radix skip its own composed close-handlers by calling
 * `preventDefault()` on the trigger's `onPointerDown` and `onClick`. That
 * also cancelled the default action of whatever the tooltip wrapped: Next's
 * app-dir `Link` returns early on `e.defaultPrevented`, and the native
 * anchor default was prevented too. On a phone, ~17 inline `<Tooltip>`-
 * around-a-link call sites plus every collapsed-sidebar nav item
 * (`src/components/layout/nav-item.tsx`) did nothing but show a tooltip.
 *
 * `navigates on tap` and `download stays live on tap` below are the two
 * tests that fail against that code and pass against the fix.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { Tooltip, TooltipProvider, TOOLTIPS_ENABLED } from '@/components/ui/tooltip';

// Mirrors the convention in tests/rendered/tooltip.test.tsx: the
// behavioural cases only mean anything while the popup is live.
const itWhenEnabled = TOOLTIPS_ENABLED ? it : it.skip;

/**
 * The query `useCoarsePointer()` subscribes to is
 * `"(hover: none), (pointer: coarse)"`. Matching on the FEATURES rather
 * than the exact string keeps this stub honest if the primitive ever
 * reorders or splits the query — it would still report a coarse device,
 * instead of silently reverting these tests to the desktop path.
 */
const COARSE_FEATURE_RE = /hover:\s*none|pointer:\s*coarse/;

let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
    originalMatchMedia = window.matchMedia;
});

afterEach(() => {
    // Plain assignment, not `Object.defineProperty` — jsdom installs
    // `matchMedia` as `{ writable: true, configurable: false }`, so
    // redefining it throws `Cannot redefine property`.
    window.matchMedia = originalMatchMedia;
});

/**
 * Replace jsdom's always-false `matchMedia` for the duration of one test.
 * Must run BEFORE `render()` — `useCoarsePointer` reads its snapshot during
 * render via `useSyncExternalStore`, so a stub installed afterwards would
 * leave the first render (and every assertion that follows) on the desktop
 * path.
 */
function installPointerClass(coarse: boolean) {
    window.matchMedia = ((query: string) =>
        ({
            matches: coarse && COARSE_FEATURE_RE.test(query),
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
        }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

function Harness({ children }: { children: React.ReactNode }) {
    // delayDuration={0} matches tooltip.test.tsx — it keeps the hover cases
    // off Radix's timer, which jsdom's clock races with.
    return <TooltipProvider delayDuration={0}>{children}</TooltipProvider>;
}

/**
 * One finger tap: pointerdown → pointerup → click, the ordering a browser
 * produces for a touch. Returns whether the click's default action survived
 * — `fireEvent` returns `dispatchEvent`'s result, which is `false` exactly
 * when a handler called `preventDefault()`. That boolean IS the navigation
 * / download contract: it is what an `<a href>` consults before doing
 * anything.
 */
function tap(el: Element): { defaultSurvived: boolean } {
    fireEvent.pointerDown(el, { pointerType: 'touch', pointerId: 1 });
    fireEvent.pointerUp(el, { pointerType: 'touch', pointerId: 1 });
    return { defaultSurvived: fireEvent.click(el, { detail: 1 }) };
}

/**
 * Stands in for `next/link`.
 *
 * The real component cannot render here — its app-dir implementation
 * short-circuits (`if (!router) return`) with no `AppRouterContext`, so it
 * would never navigate in jsdom regardless of the bug and the test would
 * pass vacuously. This reproduces the exact three lines of its click
 * contract, from `next/dist/client/app-dir/link.js`:
 *
 *     onClick(e) {
 *         if (typeof onClick === 'function') onClick(e);
 *         if (!router) return;
 *         if (e.defaultPrevented) return;
 *         linkClicked(...);
 *     }
 *
 * `onClick` there is whatever the parent passed down — which, under
 * `<Tooltip>`, is Radix's composed trigger handler. That is precisely how a
 * `preventDefault()` inside the tooltip reaches out and cancels navigation.
 */
type NavLinkProps = React.ComponentPropsWithoutRef<'a'> & { onNavigate: () => void };

const NavLink = React.forwardRef<HTMLAnchorElement, NavLinkProps>(function NavLink(
    { onNavigate, onClick, children, ...rest },
    ref,
) {
    return (
        <a
            ref={ref}
            {...rest}
            onClick={(e) => {
                onClick?.(e);
                if (e.defaultPrevented) return;
                onNavigate();
            }}
        >
            {children}
        </a>
    );
});

describe('Tooltip — the jsdom blind spot this file closes', () => {
    it('reports a FINE pointer by default, which is why the touch branch was untested', () => {
        // No stub installed: this is what every other rendered test sees.
        // The assertion is the documentation — if a future setup change
        // starts reporting a coarse pointer under jsdom, the rest of the
        // rendered suite silently changes meaning and this fails first.
        expect(window.matchMedia('(hover: none), (pointer: coarse)').matches).toBe(false);
    });

    it('the stub in this file flips it, and only for the pointer-class query', () => {
        installPointerClass(true);
        expect(window.matchMedia('(hover: none), (pointer: coarse)').matches).toBe(true);
        // A blanket `matches: true` stub would also flip every breakpoint
        // query in the tree and make these tests assert something else.
        expect(window.matchMedia('(min-width: 768px)').matches).toBe(false);
    });
});

describe('Tooltip on a coarse pointer', () => {
    itWhenEnabled('opens on tap', async () => {
        installPointerClass(true);
        render(
            <Harness>
                <Tooltip content="Delete row">
                    <button type="button">Delete</button>
                </Tooltip>
            </Harness>,
        );

        const trigger = screen.getByRole('button', { name: 'Delete' });
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

        tap(trigger);

        // This assertion alone proves the coarse branch executed: on the
        // desktop path Radix ignores touch pointer-moves and closes on
        // click, so a tap can never leave a tooltip open.
        const tooltip = await screen.findByRole('tooltip');
        expect(tooltip).toHaveTextContent('Delete row');
    });

    itWhenEnabled('closes on a second tap', async () => {
        installPointerClass(true);
        render(
            <Harness>
                <Tooltip content="Delete row">
                    <button type="button">Delete</button>
                </Tooltip>
            </Harness>,
        );

        const trigger = screen.getByRole('button', { name: 'Delete' });
        tap(trigger);
        await screen.findByRole('tooltip');

        tap(trigger);
        await waitFor(() => {
            expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        });
    });

    itWhenEnabled('a wrapped link still navigates on tap', async () => {
        installPointerClass(true);
        const onNavigate = jest.fn();
        render(
            <Harness>
                <Tooltip content="Coverage">
                    <NavLink href="/coverage" onNavigate={onNavigate}>
                        Coverage
                    </NavLink>
                </Tooltip>
            </Harness>,
        );

        const link = screen.getByRole('link', { name: 'Coverage' });
        tap(link);

        // THE regression. #449's `onClick={(e) => e.preventDefault()}` on
        // the trigger runs before the link's own handler reads
        // `e.defaultPrevented`, so this count was 0 on every touch device.
        expect(onNavigate).toHaveBeenCalledTimes(1);

        // …and the tooltip still opened. Navigating and showing the label
        // are not alternatives: the collapsed sidebar's tooltip IS the
        // link's label, and a tap has to do both.
        expect(await screen.findByRole('tooltip')).toHaveTextContent('Coverage');
    });

    itWhenEnabled('a wrapped download anchor keeps its native default on tap', async () => {
        installPointerClass(true);
        render(
            <Harness>
                <Tooltip content="Export JSON">
                    <a href="/api/audits/packs/p1?action=export" download>
                        Export
                    </a>
                </Tooltip>
            </Harness>,
        );

        const anchor = screen.getByRole('link', { name: 'Export' });
        const { defaultSurvived } = tap(anchor);

        // The audit-pack exports are plain `<a href download>` — no React
        // onClick to fall back on. If the click's default action is
        // cancelled, the file simply never downloads.
        expect(defaultSurvived).toBe(true);
        expect(await screen.findByRole('tooltip')).toHaveTextContent('Export JSON');
    });

    itWhenEnabled('dismisses on a tap outside the trigger', async () => {
        installPointerClass(true);
        render(
            <Harness>
                <Tooltip content="Delete row">
                    <button type="button">Delete</button>
                </Tooltip>
                <button type="button">Elsewhere</button>
            </Harness>,
        );

        tap(screen.getByRole('button', { name: 'Delete' }));
        await screen.findByRole('tooltip');

        fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }), {
            pointerType: 'touch',
            pointerId: 2,
        });

        await waitFor(() => {
            expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        });
    });

    itWhenEnabled('dismisses on scroll', async () => {
        installPointerClass(true);
        render(
            <Harness>
                <Tooltip content="Delete row">
                    <button type="button">Delete</button>
                </Tooltip>
            </Harness>,
        );

        tap(screen.getByRole('button', { name: 'Delete' }));
        await screen.findByRole('tooltip');

        fireEvent.scroll(window);

        await waitFor(() => {
            expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        });
    });

    itWhenEnabled('dismisses on its own timeout', async () => {
        jest.useFakeTimers();
        try {
            installPointerClass(true);
            render(
                <Harness>
                    <Tooltip content="Delete row">
                        <button type="button">Delete</button>
                    </Tooltip>
                </Harness>,
            );

            tap(screen.getByRole('button', { name: 'Delete' }));
            expect(screen.getByRole('tooltip')).toBeInTheDocument();

            // Comfortably past TOUCH_AUTO_DISMISS_MS, which the structural
            // guard bounds to 2–15s. Advancing by a fixed 20s keeps this
            // test correct across any value inside that band.
            React.act(() => {
                jest.advanceTimersByTime(20_000);
            });

            expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        } finally {
            jest.useRealTimers();
        }
    });

    itWhenEnabled('dismisses on Escape', async () => {
        installPointerClass(true);
        render(
            <Harness>
                <Tooltip content="Delete row">
                    <button type="button">Delete</button>
                </Tooltip>
            </Harness>,
        );

        tap(screen.getByRole('button', { name: 'Delete' }));
        await screen.findByRole('tooltip');

        fireEvent.keyDown(document, { key: 'Escape' });

        await waitFor(() => {
            expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        });
    });
});

describe('Tooltip on a fine pointer (unchanged)', () => {
    itWhenEnabled('opens on hover', async () => {
        installPointerClass(false);
        render(
            <Harness>
                <Tooltip content="Delete row">
                    <button type="button">Delete</button>
                </Tooltip>
            </Harness>,
        );

        fireEvent.pointerMove(screen.getByRole('button', { name: 'Delete' }), {
            pointerType: 'mouse',
        });

        expect(await screen.findByRole('tooltip')).toHaveTextContent('Delete row');
    });

    itWhenEnabled('does not tap-toggle — a click leaves it closed', async () => {
        installPointerClass(false);
        render(
            <Harness>
                <Tooltip content="Delete row">
                    <button type="button">Delete</button>
                </Tooltip>
            </Harness>,
        );

        tap(screen.getByRole('button', { name: 'Delete' }));

        // Radix's own behaviour: pointer devices get hover/focus only, and
        // a click CLOSES. The touch branch must not leak into this path.
        await waitFor(() => {
            expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        });
    });

    itWhenEnabled('never cancels a wrapped link either', () => {
        installPointerClass(false);
        const onNavigate = jest.fn();
        render(
            <Harness>
                <Tooltip content="Coverage">
                    <NavLink href="/coverage" onNavigate={onNavigate}>
                        Coverage
                    </NavLink>
                </Tooltip>
            </Harness>,
        );

        const { defaultSurvived } = tap(screen.getByRole('link', { name: 'Coverage' }));

        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(defaultSurvived).toBe(true);
    });
});

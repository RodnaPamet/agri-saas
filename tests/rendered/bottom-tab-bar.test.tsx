/**
 * @jest-environment jsdom
 *
 * BottomTabBar (mobile-shell PR-1) — unit proof of the one-thumb nav:
 *   1. Resolves the five field tabs from `useNavSections()` in display
 *      order, excluding nav surfaces that aren't bottom tabs.
 *   2. Marks the active tab with `aria-current="page"` + `data-active`
 *      (the non-colour active cue).
 *   3. Renders nothing when every target surface is gated out.
 *
 * The nav source, router, and `next/link` are stubbed so the component
 * renders without tenant / permission / next-intl context.
 */
import { render, screen } from '@testing-library/react';
import { LayoutDashboard, MapPin, ClipboardList, NotebookPen, AlertTriangle, CalendarDays } from 'lucide-react';
import { restoreViewport, setViewport } from './viewport';

// Mutable so a test can swap in the "all gated out" case. The `mock`
// prefix is what lets the jest.mock factory close over it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSections: any[] = [];
jest.mock('@/components/layout/SidebarNav', () => ({
    useNavSections: () => mockSections,
}));

let mockPath = '/t/acme/dashboard';
jest.mock('next/navigation', () => ({ usePathname: () => mockPath }));

jest.mock('next/link', () => ({
    __esModule: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    default: ({ href, children, ...rest }: any) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { BottomTabBar } from '@/components/layout/BottomTabBar';

const FULL_NAV = [
    {
        items: [
            { href: '/t/acme/dashboard', label: 'Board', icon: LayoutDashboard },
            { href: '/t/acme/assets', label: 'Asset', icon: LayoutDashboard },
            { href: '/t/acme/locations', label: 'Location', icon: MapPin },
            { href: '/t/acme/journal', label: 'Journal', icon: NotebookPen },
            { href: '/t/acme/farm-tasks', label: 'Tasks', icon: ClipboardList },
            { href: '/t/acme/risks', label: 'Risk', icon: AlertTriangle },
            { href: '/t/acme/exchange', label: 'Marketplace', icon: LayoutDashboard },
        ],
    },
    {
        title: 'Comply',
        items: [{ href: '/t/acme/farm-tasks', label: 'Plan', icon: ClipboardList }],
    },
];

beforeEach(() => {
    // Reset to the full nav before each test (test 3 swaps in a gated-out
    // set). Tests only read this, so a direct reference is fine.
    mockSections = FULL_NAV;
    mockPath = '/t/acme/dashboard';
});

describe('BottomTabBar', () => {
    it('resolves the field tabs from useNavSections in display order', () => {
        render(<BottomTabBar />);
        const nav = screen.getByRole('navigation', { name: 'Primary' });

        for (const slug of ['dashboard', 'farm-tasks', 'locations', 'journal', 'exchange']) {
            expect(screen.getByTestId(`bottom-tab-${slug}`)).toBeInTheDocument();
        }

        // Non-tab surfaces present in the nav (Asset, Risk) are excluded.
        expect(screen.queryByText('Asset')).not.toBeInTheDocument();
        expect(screen.queryByText('Risk')).not.toBeInTheDocument();
        // The legacy compliance Tasks page was dropped from the bottom bar.
        expect(screen.queryByTestId('bottom-tab-tasks')).not.toBeInTheDocument();

        // Order: dashboard first, journal last (BOTTOM_TAB_SUFFIXES order, not
        // nav order).
        const links = Array.from(nav.querySelectorAll('a'));
        expect(links).toHaveLength(5);
        expect(links[0]).toHaveAttribute('data-testid', 'bottom-tab-dashboard');
        expect(links[1]).toHaveAttribute('data-testid', 'bottom-tab-farm-tasks');
        expect(links[3]).toHaveAttribute('data-testid', 'bottom-tab-journal');
        expect(links[4]).toHaveAttribute('data-testid', 'bottom-tab-exchange');
    });

    it('marks the active tab with aria-current + data-active (non-colour cue)', () => {
        mockPath = '/t/acme/locations/loc-123'; // a detail route under /locations
        render(<BottomTabBar />);

        const loc = screen.getByTestId('bottom-tab-locations');
        expect(loc).toHaveAttribute('aria-current', 'page');
        expect(loc).toHaveAttribute('data-active', 'true');

        const dash = screen.getByTestId('bottom-tab-dashboard');
        expect(dash).not.toHaveAttribute('aria-current', 'page');
        expect(dash).toHaveAttribute('data-active', 'false');
    });

    it('renders nothing when every target surface is gated out', () => {
        // Only non-tab surfaces survive the (hypothetical) permission gate.
        mockSections = [{ items: [{ href: '/t/acme/risks', label: 'Risk', icon: AlertTriangle }] }];
        const { container } = render(<BottomTabBar />);
        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByTestId('bottom-tab-bar')).not.toBeInTheDocument();
    });
});

/**
 * P2.5 — the bar follows `User.bottomTabOrder`.
 *
 * The contract itself is unit-tested in `tests/unit/resolve-bottom-tabs.test.ts`
 * against the pure resolver. What is proved HERE is that the component is
 * actually wired to it — a resolver with a perfect test suite and no caller is
 * the failure mode these cases exist to rule out.
 */
describe('BottomTabBar — the saved arrangement', () => {
    const slugs = () =>
        Array.from(
            screen.getByRole('navigation', { name: 'Primary' }).querySelectorAll('a'),
        ).map((a) => a.getAttribute('data-testid'));

    it('renders the user’s order, not the default one', () => {
        render(<BottomTabBar savedOrder={['/journal', '/dashboard']} />);
        expect(slugs()).toEqual(['bottom-tab-journal', 'bottom-tab-dashboard']);
    });

    it('drops an unreachable choice and lets the next one take the slot', () => {
        // `/admin` is not in the nav here, so it stands in for a tab gated off
        // for this member, or an id from a newer iOS build.
        render(
            <BottomTabBar
                savedOrder={[
                    '/journal',
                    '/admin',
                    '/exchange',
                    '/locations',
                    '/farm-tasks',
                    '/dashboard',
                ]}
            />,
        );
        // Five tabs, every one of them chosen. Clamping before resolving would
        // have spent a slot on `/admin` and rendered four.
        expect(slugs()).toEqual([
            'bottom-tab-journal',
            'bottom-tab-exchange',
            'bottom-tab-locations',
            'bottom-tab-farm-tasks',
            'bottom-tab-dashboard',
        ]);
    });

    it('renders NO bar for a deliberately cleared arrangement', () => {
        // The one place web and iOS differ on purpose — iOS shows its defaults,
        // because there the tab bar IS the navigation. Owner-ruled 2026-10-04.
        const { container } = render(<BottomTabBar savedOrder={[]} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('falls back to the defaults when nothing chosen is reachable', () => {
        // Distinct from `[]`: the user asked for `/admin`, and losing the role
        // must not silently delete their bar.
        render(<BottomTabBar savedOrder={['/admin']} />);
        expect(slugs()).toHaveLength(5);
        expect(slugs()[0]).toBe('bottom-tab-dashboard');
    });
});

describe('BottomTabBar — badges and touch targets', () => {
    it('surfaces the same badge the sidebar renders', () => {
        // Same `badge` field, from the same gated nav data, so the rail and the
        // bar can never disagree about a count.
        mockSections = [
            {
                items: [
                    { href: '/t/acme/calendar', label: 'Calendar', icon: CalendarDays, badge: 3 },
                    { href: '/t/acme/journal', label: 'Journal', icon: NotebookPen },
                ],
            },
        ];
        render(<BottomTabBar savedOrder={['/calendar', '/journal']} />);

        const cal = screen.getByTestId('bottom-tab-calendar');
        expect(cal).toHaveTextContent('3');
        // Inside the link, so it joins the accessible name rather than being
        // announced as a stray number — "Calendar 3".
        expect(cal.textContent).toContain('Calendar');
        // A tab with no count renders no pill at all.
        expect(screen.getByTestId('bottom-tab-journal').textContent).toBe('Journal');
    });

    it('keeps every tab a >=44px touch target (Apple HIG / WCAG 2.5.5)', () => {
        render(<BottomTabBar />);
        for (const link of screen
            .getByRole('navigation', { name: 'Primary' })
            .querySelectorAll('a')) {
            expect(link.className).toContain('min-h-[44px]');
        }
    });

    it('is mobile-only chrome, and renders identically at both viewports', () => {
        // The bar is hidden on desktop by CSS (`md:hidden`), which jsdom does
        // not apply — so the honest assertions are that the class is present
        // and that nothing about the markup depends on viewport width. Running
        // both satisfies the phase rule without pretending jsdom laid anything
        // out.
        //
        // Queried through each render's OWN container rather than `screen`:
        // RTL's bound queries resolve against `baseElement` (document.body),
        // so mounting the component twice in one case makes every
        // `getByTestId` ambiguous instead of returning the newer tree.
        const bar = (c: HTMLElement) =>
            c.querySelector('[data-testid="bottom-tab-bar"]') as HTMLElement;

        setViewport('mobile');
        const mobile = render(<BottomTabBar savedOrder={['/journal', '/dashboard']} />);
        expect(bar(mobile.container).className).toContain('md:hidden');
        const mobileMarkup = bar(mobile.container).innerHTML;
        mobile.unmount();
        restoreViewport();

        setViewport('desktop');
        const desktop = render(<BottomTabBar savedOrder={['/journal', '/dashboard']} />);
        expect(bar(desktop.container).innerHTML).toBe(mobileMarkup);
        desktop.unmount();
        restoreViewport();
    });
});

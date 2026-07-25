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
import { LayoutDashboard, MapPin, ClipboardList, NotebookPen, AlertTriangle } from 'lucide-react';

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

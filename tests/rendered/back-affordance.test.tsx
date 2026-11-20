/**
 * Smart-nav — <BackAffordance> two-tier resolution.
 *
 * Referrer (per-tab sessionStorage) wins; falls back to the IA-canonical
 * parent on a cold load; the sibling-detail guard skips a referrer that is
 * a sibling of the current page (both share a canonical parent) to avoid a
 * circular back-to-back.
 */
import { render, screen } from '@testing-library/react';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { prevPathStorageKey } from '@/lib/nav/usePreviousPath';

// usePathname is driven per-test via this mutable holder.
let currentPath = '/t/acme/locations/loc-1';
jest.mock('next/navigation', () => ({
    usePathname: () => currentPath,
}));

function setReferrer(path: string | null) {
    const key = prevPathStorageKey('acme');
    if (path === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, path);
}

beforeEach(() => {
    window.sessionStorage.clear();
    currentPath = '/t/acme/locations/loc-1';
});

describe('BackAffordance', () => {
    it('falls back to the canonical parent on a cold load (no referrer)', async () => {
        setReferrer(null);
        currentPath = '/t/acme/locations/loc-1';
        render(<BackAffordance />);
        const link = await screen.findByTestId('page-header-back');
        expect(link).toHaveAttribute('href', '/t/acme/locations');
        expect(link).toHaveTextContent('Map');
    });

    it('prefers the in-tab referrer over the canonical parent', async () => {
        // Arrived at a location detail FROM the dashboard.
        setReferrer('/t/acme/dashboard');
        currentPath = '/t/acme/locations/loc-1';
        render(<BackAffordance />);
        const link = await screen.findByTestId('page-header-back');
        expect(link).toHaveAttribute('href', '/t/acme/dashboard');
        expect(link).toHaveTextContent('Dashboard');
    });

    it('skips a sibling referrer and goes to the shared canonical parent', async () => {
        // Stepping /assets/A → /assets/B (both resolve to /assets): back
        // must go to the list, not the sibling asset.
        setReferrer('/t/acme/assets/A');
        currentPath = '/t/acme/assets/B';
        render(<BackAffordance />);
        const link = await screen.findByTestId('page-header-back');
        expect(link).toHaveAttribute('href', '/t/acme/assets');
        expect(link).toHaveTextContent('Assets');
    });

    it('renders nothing on a main page with no referrer', () => {
        setReferrer(null);
        currentPath = '/t/acme/dashboard';
        const { container } = render(<BackAffordance />);
        expect(container.querySelector('[data-testid="page-header-back"]')).toBeNull();
    });

    it('noFallback renders nothing without a referrer', () => {
        setReferrer(null);
        currentPath = '/t/acme/locations/loc-1';
        const { container } = render(<BackAffordance noFallback />);
        expect(container.querySelector('[data-testid="page-header-back"]')).toBeNull();
    });

    it('honours an explicit override', async () => {
        setReferrer('/t/acme/dashboard');
        currentPath = '/t/acme/locations/loc-1';
        render(<BackAffordance override={{ href: '/t/acme/custom', label: 'Custom' }} />);
        const link = await screen.findByTestId('page-header-back');
        expect(link).toHaveAttribute('href', '/t/acme/custom');
        expect(link).toHaveTextContent('Custom');
    });
});

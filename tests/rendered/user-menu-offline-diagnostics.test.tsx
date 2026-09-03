/**
 * The offline-diagnostics instrument must be REACHABLE from the installed PWA.
 *
 * WHY THIS FILE EXISTS, stated plainly so the row is not "tidied away" later:
 *
 * `/t/<slug>/diagnostics/offline` was built as a URL-addressable route and
 * deliberately left out of navigation (#760). In a browser that is survivable —
 * you type the URL. In the INSTALLED PWA it is fatal:
 * `public/manifest.webmanifest` is `display: standalone` with
 * `start_url: /tenants` and no `shortcuts`, so there is no address bar and,
 * before this row, nothing anywhere in `src/` linked the page — the only
 * mention was a docblock in `src/lib/offline/durability.ts`.
 *
 * That matters because the installed context is the ONLY one where iOS grants
 * `navigator.storage.persist()`. Measured on a physical iPhone: Safari REFUSES,
 * the installed PWA GRANTS. So the instrument was unreachable in precisely the
 * context whose answer differs from the other one — the comparison #648 exists
 * to make could not be completed.
 *
 * These tests pin BOTH directions, because each alone would be satisfied by a
 * broken implementation: a row that always renders would put a dead link in
 * front of the MECHANISATOR (middleware redirects `/diagnostics/*` to
 * `/my-work`), and a row that never renders is the bug itself.
 *
 * VIEWPORT: not overridden. The menu is identical at every width and the
 * assertions are on presence and href, not layout, so the jsdom phone default
 * is honest here.
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { UserMenu } from '@/components/layout/user-menu';

jest.mock('next-intl', () => ({
    useTranslations: () => {
        const t = (key: string) => key;
        t.has = () => false;
        t.rich = (key: string) => key;
        t.markup = (key: string) => key;
        t.raw = (key: string) => key;
        return t;
    },
}));

jest.mock('@/lib/auth/sign-out', () => ({ signOutAndPurge: jest.fn() }));
jest.mock('@/components/theme/ThemeToggle', () => ({ ThemeToggle: () => <div /> }));
jest.mock('@/components/layout/UserMenuLanguageToggle', () => ({
    UserMenuLanguageToggle: () => <div />,
}));

function open() {
    fireEvent.click(screen.getByTestId('top-chrome-user-menu'));
}

const BASE = {
    displayName: 'Ivan Petrov',
    displayEmail: 'ivan@example.com',
    displayImage: null,
};

describe('UserMenu — offline diagnostics row (#648)', () => {
    it('renders a link to the instrument when a href is supplied', () => {
        render(<UserMenu {...BASE} diagnosticsHref="/t/acme/diagnostics/offline" />);
        open();

        const row = screen.getByTestId('user-menu-offline-diagnostics');
        expect(row).toHaveAttribute('href', '/t/acme/diagnostics/offline');
        expect(row).toHaveAttribute('role', 'menuitem');
    });

    it('omits the row entirely when the caller passes null', () => {
        // null covers BOTH omit reasons — org chrome (no tenant in scope) and
        // operator mode (middleware would bounce the navigation). Asserting
        // absence rather than a disabled state is deliberate: a visible row
        // that does nothing reads as a broken instrument.
        render(<UserMenu {...BASE} diagnosticsHref={null} />);
        open();

        expect(screen.queryByTestId('user-menu-offline-diagnostics')).toBeNull();
        // Anti-vacuity: prove the menu actually OPENED, so the absence above is
        // a real absence and not "nothing rendered at all".
        expect(screen.getByTestId('user-menu-sign-out')).toBeInTheDocument();
    });
});

/**
 * @jest-environment jsdom
 *
 * The account shell's section nav (P2.7).
 *
 * The shell exists because `/account/profile` and `/account/security` were two
 * unrelated full-screen pages with no way to get from one to the other. This
 * nav is that way, so what matters is that both sections are present, the
 * current one is identifiable without colour, and the targets are thumb-sized
 * — this is the primary control on a phone, where the area has no sidebar.
 */
import type * as React from 'react';
import { render, screen } from '@testing-library/react';
import { restoreViewport, setViewport } from './viewport';

let mockPath = '/account/profile';
jest.mock('next/navigation', () => ({ usePathname: () => mockPath }));
jest.mock('next-intl', () => ({
    useTranslations: () => (k: string) => k,
}));
jest.mock('next/link', () => ({
    __esModule: true,
    // Typed rather than `any`: a new eslint-disable costs the same as a new
    // warning against the lint ceiling, and this one buys nothing.
    default: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & Record<string, unknown>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { AccountNav } from '@/app/account/AccountNav';

beforeEach(() => {
    mockPath = '/account/profile';
});

describe('AccountNav', () => {
    it('offers both sections — the thing that did not exist before', () => {
        render(<AccountNav />);
        expect(screen.getByTestId('account-nav-profile')).toHaveAttribute(
            'href',
            '/account/profile',
        );
        expect(screen.getByTestId('account-nav-security')).toHaveAttribute(
            'href',
            '/account/security',
        );
    });

    it('marks the current section with aria-current, not colour alone', () => {
        render(<AccountNav />);
        expect(screen.getByTestId('account-nav-profile')).toHaveAttribute('aria-current', 'page');
        expect(screen.getByTestId('account-nav-security')).not.toHaveAttribute('aria-current');
    });

    it('treats a nested route as inside its section', () => {
        // A future `/account/security/sessions` must not leave the nav looking
        // as though nothing is selected.
        mockPath = '/account/security/sessions';
        render(<AccountNav />);
        expect(screen.getByTestId('account-nav-security')).toHaveAttribute('aria-current', 'page');
    });

    it('keeps every target >=44px (Apple HIG / WCAG 2.5.5)', () => {
        render(<AccountNav />);
        for (const a of screen.getByTestId('account-nav').querySelectorAll('a')) {
            expect(a.className).toContain('min-h-[44px]');
        }
    });

    it('renders identically at both viewports', () => {
        // The shell has no sidebar to collapse, so the nav is viewport-
        // independent by design — asserted rather than assumed. Queried
        // through each render's own container: `screen` resolves against
        // document.body, so two mounts make every query ambiguous.
        const nav = (c: HTMLElement) =>
            c.querySelector('[data-testid="account-nav"]') as HTMLElement;

        setViewport('mobile');
        const m = render(<AccountNav />);
        const mobileMarkup = nav(m.container).innerHTML;
        m.unmount();
        restoreViewport();

        setViewport('desktop');
        const d = render(<AccountNav />);
        expect(nav(d.container).innerHTML).toBe(mobileMarkup);
        d.unmount();
        restoreViewport();
    });
});

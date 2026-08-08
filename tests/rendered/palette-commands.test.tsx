/**
 * Epic 57 — navigation + action commands inside the Command Palette.
 *
 * Verifies the contract for the two curated command buckets:
 *
 *   - Navigation commands (Go to Dashboard / Controls / …)
 *     render when a tenant slug is present in the URL, each carries
 *     the expected tenant-scoped `/t/<slug>/<route>` href, and
 *     selecting one calls `router.push()` + closes the palette.
 *
 *   - Action commands (Toggle theme / Sign out) invoke the
 *     appropriate handler. No action command issues a destructive
 *     operation — the two shipped are deliberately universal.
 *
 *   - Both buckets are hidden outside tenant routes (the palette on
 *     /login shows only the keyboard-shortcut discoverability group).
 *
 *   - Typing into the palette filters commands by label.
 */

import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react';

// Shared mocks — populated per-test.
const navigationMock = {
    pathname: '/t/acme-corp/dashboard',
    push: jest.fn(),
};
const signOutMock = jest.fn();
const toggleThemeMock = jest.fn();

jest.mock('next/navigation', () => ({
    usePathname: () => navigationMock.pathname,
    useRouter: () => ({
        push: (href: string) => navigationMock.push(href),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

jest.mock('next-auth/react', () => ({
    signOut: (opts: unknown) => {
        signOutMock(opts);
        return Promise.resolve();
    },
}));

// Stub `useTheme` so we don't need the real ThemeProvider tree just
// to exercise the action handler.
jest.mock('@/components/theme/ThemeProvider', () => ({
    useTheme: () => ({
        theme: 'dark',
        setTheme: jest.fn(),
        toggle: () => toggleThemeMock(),
    }),
    ThemeProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
}));


import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

import {
    CommandPalette,
    CommandPaletteProvider,
    useCommandPalette,
} from '@/components/command-palette';

// Render an auto-opened palette for each test.
function Shell({ children }: { children?: React.ReactNode }) {
    // Test-only inner component: opens the palette imperatively
    // after the provider mounts. Defined inline so it can call
    // useCommandPalette() under the just-mounted provider.

    function OpenOnMount() {
        const { open } = useCommandPalette();
        React.useEffect(() => {
            open();
        }, [open]);
        return null;
    }
    return (
        <KeyboardShortcutProvider>
            <CommandPaletteProvider>
                {/* eslint-disable-next-line react-hooks/static-components */}
                <OpenOnMount />
                {children}
                <CommandPalette />
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>
    );
}

beforeEach(() => {
    navigationMock.pathname = '/t/acme-corp/dashboard';
    navigationMock.push.mockReset();
    signOutMock.mockReset();
    toggleThemeMock.mockReset();
    // Stub fetch so the entity-search hook doesn't error when an
    // incidental query triggers it.
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ items: [] }),
    }));
});

afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

// ─── Navigation ───────────────────────────────────────────────────────

describe('Command Palette — navigation commands', () => {
    it('renders one row per curated navigation target', () => {
        render(<Shell />);
        const expected = [
            'nav:dashboard',
            'nav:evidence',
            'nav:vendors',
            'nav:admin',
        ];
        for (const id of expected) {
            const row = document.querySelector(
                `[data-testid="command-palette-nav-${id}"]`,
            );
            expect(row).not.toBeNull();
        }
    });

    it('each navigation row carries a tenant-scoped href', () => {
        render(<Shell />);
        const rows = document.querySelectorAll(
            '[data-testid^="command-palette-nav-nav:"]',
        );
        rows.forEach((row) => {
            const href = row.getAttribute('data-href');
            expect(href).toMatch(/^\/t\/acme-corp\//);
        });
    });

    it('selecting a navigation command calls router.push and closes the palette', async () => {
        const { queryByTestId } = render(<Shell />);
        const row = document.querySelector(
            '[data-testid="command-palette-nav-nav:evidence"]',
        )!;
        expect(row.getAttribute('data-href')).toBe('/t/acme-corp/evidence');

        fireEvent.click(row);
        expect(navigationMock.push).toHaveBeenCalledWith('/t/acme-corp/evidence');
        await waitFor(() => {
            expect(queryByTestId('command-palette-input')).toBeNull();
        });
    });

    it('no navigation rows render outside a tenant route', () => {
        navigationMock.pathname = '/login';
        render(<Shell />);
        expect(
            document.querySelectorAll(
                '[data-testid^="command-palette-nav-nav:"]',
            ).length,
        ).toBe(0);
    });

    it('filters commands by label when the user types', async () => {
        render(<Shell />);
        const input = document.querySelector(
            '[data-testid="command-palette-input"]',
        ) as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'evidence' } });

        // Commands filter immediately (no debounce). Nav:evidence stays,
        // non-matching commands (e.g. nav:vendors) disappear.
        // (This used 'risk' as the query until the register was removed;
        // the assertion is about the FILTER, not the entity.)
        await waitFor(() => {
            expect(
                document.querySelector(
                    '[data-testid="command-palette-nav-nav:evidence"]',
                ),
            ).not.toBeNull();
        });
        expect(
            document.querySelector(
                '[data-testid="command-palette-nav-nav:vendors"]',
            ),
        ).toBeNull();
    });
});

// ─── Actions ──────────────────────────────────────────────────────────

describe('Command Palette — action commands', () => {
    it('renders exactly the two safe, universal actions', () => {
        render(<Shell />);
        const actions = document.querySelectorAll(
            '[data-testid^="command-palette-action-action:"]',
        );
        const ids = Array.from(actions).map((a) =>
            a.getAttribute('data-testid'),
        );
        expect(ids.sort()).toEqual([
            'command-palette-action-action:sign-out',
            'command-palette-action-action:toggle-theme',
        ]);
    });

    it('selecting "Toggle theme" invokes the theme hook and closes the palette', async () => {
        const { queryByTestId } = render(<Shell />);
        const row = document.querySelector(
            '[data-testid="command-palette-action-action:toggle-theme"]',
        )!;
        fireEvent.click(row);

        await waitFor(() => {
            expect(queryByTestId('command-palette-input')).toBeNull();
        });
        // handleAction defers invocation by a microtask — flush.
        await act(async () => {
            await Promise.resolve();
        });
        expect(toggleThemeMock).toHaveBeenCalledTimes(1);
    });

    it('selecting "Sign out" calls next-auth signOut with the login callback', async () => {
        const { queryByTestId } = render(<Shell />);
        const row = document.querySelector(
            '[data-testid="command-palette-action-action:sign-out"]',
        )!;
        fireEvent.click(row);

        await waitFor(() => {
            expect(queryByTestId('command-palette-input')).toBeNull();
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(signOutMock).toHaveBeenCalledTimes(1);
        expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: '/login' });
    });

    it('actions do not render outside a tenant route', () => {
        navigationMock.pathname = '/login';
        render(<Shell />);
        expect(
            document.querySelectorAll(
                '[data-testid^="command-palette-action-action:"]',
            ).length,
        ).toBe(0);
    });
});

// ─── Source-level hint regression guards ──────────────────────────────

describe('Shortcut hints — filter trigger', () => {
    // Lightweight structural check that future UI refactors don't
    // accidentally strip the visible `F` hint off the filter trigger
    // or the aria-keyshortcuts affordance that screen readers pick up.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const ROOT = path.resolve(__dirname, '../..');

    let src = '';
    beforeAll(() => {
        src = fs.readFileSync(
            path.join(ROOT, 'src/components/ui/filter/filter-select.tsx'),
            'utf-8',
        );
    });

    it('exposes aria-keyshortcuts="F" on the trigger for assistive tech', () => {
        expect(src).toMatch(/aria-keyshortcuts=["']F["']/);
    });

    it('renders a visible <kbd> chip reading "F" on the trigger', () => {
        expect(src).toMatch(
            /<kbd[\s\S]*?data-filter-shortcut-hint[\s\S]*?>\s*F\s*<\/kbd>/,
        );
    });

    it('the trigger carries the data-filter-trigger marker for E2E / visual tests', () => {
        expect(src).toContain('data-filter-trigger');
    });
});

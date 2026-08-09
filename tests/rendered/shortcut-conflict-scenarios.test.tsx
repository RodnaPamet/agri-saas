/**
 * Epic 57 — final-hardening regression tests.
 *
 * These are the scenarios that describe the product's keyboard
 * contract to a future contributor. They are the "if this breaks,
 * something load-bearing changed" set.
 *
 *   1. Multiple Escape bindings at different priorities fire in the
 *      right order when their preconditions are active.
 *   2. With an overlay marker mounted (Radix Dialog, Vaul Drawer, or
 *      our `data-sheet-overlay`), every `scope: 'global'` binding
 *      stands down.
 *   3. The command palette opens from any route and layers above a
 *      pre-existing overlay.
 *   4. Typing a "regular" key into a form input never triggers a
 *      global shortcut — the input-target guard is absolute.
 *   5. `mod+k` wins even from inside an input and even while another
 *      overlay is open.
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';

const navigationMock = {
    pathname: '/t/acme-corp/dashboard',
    push: jest.fn(),
};
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
    signOut: jest.fn(),
    signIn: jest.fn(),
}));


import {
    KeyboardShortcutProvider,
    useKeyboardShortcut,
} from '@/lib/hooks/use-keyboard-shortcut';

import {
    CommandPalette,
    CommandPaletteProvider,
} from '@/components/command-palette';

beforeEach(() => {
    navigationMock.pathname = '/t/acme-corp/dashboard';
    navigationMock.push.mockReset();
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ items: [] }),
    }));
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

function Shell({ children }: { children?: React.ReactNode }) {
    return (
        <KeyboardShortcutProvider>
            <CommandPaletteProvider>
                {children}
                <CommandPalette />
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>
    );
}

// ─── Escape precedence ───────────────────────────────────────────────

function ClearSelection({ count, fn }: { count: number; fn: () => void }) {
    useKeyboardShortcut('Escape', fn, {
        enabled: count > 0,
        priority: 2,
        scope: 'global',
        description: 'Clear selection',
    });
    return null;
}

function ClearFilters({ fn }: { fn: () => void }) {
    useKeyboardShortcut('Escape', fn, {
        priority: 1,
        scope: 'global',
        description: 'Clear all filters',
    });
    return null;
}

function DrawerClose({ open, fn }: { open: boolean; fn: () => void }) {
    useKeyboardShortcut('Escape', fn, {
        enabled: open,
        priority: 5,
        scope: 'overlay',
        description: 'Close navigation drawer',
    });
    return null;
}

describe('Shortcut conflicts — Escape precedence', () => {
    it('drawer > selection > filter when their preconditions all hold', () => {
        const clearSelection = jest.fn();
        const clearFilters = jest.fn();
        const closeDrawer = jest.fn();
        render(
            <Shell>
                <div data-sheet-overlay />
                <DrawerClose open fn={closeDrawer} />
                <ClearSelection count={3} fn={clearSelection} />
                <ClearFilters fn={clearFilters} />
            </Shell>,
        );
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(closeDrawer).toHaveBeenCalledTimes(1);
        expect(clearSelection).not.toHaveBeenCalled();
        expect(clearFilters).not.toHaveBeenCalled();
    });

    it('selection beats filter when no drawer is open', () => {
        const clearSelection = jest.fn();
        const clearFilters = jest.fn();
        render(
            <Shell>
                <ClearSelection count={3} fn={clearSelection} />
                <ClearFilters fn={clearFilters} />
            </Shell>,
        );
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(clearSelection).toHaveBeenCalledTimes(1);
        expect(clearFilters).not.toHaveBeenCalled();
    });

    it('filter fires when neither selection nor drawer is active', () => {
        const clearSelection = jest.fn();
        const clearFilters = jest.fn();
        render(
            <Shell>
                <ClearSelection count={0} fn={clearSelection} />
                <ClearFilters fn={clearFilters} />
            </Shell>,
        );
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(clearSelection).not.toHaveBeenCalled();
        expect(clearFilters).toHaveBeenCalledTimes(1);
    });
});

// ─── Overlay standdown ───────────────────────────────────────────────

describe('Shortcut conflicts — overlay standdown', () => {
    it.each([
        ['Radix Dialog', <div key="d" role="dialog" data-state="open" aria-label="x" />],
        ['Vaul Drawer', <div key="v" data-vaul-drawer="true" data-state="open" />],
        ['app sheet marker', <div key="s" data-sheet-overlay />],
        ['legacy modal marker', <div key="m" data-modal-overlay />],
    ])('any global-scope binding stands down while %s is mounted', (_name, marker) => {
        const spy = jest.fn();
        function Binding() {
            useKeyboardShortcut('x', spy, { description: 'X' });
            return null;
        }
        render(
            <Shell>
                {marker}
                <Binding />
            </Shell>,
        );
        fireEvent.keyDown(window, { key: 'x' });
        expect(spy).not.toHaveBeenCalled();
    });
});

// ─── Command palette availability ────────────────────────────────────

describe('Command palette — availability across routes', () => {
    function openIsRendered(): boolean {
        return document.querySelector('[data-command-palette]') !== null;
    }

    const routes = [
        '/login',
        '/t/acme-corp/dashboard',
        '/t/acme-corp/practices',
        '/t/acme-corp/risks/risk-123',
        '/audit/shared/some-token',
    ];

    for (const pathname of routes) {
        it(`opens on mod+k from ${pathname}`, () => {
            navigationMock.pathname = pathname;
            render(<Shell />);
            act(() => {
                fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
            });
            expect(openIsRendered()).toBe(true);
        });
    }

    it('mod+k still fires from inside a focused input', () => {
        render(
            <Shell>
                <input aria-label="search" />
            </Shell>,
        );
        const input = document.querySelector(
            'input[aria-label="search"]',
        ) as HTMLInputElement;
        input.focus();
        act(() => {
            fireEvent.keyDown(input, { key: 'k', ctrlKey: true });
        });
        expect(document.querySelector('[data-command-palette]')).not.toBeNull();
    });

    it('mod+k opens ON TOP of an unrelated modal', () => {
        render(
            <Shell>
                <div role="dialog" data-state="open" aria-label="pre-existing" />
            </Shell>,
        );
        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        expect(document.querySelector('[data-command-palette]')).not.toBeNull();
    });
});

// ─── Input-target guard (no-hijack) ──────────────────────────────────

describe('Shortcut safety — input hijack', () => {
    it.each([
        ['input', 'input'],
        ['textarea', 'textarea'],
    ])('typing the shortcut key inside a <%s> does not fire it', async (_name, tag) => {
        const spy = jest.fn();
        function Binding() {
            useKeyboardShortcut('/', spy, { description: 'Focus search' });
            return null;
        }
        render(
            <Shell>
                <Binding />
                {tag === 'input' ? (
                    <input aria-label="field" />
                ) : (
                    <textarea aria-label="field" />
                )}
            </Shell>,
        );
        const el = document.querySelector('[aria-label="field"]') as HTMLElement;
        el.focus();
        fireEvent.keyDown(el, { key: '/' });
        expect(spy).not.toHaveBeenCalled();
    });

    it('typing the shortcut inside a role="combobox" trigger does not fire it', () => {
        const spy = jest.fn();
        function Binding() {
            useKeyboardShortcut('f', spy, { description: 'Open filters' });
            return null;
        }
        render(
            <Shell>
                <Binding />
                <button role="combobox" aria-practices="status-listbox" aria-expanded="false" aria-label="Status" />
            </Shell>,
        );
        const el = document.querySelector(
            '[role="combobox"]',
        ) as HTMLButtonElement;
        fireEvent.keyDown(el, { key: 'f' });
        expect(spy).not.toHaveBeenCalled();
    });
});

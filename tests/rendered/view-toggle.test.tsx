/**
 * Epic 66 — `<ViewToggle>` + `useViewMode` integration coverage.
 *
 * Verifies the toggle's interaction surface, the
 * `localStorage`-backed persistence (per-page key), the SSR-safe
 * fallback behaviour from the underlying `useLocalStorage`, and
 * that toggling does NOT remount or otherwise disturb sibling
 * filter / search state passed alongside it in the toolbar.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { act, fireEvent, render } from '@testing-library/react';

import { ViewToggle } from '@/components/ui/view-toggle';
import {
    useViewMode,
    viewModeStorageKey,
    type ViewMode,
} from '@/components/ui/hooks';

// ─── ViewToggle (controlled) ───────────────────────────────────────

describe('ViewToggle — controlled', () => {
    it('renders both Table and Cards options as a radiogroup', () => {
        const { container, getByRole } = render(
            <ViewToggle view="table" onChange={() => undefined} />,
        );
        expect(getByRole('radiogroup')).toBeTruthy();
        const radios = container.querySelectorAll('[role="radio"]');
        expect(radios.length).toBe(2);
    });

    it('marks the selected option with aria-checked + data-selected', () => {
        const { container } = render(
            <ViewToggle view="cards" onChange={() => undefined} />,
        );
        const cardsRadio = container.querySelector(
            '#view-toggle-cards',
        ) as HTMLElement;
        const tableRadio = container.querySelector(
            '#view-toggle-table',
        ) as HTMLElement;
        expect(cardsRadio.getAttribute('aria-checked')).toBe('true');
        expect(tableRadio.getAttribute('aria-checked')).toBe('false');
    });

    it('fires onChange with the picked mode', () => {
        const onChange = jest.fn();
        const { container } = render(
            <ViewToggle view="table" onChange={onChange} />,
        );
        const cardsRadio = container.querySelector(
            '#view-toggle-cards',
        ) as HTMLElement;
        fireEvent.click(cardsRadio);
        expect(onChange).toHaveBeenCalledWith('cards');
    });

    it('exposes the active view as data-view on the wrapper', () => {
        const { container, rerender } = render(
            <ViewToggle view="table" onChange={() => undefined} />,
        );
        expect(
            container
                .querySelector('[data-view-toggle]')
                ?.getAttribute('data-view'),
        ).toBe('table');
        rerender(<ViewToggle view="cards" onChange={() => undefined} />);
        expect(
            container
                .querySelector('[data-view-toggle]')
                ?.getAttribute('data-view'),
        ).toBe('cards');
    });

    it('honours a custom aria-label', () => {
        const { getByRole } = render(
            <ViewToggle
                view="table"
                onChange={() => undefined}
                ariaLabel="Practices view mode"
            />,
        );
        expect(getByRole('radiogroup').getAttribute('aria-label')).toBe(
            'Practices view mode',
        );
    });
});

// ─── useViewMode — persistence ──────────────────────────────────────

function Harness({
    page,
    initial,
    onReady,
}: {
    page: string;
    initial?: ViewMode;
    onReady: (api: ReturnType<typeof useViewMode>) => void;
}) {
    const api = useViewMode(page, initial);
    React.useEffect(() => {
        onReady(api);
    }, [api, onReady]);
    return <ViewToggle view={api[0]} onChange={api[1]} />;
}

describe('useViewMode — persistence', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it('returns the initial view (default `table`) on first render before hydration', () => {
        let api: ReturnType<typeof useViewMode> | undefined;
        render(
            <Harness page="practices" onReady={(a) => (api = a)} />,
        );
        // Without a prior value in storage, the hook stays on the
        // initial value through hydration.
        expect(api?.[0]).toBe('table');
    });

    it('respects a custom `initial` argument', () => {
        let api: ReturnType<typeof useViewMode> | undefined;
        render(
            <Harness
                page="vendors"
                initial="cards"
                onReady={(a) => (api = a)}
            />,
        );
        expect(api?.[0]).toBe('cards');
    });

    it('persists the chosen view to localStorage under the per-page key', () => {
        let api: ReturnType<typeof useViewMode> | undefined;
        const { container } = render(
            <Harness page="practices" onReady={(a) => (api = a)} />,
        );
        act(() => {
            api?.[1]('cards');
        });
        // The persisted value uses the per-page namespaced key.
        const raw = window.localStorage.getItem(
            viewModeStorageKey('practices'),
        );
        // Stored as JSON via useLocalStorage's default serializer.
        expect(raw).toBe('"cards"');
        expect(
            container
                .querySelector('[data-view-toggle]')
                ?.getAttribute('data-view'),
        ).toBe('cards');
    });

    it('hydrates from a pre-existing localStorage value', async () => {
        window.localStorage.setItem(
            viewModeStorageKey('vendors'),
            '"cards"',
        );
        let api: ReturnType<typeof useViewMode> | undefined;
        render(
            <Harness page="vendors" onReady={(a) => (api = a)} />,
        );
        // useLocalStorage hydrates inside a useEffect — wait for it.
        await act(async () => {
            await Promise.resolve();
        });
        expect(api?.[0]).toBe('cards');
    });

    it('different pages persist independently (per-page namespacing)', () => {
        let a: ReturnType<typeof useViewMode> | undefined;
        let b: ReturnType<typeof useViewMode> | undefined;
        render(
            <>
                <Harness page="practices" onReady={(x) => (a = x)} />
                <Harness page="risks" onReady={(x) => (b = x)} />
            </>,
        );
        act(() => {
            a?.[1]('cards');
        });
        // Other page's storage entry untouched.
        expect(
            window.localStorage.getItem(viewModeStorageKey('practices')),
        ).toBe('"cards"');
        expect(
            window.localStorage.getItem(viewModeStorageKey('risks')),
        ).toBeNull();
        expect(b?.[0]).toBe('table');
    });

    it('coerces a corrupted localStorage value back to the initial mode', async () => {
        // Simulate a user editing devtools / older storage shape.
        window.localStorage.setItem(
            viewModeStorageKey('policies'),
            '"kanban"',
        );
        let api: ReturnType<typeof useViewMode> | undefined;
        render(
            <Harness page="policies" onReady={(a) => (api = a)} />,
        );
        await act(async () => {
            await Promise.resolve();
        });
        // 'kanban' is not a known ViewMode — coerced back to 'table'.
        expect(api?.[0]).toBe('table');
    });

    it('refuses to persist a bogus mode (defensive narrowing on write)', () => {
        let api: ReturnType<typeof useViewMode> | undefined;
        render(
            <Harness page="practices" onReady={(a) => (api = a)} />,
        );
        act(() => {
            // Caller bypasses TypeScript and passes an unknown mode.
            (api?.[1] as (m: string) => void)('kanban');
        });
        // The hook coerces it back to 'table' before writing.
        expect(
            window.localStorage.getItem(viewModeStorageKey('practices')),
        ).toBe('"table"');
    });
});

// ─── Filter/search-state preservation contract ──────────────────────

describe('ViewToggle — does not disturb sibling state', () => {
    function Toolbar({ page }: { page: string }) {
        const [view, setView] = useViewMode(page);
        const [search, setSearch] = React.useState('initial query');
        return (
            <div>
                <input
                    aria-label="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <ViewToggle view={view} onChange={setView} />
                <span data-testid="active-view">{view}</span>
                <span data-testid="active-search">{search}</span>
            </div>
        );
    }

    it('switching view leaves the sibling search input value intact', () => {
        window.localStorage.clear();
        const { container, getByTestId, getByLabelText } = render(
            <Toolbar page="practices" />,
        );
        // Type a fresh query (not the default).
        const searchInput = getByLabelText('search') as HTMLInputElement;
        fireEvent.change(searchInput, {
            target: { value: 'firewall' },
        });
        expect(getByTestId('active-search').textContent).toBe('firewall');
        expect(getByTestId('active-view').textContent).toBe('table');

        // Flip the view.
        const cardsRadio = container.querySelector(
            '#view-toggle-cards',
        ) as HTMLElement;
        fireEvent.click(cardsRadio);

        // View flipped, search untouched.
        expect(getByTestId('active-view').textContent).toBe('cards');
        expect(getByTestId('active-search').textContent).toBe('firewall');
        expect(searchInput.value).toBe('firewall');
    });
});

// ─── viewModeStorageKey ─────────────────────────────────────────────

describe('viewModeStorageKey', () => {
    it('namespaces with the inflect:view-mode: prefix', () => {
        expect(viewModeStorageKey('practices')).toBe(
            'inflect:view-mode:practices',
        );
    });
});

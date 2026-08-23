/**
 * `useFilterContext` URL sync — the EMPTY query-string arm.
 *
 * Target: `src/components/ui/filter/filter-context.tsx`, the last line of
 * the `pushToUrl` callback:
 *
 *     router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false })
 *
 * The TRUE arm runs on every ordinary filter change. The FALSE arm — bare
 * pathname, no `?`, no query string — is reached only when EVERY filter
 * AND the search have been cleared, so the URL sync has nothing left to
 * serialise. Nothing exercised it deliberately: it was hit by accident in
 * one run and not in another, which made the branch's coverage differ
 * between a sharded and an unsharded run. This suite states it as a
 * contract instead, and asserts the ARGUMENT `router.replace` receives —
 * "replace was called" is exactly the assertion that cannot tell the two
 * arms apart.
 *
 * Two independent routes into the empty-`qs` case are covered, because
 * `pushToUrl` builds `params` from three sources (existing search params,
 * the filter state, the search query) and only the intersection of all
 * three being empty produces the bare pathname:
 *
 *   1. `clearAll()` — driven through the real "Clear Filters" button in
 *      `<FilterList>`, with both a filter and a search active.
 *   2. `setSearch('')` — the search was the only param in the URL.
 *
 * ── Viewport ────────────────────────────────────────────────────────
 * Every case below pins its viewport EXPLICITLY rather than inheriting
 * the jsdom phone default. `pushToUrl` itself has no media-query branch;
 * the surrounding toolbar does (`FilterUI.Select` reads `useMediaQuery`
 * for its popover width), so the clear-all case is asserted on BOTH a
 * phone and a desktop to show the URL it writes is the same either way.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { restoreViewport, setViewport, type Viewport } from './viewport';

const mockPathname = '/t/acme/journal';
const mockReplace = jest.fn();

// The filter system's URL-sync layer calls the Next router — mock it, but
// keep `replace` a STABLE jest.fn (the other filter suites hand out a
// fresh `jest.fn()` per render, which cannot be asserted against).
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: mockReplace,
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => mockPathname,
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { CheckCircle } from 'lucide-react';

import { FilterToolbar } from '@/components/filters/FilterToolbar';
import {
    createFilterDefs,
    FilterProvider,
    useFilterContext,
    useFilters,
} from '@/components/ui/filter';

const { filters: defs, filterKeys } = createFilterDefs({
    status: {
        label: 'Status',
        icon: CheckCircle,
        options: [
            { value: 'ACTIVE', label: 'Active' },
            { value: 'DRAFT', label: 'Draft' },
        ],
    },
});

/**
 * Buttons that drive the context mutations directly, so a case can set up
 * "a filter and a search are both active" without depending on the
 * dropdown's internals. The CLEARING half still goes through real UI
 * where there is one (the "Clear Filters" button).
 */
function Controls() {
    const { set, setSearch } = useFilters();
    return (
        <>
            <button type="button" onClick={() => set('status', 'ACTIVE')}>
                seed-filter
            </button>
            <button type="button" onClick={() => setSearch('wheat')}>
                seed-search
            </button>
            <button type="button" onClick={() => setSearch('')}>
                clear-search
            </button>
        </>
    );
}

function Shell() {
    const ctx = useFilterContext(defs, filterKeys);
    return (
        <FilterProvider value={ctx}>
            <Controls />
            <FilterToolbar filters={defs} />
        </FilterProvider>
    );
}

/** The `(url, options)` pair of the most recent `router.replace` call. */
function lastReplaceCall(): [string, { scroll: boolean }] {
    expect(mockReplace).toHaveBeenCalled();
    return mockReplace.mock.calls[mockReplace.mock.calls.length - 1] as [
        string,
        { scroll: boolean },
    ];
}

function click(name: string | RegExp) {
    act(() => {
        fireEvent.click(screen.getByRole('button', { name }));
    });
}

describe('useFilterContext — pushToUrl query-string arms', () => {
    beforeEach(() => {
        mockReplace.mockClear();
    });

    afterEach(restoreViewport);

    it('writes `?<qs>` while any filter or search is active (phone)', async () => {
        setViewport('mobile');
        render(<Shell />);

        click('seed-filter');
        await waitFor(() => {
            expect(lastReplaceCall()[0]).toBe(`${mockPathname}?status=ACTIVE`);
        });

        click('seed-search');
        await waitFor(() => {
            expect(lastReplaceCall()[0]).toBe(
                `${mockPathname}?status=ACTIVE&q=wheat`,
            );
        });
        expect(lastReplaceCall()[1]).toEqual({ scroll: false });
    });

    // The clear-all route into the empty-`qs` arm, asserted on both
    // devices — the toolbar around it is viewport-sensitive, the URL is
    // not.
    it.each<[Viewport]>([['mobile'], ['desktop']])(
        'clearing every filter AND the search replaces with the BARE pathname (%s)',
        async (viewport) => {
            setViewport(viewport);
            render(<Shell />);

            // Both sources of query params are populated first, so the
            // clear has something to remove on each of them.
            click('seed-filter');
            click('seed-search');
            await waitFor(() => {
                expect(lastReplaceCall()[0]).toBe(
                    `${mockPathname}?status=ACTIVE&q=wheat`,
                );
            });

            // Real UI: the "Clear Filters" button `<FilterList>` renders
            // once a pill is active.
            click(/clear filters/i);

            await waitFor(() => {
                const [url, options] = lastReplaceCall();
                // The FALSE arm of `qs ? `?${qs}` : ""` — pathname only.
                expect(url).toBe(mockPathname);
                expect(url).not.toContain('?');
                expect(options).toEqual({ scroll: false });
            });
        },
    );

    it('clearing a search that was the only param replaces with the BARE pathname (phone)', async () => {
        setViewport('mobile');
        render(<Shell />);

        click('seed-search');
        await waitFor(() => {
            expect(lastReplaceCall()[0]).toBe(`${mockPathname}?q=wheat`);
        });

        click('clear-search');
        await waitFor(() => {
            const [url, options] = lastReplaceCall();
            expect(url).toBe(mockPathname);
            expect(url).not.toContain('?');
            expect(options).toEqual({ scroll: false });
        });
    });
});

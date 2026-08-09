/**
 * R23-PR-B — `useKpiFilter` behavioural unit test.
 *
 * Pairs with the structural ratchet at
 * `tests/guards/r23-prb-kpi-filter-hook.test.ts`. This file owns
 * the behavioural contract; the ratchet owns the API shape lock.
 *
 * Covers:
 *   - activeKpiId resolves to the single matching def
 *   - activeKpiId is null when no def matches
 *   - activeKpiId is null when MULTIPLE defs match (mutual-exclusion
 *     contract — the page author owns mutual exclusivity; the hook
 *     just reports the ambiguity)
 *   - toggle: inactive → apply; active → clear
 *   - select: always applies (no toggle)
 *   - clear: calls ctx.clearAll
 *
 * Implementation note: the hook reads from `useFilters()` which
 * requires `<FilterProvider>`. We wrap the test harness in a
 * provider with a practicelable mock context value so the test can
 * drive the state shape directly.
 */
import * as React from 'react';
import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';

import {
    FilterProvider,
    type FilterContextValue,
    type FilterState,
} from '@/components/ui/filter';
import {
    useKpiFilter,
    type KpiFilterDef,
} from '@/components/ui/kpi-filter';

function makeMockCtx(initial: FilterState = {}): {
    ctx: FilterContextValue;
    setState: (next: FilterState) => void;
    clearAllSpy: jest.Mock;
    setSpy: jest.Mock;
} {
    let state = initial;
    const clearAllSpy = jest.fn(() => {
        state = {};
    });
    const setSpy = jest.fn((key: string, value: string) => {
        state = { ...state, [key]: [value] };
    });
    // The test wraps the renderHook output in a FilterProvider whose
    // value mutates between renders via the practicelable closure. The
    // re-render trigger comes from React testing-library — we just
    // ensure the provider value re-references state each render.
    const ctx: FilterContextValue = {
        get state() {
            return state;
        },
        filters: [],
        filterKeys: [],
        set: setSpy,
        add: jest.fn(),
        remove: jest.fn(),
        removeAll: jest.fn(),
        toggle: jest.fn(),
        clearAll: clearAllSpy,
        hasActive: false,
        activeCount: 0,
        search: '',
        setSearch: jest.fn(),
    };
    return {
        ctx,
        setState: (next) => {
            state = next;
        },
        clearAllSpy,
        setSpy,
    };
}

type KpiId = 'all' | 'open' | 'overdue';

const defs: ReadonlyArray<KpiFilterDef<KpiId>> = [
    {
        id: 'all',
        apply: (ctx) => ctx.clearAll(),
        isActive: (state) => Object.keys(state).length === 0,
    },
    {
        id: 'open',
        apply: (ctx) => ctx.set('status', 'OPEN'),
        isActive: (state) => (state.status ?? []).includes('OPEN'),
    },
    {
        id: 'overdue',
        apply: (ctx) => ctx.set('overdue', '1'),
        isActive: (state) => (state.overdue ?? []).includes('1'),
    },
];

describe('useKpiFilter', () => {
    it('activeKpiId resolves to the single matching def', () => {
        const { ctx } = makeMockCtx({ status: ['OPEN'] });
        const { result } = renderHook(() => useKpiFilter(defs), {
            wrapper: ({ children }) => (
                <FilterProvider value={ctx}>{children}</FilterProvider>
            ),
        });
        expect(result.current.activeKpiId).toBe('open');
    });

    it('activeKpiId is `all` when no filters are set (the implicit default)', () => {
        const { ctx } = makeMockCtx({});
        const { result } = renderHook(() => useKpiFilter(defs), {
            wrapper: ({ children }) => (
                <FilterProvider value={ctx}>{children}</FilterProvider>
            ),
        });
        expect(result.current.activeKpiId).toBe('all');
    });

    it('activeKpiId is null when no def matches the current state', () => {
        // status=CLOSED matches neither `all` (state is non-empty)
        // nor `open` (status doesn't include OPEN) nor `overdue`.
        const { ctx } = makeMockCtx({ status: ['CLOSED'] });
        const { result } = renderHook(() => useKpiFilter(defs), {
            wrapper: ({ children }) => (
                <FilterProvider value={ctx}>{children}</FilterProvider>
            ),
        });
        expect(result.current.activeKpiId).toBeNull();
    });

    it('activeKpiId is null when MULTIPLE defs match (mutual-exclusion contract)', () => {
        // status=OPEN AND overdue=1 → both `open` and `overdue` defs
        // report active. The hook resolves to null rather than
        // silently picking a winner.
        const { ctx } = makeMockCtx({ status: ['OPEN'], overdue: ['1'] });
        const { result } = renderHook(() => useKpiFilter(defs), {
            wrapper: ({ children }) => (
                <FilterProvider value={ctx}>{children}</FilterProvider>
            ),
        });
        expect(result.current.activeKpiId).toBeNull();
    });

    it('toggle: inactive KPI → calls apply (sets the filter)', () => {
        const { ctx, setSpy } = makeMockCtx({});
        const { result } = renderHook(() => useKpiFilter(defs), {
            wrapper: ({ children }) => (
                <FilterProvider value={ctx}>{children}</FilterProvider>
            ),
        });
        act(() => {
            result.current.toggle('open');
        });
        expect(setSpy).toHaveBeenCalledWith('status', 'OPEN');
    });

    it('toggle: active KPI → calls clearAll (deactivates)', () => {
        const { ctx, clearAllSpy } = makeMockCtx({ status: ['OPEN'] });
        const { result } = renderHook(() => useKpiFilter(defs), {
            wrapper: ({ children }) => (
                <FilterProvider value={ctx}>{children}</FilterProvider>
            ),
        });
        // 'open' is active given the initial state. Toggling it
        // should clear, not re-apply.
        act(() => {
            result.current.toggle('open');
        });
        expect(clearAllSpy).toHaveBeenCalled();
    });

    it('select: always applies (no toggle semantics)', () => {
        const { ctx, setSpy, clearAllSpy } = makeMockCtx({ status: ['OPEN'] });
        const { result } = renderHook(() => useKpiFilter(defs), {
            wrapper: ({ children }) => (
                <FilterProvider value={ctx}>{children}</FilterProvider>
            ),
        });
        // 'open' is active. select('open') still calls apply (it
        // doesn't deactivate). Useful for cases where the page
        // wants explicit "this KPI is now active" semantics.
        act(() => {
            result.current.select('open');
        });
        expect(setSpy).toHaveBeenCalledWith('status', 'OPEN');
        expect(clearAllSpy).not.toHaveBeenCalled();
    });

    it('clear: calls ctx.clearAll', () => {
        const { ctx, clearAllSpy } = makeMockCtx({ status: ['OPEN'] });
        const { result } = renderHook(() => useKpiFilter(defs), {
            wrapper: ({ children }) => (
                <FilterProvider value={ctx}>{children}</FilterProvider>
            ),
        });
        act(() => {
            result.current.clear();
        });
        expect(clearAllSpy).toHaveBeenCalled();
    });

    it('toggle is a no-op when called with an unknown id', () => {
        const { ctx, clearAllSpy, setSpy } = makeMockCtx({});
        const { result } = renderHook(() => useKpiFilter(defs), {
            wrapper: ({ children }) => (
                <FilterProvider value={ctx}>{children}</FilterProvider>
            ),
        });
        // 'doesnt-exist' is not in the defs array — toggle silently
        // ignores it (no apply, no clear).
        act(() => {
            // TypeScript would catch this at compile time; the runtime
            // safety is documented behaviour.
            (result.current.toggle as (id: string) => void)('doesnt-exist');
        });
        expect(setSpy).not.toHaveBeenCalled();
        expect(clearAllSpy).not.toHaveBeenCalled();
    });
});

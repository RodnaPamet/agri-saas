/**
 * Epic 59 — chart interaction primitives.
 *
 * Behavioural coverage for the shared interaction layer every Epic
 * 59 chart builds on:
 *
 *   - `<ChartTooltipSync>` — sync state initialises + updates.
 *   - `useChartHover` — returns a structured hover snapshot that
 *     resolves the date to the matching datum index.
 *   - `useChartKeyboardNavigation` — ArrowLeft / ArrowRight / Home
 *     / End / Escape move the focused index, clamp at endpoints,
 *     and propagate into `ChartTooltipSync` so the hover echoes on
 *     peer charts.
 *   - `useChartContext` / `useChartTooltipContext` — throw outside
 *     a provider, as the API documents.
 *   - `<ChartTooltipContainer>` / `<ChartTooltipRow>` — render with
 *     the canonical token classes, support colour-swatch prop, and
 *     emit `data-chart-tooltip` / `data-chart-tooltip-row` markers
 *     for cross-chart styling / E2E selectors.
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';

import {
    ChartContext,
    ChartTooltipContainer,
    ChartTooltipContext,
    ChartTooltipRow,
    ChartTooltipSync,
    useChartContext,
    useChartHover,
    useChartKeyboardNavigation,
    useChartTooltipContext,
} from '@/components/ui/charts';
import { ChartTooltipSyncContext } from '@/components/ui/charts/tooltip-sync';
import type {
    ChartHoverState,
    Data,
} from '@/components/ui/charts';

// Canned multi-datum data set.
interface DemoValues {
    coverage: number;
}
const data: Data<DemoValues> = [
    { date: new Date('2026-04-01T00:00:00Z'), values: { coverage: 70 } },
    { date: new Date('2026-04-02T00:00:00Z'), values: { coverage: 72 } },
    { date: new Date('2026-04-03T00:00:00Z'), values: { coverage: 74 } },
    { date: new Date('2026-04-04T00:00:00Z'), values: { coverage: 76 } },
    { date: new Date('2026-04-05T00:00:00Z'), values: { coverage: 78 } },
];

// ─── useChartHover ───────────────────────────────────────────────────

describe('useChartHover', () => {
    function Probe({
        onState,
    }: {
        onState: (s: ReturnType<typeof useChartHover<DemoValues>>) => void;
    }) {
        const state = useChartHover<DemoValues>(data);
        React.useEffect(() => {
            onState(state);
        }, [state, onState]);
        return null;
    }

    it('returns a cleared state by default (no hover)', () => {
        const onState = jest.fn();
        render(
            <ChartTooltipSync>
                <Probe onState={onState} />
            </ChartTooltipSync>,
        );
        const last = onState.mock.calls[onState.mock.calls.length - 1][0];
        expect(last.date).toBeNull();
        expect(last.index).toBe(-1);
        expect(last.datum).toBeNull();
    });

    it('resolves the hovered date to a matching datum + index', () => {
        const onState = jest.fn();
        function Driver() {
            const { setTooltipDate } = React.useContext(ChartTooltipSyncContext);
            React.useEffect(() => {
                setTooltipDate?.(new Date('2026-04-03T00:00:00Z'));
            }, [setTooltipDate]);
            return null;
        }
        render(
            <ChartTooltipSync>
                <Driver />
                <Probe onState={onState} />
            </ChartTooltipSync>,
        );
        const last = onState.mock.calls[onState.mock.calls.length - 1][0];
        expect(last.index).toBe(2);
        expect(last.datum?.values.coverage).toBe(74);
    });

    it('reports index -1 when the hovered date is not in the data set', () => {
        const onState = jest.fn();
        function Driver() {
            const { setTooltipDate } = React.useContext(ChartTooltipSyncContext);
            React.useEffect(() => {
                setTooltipDate?.(new Date('1999-01-01T00:00:00Z'));
            }, [setTooltipDate]);
            return null;
        }
        render(
            <ChartTooltipSync>
                <Driver />
                <Probe onState={onState} />
            </ChartTooltipSync>,
        );
        const last = onState.mock.calls[onState.mock.calls.length - 1][0];
        expect(last.index).toBe(-1);
        expect(last.datum).toBeNull();
        expect(last.date).not.toBeNull();
    });

    it('is safe to call outside a ChartTooltipSync — returns cleared state', () => {
        const onState = jest.fn();
        render(<Probe onState={onState} />);
        const last = onState.mock.calls[onState.mock.calls.length - 1][0];
        expect(last.date).toBeNull();
        expect(last.index).toBe(-1);
    });
});

// ─── useChartKeyboardNavigation ──────────────────────────────────────

describe('useChartKeyboardNavigation', () => {
    function Nav({
        onFocusIndexChange,
        focusedIndex,
    }: {
        onFocusIndexChange?: (i: number) => void;
        focusedIndex?: number;
    }) {
        const { onKeyDown, focusedIndex: current } = useChartKeyboardNavigation({
            data,
            focusedIndex,
            onFocusIndexChange,
        });
        return (
            <div
                tabIndex={0}
                onKeyDown={onKeyDown}
                data-testid="nav"
                data-focus={current}
            />
        );
    }

    function press(el: Element, key: string) {
        act(() => {
            fireEvent.keyDown(el, { key });
        });
    }

    it('ArrowRight moves the focused index forward, clamped at the end', () => {
        const spy = jest.fn();
        const { getByTestId } = render(<Nav onFocusIndexChange={spy} />);
        const nav = getByTestId('nav');
        press(nav, 'ArrowRight');
        expect(spy).toHaveBeenLastCalledWith(1);
        for (let i = 0; i < 10; i++) press(nav, 'ArrowRight');
        // Clamp to last index (4).
        expect(spy).toHaveBeenLastCalledWith(4);
    });

    it('ArrowLeft moves backward, clamped at 0', () => {
        // Uncontrolled mode so the hook's internal state advances
        // between presses. (Controlled mode always recomputes from
        // the passed prop, which the separate `focusedIndex` arg
        // stays pinned at by design.)
        const spy = jest.fn();
        const { getByTestId } = render(<Nav onFocusIndexChange={spy} />);
        const nav = getByTestId('nav');
        // Walk forward to index 3 first.
        press(nav, 'ArrowRight');
        press(nav, 'ArrowRight');
        press(nav, 'ArrowRight');
        expect(spy).toHaveBeenLastCalledWith(3);
        press(nav, 'ArrowLeft');
        expect(spy).toHaveBeenLastCalledWith(2);
        press(nav, 'ArrowLeft');
        press(nav, 'ArrowLeft');
        press(nav, 'ArrowLeft');
        // Clamped to 0 (can't go lower).
        expect(spy).toHaveBeenLastCalledWith(0);
    });

    it('Home jumps to 0 and End jumps to the last index', () => {
        const spy = jest.fn();
        const { getByTestId } = render(<Nav onFocusIndexChange={spy} />);
        const nav = getByTestId('nav');
        press(nav, 'End');
        expect(spy).toHaveBeenLastCalledWith(data.length - 1);
        press(nav, 'Home');
        expect(spy).toHaveBeenLastCalledWith(0);
    });

    it('Escape clears the focus to -1', () => {
        const spy = jest.fn();
        const { getByTestId } = render(<Nav onFocusIndexChange={spy} />);
        const nav = getByTestId('nav');
        press(nav, 'ArrowRight');
        press(nav, 'Escape');
        expect(spy).toHaveBeenLastCalledWith(-1);
    });

    it('keyboard focus propagates into ChartTooltipSync so peer charts echo', () => {
        // Keep the peer state in a ref so TypeScript's narrow-at-declaration
        // practice flow doesn't pin the type to `null`.
        const peerRef: { current: ChartHoverState<DemoValues> | null } = {
            current: null,
        };
        function Peer() {
            peerRef.current = useChartHover<DemoValues>(data);
            return null;
        }
        const spy = jest.fn();
        const { getByTestId } = render(
            <ChartTooltipSync>
                <Nav onFocusIndexChange={spy} />
                <Peer />
            </ChartTooltipSync>,
        );
        const nav = getByTestId('nav');
        press(nav, 'ArrowRight');
        expect(peerRef.current?.datum?.values.coverage).toBe(72);
        press(nav, 'End');
        expect(peerRef.current?.datum?.values.coverage).toBe(78);
        press(nav, 'Escape');
        expect(peerRef.current?.datum).toBeNull();
    });
});

// ─── Chart context hooks — throw outside a provider ─────────────────

describe('useChartContext / useChartTooltipContext', () => {
    function ChartContextProbe() {
        useChartContext();
        return null;
    }
    function ChartTooltipContextProbe() {
        useChartTooltipContext();
        return null;
    }

    it('useChartContext throws when no provider is mounted', () => {
        const originalError = console.error;
        console.error = jest.fn();
        expect(() => render(<ChartContextProbe />)).toThrow(/No chart context/);
        console.error = originalError;
    });

    it('useChartTooltipContext throws when no provider is mounted', () => {
        const originalError = console.error;
        console.error = jest.fn();
        expect(() => render(<ChartTooltipContextProbe />)).toThrow(
            /No chart tooltip context/,
        );
        console.error = originalError;
    });

    it('useChartContext resolves when a value is provided', () => {
        const fakeCtx = {
            width: 100,
            height: 50,
        } as unknown as React.ContextType<typeof ChartContext>;
        function Probe() {
            const ctx = useChartContext();
            return <div data-testid="w">{(ctx as { width: number }).width}</div>;
        }
        const { getByTestId } = render(
            <ChartContext.Provider value={fakeCtx}>
                <Probe />
            </ChartContext.Provider>,
        );
        expect(getByTestId('w').textContent).toBe('100');
    });

    it('useChartTooltipContext resolves when a value is provided', () => {
        const fakeTip = {} as unknown as React.ContextType<
            typeof ChartTooltipContext
        >;
        function Probe() {
            const ctx = useChartTooltipContext();
            return <div data-testid="ok">{typeof ctx === 'object' ? 'yes' : 'no'}</div>;
        }
        const { getByTestId } = render(
            <ChartTooltipContext.Provider value={fakeTip}>
                <Probe />
            </ChartTooltipContext.Provider>,
        );
        expect(getByTestId('ok').textContent).toBe('yes');
    });
});

// ─── Token-backed tooltip primitives ─────────────────────────────────

describe('ChartTooltipContainer + ChartTooltipRow', () => {
    it('ChartTooltipContainer renders with canonical token classes', () => {
        const { container } = render(
            <ChartTooltipContainer title="16 Apr 2026">
                <span>body</span>
            </ChartTooltipContainer>,
        );
        const root = container.querySelector(
            '[data-chart-tooltip]',
        ) as HTMLElement;
        expect(root).not.toBeNull();
        // Token-backed surface classes the rest of the app uses.
        expect(root.className).toContain('bg-bg-elevated');
        expect(root.className).toContain('border-border-default');
        expect(root.className).toContain('text-content-default');
        // Title renders above the body.
        expect(root.textContent).toContain('16 Apr 2026');
        expect(root.textContent).toContain('body');
    });

    it('ChartTooltipRow renders label + value + token-class swatch', () => {
        const { container } = render(
            <ChartTooltipRow
                label="Coverage"
                value="72%"
                swatch="bg-brand-emphasis"
            />,
        );
        const row = container.querySelector(
            '[data-chart-tooltip-row]',
        ) as HTMLElement;
        expect(row).not.toBeNull();
        expect(row.textContent).toContain('Coverage');
        expect(row.textContent).toContain('72%');
        const swatch = row.querySelector('.bg-brand-emphasis');
        expect(swatch).not.toBeNull();
    });

    it('ChartTooltipRow falls back to an inline style when swatch is a CSS colour', () => {
        const { container } = render(
            <ChartTooltipRow
                label="Coverage"
                value="72%"
                swatch="#ff0000"
            />,
        );
        const row = container.querySelector(
            '[data-chart-tooltip-row]',
        ) as HTMLElement;
        // No bg- token class, inline style instead.
        expect(row.querySelector('[class*="bg-"]')).toBeNull();
        const styled = row.querySelector('[style*="background-color"]');
        expect(styled).not.toBeNull();
    });
});

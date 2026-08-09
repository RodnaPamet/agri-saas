/**
 * Epic 69 — `SWRDevTools` dev-only inspector tests.
 *
 * Pins the three load-bearing properties of the panel:
 *
 *   1. **Production gating.** The default export returns `null`
 *      whenever `NODE_ENV !== 'development'` or
 *      `NEXT_PUBLIC_TEST_MODE === '1'`. Renders are tree-shaken
 *      from the prod bundle and the panel never appears in E2E
 *      runs (which would block selector-visibility checks).
 *
 *   2. **Cache visibility.** When mounted under an SWRConfig
 *      provider with live `useTenantSWR` consumers, the panel
 *      surfaces every cache key, the validation count, and the
 *      hit / miss tally maintained from observed transitions.
 *
 *   3. **Toggle UX.** The collapsed pill expands into the panel
 *      on click and back; both buttons are present and accessible.
 *
 * The wrapped public surface (`SWRDevTools` default export) is
 * tested for the gating behaviour. The inner panel
 * (`SWRDevToolsImpl`, named export) is tested for cache observation
 * — exercising it directly bypasses the env gate so we can render
 * in jsdom without poking at `NODE_ENV`.
 */

import * as React from 'react';
import {
    act,
    render,
    screen,
    waitFor,
    fireEvent,
} from '@testing-library/react';
import { SWRConfig } from 'swr';

import SWRDevTools, {
    SWRDevToolsImpl,
} from '@/components/dev/swr-devtools';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

function makeWrapper() {
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
                {children}
            </SWRConfig>
        );
    };
}

// ── Production gating ──────────────────────────────────────────────────

describe('SWRDevTools — production gating', () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
        // Restore exactly so cross-test pollution can't leak the
        // production NODE_ENV into other rendered tests.
        Object.assign(process.env, originalEnv);
    });

    it('renders nothing when NODE_ENV is "production"', () => {
        // jest's transform inlines `process.env.NODE_ENV` per call
        // site at runtime (not at build time), so reassigning here
        // is observable inside the component.
        (process.env as Record<string, string>).NODE_ENV = 'production';
        const { container } = render(<SWRDevTools />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when NODE_ENV is "test"', () => {
        (process.env as Record<string, string>).NODE_ENV = 'test';
        const { container } = render(<SWRDevTools />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when NEXT_PUBLIC_TEST_MODE === "1" even in development', () => {
        (process.env as Record<string, string>).NODE_ENV = 'development';
        process.env.NEXT_PUBLIC_TEST_MODE = '1';
        const { container } = render(<SWRDevTools />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders the toggle pill when NODE_ENV is "development" and test-mode flag is unset', () => {
        (process.env as Record<string, string>).NODE_ENV = 'development';
        process.env.NEXT_PUBLIC_TEST_MODE = '';
        render(<SWRDevTools />, { wrapper: makeWrapper() });
        expect(screen.getByTestId('swr-devtools-toggle')).toBeInTheDocument();
    });
});

// ── Cache observability ────────────────────────────────────────────────

describe('SWRDevToolsImpl — cache visibility', () => {
    it('shows the toggle pill collapsed by default', () => {
        render(<SWRDevToolsImpl />, { wrapper: makeWrapper() });
        expect(screen.getByTestId('swr-devtools-toggle')).toBeInTheDocument();
        expect(
            screen.queryByTestId('swr-devtools-panel'),
        ).not.toBeInTheDocument();
    });

    it('expands to a panel on click and reveals total / validating / hit / miss counters', async () => {
        render(<SWRDevToolsImpl />, { wrapper: makeWrapper() });
        fireEvent.click(screen.getByTestId('swr-devtools-toggle'));
        expect(screen.getByTestId('swr-devtools-panel')).toBeInTheDocument();
        expect(screen.getByTestId('swr-devtools-total')).toHaveTextContent(
            /keys:/,
        );
        expect(
            screen.getByTestId('swr-devtools-validating'),
        ).toHaveTextContent(/validating:/);
        expect(screen.getByTestId('swr-devtools-hits')).toHaveTextContent(
            /hit:/,
        );
        expect(screen.getByTestId('swr-devtools-misses')).toHaveTextContent(
            /miss:/,
        );
    });

    it('lists active SWR cache keys observed from the provider', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => [] });

        function Harness() {
            useTenantSWR<unknown[]>('/practices');
            useTenantSWR<unknown[]>('/risks');
            return <SWRDevToolsImpl />;
        }

        render(<Harness />, { wrapper: makeWrapper() });

        // Open panel.
        fireEvent.click(screen.getByTestId('swr-devtools-toggle'));

        // The polling effect runs on a 1-second interval. Advance
        // by 1.1 s so the snapshot picks up the resolved fetches
        // and renders the per-key rows.
        await act(async () => {
            jest.useFakeTimers();
            jest.advanceTimersByTime(1100);
            jest.useRealTimers();
        });

        await waitFor(() => {
            expect(
                screen.getByTestId('swr-devtools-row-/api/t/acme/practices'),
            ).toBeInTheDocument();
            expect(
                screen.getByTestId('swr-devtools-row-/api/t/acme/risks'),
            ).toBeInTheDocument();
        });

        // Both keys count toward the total.
        expect(
            screen.getByTestId('swr-devtools-total'),
        ).toHaveTextContent(/keys:\s*2/);
    });

    it('toggles back to the collapsed pill via the close button', () => {
        render(<SWRDevToolsImpl />, { wrapper: makeWrapper() });
        fireEvent.click(screen.getByTestId('swr-devtools-toggle'));
        expect(screen.getByTestId('swr-devtools-panel')).toBeInTheDocument();

        fireEvent.click(screen.getByTestId('swr-devtools-close'));
        expect(
            screen.queryByTestId('swr-devtools-panel'),
        ).not.toBeInTheDocument();
        expect(screen.getByTestId('swr-devtools-toggle')).toBeInTheDocument();
    });
});

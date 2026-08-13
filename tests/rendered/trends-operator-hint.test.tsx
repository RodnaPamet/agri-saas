/** @jest-environment jsdom */
/**
 * Trends → Prices: the operator hint names the feed that actually publishes
 * the selected commodity.
 *
 * ── The break this catches ───────────────────────────────────────────
 *
 * The hint was one hard-coded string for every commodity:
 *
 *     t('operator.body', { ec: 'EC_AGRIFOOD_BASE_URL', av: 'ALPHA_VANTAGE_API_KEY' })
 *
 * On the fertiliser tab that told an operator staring at an empty urea chart
 * to configure two variables that CANNOT populate urea — urea comes from the
 * World Bank Pink Sheet — while saying nothing about the feed that can. And
 * `EC_AGRIFOOD_BASE_URL` is not a credential at all: it is an optional
 * base-URL override whose correct production value is unset.
 *
 * ── Which viewport ───────────────────────────────────────────────────
 *
 * jsdom's default (a PHONE) is used unchanged and deliberately: the empty
 * state and the hint render identically at every width, nothing here branches
 * on a media query.
 *
 * ── About the intl mock ──────────────────────────────────────────────
 *
 * It renders the KEY, and appends interpolated params. The append matters:
 * under a key-only mock the old `{ec}` / `{av}` values never reached the DOM,
 * so "the hint must not name an env var" would have passed no matter what the
 * component did. Params in the output make that assertion real.
 */
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string, params?: Record<string, unknown>) =>
        params ? `${key} ${JSON.stringify(params)}` : key,
}));

jest.mock('@/components/ui/charts', () => ({
    TimeSeriesChart: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="ts-chart">{children}</div>
    ),
    Areas: () => <div data-testid="areas" />,
    XAxis: () => null,
    YAxis: () => null,
}));

jest.mock('@/components/ui/combobox', () => ({
    Combobox: ({
        options,
        setSelected,
    }: {
        options: Array<{ value: string; label: React.ReactNode }>;
        setSelected: (o: { value: string; label: React.ReactNode }) => void;
    }) => (
        <div>
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    data-testid={`cmbx-${o.value}`}
                    onClick={() => setSelected(o)}
                >
                    {o.value}
                </button>
            ))}
        </div>
    ),
}));

let mockIsAdmin = true;
jest.mock('@/lib/tenant-context-provider', () => ({
    usePermissions: () => ({ admin: { manage: mockIsAdmin } }),
}));

const NOW = '2026-08-13T00:00:00.000Z';

// Every commodity reads as empty — the hint is an empty-state affordance, so
// an empty payload is the case under test rather than a degenerate one.
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string) => {
        if (key.startsWith('/me/interests')) return { data: { keywords: [] }, error: undefined };
        const commodity = /commodity=([^&]+)/.exec(key)?.[1] ?? '';
        return {
            data: { commodity, range: '3m', generatedAt: NOW, series: [] },
            error: undefined,
        };
    },
}));

import { PricesTab } from '@/components/trends/PricesTab';
import { TooltipProvider } from '@/components/ui/tooltip';

function renderTab() {
    return render(
        <TooltipProvider>
            <PricesTab />
        </TooltipProvider>,
    );
}

/** Move the picker to a category, then to a commodity inside it. */
function select(category: 'grain' | 'fuel' | 'fertilizer', commodity: string) {
    fireEvent.click(document.getElementById(`trends-category-${category}`)!);
    fireEvent.click(screen.getByTestId(`cmbx-${commodity}`));
}

afterEach(() => {
    mockIsAdmin = true;
});

describe('the operator hint names the right feed', () => {
    it('points at the World Bank for urea, not at two irrelevant env vars', () => {
        renderTab();
        select('fertilizer', 'urea');

        expect(screen.getByTestId('trends-operator-hint')).toBeInTheDocument();
        expect(screen.getByText(/operator\.feeds\.worldBank/)).toBeInTheDocument();
    });

    it('points at the Oil Bulletin for diesel', () => {
        renderTab();
        select('fuel', 'diesel');
        expect(screen.getByText(/operator\.feeds\.oilBulletin/)).toBeInTheDocument();
    });

    it('points at EC AGRI-food for a crop', () => {
        renderTab();
        expect(screen.getByText(/operator\.feeds\.ecAgrifood/)).toBeInTheDocument();
    });

    it('never names an environment variable', () => {
        // Both were presented as things to configure. Neither is a credential
        // for most commodities, and EC_AGRIFOOD_BASE_URL is not a credential
        // for ANY of them — its correct production value is unset.
        for (const [cat, c] of [
            ['grain', 'wheat'],
            ['fuel', 'diesel'],
            ['fertilizer', 'urea'],
        ] as const) {
            const { unmount } = renderTab();
            select(cat, c);
            expect(document.body.textContent).not.toContain('EC_AGRIFOOD_BASE_URL');
            expect(document.body.textContent).not.toContain('ALPHA_VANTAGE_API_KEY');
            expect(document.body.textContent).not.toContain('operator.body');
            unmount();
        }
    });

    it('says nothing to configure when no free feed exists at all', () => {
        // MAP is somebody's typing by nature. An operator box implying there
        // is a job to fix would send them looking for a broken pipeline that
        // was never built.
        renderTab();
        select('fertilizer', 'map');
        expect(screen.queryByTestId('trends-operator-hint')).not.toBeInTheDocument();
    });

    it('stays admin-only', () => {
        // It names internal plumbing and a cron cadence — an instruction a
        // farmer cannot act on.
        mockIsAdmin = false;
        renderTab();
        select('fertilizer', 'urea');
        expect(screen.queryByTestId('trends-operator-hint')).not.toBeInTheDocument();
    });
});

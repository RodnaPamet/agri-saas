/**
 * Epic 66 — rollout integration coverage.
 *
 * Verifies the one real-page surface the rollout still has: the
 * portfolio dashboard's tenant-health cards (`<TenantCoverageCards>`)
 * — card cardinality, RAG badge, the sparkline/no-sparkline branch,
 * the overdue-evidence kv row, the empty state, and the drill-down
 * link.
 *
 * Strategy mirrors the Epic-63 rollout file: don't mount the dashboard
 * widget grid (`PortfolioDashboard` pulls in react-grid-layout) —
 * render the leaf component directly with synthesised props.
 *
 * The framework list page's table/cards toggle was this file's second
 * subject; that page left with the GRC teardown and its tests went
 * with it. The `<ViewToggle>` primitive itself is exercised by
 * `tests/rendered/view-toggle.test.tsx`.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { render } from '@testing-library/react';

// jsdom 0×0 ParentSize stub so MiniAreaChart has room to draw under
// the sparkline branch of the tenant cards.
jest.mock('@visx/responsive', () => {
    const actual = jest.requireActual('@visx/responsive');
    return {
        ...actual,
        ParentSize: ({
            children,
            className,
        }: {
            children: (args: { width: number; height: number }) => React.ReactNode;
            className?: string;
        }) => (
            <div
                data-testid="parent-size"
                className={className}
                style={{ width: 200, height: 40 }}>
                {children({ width: 200, height: 40 })}
            </div>
        ),
    };
});

// `<TenantCoverageCards>` uses `<TimestampTooltip>` which reaches
// the real Radix Tooltip via the `@/` alias — bypasses the
// jest.config moduleNameMapper rewrite that catches `./tooltip` and
// `../tooltip` only. Mock locally so the test doesn't need a
// TooltipProvider wrapper.
jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({
        children,
        content,
    }: {
        children: React.ReactNode;
        content: React.ReactNode;
    }) => (
        <span data-testid="tooltip-mock">
            {children}
            <span data-testid="tooltip-content">{content}</span>
        </span>
    ),
    TooltipProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
    InfoTooltip: () => null,
}));

// next/navigation isn't in scope under jsdom — stub the hooks the
// card's `<Link>` (and any transitively-imported primitives) might
// reach for.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/org/acme/dashboard',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ orgSlug: 'acme' }),
}));

// `<TenantCoverageCards>` (and the `<RagPill>` / `<EmptyState>` it
// mounts) uses `useTranslations`. Echo the key so rendered text is the
// message key — `t.rich` included, for any primitive that reaches for
// it.
jest.mock('next-intl', () => ({
    useTranslations: () => {
        const t = (key: string) => key;
        (t as unknown as { rich: (k: string) => string }).rich = (key: string) => key;
        return t;
    },
}));

import { TenantCoverageCards } from '@/app/org/[orgSlug]/(app)/dashboard-sections';
import type { TenantHealthRow } from '@/app-layer/schemas/portfolio';

// ─── Tenant cards fixtures ─────────────────────────────────────────

function tenantRow(over: Partial<TenantHealthRow> = {}): TenantHealthRow {
    return {
        tenantId: 't1',
        slug: 'acme-corp',
        name: 'Acme Corp',
        drillDownUrl: '/org/acme/tenants/acme-corp',
        hasSnapshot: true,
        snapshotDate: '2026-05-01',
        overdueEvidence: 2,
        rag: 'GREEN',
        ...over,
    };
}

function makeSeries(values: number[]) {
    const start = new Date('2026-04-01T00:00:00Z').getTime();
    return values.map((value, i) => ({
        date: new Date(start + i * 86_400_000),
        value,
    }));
}

// ─── TenantCoverageCards ───────────────────────────────────────────

describe('TenantCoverageCards — Epic 66 rollout', () => {
    it('renders one CardList card per tenant', () => {
        const { container } = render(
            <TenantCoverageCards
                rows={[
                    tenantRow({ tenantId: 't1', slug: 'acme', name: 'Acme' }),
                    tenantRow({ tenantId: 't2', slug: 'globex', name: 'Globex' }),
                ]}
            />,
        );
        expect(
            container.querySelector('[data-testid="org-tenant-coverage-cards"]'),
        ).not.toBeNull();
        expect(
            container.querySelectorAll('[data-card-list-card]').length,
        ).toBe(2);
    });

    it('mounts a RAG badge in each card header', () => {
        const { container } = render(
            <TenantCoverageCards
                rows={[
                    tenantRow({ tenantId: 't1', slug: 'a', rag: 'GREEN' }),
                    tenantRow({ tenantId: 't2', slug: 'b', rag: 'RED', name: 'BadCorp' }),
                ]}
            />,
        );
        const greenCard = container.querySelector(
            '[data-testid="org-tenant-card-a"]',
        );
        const redCard = container.querySelector(
            '[data-testid="org-tenant-card-b"]',
        );
        expect(greenCard?.textContent).toContain('GREEN');
        expect(redCard?.textContent).toContain('RED');
    });

    it('renders the sparkline when a trend series is supplied for the tenant', () => {
        const series = makeSeries([60, 65, 70, 75]);
        const { getByTestId } = render(
            <TenantCoverageCards
                rows={[tenantRow({ tenantId: 't1', slug: 'acme' })]}
                trends={{ t1: series }}
            />,
        );
        expect(
            getByTestId('org-tenant-card-spark-acme'),
        ).toBeTruthy();
        // The old companion assertion here — "the CoverageBar fallback
        // does NOT mount when the sparkline is present" — is gone with
        // its subject. `coveragePercent` left `TenantHealthRow` in the
        // GRC teardown, so there is no percentage bar (role=progressbar)
        // to suppress; the card's non-sparkline content is the kv block
        // asserted below.
    });

    it('omits the sparkline when no trend series is provided', () => {
        const { container } = render(
            <TenantCoverageCards
                rows={[tenantRow({ tenantId: 't1', slug: 'acme' })]}
            />,
        );
        // The card itself still mounts — the missing sparkline must be
        // the `hasSparkline` branch, not a card that failed to render.
        expect(
            container.querySelector('[data-testid="org-tenant-card-acme"]'),
        ).not.toBeNull();
        // No sparkline test-id.
        expect(
            container.querySelector('[data-testid="org-tenant-card-spark-acme"]'),
        ).toBeNull();
    });

    it('shows the overdue-evidence metric in the kv block', () => {
        const { container } = render(
            <TenantCoverageCards
                rows={[
                    tenantRow({
                        tenantId: 't1',
                        slug: 'acme',
                        overdueEvidence: 4,
                    }),
                ]}
            />,
        );
        const kv = container.querySelector(
            '[data-testid="org-tenant-card-acme"] [data-card-kv]',
        );
        // The openRisks (12) + criticalRisks (3) stats went with the
        // risk register, and the coverage percentage went with the
        // practice models in the GRC teardown — overdue evidence is the
        // one metric the card still carries, so assert it exactly
        // (label + value) rather than as a substring of the card.
        expect(kv?.querySelector('dt')?.textContent).toBe('cardOverdueEvidence');
        expect(kv?.querySelector('dd')?.textContent).toBe('4');
    });

    it('falls through to EmptyState when no rows are supplied', () => {
        const { container } = render(<TenantCoverageCards rows={[]} />);
        expect(
            container.querySelector('[data-testid="org-tenant-coverage-cards"]'),
        ).toBeNull();
        // T14 i18n — the empty-state title moved to a next-intl key
        // (org.sections.emptyTenantsTitle = "No tenants linked"). This
        // file's next-intl mock echoes keys (same reason the kv label
        // asserts as `cardOverdueEvidence` above), so the rendered
        // EmptyState carries the key. The English copy is asserted in
        // messages/en.json elsewhere.
        expect(container.textContent).toContain('emptyTenantsTitle');
    });

    it('exposes a navigable Link in the card header pointing at drillDownUrl', () => {
        // Card-level click navigates via `window.location.href` —
        // not feasibly testable under jsdom (`window.location` isn't
        // redefinable across all jsdom versions). The visible link
        // in the header is the keyboard-friendly equivalent and the
        // canonical navigation entry point for screen readers, so
        // we assert on its `href` instead.
        const { container } = render(
            <TenantCoverageCards
                rows={[
                    tenantRow({
                        tenantId: 't1',
                        slug: 'acme',
                        drillDownUrl: '/org/acme/tenants/acme',
                    }),
                ]}
            />,
        );
        const link = container.querySelector(
            '[data-testid="org-tenant-card-acme"] a[href="/org/acme/tenants/acme"]',
        );
        expect(link).not.toBeNull();
    });
});

// ─── FrameworksClient — table/cards toggle (DELETED) ───────────────
//
// This half of the file rendered `<FrameworksClient>` and asserted the
// table ⇄ cards toggle persisted its choice through
// `viewModeStorageKey('frameworks')`. The framework list page left with
// the GRC teardown, so the component no longer exists and no surviving
// surface mounts it. The `FW_FIXTURES` / `COV_FIXTURES` objects that
// outlived those tests are deleted with them — `COV_FIXTURES` supplied
// `coveragePercent`, a field that is gone from every DTO, and a fixture
// carrying a deleted shape is exactly what keeps a dead surface looking
// alive. The `<ViewToggle>` primitive itself stays covered by
// `tests/rendered/view-toggle.test.tsx`.


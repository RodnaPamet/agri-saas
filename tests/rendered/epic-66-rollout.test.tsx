/**
 * Epic 66 — rollout integration coverage.
 *
 * Verifies the two real-page surfaces:
 *   - portfolio dashboard tenant-health cards
 *   - framework list page table/cards toggle
 *
 * Strategy mirrors the Epic-63 rollout file: don't mount the heavy
 * server modules (the framework `page.tsx` runs on the server with
 * a real Prisma fetch), and don't mount the dashboard widget grid
 * (`PortfolioDashboard` pulls in react-grid-layout). Render the
 * leaf components (`TenantCoverageCards`, `FrameworksClient`)
 * directly with synthesised props.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { fireEvent, render } from '@testing-library/react';

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
// FrameworksClient (and any transitively-imported primitives) might
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
    usePathname: () => '/t/acme-corp/frameworks',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme-corp' }),
}));

// FrameworksClient uses `useTranslations` (+ `t.rich` in the custom-
// framework explainer modal, which is always mounted). Echo the key so
// rendered text is the message key.
jest.mock('next-intl', () => ({
    useTranslations: () => {
        const t = (key: string) => key;
        (t as unknown as { rich: (k: string) => string }).rich = (key: string) => key;
        return t;
    },
}));

import { TenantCoverageCards } from '@/app/org/[orgSlug]/(app)/dashboard-sections';
import {
    viewModeStorageKey,
} from '@/components/ui/hooks';
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
        coveragePercent: 75.3,
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
        const { container, getByTestId } = render(
            <TenantCoverageCards
                rows={[tenantRow({ tenantId: 't1', slug: 'acme' })]}
                trends={{ t1: series }}
            />,
        );
        expect(
            getByTestId('org-tenant-card-spark-acme'),
        ).toBeTruthy();
        // The CoverageBar fallback should NOT mount when sparkline is present.
        // (CoverageBar uses role="progressbar"; the tenant CardContent
        // bar would be the single one if it rendered.)
        expect(
            container.querySelectorAll(
                '[data-testid="org-tenant-card-acme"] [role="progressbar"]',
            ).length,
        ).toBe(0);
    });

    it('falls back to CoverageBar when no trend series is provided', () => {
        const { container } = render(
            <TenantCoverageCards
                rows={[tenantRow({ tenantId: 't1', slug: 'acme' })]}
            />,
        );
        // No sparkline test-id.
        expect(
            container.querySelector('[data-testid="org-tenant-card-spark-acme"]'),
        ).toBeNull();
        // CoverageBar mounts a role=progressbar div.
        expect(
            container.querySelectorAll(
                '[data-testid="org-tenant-card-acme"] [role="progressbar"]',
            ).length,
        ).toBeGreaterThan(0);
    });

    it('shows control summary metrics in the kv block', () => {
        const { container } = render(
            <TenantCoverageCards
                rows={[
                    tenantRow({
                        tenantId: 't1',
                        slug: 'acme',
                        coveragePercent: 88.2,
                        overdueEvidence: 4,
                    }),
                ]}
            />,
        );
        const card = container.querySelector(
            '[data-testid="org-tenant-card-acme"]',
        );
        // The openRisks (12) + criticalRisks (3) stats went with the
        // risk register; coverage + overdue-evidence remain.
        expect(card?.textContent).toContain('88.2%');
        expect(card?.textContent).toContain('4');
    });

    it('falls through to EmptyState when no rows are supplied', () => {
        const { container } = render(<TenantCoverageCards rows={[]} />);
        expect(
            container.querySelector('[data-testid="org-tenant-coverage-cards"]'),
        ).toBeNull();
        // T14 i18n — the empty-state title moved to a next-intl key
        // (org.sections.emptyTenantsTitle = "No tenants linked"). This
        // file's next-intl mock echoes keys (see the installed/available
        // badge assertions above), so the rendered EmptyState carries the
        // key. The English copy is asserted in messages/en.json elsewhere.
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

// ─── FrameworksClient — table/cards toggle ─────────────────────────

const FW_FIXTURES = [
    {
        id: 'fw1',
        key: 'ISO27001',
        name: 'ISO 27001',
        kind: 'INFOSEC',
        version: '2022',
        description: 'Information Security Management System',
        _count: { requirements: 93, packs: 1 },
    },
    {
        id: 'fw2',
        key: 'NIS2',
        name: 'NIS 2',
        kind: 'CYBER',
        version: null,
        description: 'EU Network and Information Security Directive',
        _count: { requirements: 20, packs: 1 },
    },
];
const COV_FIXTURES = {
    ISO27001: { coveragePercent: 100, mapped: 93, total: 93 },
    NIS2: { coveragePercent: 0, mapped: 0, total: 20 },
};


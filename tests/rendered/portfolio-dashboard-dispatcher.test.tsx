/**
 * Epic 41 page rewire — widget dispatcher behavioural tests.
 *
 * Verifies the dispatcher resolves each (type, chartType) pair to
 * the right rendered surface using a fixture portfolio dataset.
 * No drag, no edit mode — the dispatcher is the unit under test.
 *
 * Coverage:
 *   - KPI variants (overdue-evidence / tenants) render with the right
 *     value pulled from PortfolioData
 *   - a KPI chartType the GRC teardown deleted falls to the tail
 *     branch and renders the "—" placeholder, not a fabricated zero
 *   - DONUT (rag-distribution) renders the four legend bands
 *   - TENANT_LIST renders rows with drill-down links
 *   - DRILLDOWN_CTAS renders the surviving evidence navigation card
 */

import { render, screen } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/org/acme-org',
    useSearchParams: () => new URLSearchParams(),
}));

import {
    DispatchedWidget,
    type PortfolioData,
} from '@/app/org/[orgSlug]/(app)/widget-dispatcher';
import type { OrgDashboardWidgetDto } from '@/app-layer/schemas/org-dashboard-widget.schemas';

// ─── Fixture portfolio data ────────────────────────────────────────

function makeData(): PortfolioData {
    return {
        orgSlug: 'acme-org',
        summary: {
            organizationId: 'org-1',
            organizationSlug: 'acme-org',
            generatedAt: new Date().toISOString(),
            tenants: { total: 12, snapshotted: 10, pending: 2 },
            evidence: { total: 200, overdue: 8, dueSoon7d: 5 },
            tasks: { open: 30, overdue: 4 },
            rag: { green: 6, amber: 3, red: 1, pending: 2 },
        },
        tenantHealth: [
            {
                tenantId: 't-1',
                slug: 'alpha',
                name: 'Alpha Co',
                drillDownUrl: '/t/alpha/dashboard',
                hasSnapshot: true,
                snapshotDate: '2026-04-29',
                overdueEvidence: 2,
                rag: 'AMBER',
            },
            {
                tenantId: 't-2',
                slug: 'beta',
                name: 'Beta Co',
                drillDownUrl: '/t/beta/dashboard',
                hasSnapshot: true,
                snapshotDate: '2026-04-29',
                overdueEvidence: 0,
                rag: 'GREEN',
            },
        ],
        trends: {
            organizationId: 'org-1',
            daysRequested: 90,
            daysAvailable: 1,
            rangeStart: new Date().toISOString(),
            rangeEnd: new Date().toISOString(),
            tenantsAggregated: 2,
            dataPoints: [],
        },
    };
}

function makeWidget(
    overrides: Partial<OrgDashboardWidgetDto> & {
        type: OrgDashboardWidgetDto['type'];
        chartType: string;
    },
): OrgDashboardWidgetDto {
    return {
        id: 'w-1',
        organizationId: 'org-1',
        title: null,
        config: {},
        position: { x: 0, y: 0 },
        size: { w: 3, h: 2 },
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    } as OrgDashboardWidgetDto;
}

describe('Epic 41 — DispatchedWidget per (type, chartType)', () => {
    // ─── KPI ──────────────────────────────────────────────────────

    // This used to assert KPI/coverage rendered 75.0% + a "75 of 100
    // practices implemented" subtitle. GRC teardown phase 2 removed
    // 'coverage' from KpiChartType along with PortfolioSummary.practices,
    // so that metric has no subject. The test is re-pointed rather than
    // deleted because the chartType is NOT gone from the DATA: the read
    // path does not re-validate persisted rows, and the default preset
    // had seeded a KPI/'coverage' tile into every org before it was
    // re-pointed at 'tenants' (schemas note §8d.4), so the dispatcher
    // keeps meeting the literal until the §8d.4 data migration rewrites
    // those rows. What it must do meanwhile is the assertion below —
    // fall to the tail branch and render the "—" placeholder.
    // Fabricating a 0 (or a 0.0%) would report "measured zero coverage"
    // as fact, which is the exact class of lie this teardown keeps
    // finding.
    it('KPI/coverage — a deleted chartType degrades to "—", never a fabricated zero', () => {
        const widget = makeWidget({
            type: 'KPI',
            chartType: 'coverage',
            config: { format: 'percent' },
            title: 'Coverage',
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(screen.getByText('Coverage')).toBeInTheDocument();
        expect(screen.getByText('—')).toBeInTheDocument();
        expect(screen.queryByText('0')).toBeNull();
        expect(screen.queryByText('0.0%')).toBeNull();
        // The tail branch carries no subtitle — the practices-implemented
        // line went with the model it counted.
        expect(screen.queryByText(/practices implemented/)).toBeNull();
    });

    it('KPI/overdue-evidence renders the overdue count + due-soon subtitle', () => {
        const widget = makeWidget({
            type: 'KPI',
            chartType: 'overdue-evidence',
            config: { format: 'number' },
            title: 'Overdue Evidence',
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(screen.getByText('Overdue Evidence')).toBeInTheDocument();
        expect(screen.getByText('8')).toBeInTheDocument();
        expect(
            screen.getByText(/5 due within 7 days/),
        ).toBeInTheDocument();
    });

    it('KPI/tenants renders the total + snapshotted subtitle', () => {
        const widget = makeWidget({
            type: 'KPI',
            chartType: 'tenants',
            config: { format: 'number' },
            title: 'Tenants',
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(screen.getByText('Tenants')).toBeInTheDocument();
        expect(screen.getByText('12')).toBeInTheDocument();
        expect(screen.getByText(/10 snapshotted/)).toBeInTheDocument();
    });

    // ─── DONUT ───────────────────────────────────────────────────

    it('DONUT/rag-distribution renders the four RAG bands', () => {
        const widget = makeWidget({
            type: 'DONUT',
            chartType: 'rag-distribution',
            config: { showLegend: true },
            title: 'Tenant Health Distribution',
            size: { w: 6, h: 4 },
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        // The wrapper renders the title.
        expect(
            screen.getByText('Tenant Health Distribution'),
        ).toBeInTheDocument();
        // The donut renders the three positive segments + one PENDING.
        // (RAG_COLORS includes PENDING, but only segments with value>0
        // pass the filter — green=6, amber=3, red=1, pending=2 → 4)
        expect(screen.getByText('Healthy')).toBeInTheDocument();
        expect(screen.getByText('At risk')).toBeInTheDocument();
        expect(screen.getByText('Critical')).toBeInTheDocument();
        expect(screen.getByText('Pending snapshot')).toBeInTheDocument();
    });

    // ─── TENANT_LIST ─────────────────────────────────────────────

    it('TENANT_LIST renders tenant rows with drill-down hrefs', () => {
        // `chartType: 'coverage'` here is the OPAQUE one-member identifier
        // for the tenant-list widget, not a coverage metric — the rows now
        // carry RAG + overdue evidence. Renaming it would need a data
        // migration for no user-visible gain, so it stays; don't "tidy" it.
        const widget = makeWidget({
            type: 'TENANT_LIST',
            chartType: 'coverage',
            config: { sortBy: 'rag' },
            title: 'Coverage by Tenant',
            size: { w: 12, h: 6 },
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(screen.getByText('Coverage by Tenant')).toBeInTheDocument();
        // Both fixture tenants appear; sort 'rag' puts AMBER (Alpha)
        // before GREEN (Beta).
        const links = screen.getAllByRole('link');
        const alpha = links.find((a) => a.textContent?.includes('Alpha Co'));
        const beta = links.find((a) => a.textContent?.includes('Beta Co'));
        expect(alpha?.getAttribute('href')).toBe('/t/alpha/dashboard');
        expect(beta?.getAttribute('href')).toBe('/t/beta/dashboard');
    });

    // ─── DRILLDOWN_CTAS ──────────────────────────────────────────

    it('DRILLDOWN_CTAS renders the nav card pointing at /org/<slug>/evidence', () => {
        const widget = makeWidget({
            type: 'DRILLDOWN_CTAS',
            chartType: 'default',
            config: {},
            title: 'Drill-down',
            size: { w: 12, h: 2 },
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        expect(screen.getByText('Drill-down')).toBeInTheDocument();
        // GRC teardown phase 2 removed the 'practices' tile — its href
        // pointed at /org/:slug/practices, a deleted route, so the tile was
        // a live 404. 'evidence' is the surviving drill-down.
        expect(
            screen.getByTestId('org-drilldown-evidence').getAttribute('href'),
        ).toBe('/org/acme-org/evidence');
        expect(screen.queryByTestId('org-drilldown-practices')).toBeNull();
    });

    it('DRILLDOWN_CTAS respects entries config (subset rendering)', () => {
        const widget = makeWidget({
            type: 'DRILLDOWN_CTAS',
            chartType: 'default',
            config: { entries: ['evidence'] },
            title: 'Drill-down',
            size: { w: 12, h: 2 },
        });
        render(<DispatchedWidget widget={widget} data={makeData()} />);
        // The subset contract still holds — an explicit `entries` list
        // renders exactly those tiles. With only one surviving CTA the
        // assertion is that the named one renders and the deleted one
        // cannot come back.
        expect(
            screen.getByTestId('org-drilldown-evidence'),
        ).toBeInTheDocument();
        expect(
            screen.queryByTestId('org-drilldown-practices'),
        ).toBeNull();
    });
});

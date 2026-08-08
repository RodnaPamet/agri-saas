/**
 * Epic 61 — portfolio overview animated-stat rollout.
 *
 * Pins three integration surfaces that previously hard-swapped numeric
 * values on data refetch:
 *
 *   1. PortfolioDashboard header — total tenants + pending count
 *   2. DrillDownCtas — non-performing controls /
 *      overdue evidence headline counters
 *   3. TenantCoverageList — per-row coveragePercent
 *
 * Tests render against the global `@number-flow/react` mock wired in
 * `jest.config.js → jsdomProject.moduleNameMapper`, so every assertion
 * uses the deterministic `Intl.NumberFormat` text the real component
 * settles on.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { render } from '@testing-library/react';

// PortfolioDashboard transitively imports WidgetPicker → Modal, which
// calls useRouter at mount. jsdom has no app-router context, so stub
// the navigation hooks to no-ops.
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
    useParams: () => ({ orgSlug: 'acme-org' }),
}));

import { PortfolioDashboard } from '@/app/org/[orgSlug]/(app)/PortfolioDashboard';
import {
    DrillDownCtas,
    TenantCoverageList,
} from '@/app/org/[orgSlug]/(app)/dashboard-sections';
import type { PortfolioData } from '@/app/org/[orgSlug]/(app)/widget-dispatcher';
import type {
    PortfolioSummary,
    TenantHealthRow,
} from '@/app-layer/schemas/portfolio';

// ─── Fixtures ────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
    const base: PortfolioSummary = {
        organizationId: 'org_1',
        organizationSlug: 'acme-org',
        generatedAt: '2026-05-03T00:00:00Z',
        tenants: { total: 7, snapshotted: 5, pending: 2 },
        controls: { applicable: 200, implemented: 150, coveragePercent: 75 },
        evidence: { total: 120, overdue: 9, dueSoon7d: 3 },
        policies: { total: 12, overdueReview: 1 },
        tasks: { open: 22, overdue: 4 },
        findings: { open: 6 },
        rag: { green: 3, amber: 2, red: 0, pending: 2 },
    };
    return { ...base, ...overrides };
}

function makePortfolioData(summary: PortfolioSummary = makeSummary()): PortfolioData {
    return {
        orgSlug: 'acme-org',
        summary,
        tenantHealth: [],
        trends: {
            organizationId: 'org_1',
            daysRequested: 30,
            daysAvailable: 30,
            rangeStart: '2026-04-03',
            rangeEnd: '2026-05-03',
            tenantsAggregated: 5,
            dataPoints: [],
        },
    };
}

function makeTenantRow(over: Partial<TenantHealthRow> = {}): TenantHealthRow {
    return {
        tenantId: 't1',
        slug: 'acme-corp',
        name: 'Acme Corp',
        drillDownUrl: '/org/acme-org/tenants/acme-corp',
        hasSnapshot: true,
        snapshotDate: '2026-05-01',
        coveragePercent: 75.3,
        overdueEvidence: 2,
        rag: 'GREEN',
        ...over,
    };
}

// ─── PortfolioDashboard header ───────────────────────────────────────

describe('PortfolioDashboard — header stats animate', () => {
    it('animates the tenant count and shows pending segment when > 0', () => {
        const { container, getByText } = render(
            <PortfolioDashboard
                initialWidgets={[]}
                data={makePortfolioData()}
                canEdit={false}
            />,
        );
        const header = container.querySelector('[data-portfolio-header-stats]');
        expect(header).not.toBeNull();
        // Both numbers should render through AnimatedNumber.
        expect(
            header?.querySelectorAll('[data-animated-number]').length,
        ).toBe(2);
        // The values render deterministically via the NumberFlow mock.
        expect(getByText('7')).toBeInTheDocument();
        expect(getByText('2')).toBeInTheDocument();
        // Static descriptive text is preserved.
        expect(container.textContent).toContain('tenants');
        expect(container.textContent).toContain('pending first snapshot');
    });

    it('omits the pending segment when pending=0', () => {
        const { container } = render(
            <PortfolioDashboard
                initialWidgets={[]}
                data={makePortfolioData(
                    makeSummary({
                        tenants: { total: 1, snapshotted: 1, pending: 0 },
                    }),
                )}
                canEdit={false}
            />,
        );
        const header = container.querySelector('[data-portfolio-header-stats]');
        // Only one animated number (total) — pending segment never mounts.
        expect(
            header?.querySelectorAll('[data-animated-number]').length,
        ).toBe(1);
        // Singular noun for total=1.
        expect(header?.textContent).toContain('1 tenant');
        expect(header?.textContent).not.toContain('pending');
    });

    it('updates the rendered count when data changes', () => {
        const { container, rerender } = render(
            <PortfolioDashboard
                initialWidgets={[]}
                data={makePortfolioData(
                    makeSummary({
                        tenants: { total: 3, snapshotted: 3, pending: 0 },
                    }),
                )}
                canEdit={false}
            />,
        );
        const before = container.textContent;
        rerender(
            <PortfolioDashboard
                initialWidgets={[]}
                data={makePortfolioData(
                    makeSummary({
                        tenants: { total: 12, snapshotted: 10, pending: 2 },
                    }),
                )}
                canEdit={false}
            />,
        );
        expect(container.textContent).not.toBe(before);
        expect(container.textContent).toContain('12 tenants');
        expect(container.textContent).toContain('2 pending');
    });
});

// ─── DrillDownCtas ──────────────────────────────────────────────────

describe('DrillDownCtas — counters animate', () => {
    it('renders all CTA counters through AnimatedNumber', () => {
        const summary = makeSummary({
            controls: { applicable: 200, implemented: 150, coveragePercent: 75 },
            evidence: { total: 120, overdue: 9, dueSoon7d: 3 },
        });
        const { container } = render(
            <DrillDownCtas summary={summary} orgSlug="acme-org" />,
        );
        // Two CTAs, one animated number each — the risks CTA went with
        // the register.
        expect(
            container.querySelectorAll(
                '[data-testid="org-drilldown-ctas"] [data-animated-number]',
            ).length,
        ).toBe(2);
    });

    it('counters reflect the summary values exactly', () => {
        const summary = makeSummary({
            controls: { applicable: 200, implemented: 150, coveragePercent: 75 },
            evidence: { total: 120, overdue: 9, dueSoon7d: 3 },
        });
        const { container } = render(
            <DrillDownCtas summary={summary} orgSlug="acme-org" />,
        );
        const controls = container.querySelector('[data-testid="org-drilldown-controls"]');
        const evidence = container.querySelector('[data-testid="org-drilldown-evidence"]');
        // applicable - implemented = 50
        expect(controls?.textContent).toContain('50');
        expect(evidence?.textContent).toContain('9');
    });

    it('re-render with new counts updates the rendered numbers', () => {
        const { container, rerender } = render(
            <DrillDownCtas summary={makeSummary()} orgSlug="acme-org" />,
        );
        const before = container.textContent;
        rerender(
            <DrillDownCtas
                summary={makeSummary({
                    controls: {
                        applicable: 300,
                        implemented: 250,
                        coveragePercent: 83,
                    },
                    evidence: { total: 140, overdue: 14, dueSoon7d: 5 },
                })}
                orgSlug="acme-org"
            />,
        );
        expect(container.textContent).not.toBe(before);
        // The critical-risks counter went with the register; overdue
        // evidence is the value that visibly changes on re-render.
        expect(container.textContent).toContain('14'); // new overdue
    });
});

// ─── TenantCoverageList ─────────────────────────────────────────────

describe('TenantCoverageList — per-row coverage animates', () => {
    it('renders coveragePercent through AnimatedNumber when present', () => {
        const { container, getByText } = render(
            <TenantCoverageList rows={[makeTenantRow({ coveragePercent: 75.3 })]} />,
        );
        const animated = container.querySelectorAll(
            '[data-testid="org-tenant-coverage-list"] [data-animated-number]',
        );
        expect(animated.length).toBe(1);
        expect(getByText('75.3%')).toBeInTheDocument();
    });

    it('renders "—" when coveragePercent is null (no AnimatedNumber)', () => {
        const { container, getByText } = render(
            <TenantCoverageList rows={[makeTenantRow({ coveragePercent: null })]} />,
        );
        expect(
            container.querySelectorAll(
                '[data-testid="org-tenant-coverage-list"] [data-animated-number]',
            ).length,
        ).toBe(0);
        expect(getByText('—')).toBeInTheDocument();
    });

    it('updates rendered coverage when the value changes', () => {
        const { container, rerender } = render(
            <TenantCoverageList rows={[makeTenantRow({ coveragePercent: 60 })]} />,
        );
        expect(container.textContent).toContain('60.0%');
        rerender(
            <TenantCoverageList rows={[makeTenantRow({ coveragePercent: 88.5 })]} />,
        );
        expect(container.textContent).toContain('88.5%');
    });

    it('mounts one animated coverage per row across many tenants', () => {
        const rows = Array.from({ length: 6 }, (_, i) =>
            makeTenantRow({
                tenantId: `t${i}`,
                slug: `t-${i}`,
                name: `Tenant ${i}`,
                coveragePercent: 50 + i * 5,
            }),
        );
        const { container } = render(<TenantCoverageList rows={rows} />);
        // Six rows → six animated coverage spans (perf sanity check
        // that we don't accidentally lift the AnimatedNumber out of
        // the row map and lose per-row identity).
        expect(
            container.querySelectorAll(
                '[data-testid="org-tenant-coverage-list"] [data-animated-number]',
            ).length,
        ).toBe(6);
    });
});

/**
 * Epic 61 — portfolio overview animated-stat rollout.
 *
 * Pins three integration surfaces that previously hard-swapped numeric
 * values on data refetch:
 *
 *   1. PortfolioDashboard header — total tenants + pending count
 *   2. DrillDownCtas — overdue-evidence headline counter
 *   3. TenantCoverageList — per-row overdue-evidence count
 *
 * GRC teardown phase 2 narrowed (2) and (3) rather than removing them.
 * The non-performing-practices CTA and the per-row `coveragePercent`
 * left with the Practice models; overdue evidence is the metric both
 * surfaces animate now, and it exercises exactly the same rollout
 * property (value flows through `<AnimatedNumber>`, one instance per
 * counter/row, re-render updates the rendered text).
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
        evidence: { total: 120, overdue: 9, dueSoon7d: 3 },
        tasks: { open: 22, overdue: 4 },
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
            evidence: { total: 120, overdue: 9, dueSoon7d: 3 },
        });
        const { container } = render(
            <DrillDownCtas summary={summary} orgSlug="acme-org" />,
        );
        // One CTA, one animated number. The risks CTA went with the
        // register; the practices CTA went with GRC teardown phase 2,
        // where its href pointed at a deleted route and its count read
        // snapshot columns nothing computes any more.
        expect(
            container.querySelectorAll(
                '[data-testid="org-drilldown-ctas"] [data-animated-number]',
            ).length,
        ).toBe(1);
    });

    it('counters reflect the summary values exactly', () => {
        const summary = makeSummary({
            evidence: { total: 120, overdue: 9, dueSoon7d: 3 },
        });
        const { container } = render(
            <DrillDownCtas summary={summary} orgSlug="acme-org" />,
        );
        const evidence = container.querySelector('[data-testid="org-drilldown-evidence"]');
        expect(evidence?.textContent).toContain('9');
        // The practices tile is gone (GRC teardown phase 2) — assert it
        // cannot come back rather than dropping the check.
        expect(
            container.querySelector('[data-testid="org-drilldown-practices"]'),
        ).toBeNull();
    });

    it('re-render with new counts updates the rendered numbers', () => {
        const { container, rerender } = render(
            <DrillDownCtas summary={makeSummary()} orgSlug="acme-org" />,
        );
        const before = container.textContent;
        rerender(
            <DrillDownCtas
                summary={makeSummary({
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
//
// GRC teardown phase 2: the per-row headline metric was
// `coveragePercent`; it left the DTO with the Practice models and the
// row now animates `overdueEvidence`. Same rollout property, different
// column — these are the coverage tests re-pointed, not new ones.
// (The component keeps its `TenantCoverageList` name +
// `org-tenant-coverage-list` testid; both are src-side and out of scope
// for this file.)

describe('TenantCoverageList — per-row overdue-evidence count animates', () => {
    it('renders overdueEvidence through AnimatedNumber when present', () => {
        const { container, getByText } = render(
            <TenantCoverageList rows={[makeTenantRow({ overdueEvidence: 12 })]} />,
        );
        const animated = container.querySelectorAll(
            '[data-testid="org-tenant-coverage-list"] [data-animated-number]',
        );
        expect(animated.length).toBe(1);
        expect(getByText('12')).toBeInTheDocument();
    });

    it('renders 0 through AnimatedNumber when overdueEvidence is null', () => {
        // The "—" placeholder went with `coveragePercent`. The nullable
        // branch itself survives (`overdueEvidence` is null on a tenant
        // with no snapshot) and the row now coalesces it to 0 in BOTH
        // the animated value and the descriptive line — so pin that,
        // rather than dropping the only test covering the null path.
        // The snapshot-less tenant is still marked by the RagPill,
        // which renders "Pending" for a null rag.
        const { container, getByText } = render(
            <TenantCoverageList
                rows={[
                    // The shape the DTO documents for a tenant with no
                    // snapshot: every metric field null, rag null.
                    makeTenantRow({
                        hasSnapshot: false,
                        snapshotDate: null,
                        overdueEvidence: null,
                        rag: null,
                    }),
                ]}
            />,
        );
        expect(
            container.querySelectorAll(
                '[data-testid="org-tenant-coverage-list"] [data-animated-number]',
            ).length,
        ).toBe(1);
        expect(getByText('0')).toBeInTheDocument();
        expect(getByText('Pending')).toBeInTheDocument();
    });

    it('updates the rendered overdue count when the value changes', () => {
        const { container, rerender } = render(
            <TenantCoverageList rows={[makeTenantRow({ overdueEvidence: 6 })]} />,
        );
        const animated = () =>
            container.querySelector(
                '[data-testid="org-tenant-coverage-list"] [data-animated-number]',
            );
        expect(animated()?.textContent).toBe('6');
        rerender(
            <TenantCoverageList rows={[makeTenantRow({ overdueEvidence: 14 })]} />,
        );
        expect(animated()?.textContent).toBe('14');
    });

    it('mounts one animated counter per row across many tenants', () => {
        const rows = Array.from({ length: 6 }, (_, i) =>
            makeTenantRow({
                tenantId: `t${i}`,
                slug: `t-${i}`,
                name: `Tenant ${i}`,
                overdueEvidence: 50 + i * 5,
            }),
        );
        const { container } = render(<TenantCoverageList rows={rows} />);
        // Six rows → six animated spans (perf sanity check that we
        // don't accidentally lift the AnimatedNumber out of the row map
        // and lose per-row identity).
        expect(
            container.querySelectorAll(
                '[data-testid="org-tenant-coverage-list"] [data-animated-number]',
            ).length,
        ).toBe(6);
    });
});

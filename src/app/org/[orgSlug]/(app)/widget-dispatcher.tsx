"use client";

/**
 * Epic 41 page rewire — per-widget rendering dispatcher.
 *
 * Maps a backend `OrgDashboardWidget` row + the live portfolio
 * data into a rendered `<DashboardWidget>` tile. The dispatcher
 * is the single point that translates persistence vocabulary
 * (`type` + `chartType` + `config`) into the visualization
 * primitive (`<ChartRenderer>` + extracted section components).
 *
 * Adding a new (type, chartType) variant is a one-place edit
 * here + the matching schema + the matching backend chartType
 * enum extension. The renderer stays variant-agnostic.
 */

import { ShieldCheck, AlertTriangle, Paperclip, Building2 } from 'lucide-react';

import {
    ChartRenderer,
    DashboardWidget,
    type ChartRendererProps,
} from '@/components/ui/dashboard-widgets';
import type { OrgDashboardWidgetDto } from '@/app-layer/schemas/org-dashboard-widget.schemas';
import type {
    PortfolioSummary,
    PortfolioTrend,
    TenantHealthRow,
} from '@/app-layer/schemas/portfolio';

import {
    DrillDownCtas,
    TenantCoverageCards,
    TenantCoverageList,
} from './dashboard-sections';

// ─── Public types ───────────────────────────────────────────────────

export interface PortfolioData {
    summary: PortfolioSummary;
    tenantHealth: TenantHealthRow[];
    trends: PortfolioTrend;
    orgSlug: string;
}

interface DispatcherProps {
    widget: OrgDashboardWidgetDto;
    data: PortfolioData;
    /** Render-mode actions slot. Empty in read mode; carries the
     *  delete trigger in edit mode. */
    actionsSlot?: React.ReactNode;
}

// ─── KPI variant resolver ──────────────────────────────────────────
//
// Each chartType pulls its value/subtitle from a different slice of
// PortfolioSummary. Centralising the mapping here keeps the
// dispatcher's KPI arm small and lets the picker / preset / API
// share one source of truth for "which metric does each chartType
// surface".

const KPI_GRADIENTS: Record<string, string> = {
    coverage: 'from-emerald-500 to-teal-500',
    'overdue-evidence': 'from-amber-500 to-orange-500',
    tenants: 'from-blue-500 to-indigo-500',
};

const KPI_ICONS = {
    coverage: ShieldCheck,
    'overdue-evidence': Paperclip,
    tenants: Building2,
} as const;

function resolveKpiContent(
    widget: OrgDashboardWidgetDto,
    data: PortfolioData,
): ChartRendererProps {
    const cfg = widget.config as Record<string, unknown>;
    const format = (cfg.format as 'number' | 'percent' | 'compact' | undefined) ?? 'number';
    const gradient = (cfg.gradient as string | undefined)
        ?? KPI_GRADIENTS[widget.chartType]
        ?? 'from-brand-default to-brand-muted';

    switch (widget.chartType) {
        case 'coverage':
            return {
                chartType: 'kpi',
                config: {
                    label: widget.title ?? 'Coverage',
                    value: data.summary.controls.coveragePercent,
                    format,
                    gradient,
                    icon: KPI_ICONS.coverage,
                    subtitle: `${data.summary.controls.implemented.toLocaleString()} of ${data.summary.controls.applicable.toLocaleString()} controls implemented`,
                },
            };
        case 'overdue-evidence':
            return {
                chartType: 'kpi',
                config: {
                    label: widget.title ?? 'Overdue Evidence',
                    value: data.summary.evidence.overdue,
                    format,
                    gradient,
                    icon: KPI_ICONS['overdue-evidence'],
                    subtitle: `${data.summary.evidence.dueSoon7d.toLocaleString()} due within 7 days`,
                    trendPolarity: 'down-good',
                },
            };
        case 'tenants':
            return {
                chartType: 'kpi',
                config: {
                    label: widget.title ?? 'Tenants',
                    value: data.summary.tenants.total,
                    format,
                    gradient,
                    icon: KPI_ICONS.tenants,
                    subtitle: `${data.summary.tenants.snapshotted.toLocaleString()} snapshotted`,
                    trendPolarity: 'neutral',
                },
            };
    }
    return {
        chartType: 'kpi',
        config: { label: widget.title ?? widget.chartType, value: null, format },
    };
}

// ─── Donut variant resolver ────────────────────────────────────────

const RAG_COLORS = {
    GREEN: 'rgb(16, 185, 129)',
    AMBER: 'rgb(245, 158, 11)',
    RED: 'rgb(239, 68, 68)',
    PENDING: 'rgb(148, 163, 184)',
} as const;

function resolveDonutContent(
    widget: OrgDashboardWidgetDto,
    data: PortfolioData,
): ChartRendererProps {
    const cfg = widget.config as { showLegend?: boolean };
    if (widget.chartType === 'rag-distribution') {
        const segments = [
            { label: 'Healthy', value: data.summary.rag.green, color: RAG_COLORS.GREEN },
            { label: 'At risk', value: data.summary.rag.amber, color: RAG_COLORS.AMBER },
            { label: 'Critical', value: data.summary.rag.red, color: RAG_COLORS.RED },
            { label: 'Pending snapshot', value: data.summary.rag.pending, color: RAG_COLORS.PENDING },
        ].filter((s) => s.value > 0);
        const totalCategorised = data.summary.rag.green + data.summary.rag.amber + data.summary.rag.red;
        return {
            chartType: 'donut',
            config: {
                segments,
                centerLabel:
                    totalCategorised > 0 ? String(totalCategorised) : undefined,
                centerSub: 'Active',
                showLegend: cfg.showLegend ?? true,
            },
        };
    }
    return { chartType: 'donut', config: { segments: [] } };
}

// ─── Trend variant resolver ────────────────────────────────────────

function resolveTrendContent(
    widget: OrgDashboardWidgetDto,
    data: PortfolioData,
): ChartRendererProps {
    const points = data.trends.dataPoints.map((p) => {
        let value = 0;
        switch (widget.chartType) {
            case 'controls-coverage':
                value = p.controlCoveragePercent;
                break;
            case 'evidence-overdue':
                value = p.evidenceOverdue;
                break;
        }
        return { date: new Date(p.date), value };
    });

    const colorMap: Record<string, string> = {
        'controls-coverage': 'text-content-success',
        'evidence-overdue': 'text-content-warning',
    };

    return {
        chartType: 'area',
        config: {
            points,
            seriesId: widget.chartType,
            seriesColorClassName: colorMap[widget.chartType] ?? 'text-brand-default',
            seriesLabel: widget.title ?? widget.chartType,
        },
    };
}

// ─── Main dispatcher ──────────────────────────────────────────────

/**
 * Stable DOM ids for dispatched widgets.
 *
 * The org dashboard predates the configurable widget engine; the
 * pre-Epic-41 hardcoded layout exposed `#org-stat-coverage`,
 * `#org-stat-overdue-evidence`,
 * `#org-stat-tenants`, `#org-drilldown-ctas`, and `#org-tenant-coverage`
 * as load-bearing anchors for E2E selectors (`ciso-portfolio.spec.ts`)
 * and deep-link navigation. The rewire to widgets must preserve them
 * so external automation doesn't silently break.
 *
 * KPI widgets get one id per `chartType` (the inner stat is what the
 * test asserts on); other widget types get one id per `type`.
 */
function widgetDomId(widget: OrgDashboardWidgetDto): string | undefined {
    if (widget.type === 'KPI') {
        return `org-stat-${widget.chartType}`;
    }
    if (widget.type === 'DRILLDOWN_CTAS') return 'org-drilldown-ctas';
    if (widget.type === 'TENANT_LIST') return 'org-tenant-coverage';
    return undefined;
}

export function DispatchedWidget({
    widget,
    data,
    actionsSlot,
}: DispatcherProps) {
    let body: React.ReactNode = null;
    let title: string | undefined = widget.title ?? undefined;
    const domId = widgetDomId(widget);

    switch (widget.type) {
        case 'KPI': {
            // KPI cards have their own internal label and gradient;
            // wrapping them in a DashboardWidget with a title would
            // double-render the label. Render bare — the KpiCard IS
            // the widget surface for this type. The id wrapper exists
            // so the legacy `#org-stat-*` E2E selectors keep resolving.
            const props = resolveKpiContent(widget, data);
            return (
                <div id={domId} className="h-full">
                    <ChartRenderer {...props} />
                </div>
            );
        }
        case 'DONUT': {
            body = <ChartRenderer {...resolveDonutContent(widget, data)} />;
            break;
        }
        case 'TREND': {
            body = <ChartRenderer {...resolveTrendContent(widget, data)} />;
            break;
        }
        case 'TENANT_LIST': {
            const cfg = widget.config as {
                sortBy?: 'rag' | 'name' | 'coverage';
                limit?: number;
                display?: 'list' | 'cards';
            };
            title = widget.title ?? 'Coverage by Tenant';
            body = (
                <div className="overflow-y-auto h-full -mx-2 px-2">
                    {cfg.display === 'cards' ? (
                        <TenantCoverageCards
                            rows={data.tenantHealth}
                            sortBy={cfg.sortBy}
                            limit={cfg.limit}
                        />
                    ) : (
                        <TenantCoverageList
                            rows={data.tenantHealth}
                            sortBy={cfg.sortBy}
                            limit={cfg.limit}
                        />
                    )}
                </div>
            );
            break;
        }
        case 'DRILLDOWN_CTAS': {
            const cfg = widget.config as {
                entries?: ReadonlyArray<'controls' | 'evidence'>;
            };
            title = widget.title ?? 'Drill-down';
            body = (
                <DrillDownCtas
                    summary={data.summary}
                    orgSlug={data.orgSlug}
                    entries={cfg.entries}
                />
            );
            break;
        }
    }

    return (
        <DashboardWidget
            title={title}
            actions={actionsSlot}
            data-widget-id={widget.id}
            id={domId}
            showResizeHandle={Boolean(actionsSlot)}
        >
            {body}
        </DashboardWidget>
    );
}

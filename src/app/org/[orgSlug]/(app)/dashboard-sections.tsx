"use client";

/**
 * Epic 41 page rewire — extracted dashboard section primitives.
 *
 * The org overview page used to render `TenantCoverageList` /
 * `DrillDownCtas` / `RagPill` / `CoverageBar` inline. The widget
 * dispatcher (`widget-dispatcher.tsx`) needs them as standalone
 * components to mount inside a `<DashboardWidget>` for `TENANT_LIST`
 * and `DRILLDOWN_CTAS` widget types. The visual / a11y / token
 * choices are unchanged from the prior page — no design drift.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRight, Layers, Paperclip } from 'lucide-react';

import { AnimatedNumber } from '@/components/ui/animated-number';
import { CardList } from '@/components/ui/card-list';
import { EmptyState } from '@/components/ui/empty-state';
import { MiniAreaChart } from '@/components/ui/mini-area-chart';
import { StatusBadge } from '@/components/ui/status-badge';
import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';
import type {
    PortfolioSummary,
    RagBadge,
    TenantHealthRow,
} from '@/app-layer/schemas/portfolio';

// ─── Tenant coverage list ──────────────────────────────────────────

export function TenantCoverageList({
    rows,
    sortBy = 'rag',
    limit,
}: {
    rows: TenantHealthRow[];
    sortBy?: 'rag' | 'name';
    limit?: number;
}) {
    const t = useTranslations('org.sections');
    if (rows.length === 0) {
        return (
            <EmptyState
                icon={Layers}
                title={t('emptyTenantsTitle')}
                description={t('emptyTenantsDesc')}
            />
        );
    }

    const ragOrder: Record<RagBadge | 'PENDING', number> = {
        RED: 0, AMBER: 1, GREEN: 2, PENDING: 3,
    };
    const sorted = [...rows].sort((a, b) => {
        if (sortBy === 'rag') {
            const ra = ragOrder[a.rag ?? 'PENDING'];
            const rb = ragOrder[b.rag ?? 'PENDING'];
            if (ra !== rb) return ra - rb;
            return a.name.localeCompare(b.name);
        }
        return a.name.localeCompare(b.name);
    });
    const visible = limit ? sorted.slice(0, limit) : sorted;

    return (
        <ul
            className="divide-y divide-border-subtle"
            data-testid="org-tenant-coverage-list"
        >
            {visible.map((row) => (
                <li key={row.tenantId} className="py-2">
                    <Link
                        href={row.drillDownUrl}
                        className="flex items-center gap-default hover:bg-bg-muted -mx-3 px-3 py-2 rounded-lg transition-colors group"
                        data-testid={`org-tenant-row-${row.slug}`}
                    >
                        <RagPill rag={row.rag} />
                        <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-tight">
                                <span className="text-sm font-medium text-content-emphasis truncate">
                                    {row.name}
                                </span>
                                <span className="text-xs tabular-nums text-content-muted">
                                    <AnimatedNumber
                                        value={row.overdueEvidence ?? 0}
                                        format={{ kind: 'integer' }}
                                    />
                                </span>
                            </div>
                            <div className="mt-1.5 flex items-center gap-default text-xs text-content-muted">
                                <span>{row.overdueEvidence ?? 0} {t('overdueEvidence')}</span>
                            </div>
                        </div>
                        <ChevronRight
                            className="w-4 h-4 text-content-subtle group-hover:text-content-emphasis transition-colors"
                            aria-hidden="true"
                        />
                    </Link>
                </li>
            ))}
        </ul>
    );
}

export function RagPill({ rag }: { rag: RagBadge | null }) {
    const t = useTranslations('org.sections');
    if (rag === null) return <StatusBadge variant="neutral">{t('pending')}</StatusBadge>;
    const variant: 'success' | 'warning' | 'error' =
        rag === 'GREEN' ? 'success' : rag === 'AMBER' ? 'warning' : 'error';
    return <StatusBadge variant={variant}>{rag}</StatusBadge>;
}


// ─── Tenant coverage cards (Epic 66) ──────────────────────────────
//
// Card-based representation of the same `TenantHealthRow[]` data
// `<TenantCoverageList>` consumes. Designed for the portfolio
// dashboard's `TENANT_LIST` widget when the operator wants a richer
// per-tenant summary (RAG badge + sparkline + practice count + last
// activity) instead of the dense list. Built on the shared
// `<CardList>` compound primitives so the layout, hover, focus,
// and selection affordances stay consistent with every other
// card-based surface.

export interface TenantCoverageCardsProps {
    rows: TenantHealthRow[];
    sortBy?: 'rag' | 'name';
    limit?: number;
    /**
     * Optional per-tenant trend series for the sparkline. Keyed by
     * `tenantId`. When a tenant has no series (or the prop is
     * omitted entirely), the card falls back to a plain coverage
     * percentage and skips the sparkline. Lets pages adopt the
     * card view incrementally — sparklines can be wired in later
     * without forcing a schema/API change first.
     */
    trends?: Record<
        string,
        ReadonlyArray<{ date: Date; value: number }>
    >;
}

export function TenantCoverageCards({
    rows,
    sortBy = 'rag',
    limit,
    trends,
}: TenantCoverageCardsProps) {
    const t = useTranslations('org.sections');
    if (rows.length === 0) {
        return (
            <EmptyState
                icon={Layers}
                title={t('emptyTenantsTitle')}
                description={t('emptyTenantsDesc')}
            />
        );
    }

    // Same sort + slice contract as TenantCoverageList so a widget
    // can flip `display: 'list' | 'cards'` without re-ranking.
    const ragOrder: Record<RagBadge | 'PENDING', number> = {
        RED: 0,
        AMBER: 1,
        GREEN: 2,
        PENDING: 3,
    };
    const sorted = [...rows].sort((a, b) => {
        if (sortBy === 'rag') {
            const ra = ragOrder[a.rag ?? 'PENDING'];
            const rb = ragOrder[b.rag ?? 'PENDING'];
            if (ra !== rb) return ra - rb;
            return a.name.localeCompare(b.name);
        }
        return a.name.localeCompare(b.name);
    });
    const visible = limit ? sorted.slice(0, limit) : sorted;

    return (
        <CardList aria-label={t('tenantCoverageAria')} data-testid="org-tenant-coverage-cards">
            {visible.map((row) => {
                const series = trends?.[row.tenantId] ?? [];
                const hasSparkline = series.length > 1;
                const variant: 'success' | 'warning' | 'error' | 'neutral' =
                    row.rag === 'GREEN'
                        ? 'success'
                        : row.rag === 'AMBER'
                        ? 'warning'
                        : row.rag === 'RED'
                        ? 'error'
                        : 'neutral';
                return (
                    <CardList.Card
                        key={row.tenantId}
                        data-testid={`org-tenant-card-${row.slug}`}
                        // Whole-card click navigates to the tenant
                        // — match the existing `<TenantCoverageList>`
                        // navigation behaviour. The Link below is a
                        // visible affordance + keyboard-accessible
                        // backstop (anchor click is intercepted by
                        // the card's interactive-child guard, so it
                        // navigates via its own href without
                        // double-triggering the card click).
                        onClick={() => {
                            if (typeof window !== 'undefined') {
                                window.location.href = row.drillDownUrl;
                            }
                        }}
                    >
                        <CardList.CardHeader
                            title={
                                <Link
                                    href={row.drillDownUrl}
                                    className="text-content-emphasis hover:underline"
                                >
                                    {row.name}
                                </Link>
                            }
                            subtitle={row.slug}
                            badge={<RagPill rag={row.rag} />}
                        />
                        <CardList.CardContent
                            kv={[
                                {
                                    label: t('cardOverdueEvidence'),
                                    value: row.overdueEvidence ?? 0,
                                },
                            ]}
                        >
                            {hasSparkline ? (
                                <div
                                    className="h-10 w-full"
                                    data-testid={`org-tenant-card-spark-${row.slug}`}
                                >
                                    <MiniAreaChart
                                        data={series}
                                        variant={variant}
                                        aria-label={t('coverageTrendAria', {
                                            name: row.name,
                                        })}
                                    />
                                </div>
                            ) : null}
                            {row.snapshotDate && (
                                <p className="text-xs text-content-subtle">
                                    {t('lastActivity')}{' '}
                                    <TimestampTooltip date={row.snapshotDate} />
                                </p>
                            )}
                        </CardList.CardContent>
                    </CardList.Card>
                );
            })}
        </CardList>
    );
}

// ─── Drill-down CTAs ───────────────────────────────────────────────

export function DrillDownCtas({
    summary,
    orgSlug,
    entries,
}: {
    summary: PortfolioSummary;
    orgSlug: string;
    entries?: ReadonlyArray<'evidence'>;
}) {
    const t = useTranslations('org.sections');
    // GRC teardown phase 2: the 'practices' drill-down tile is gone. Its
    // href pointed at /org/:slug/practices, a route this teardown deleted,
    // and its count read summary.practices.* — columns jobs/snapshot.ts
    // stopped computing, so the tile rendered a confident zero over a dead
    // link. No e2e caught it: ciso test B only asserts the CTA container is
    // visible, so a real user clicking the tile 404s while CI stays green.
    const all = [
        {
            key: 'evidence' as const,
            label: t('ctaEvidence'),
            count: summary.evidence.overdue,
            href: `/org/${orgSlug}/evidence`,
            icon: Paperclip,
            tone: 'orange',
        },
    ] as const;
    const visible = entries
        ? all.filter((cta) => entries.includes(cta.key))
        : all;

    return (
        <div
            className="grid grid-cols-1 sm:grid-cols-3 gap-compact h-full"
            data-testid="org-drilldown-ctas"
        >
            {visible.map((cta) => (
                <Link
                    key={cta.href}
                    href={cta.href}
                    className="rounded-lg border border-border-subtle hover:border-border-default hover:bg-bg-muted/50 transition-colors duration-150 ease-out p-3 group"
                    data-testid={`org-drilldown-${cta.key}`}
                >
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-tight text-content-emphasis">
                            <cta.icon
                                className={`w-4 h-4 text-${cta.tone}-500`}
                                aria-hidden="true"
                            />
                            <span className="font-medium text-xs">{cta.label}</span>
                        </div>
                        <ChevronRight
                            className="w-4 h-4 text-content-subtle group-hover:text-content-emphasis transition-colors"
                            aria-hidden="true"
                        />
                    </div>
                    <p className="mt-2 text-xl font-bold text-content-emphasis tabular-nums">
                        <AnimatedNumber
                            value={cta.count}
                            format={{ kind: 'integer' }}
                        />
                    </p>
                    <p className="text-xs text-content-muted">
                        {cta.count === 1 ? t('ctaItemsOne') : t('ctaItemsOther')}
                    </p>
                </Link>
            ))}
        </div>
    );
}

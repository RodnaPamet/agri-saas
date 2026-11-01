'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { DataTable, createColumns } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@/lib/format-date';
import type { UsageInsights } from '@/app-layer/usecases/usage-insights';

/**
 * The three tables of «Използване». Client half of the #493 console.
 *
 * Split from the page for the ordinary reason: `DataTable` is a client
 * primitive and the gate is a server concern. The page decides WHO may see
 * this; this file decides what it looks like.
 */
export function UsageConsoleClient({ insights }: { insights: UsageInsights }) {
    const t = useTranslations('admin.usage');

    const farmColumns = useMemo(
        () =>
            createColumns<UsageInsights['byFarm'][number]>([
                {
                    id: 'farm',
                    header: t('colFarm'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-default">{row.original.tenantName}</span>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'events',
                    header: t('colEvents'),
                    cell: ({ row }) => <span className="tabular-nums">{row.original.events}</span>,
                    meta: { mobileCard: { slot: 'meta' } },
                },
                {
                    id: 'people',
                    header: t('colPeople'),
                    cell: ({ row }) => <span className="tabular-nums">{row.original.distinctUsers}</span>,
                    meta: { mobileCard: { slot: 'meta' } },
                },
                {
                    id: 'lastSeen',
                    header: t('colLastSeen'),
                    cell: ({ row }) => formatDateTime(row.original.lastSeen),
                    meta: { mobileCard: { slot: 'meta' } },
                },
            ]),
        [t],
    );

    const nameColumns = (label: string, showSurface: boolean) =>
        createColumns<UsageInsights['byScreen'][number]>([
            {
                id: 'name',
                header: label,
                cell: ({ row }) =>
                    showSurface ? (
                        <span className="text-sm text-content-default">{row.original.surface}</span>
                    ) : (
                        /*
                         * The event NAME as stored, monospaced and untranslated.
                         * These are the frozen vocabulary values the iOS enum also
                         * uses, so a superuser comparing this page against a client
                         * bug report needs the literal token, not a rendering of it.
                         */
                        <span className="font-mono text-xs text-content-default">{row.original.name}</span>
                    ),
                meta: { mobileCard: { slot: 'title' } },
            },
            {
                id: 'events',
                header: t('colEvents'),
                cell: ({ row }) => <span className="tabular-nums">{row.original.events}</span>,
                meta: { mobileCard: { slot: 'meta' } },
            },
            {
                id: 'people',
                header: t('colPeople'),
                cell: ({ row }) => <span className="tabular-nums">{row.original.distinctUsers}</span>,
                meta: { mobileCard: { slot: 'meta' } },
            },
        ]);

    if (insights.totalEvents === 0) {
        return (
            <EmptyState
                size="sm"
                variant="no-records"
                title={t('noData')}
                /*
                 * Two causes, one appearance, and they want different actions:
                 * the flag is off and nothing is recording, or the flag is on
                 * and nobody used the product in this window. A count cannot
                 * tell them apart, so the copy names BOTH rather than guessing —
                 * an "it's off" message on a live deployment would send an
                 * operator to flip a switch that is already flipped.
                 */
                description={`${t('noDataDescription')} ${t('flagOff')}`}
            />
        );
    }

    return (
        <div className="space-y-section">
            <p className="text-sm text-content-muted">
                {t('totalEvents', { count: insights.totalEvents })}
            </p>

            <section className="space-y-default">
                <Heading level={2}>{t('byFarm')}</Heading>
                <DataTable
                    mobileFallback="card"
                    data={insights.byFarm}
                    columns={farmColumns}
                    getRowId={(r: UsageInsights['byFarm'][number]) => r.tenantId}
                />
            </section>

            <section className="space-y-default">
                <Heading level={2}>{t('byScreen')}</Heading>
                <DataTable
                    mobileFallback="card"
                    data={insights.byScreen}
                    columns={nameColumns(t('colScreen'), true)}
                    getRowId={(r: UsageInsights['byScreen'][number]) => r.surface ?? r.name}
                />
            </section>

            <section className="space-y-default">
                <Heading level={2}>{t('byAction')}</Heading>
                <DataTable
                    mobileFallback="card"
                    data={insights.byAction}
                    columns={nameColumns(t('colAction'), false)}
                    getRowId={(r: UsageInsights['byAction'][number]) => r.name}
                />
            </section>
        </div>
    );
}

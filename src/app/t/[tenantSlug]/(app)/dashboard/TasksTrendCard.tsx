'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { Skeleton } from '@/components/ui/skeleton';
import { AsyncState } from '@/components/ui/async-state';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import {
    TimeSeriesChart,
    Areas,
    XAxis,
    YAxis,
    type Series,
    type TimeSeriesDatum,
} from '@/components/ui/charts';
import type { FarmTaskTrendPoint } from '@/app-layer/usecases/farm-task';

type TrendValues = { created: number; completed: number };

// Series hues — created leads with the brand tone, completed with the
// positive/success tone. `text-*` because the chart area fills use
// currentColor; the legend dots use the matching `bg-*` token.
const CREATED_LINE = 'text-brand-default';
const COMPLETED_LINE = 'text-content-success';
const CREATED_DOT = 'bg-brand-default';
const COMPLETED_DOT = 'bg-content-success';

function LegendItem({ dot, label, count }: { dot: string; label: string; count: number }) {
    return (
        <span className="flex items-center gap-tight">
            <span aria-hidden="true" className={`h-2 w-2 rounded-full ${dot}`} />
            <span className="text-content-muted">{label}</span>
            <span className="font-medium text-content-default tabular-nums">{count}</span>
        </span>
    );
}

/**
 * Dashboard "tasks — created vs completed" trendline. Reads the daily
 * bucketed counts (last 14 days) from `/dashboard/task-trend` and renders two
 * area series through the shared TimeSeriesChart primitive. Always shown
 * (Tasks isn't module-gated); collapses to a one-line empty state when the
 * window had no farm-task activity, and to a skeleton while the read is in
 * flight.
 */
export default function TasksTrendCard() {
    const t = useTranslations('dashboard.taskTrend');
    const { data, error, isLoading, mutate } = useTenantSWR<{ trend: FarmTaskTrendPoint[] }>(
        CACHE_KEYS.dashboard.taskTrend(),
    );

    const points = useMemo(() => data?.trend ?? [], [data]);

    const chartData = useMemo<TimeSeriesDatum<TrendValues>[]>(
        () =>
            points.map((p) => ({
                date: new Date(`${p.date}T00:00:00Z`),
                values: { created: p.created, completed: p.completed },
            })),
        [points],
    );

    const series = useMemo<Series<TrendValues>[]>(
        // `isActive: true` is REQUIRED for the series to render: <Areas>
        // filters on truthy `isActive`, so a series that omits it draws its
        // axis/scale (layout.ts treats undefined as active) but no area —
        // the "axes but no line" symptom. Every other caller (TrendCard, …)
        // sets it; this card originally missed it.
        () => [
            { id: 'created', isActive: true, valueAccessor: (d) => d.values.created, colorClassName: CREATED_LINE },
            { id: 'completed', isActive: true, valueAccessor: (d) => d.values.completed, colorClassName: COMPLETED_LINE },
        ],
        [],
    );

    const totals = useMemo(
        () =>
            points.reduce(
                (a, p) => ({
                    created: a.created + p.created,
                    completed: a.completed + p.completed,
                }),
                { created: 0, completed: 0 },
            ),
        [points],
    );
    const hasActivity = totals.created > 0 || totals.completed > 0;

    return (
        <Card>
            <div className="flex items-baseline justify-between mb-3 gap-tight">
                <Heading level={3} id="task-trend-heading">
                    {t('title')}
                </Heading>
                {points.length > 0 && (
                    <span className="text-xs text-content-subtle">
                        {t('window', { days: points.length })}
                    </span>
                )}
            </div>

            <AsyncState
                data={data}
                error={error}
                isLoading={isLoading}
                onRetry={() => void mutate()}
                skeleton={<Skeleton className="h-40 w-full" />}
            >
                {() => !hasActivity ? (
                <p className="text-content-subtle text-xs">{t('empty')}</p>
            ) : (
                <>
                    <div className="mb-2 flex items-center gap-default text-xs">
                        <LegendItem dot={CREATED_DOT} label={t('created')} count={totals.created} />
                        <LegendItem dot={COMPLETED_DOT} label={t('completed')} count={totals.completed} />
                    </div>
                    <div
                        className="h-40"
                        role="img"
                        aria-label={t('ariaSummary', {
                            days: points.length,
                            created: totals.created,
                            completed: totals.completed,
                        })}
                    >
                        <TimeSeriesChart<TrendValues> type="area" data={chartData} series={series}>
                            <YAxis showGridLines />
                            <Areas />
                            <XAxis />
                        </TimeSeriesChart>
                    </div>
                </>
            )}
            </AsyncState>
        </Card>
    );
}

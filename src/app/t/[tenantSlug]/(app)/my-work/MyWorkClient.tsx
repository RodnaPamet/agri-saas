'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { ChevronRight } from '@/components/ui/icons/nucleo/chevron-right';
import { LocationPin } from '@/components/ui/icons/nucleo/location-pin';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/format-date';
import { AsyncState } from '@/components/ui/async-state';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { useOfflineSync } from '@/lib/offline/use-offline-sync';

interface WorkRow {
    id: string;
    title: string;
    type: string;
    status: string;
    dueAt: string | null;
}

const CARD_CLASS =
    'flex items-center gap-default rounded-lg border border-border-default bg-bg-elevated p-4 min-h-[72px]';

function TypeChip({ label }: { label: string }) {
    return (
        <span className="inline-flex items-center rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-content-muted">
            {label}
        </span>
    );
}

export function MyWorkClient({ tenantSlug: _tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('myWork');
    const href = useTenantHref();
    const apiUrl = useTenantApiUrl();
    const { submit } = useOfflineSync();
    const { data, error, isLoading, mutate } = useTenantSWR<WorkRow[]>('/farm-tasks?open=1');

    const rows = data ?? [];

    const markDone = useCallback(
        async (id: string, label: string) => {
            // Optimistically drop the row — the operator sees instant progress.
            await mutate((cur) => (cur ?? []).filter((r) => r.id !== id), {
                revalidate: false,
            });
            try {
                // Network-first, falls back to the offline outbox (returns
                // 'queued') so a completion tapped in the field still lands
                // when connectivity returns.
                await submit({
                    url: apiUrl(`/tasks/${id}/status`),
                    method: 'POST',
                    body: { status: 'RESOLVED', resolution: t('doneResolution') },
                    label,
                });
            } catch {
                // Hard failure (not a mere offline queue) — revalidate so the
                // task reappears rather than silently vanishing.
                await mutate();
            }
        },
        [apiUrl, mutate, submit, t],
    );

    return (
        <div className="space-y-section">
            <header className="flex items-start justify-between gap-default">
                <div className="space-y-tight">
                    <Heading level={1}>{t('title')}</Heading>
                    <p className="text-sm text-content-muted">
                        {t('subtitle', { count: rows.length })}
                    </p>
                </div>
                {/* The sprayer needs to see where the fields are as part of the
                    job — the one extra surface they can reach from here. */}
                <Link
                    href={href('/locations')}
                    className="inline-flex flex-shrink-0 items-center gap-tight rounded-lg border border-border-default bg-bg-elevated px-3 py-2 text-sm font-medium text-content-default transition-colors hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                    <LocationPin className="h-4 w-4 flex-shrink-0 text-content-muted" aria-hidden="true" />
                    {t('locations')}
                </Link>
            </header>

            {/*
              * `rows` is derived from `data`, so `rows.length === 0` was true
              * both when the queue is empty AND when the fetch never landed.
              * Offline, SWR retries twice, gives up, sets isLoading false with
              * data still undefined — and an operator with queued jobs was
              * shown "no records" (#862). AsyncState resolves that: no data
              * and not loading is a failure, and only real data reaches the
              * empty check below.
              */}
            <AsyncState
                data={data}
                error={error}
                isLoading={isLoading}
                onRetry={() => void mutate()}
                skeleton={
                    <div className="space-y-default" aria-hidden="true">
                        <Skeleton className="h-[72px] w-full rounded-lg" />
                        <Skeleton className="h-[72px] w-full rounded-lg" />
                        <Skeleton className="h-[72px] w-full rounded-lg" />
                    </div>
                }
            >
                {() => rows.length === 0 ? (
                <EmptyState
                    variant="no-records"
                    title={t('emptyTitle')}
                    description={t('emptyHint')}
                />
            ) : (
                <ul className="space-y-default">
                    {rows.map((task) => {
                        const isFieldOp = task.type === 'FIELD_OPERATION';
                        const due = task.dueAt ? t('dueLabel', { date: formatDate(task.dueAt) }) : t('noDue');
                        const meta = (
                            <span className="flex min-w-0 flex-col gap-tight">
                                <span className="truncate text-base font-semibold text-content-emphasis">
                                    {task.title}
                                </span>
                                <span className="flex items-center gap-compact">
                                    <TypeChip label={isFieldOp ? t('fieldOperation') : t('farmTask')} />
                                    <span className="truncate text-xs text-content-subtle">{due}</span>
                                </span>
                            </span>
                        );

                        return (
                            <li key={task.id}>
                                {isFieldOp ? (
                                    // Tap → the existing offline parcel-marking panel.
                                    <Link
                                        href={href(`/field/${task.id}`)}
                                        aria-label={t('openJob', { title: task.title })}
                                        className={`${CARD_CLASS} justify-between transition-colors hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]`}
                                    >
                                        {meta}
                                        <ChevronRight className="h-5 w-5 flex-shrink-0 text-content-subtle" aria-hidden="true" />
                                    </Link>
                                ) : (
                                    <div className={`${CARD_CLASS} justify-between`}>
                                        {meta}
                                        <Button
                                            variant="primary"
                                            size="sm"
                                            className="flex-shrink-0"
                                            onClick={() => void markDone(task.id, t('doneLabel', { title: task.title }))}
                                        >
                                            {t('markDone')}
                                        </Button>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            </AsyncState>
        </div>
    );
}

export default MyWorkClient;

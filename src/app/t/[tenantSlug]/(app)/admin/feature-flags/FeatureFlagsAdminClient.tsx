'use client';

/**
 * «Функции» — the flag switchboard (#2706).
 *
 * Three things this screen must not hide, each of which would make it worse
 * than the terminal it replaces:
 *
 *   1. **`FEATURE_FLAGS_FORCE_OFF`** overrides every row. A page showing a
 *      flag as ON while every client sees it off is actively misleading, so the
 *      banner is unconditional when it is set — and it says that clearing it is
 *      an operator action on the VM, because it is deliberately not reachable
 *      from any API: the switch exists for when the application is the thing
 *      going wrong.
 *   2. **A cohort with no members** makes an ENABLED flag off for everyone
 *      while reading as a live rollout. The flag row cannot show that; the
 *      cohort sizes beside it can.
 *   3. **A flip takes up to 30s** to reach every request, because the table is
 *      Redis-cached under one key. Said on the page, so a superuser who flips
 *      and reloads does not conclude it failed and flip it back.
 *
 * The rows are the RAW table, never a resolved per-caller view: an operator
 * opens this screen precisely to see that a flag is enabled-but-cohort-gated,
 * which `/api/auth/me` collapses to one boolean on purpose.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPut } from '@/lib/api-client';
import { Switch } from '@/components/ui/switch';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';

interface FlagRow {
    key: string;
    enabled: boolean;
    cohorts: string[];
    description: string | null;
    updatedAt: string;
}

interface CohortSize {
    cohort: string;
    members: number;
}

interface FlagsPayload {
    flags: FlagRow[];
    cohorts: CohortSize[];
    forcedOff: boolean;
}

export function FeatureFlagsAdminClient() {
    const t = useTranslations('featureFlagsAdmin');
    const url = useTenantApiUrl();
    const { data, isLoading, mutate } = useTenantSWR<FlagsPayload>('/admin/feature-flags');
    const [pending, setPending] = useState<string | null>(null);

    const flags = data?.flags ?? [];
    const sizes = new Map((data?.cohorts ?? []).map((c) => [c.cohort, c.members]));

    const toggle = async (row: FlagRow, next: boolean) => {
        setPending(row.key);
        try {
            // The WHOLE row, because `cohorts` must always be explicit: an
            // absent list in a Prisma update means "leave it alone", and a
            // flip that silently kept a narrowing the operator could not see
            // would be the exact confusion this screen exists to remove.
            await apiPut(url('/admin/feature-flags'), {
                key: row.key,
                enabled: next,
                cohorts: row.cohorts,
            });
            await mutate();
        } finally {
            setPending(null);
        }
    };

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <PageBreadcrumbs items={[{ label: t('title') }]} />
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-xs text-content-muted">{t('propagationNote')}</p>
            </ListPageShell.Header>

            <ListPageShell.Body>
                {data?.forcedOff ? (
                    <InlineNotice variant="warning" title={t('forcedOffTitle')}>
                        {t('forcedOffBody')}
                    </InlineNotice>
                ) : null}

                {!isLoading && flags.length === 0 ? (
                    <EmptyState title={t('emptyTitle')} description={t('emptyBody')} />
                ) : null}

                <div className="space-y-default">
                    {flags.map((row) => {
                        // An enabled flag whose cohort has nobody in it is OFF
                        // for everyone and reads as a live rollout. Surfaced
                        // per row rather than as a summary, because the
                        // operator acts on one flag at a time.
                        const emptyCohorts = row.cohorts.filter((c) => (sizes.get(c) ?? 0) === 0);
                        const silentlyOff = row.enabled && emptyCohorts.length > 0;

                        return (
                            <div
                                key={row.key}
                                className="flex items-start justify-between gap-default rounded-md border border-border-default p-default"
                            >
                                <div className="space-y-tight">
                                    <div className="flex items-center gap-tight">
                                        <span className="font-mono text-sm text-content-default">
                                            {row.key}
                                        </span>
                                        {data?.forcedOff ? (
                                            <StatusBadge variant="warning">
                                                {t('maskedByForceOff')}
                                            </StatusBadge>
                                        ) : null}
                                        {silentlyOff ? (
                                            <StatusBadge variant="warning">
                                                {t('offForEveryone')}
                                            </StatusBadge>
                                        ) : null}
                                    </div>
                                    {row.description ? (
                                        <p className="text-xs text-content-muted">
                                            {row.description}
                                        </p>
                                    ) : null}
                                    <p className="text-xs text-content-subtle">
                                        {row.cohorts.length === 0
                                            ? t('cohortsEveryone')
                                            : row.cohorts
                                                  .map(
                                                      (c) =>
                                                          `${c} (${sizes.get(c) ?? 0})`,
                                                  )
                                                  .join(', ')}
                                    </p>
                                </div>
                                <Switch
                                    checked={row.enabled}
                                    loading={pending === row.key}
                                    onCheckedChange={(next) => void toggle(row, next)}
                                    aria-label={t('toggleAria', { key: row.key })}
                                    id={`flag-${row.key}`}
                                />
                            </div>
                        );
                    })}
                </div>
            </ListPageShell.Body>
        </ListPageShell>
    );
}

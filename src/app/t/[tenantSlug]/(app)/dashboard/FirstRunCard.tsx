'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { Button } from '@/components/ui/button';
import { ProgressCircle } from '@/components/ui/progress-circle';
import { CircleCheckFill, CircleDotted } from '@/components/ui/icons/nucleo';
import { useLocalStorage, useToast } from '@/components/ui/hooks';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { apiPost, apiDelete } from '@/lib/api-client';
import {
    useTenantContext,
    useTenantHref,
    useTenantApiUrl,
} from '@/lib/tenant-context-provider';
import { cn } from '@/lib/cn';
import {
    firstRunProgress,
    firstRunDismissKey,
    type FirstRunSignals,
} from '@/lib/onboarding-steps';
import type { AgDashboardPayload } from '@/app-layer/usecases/ag-dashboard';

/**
 * Guided first-run card — the "your first five minutes" progress ring,
 * plus the "try it with sample data" escape hatch.
 *
 * A brand-new farmer lands on a near-empty dashboard; this card gives them
 * two concrete next steps (map a field → log a job) with a ring that fills
 * as each is done, and a one-tap way to explore with seeded sample data.
 *
 * Visibility:
 *   - Onboarding nudge → hidden once both steps are complete (derived from
 *     real data, never a manual checkbox) or once dismissed.
 *   - Sample-data banner → shown WHENEVER sample data exists, even after
 *     dismiss/completion, so the "Clear sample data" practice is always
 *     reachable (loading sample rows makes the farm look "set up", which
 *     would otherwise hide the only place to undo it).
 *
 * Step-completion signals come from the SAME `/dashboard/ag` payload the
 * strip already fetched — no extra request. The sample-data status is its
 * own tiny `/sample-data` read.
 */
export default function FirstRunCard({
    payload,
    onChanged,
}: {
    payload: AgDashboardPayload;
    onChanged?: () => void;
}) {
    const t = useTranslations('dashboard.firstRun');
    const router = useRouter();
    const href = useTenantHref();
    const buildUrl = useTenantApiUrl();
    const toast = useToast();
    const { tenantId } = useTenantContext();
    const [dismissed, setDismissed] = useLocalStorage<boolean>(
        firstRunDismissKey(tenantId),
        false,
    );
    const [busy, setBusy] = useState(false);

    const { data: sampleStatus, mutate: mutateSample } = useTenantSWR<{ hasSampleData: boolean }>(
        '/sample-data',
    );
    const hasSample = sampleStatus?.hasSampleData ?? false;

    const fieldMapped =
        payload.achievements?.milestones.some(
            (m) => m.key === 'first-field-mapped' && m.earned,
        ) ?? false;
    const jobLogged =
        (payload.recentJournal?.length ?? 0) > 0 || (payload.myTasks?.length ?? 0) > 0;

    const signals: FirstRunSignals = { fieldMapped, jobLogged };
    const progress = firstRunProgress(signals);

    const onboardingDone = dismissed || progress.allComplete;
    // Nothing to show: onboarding is finished/dismissed AND there's no
    // sample data to manage.
    if (onboardingDone && !hasSample) return null;

    async function refresh() {
        await Promise.all([mutateSample()]);
        onChanged?.();
    }

    async function loadSample() {
        setBusy(true);
        try {
            const res = await apiPost<{ created: boolean }>(buildUrl('/sample-data'), {});
            await refresh();
            toast.success(
                res.created ? t('sampleAdded') : t('sampleAlreadyLoaded'),
                { description: t('sampleAddedDesc') },
            );
        } catch {
            toast.error(t('sampleAddError'), { description: t('tryAgain') });
        } finally {
            setBusy(false);
        }
    }

    async function clearSample() {
        setBusy(true);
        try {
            await apiDelete(buildUrl('/sample-data'));
            await refresh();
            toast.success(t('sampleCleared'));
        } catch {
            toast.error(t('sampleClearError'), { description: t('tryAgain') });
        } finally {
            setBusy(false);
        }
    }

    // ── Sample-data mode — the farm is running on seeded demo rows ──
    if (hasSample) {
        return (
            <Card density="comfortable" className="border-border-emphasis">
                <div className="flex items-start justify-between gap-default">
                    <div className="min-w-0 space-y-1">
                        <Heading level={2} className="text-base">
                            {t('sampleTitle')}
                        </Heading>
                        <p className="text-sm text-content-secondary">
                            {t('sampleDesc')}
                        </p>
                    </div>
                    <Button
                        variant="secondary"
                        size="sm"
                        loading={busy}
                        onClick={clearSample}
                        className="shrink-0"
                    >
                        {t('clearSample')}
                    </Button>
                </div>
            </Card>
        );
    }

    // ── Onboarding nudge — guide the first five minutes ──
    return (
        <Card density="comfortable" className="border-border-emphasis">
            <div className="flex items-start gap-default">
                <ProgressCircle
                    progress={progress.completedCount / progress.total}
                    label={`${progress.completedCount}/${progress.total}`}
                    size="lg"
                    variant="brand"
                    aria-label={t('setupProgress', { completed: progress.completedCount, total: progress.total })}
                    className="shrink-0"
                />
                <div className="min-w-0 flex-1 space-y-default">
                    <div className="flex items-start justify-between gap-compact">
                        <div className="min-w-0">
                            <Heading level={2} className="text-base">
                                {t('onboardingTitle')}
                            </Heading>
                            <p className="text-sm text-content-secondary">
                                {t('onboardingDesc')}
                            </p>
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDismissed(true)}
                            className="shrink-0"
                        >
                            {t('dismiss')}
                        </Button>
                    </div>
                    <ul className="space-y-compact">
                        {progress.steps.map(({ step, done }) => (
                            <li key={step.id} className="flex items-center gap-compact">
                                {done ? (
                                    <CircleCheckFill
                                        className="size-5 shrink-0 text-content-success"
                                        aria-hidden
                                    />
                                ) : (
                                    <CircleDotted
                                        className="size-5 shrink-0 text-content-muted"
                                        aria-hidden
                                    />
                                )}
                                <div className="min-w-0 flex-1">
                                    <p
                                        className={cn(
                                            'text-sm font-medium',
                                            done && 'text-content-muted line-through',
                                        )}
                                    >
                                        {step.label}
                                    </p>
                                    {!done && (
                                        <p className="text-xs text-content-secondary">{step.hint}</p>
                                    )}
                                </div>
                                {!done && (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="shrink-0"
                                        onClick={() => router.push(href(step.href))}
                                    >
                                        {step.cta}
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                    <div className="flex items-center gap-compact border-t border-border-subtle pt-default">
                        <p className="flex-1 text-xs text-content-muted">
                            {t('sampleHint')}
                        </p>
                        <Button
                            variant="ghost"
                            size="sm"
                            loading={busy}
                            onClick={loadSample}
                            className="shrink-0"
                        >
                            {t('trySample')}
                        </Button>
                    </div>
                </div>
            </div>
        </Card>
    );
}

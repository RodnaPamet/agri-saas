'use client';

/**
 * Live run monitor (Automation Epic 10).
 *
 * The operator console: in-flight (RUNNING) executions with a cancel
 * affordance, a live recent-activity feed (5s refresh), and the manual
 * trigger panel. The Dynamic-Workflow-Tracker equivalent.
 */
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { ManualTriggerPanel } from '@/components/processes/ManualTriggerPanel';

interface ExecRow {
    id: string;
    ruleName: string;
    triggerEvent: string;
    status: string;
    triggeredBy: string;
    createdAt: string;
}

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    SUCCEEDED: 'success',
    FAILED: 'error',
    RUNNING: 'info',
    PENDING: 'neutral',
    SKIPPED: 'neutral',
};

export function MonitorTab() {
    const { formatDateTime } = useDateFormat();
    const t = useTranslations('processes.monitor');
    const apiUrl = useTenantApiUrl();
    const key = apiUrl(CACHE_KEYS.automation.executions.live());
    const { data, mutate } = useSWR<{ running: ExecRow[]; recent: ExecRow[] }>(
        key,
        (url: string) => fetch(url).then((r) => r.json()),
        { refreshInterval: 5000, revalidateOnFocus: true },
    );

    async function cancel(id: string) {
        await fetch(apiUrl(`/automation/executions/${id}`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'cancel' }),
        });
        await mutate();
    }

    const running = data?.running ?? [];
    const recent = data?.recent ?? [];

    return (
        <div className="grid grid-cols-1 gap-section p-default lg:grid-cols-3">
            <div className="space-y-section lg:col-span-2">
                <Card>
                    <p className="mb-default text-[11px] uppercase tracking-wide text-content-subtle">
                        {t('inFlight', { count: running.length })}
                    </p>
                    {running.length === 0 ? (
                        <p className="text-sm text-content-muted">{t('nothingRunning')}</p>
                    ) : (
                        <ul className="space-y-tight" data-testid="inflight-list">
                            {running.map((e) => (
                                <li key={e.id} className="flex items-center justify-between gap-default">
                                    <span className="flex items-center gap-compact text-sm">
                                        <StatusBadge variant="info">{t('running')}</StatusBadge>
                                        <span className="text-content-default">{e.ruleName}</span>
                                    </span>
                                    <Button variant="ghost" size="sm" onClick={() => cancel(e.id)}>
                                        {t('cancel')}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>

                <Card>
                    <p className="mb-default text-[11px] uppercase tracking-wide text-content-subtle">
                        {t('recentActivity')}
                    </p>
                    {recent.length === 0 ? (
                        <p className="text-sm text-content-muted">{t('recentEmpty')}</p>
                    ) : (
                        <ul className="space-y-tight" data-testid="recent-feed">
                            {recent.map((e) => (
                                <li key={e.id} className="flex items-center justify-between gap-default text-sm">
                                    <span className="flex items-center gap-compact">
                                        <StatusBadge variant={STATUS_VARIANT[e.status] ?? 'neutral'}>
                                            {e.status}
                                        </StatusBadge>
                                        <span className="truncate text-content-default">{e.ruleName}</span>
                                    </span>
                                    <span className="shrink-0 text-xs text-content-subtle tabular-nums">
                                        {formatDateTime(e.createdAt)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
            </div>
            <ManualTriggerPanel />
        </div>
    );
}

'use client';

/**
 * Execution history panel (Automation Epic 6).
 *
 * The GRC audit trail for a single rule: recent executions with status,
 * trigger source, duration, and an expandable error/outcome line, plus a
 * manual re-trigger. Reads the cursor-paginated executions endpoint (first
 * page) via SWR; "Load more" advances the cursor.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useDateFormat } from '@/lib/i18n/use-date-format';

interface ExecutionRow {
    id: string;
    status: string;
    triggeredBy: string;
    durationMs: number | null;
    errorMessage: string | null;
    createdAt: string;
}

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    SUCCEEDED: 'success',
    FAILED: 'error',
    RUNNING: 'info',
    PENDING: 'neutral',
    SKIPPED: 'neutral',
};

export function ExecutionsPanel({
    ruleId,
    ruleEnabled,
}: {
    ruleId: string;
    ruleEnabled: boolean;
}) {
    const { formatDateTime } = useDateFormat();
    const t = useTranslations('ui');
    const apiUrl = useTenantApiUrl();
    const key = apiUrl(CACHE_KEYS.automation.rules.executions(ruleId));
    const { data, isLoading, mutate } = useSWR<{ items: ExecutionRow[]; nextCursor: string | null }>(
        key,
        (url: string) => fetch(url).then((r) => r.json()),
    );
    const [expanded, setExpanded] = useState<string | null>(null);
    const [retriggering, setRetriggering] = useState(false);

    async function reTrigger() {
        setRetriggering(true);
        try {
            await fetch(apiUrl(`/automation/rules/${ruleId}/re-trigger`), { method: 'POST' });
            // Give the worker a beat, then refresh the list.
            await mutate();
        } finally {
            setRetriggering(false);
        }
    }

    const items = data?.items ?? [];

    return (
        <div className="space-y-tight">
            <div className="flex items-center justify-between">
                <p className="text-[11px] uppercase tracking-wide text-content-subtle">
                    {t('executions.recentExecutions')}
                </p>
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={!ruleEnabled || retriggering}
                    loading={retriggering}
                    onClick={reTrigger}
                >
                    {t('executions.reTrigger')}
                </Button>
            </div>
            {isLoading ? (
                <p className="text-sm text-content-muted">{t('executions.loading')}</p>
            ) : items.length === 0 ? (
                <p className="text-sm text-content-subtle">{t('executions.emptyExecutions')}</p>
            ) : (
                <ul className="space-y-tight" data-testid="executions-list">
                    {items.map((e) => (
                        <li key={e.id} className="rounded-md border border-border-subtle p-2">
                            <button
                                type="button"
                                className="flex w-full items-center justify-between gap-compact text-left"
                                onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                            >
                                <span className="flex items-center gap-compact">
                                    <StatusBadge variant={STATUS_VARIANT[e.status] ?? 'neutral'}>
                                        {e.status}
                                    </StatusBadge>
                                    <span className="text-xs text-content-muted">{e.triggeredBy}</span>
                                </span>
                                <span className="text-xs text-content-subtle tabular-nums">
                                    {formatDateTime(e.createdAt)}
                                </span>
                            </button>
                            {expanded === e.id && (
                                <div className="mt-2 space-y-tight text-xs text-content-muted">
                                    {e.durationMs != null && <p>{t('executions.duration', { ms: e.durationMs })}</p>}
                                    {e.errorMessage && (
                                        <p className="text-content-error">{e.errorMessage}</p>
                                    )}
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

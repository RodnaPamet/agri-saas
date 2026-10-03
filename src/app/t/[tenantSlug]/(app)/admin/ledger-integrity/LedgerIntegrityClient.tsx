'use client';

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ShieldCheck, ShieldAlert, ShieldQuestion, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { useToast } from '@/components/ui/hooks/use-toast';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { cn } from '@/lib/cn';

interface LedgerReconciliationRun {
    id: string;
    runAt: string;
    valid: boolean | null;
    totalEntries: number | null;
    firstBreakAt: number | null;
    firstBreakId: string | null;
    balanceHealthy: boolean | null;
    lotsChecked: number | null;
    driftCount: number | null;
    negativeCount: number | null;
    runBy: string | null;
}

/**
 * Interactive island for the Stock Ledger Integrity admin page.
 *
 *   • Hero card — the latest reconciliation verdict (intact / drift /
 *     never-run), entry count, and when + who last ran it.
 *   • "Run reconciliation" — POSTs the admin route; on success a toast
 *     fires and `router.refresh()` re-fetches the server-rendered
 *     history so the hero + timeline reflect the new run.
 *   • History — every past run, newest first.
 */
export function LedgerIntegrityClient({ history }: { history: LedgerReconciliationRun[] }) {
    const { formatDateTime } = useDateFormat();
    const t = useTranslations('admin.ledgerIntegrity');
    const router = useRouter();
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const latest = history[0] ?? null;

    const historyColumns = useMemo(
        () =>
            createColumns<LedgerReconciliationRun>([
                {
                    accessorKey: 'runAt',
                    header: t('colRunAt'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-default">
                            {formatDateTime(row.original.runAt)}
                        </span>
                    ),
                },
                {
                    accessorKey: 'valid',
                    header: t('colResult'),
                    cell: ({ row }) => <ResultBadge valid={row.original.valid} />,
                },
                {
                    accessorKey: 'totalEntries',
                    header: t('colEntries'),
                    cell: ({ row }) => (
                        <span className="text-sm tabular-nums text-content-muted">
                            {row.original.totalEntries ?? '—'}
                        </span>
                    ),
                },
                {
                    accessorKey: 'firstBreakAt',
                    header: t('colBreak'),
                    cell: ({ row }) => {
                        const { valid, firstBreakAt } = row.original;
                        if (valid !== false) return <span className="text-content-subtle">—</span>;
                        return (
                            <span className="text-sm text-content-error">
                                {t('entryNum', { num: firstBreakAt ?? '?' })}
                            </span>
                        );
                    },
                },
                {
                    accessorKey: 'balanceHealthy',
                    header: t('colBalance'),
                    cell: ({ row }) => <BalanceBadge run={row.original} />,
                },
                {
                    accessorKey: 'runBy',
                    header: t('colRunBy'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">{row.original.runBy ?? t('system')}</span>
                    ),
                },
            ]),
        [],
    );

    const runReconciliation = useCallback(async () => {
        setRunning(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/ledger-reconciliation'), { method: 'POST' });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: t('reconFailed') }));
                const msg = err.error?.message || err.error || err.message || t('reconFailed');
                setError(msg);
                toast.error(msg);
                return;
            }
            const report = (await res.json()) as {
                valid: boolean;
                totalEntries: number;
                balanceHealthy?: boolean;
            };
            if (!report.valid) {
                toast.error(t('foundBreak'));
            } else if (report.balanceHealthy === false) {
                // Chain intact but the lot balances drifted — surface the
                // balance half so "verified intact" can't mislead.
                toast.error(t('toastBalanceDrift'));
            } else {
                toast.success(t('verifiedAcross', { count: report.totalEntries }));
            }
            // Re-fetch the server-rendered history so the hero + timeline update.
            router.refresh();
        } catch (e) {
            const msg = (e as Error).message || t('reconFailed');
            setError(msg);
            toast.error(msg);
        } finally {
            setRunning(false);
        }
    }, [apiUrl, router, toast]);

    return (
        <div className="space-y-section">
            {error && <InlineNotice variant="error">{error}</InlineNotice>}

            {/* ── Hero status ── */}
            <Card className="p-6">
                <div className="flex items-start justify-between gap-default flex-wrap">
                    <StatusHero latest={latest} />
                    <Button
                        variant="primary"
                        icon={<RefreshCw className={cn('w-4 h-4', running && 'animate-spin')} />}
                        onClick={runReconciliation}
                        disabled={running}
                        id="run-reconciliation-btn"
                    >
                        {running ? t('running') : t('runReconciliation')}
                    </Button>
                </div>
            </Card>

            {/* ── History ── */}
            <div className="space-y-default">
                <Heading level={2}>{t('history')}</Heading>
                <DataTable<LedgerReconciliationRun>
                    data-testid="ledger-reconciliation-history-table"
                    data={history}
                    getRowId={(r) => r.id}
                    columns={historyColumns}
                    emptyState={
                        <div className="py-8 text-center text-sm text-content-muted">
                            {t('noRuns')}
                        </div>
                    }
                />
            </div>
        </div>
    );
}

/** The big verdict block on the left of the hero card. */
function StatusHero({ latest }: { latest: LedgerReconciliationRun | null }) {
    const { formatDateTime } = useDateFormat();
    const t = useTranslations('admin.ledgerIntegrity');
    if (!latest) {
        return (
            <HeroLayout
                icon={<ShieldQuestion className="w-8 h-8 text-content-muted" />}
                title={t('neverRun')}
                subtitle={t('neverRunSubtitle')}
            />
        );
    }
    const when = `${formatDateTime(latest.runAt)}${latest.runBy ? t('byRunner', { name: latest.runBy }) : ''}`;
    if (latest.valid === false) {
        return (
            <HeroLayout
                icon={<ShieldAlert className="w-8 h-8 text-content-error" />}
                title={t('driftDetected')}
                titleClassName="text-content-error"
                subtitle={t('driftSubtitle', { num: latest.firstBreakAt ?? '?', when })}
            />
        );
    }
    if (latest.valid === true && latest.balanceHealthy === false) {
        // Chain intact, but the lot on-hand cache drifted or went
        // negative — a "verified" chain must not mask this.
        return (
            <HeroLayout
                icon={<ShieldAlert className="w-8 h-8 text-content-warning" />}
                title={t('balanceDriftTitle')}
                titleClassName="text-content-warning"
                subtitle={t('balanceDriftSubtitle', {
                    drift: latest.driftCount ?? 0,
                    negative: latest.negativeCount ?? 0,
                    when,
                })}
            />
        );
    }
    if (latest.valid === true) {
        // balanceHealthy true → mention both halves; null (legacy chain-only
        // run) → the original chain-only subtitle.
        return (
            <HeroLayout
                icon={<ShieldCheck className="w-8 h-8 text-content-success" />}
                title={t('verifiedIntact')}
                titleClassName="text-content-success"
                subtitle={
                    latest.balanceHealthy === true
                        ? t('intactBothSubtitle', {
                              count: latest.totalEntries ?? 0,
                              lots: latest.lotsChecked ?? 0,
                              when,
                          })
                        : t('intactSubtitle', { count: latest.totalEntries ?? 0, when })
                }
            />
        );
    }
    return (
        <HeroLayout
            icon={<ShieldQuestion className="w-8 h-8 text-content-muted" />}
            title={t('lastRunRecorded')}
            subtitle={t('unknownSubtitle', { when })}
        />
    );
}

function HeroLayout({
    icon,
    title,
    subtitle,
    titleClassName,
}: {
    icon: React.ReactNode;
    title: string;
    subtitle: string;
    titleClassName?: string;
}) {
    return (
        <div className="flex items-start gap-default min-w-0">
            <div className="shrink-0">{icon}</div>
            <div className="min-w-0">
                <div className={cn('text-lg font-semibold text-content-default', titleClassName)}>{title}</div>
                <p className="text-sm text-content-muted mt-1">{subtitle}</p>
            </div>
        </div>
    );
}

function ResultBadge({ valid }: { valid: boolean | null }) {
    const t = useTranslations('admin.ledgerIntegrity');
    if (valid === true) return <StatusBadge variant="success" size="sm">{t('intact')}</StatusBadge>;
    if (valid === false) return <StatusBadge variant="error" size="sm">{t('drift')}</StatusBadge>;
    return <StatusBadge variant="neutral" size="sm">{t('unknown')}</StatusBadge>;
}

/** The balance-half verdict per run: healthy / drift-or-negative / unknown. */
function BalanceBadge({ run }: { run: LedgerReconciliationRun }) {
    const t = useTranslations('admin.ledgerIntegrity');
    if (run.balanceHealthy === null) return <span className="text-content-subtle">—</span>;
    if (run.balanceHealthy) return <StatusBadge variant="success" size="sm">{t('balanceOk')}</StatusBadge>;
    // Unhealthy: prefer the sharper "negative on-hand" signal, else cache drift.
    const label =
        (run.negativeCount ?? 0) > 0
            ? t('balanceNegativeN', { count: run.negativeCount ?? 0 })
            : t('balanceDriftN', { count: run.driftCount ?? 0 });
    return <StatusBadge variant="error" size="sm">{label}</StatusBadge>;
}

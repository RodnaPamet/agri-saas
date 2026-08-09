'use client';
/* eslint-disable @typescript-eslint/no-explicit-any -- Tanstack-react-table cell callbacks (tanstack cell callbacks where row/getValue carry the implicit-any annotation) — typing each callback with `CellContext<TData, TValue>` requires importing the right generic per column and adds significant ceremony. The implicit any here is at the render-time boundary; row.original is type-narrowed by the column's accessorKey at runtime. */
import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DataTable, createColumns } from '@/components/ui/table';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

interface NotificationSettings {
    enabled: boolean;
    defaultFromName: string;
    defaultFromEmail: string;
    complianceMailbox: string | null;
}

interface OutboxStats {
    last24h: { pending: number; sent: number; failed: number };
    last7d: { pending: number; sent: number; failed: number };
    last30d: { pending: number; sent: number; failed: number };
}

export default function NotificationSettingsPage() {
    const t = useTranslations('admin.notificationSettings');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [tab, setTab] = useState<'settings' | 'stats'>('settings');
    const [settings, setSettings] = useState<NotificationSettings | null>(null);
    const [stats, setStats] = useState<OutboxStats | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [runningJob, setRunningJob] = useState<'processOutbox' | 'dailySweep' | null>(null);

    const fetchData = useCallback(() => {
        fetch(apiUrl('/notification-settings'))
            .then(r => r.json())
            .then(data => {
                setSettings(data.settings);
                setStats(data.stats);
            })
            .catch(console.error);
    }, [apiUrl]);

    useEffect(() => { fetchData(); }, [fetchData]);

    async function handleRunJob(jobType: 'processOutbox' | 'dailySweep') {
        if (!confirm(t('confirmRunJob', { job: jobType }))) return;
        setRunningJob(jobType);
        try {
            const res = await fetch(apiUrl('/notification-settings/run-job'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobType }),
            });
            const data = await res.json();
            if (res.ok) {
                alert(t('jobSuccess', { message: data.message }) + '\n' + JSON.stringify(data.stats, null, 2));
                fetchData(); // Refresh stats
            } else {
                alert(t('jobError', { error: data.error || t('failedToTrigger') }));
            }
        } finally {
            setRunningJob(null);
        }
    }

    async function handleSave() {
        if (!settings) return;
        setSaving(true);
        setSaved(false);
        try {
            const res = await fetch(apiUrl('/notification-settings'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            });
            const updated = await res.json();
            setSettings(updated);
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } finally {
            setSaving(false);
        }
    }

    if (!settings) return <div className="p-8"><div className="h-6 w-full sm:w-48 bg-bg-elevated rounded animate-pulse" /></div>;

    return (
        <div className="space-y-section animate-fadeIn">
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                        { label: t('breadcrumbEmailNotifications') },
                    ]}
                    className="mb-1"
                />
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-default">
                <div className="flex flex-wrap items-center gap-compact">
                    <Heading level={1}>{t('heading')}</Heading>
                    <StatusBadge variant={settings.enabled ? 'success' : 'warning'}>
                        {settings.enabled ? t('enabled') : t('disabled')}
                    </StatusBadge>
                </div>
                <div className="flex items-center gap-compact">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleRunJob('processOutbox')}
                        disabled={!!runningJob}
                        loading={runningJob === 'processOutbox'}
                        className="rounded-full"
                    >
                        {runningJob === 'processOutbox' ? t('sending') : t('processOutboxNow')}
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleRunJob('dailySweep')}
                        disabled={!!runningJob}
                        loading={runningJob === 'dailySweep'}
                        className="rounded-full"
                    >
                        {runningJob === 'dailySweep' ? t('runningEllipsis') : t('runDailySweep')}
                    </Button>
                </div>
            </div>

            {/* Epic 60 — ToggleGroup replaces hand-rolled tab bar. */}
            <ToggleGroup
                ariaLabel={t('adminView')}
                options={[
                    { value: 'settings', label: t('settingsTab') },
                    { value: 'stats', label: t('sendStatsTab') },
                ]}
                selected={tab}
                selectAction={(v) => setTab(v as 'settings' | 'stats')}
            />

            {tab === 'settings' ? (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    {/* Enable / Disable */}
                    <label className="flex items-center gap-compact cursor-pointer">
                        <input
                            type="checkbox"
                            checked={settings.enabled}
                            onChange={e => setSettings({ ...settings, enabled: e.target.checked })}
                            className="toggle toggle-brand"
                        />
                        <span className="text-sm font-medium">{t('enableEmailNotifications')}</span>
                    </label>

                    {/* From Name */}
                    <div>
                        <label className="block text-xs text-content-muted mb-1">{t('senderName')}</label>
                        <input
                            type="text"
                            value={settings.defaultFromName}
                            onChange={e => setSettings({ ...settings, defaultFromName: e.target.value })}
                            className="input input-bordered w-full max-w-md"
                            placeholder={t('senderNamePlaceholder')}
                        />
                    </div>

                    {/* From Email */}
                    <div>
                        <label className="block text-xs text-content-muted mb-1">{t('senderEmail')}</label>
                        <input
                            type="email"
                            value={settings.defaultFromEmail}
                            onChange={e => setSettings({ ...settings, defaultFromEmail: e.target.value })}
                            className="input input-bordered w-full max-w-md"
                            placeholder={t('senderEmailPlaceholder')}
                        />
                    </div>

                    {/* Compliance Mailbox */}
                    <div>
                        <label className="block text-xs text-content-muted mb-1">{t('complianceMailbox')}</label>
                        <input
                            type="email"
                            value={settings.complianceMailbox || ''}
                            onChange={e => setSettings({ ...settings, complianceMailbox: e.target.value || null })}
                            className="input input-bordered w-full max-w-md"
                            placeholder={t('complianceMailboxPlaceholder')}
                        />
                        <p className="text-xs text-content-subtle mt-1">{t('bccNote')}</p>
                    </div>

                    {/* Save */}
                    <div className="flex items-center gap-compact pt-2">
                        <Button variant="primary" onClick={handleSave} disabled={saving} loading={saving}>
                            {saving ? t('savingSettings') : t('saveSettings')}
                        </Button>
                        {saved && <span className="text-sm text-content-success">{t('savedSuccessfully')}</span>}
                    </div>
                </div>
            ) : (
                /* R13-PR6 — outer `cardVariants()` wrapper dropped
                   so the DataTable primitive's own bordered card is
                   the only one (matches Practices list visually). */
                <div>
                    {stats ? (() => {
                        const statsColumns = createColumns<{ label: string; pending: number; sent: number; failed: number; total: number }>([
                            { accessorKey: 'label', header: t('colPeriod'), cell: ({ getValue }: any) => <span className="font-medium">{getValue()}</span> },
                            { accessorKey: 'pending', header: t('colPending'), cell: ({ getValue }: any) => <StatusBadge variant="warning">{getValue()}</StatusBadge> },
                            { accessorKey: 'sent', header: t('colSent'), cell: ({ getValue }: any) => <StatusBadge variant="success">{getValue()}</StatusBadge> },
                            { accessorKey: 'failed', header: t('colFailed'), cell: ({ getValue }: any) => <StatusBadge variant="error">{getValue()}</StatusBadge> },
                            { accessorKey: 'total', header: t('colTotal'), cell: ({ getValue }: any) => <span className="text-content-muted">{getValue()}</span> },
                        ]);
                        const statsData = [
                            { label: t('last24h'), ...stats.last24h, total: stats.last24h.pending + stats.last24h.sent + stats.last24h.failed },
                            { label: t('last7d'), ...stats.last7d, total: stats.last7d.pending + stats.last7d.sent + stats.last7d.failed },
                            { label: t('last30d'), ...stats.last30d, total: stats.last30d.pending + stats.last30d.sent + stats.last30d.failed },
                        ];
                        return (
                            <DataTable
                                data={statsData}
                                columns={statsColumns}
                                getRowId={(r) => r.label}
                                emptyState={t('noStats')}
                                resourceName={(p) => p ? t('periodsPlural') : t('periodSingular')}
                                data-testid="notification-stats-table"
                            />
                        );
                    })() : (
                        <p className="text-content-muted"><span className="inline-block h-4 w-full sm:w-32 bg-bg-elevated rounded animate-pulse" /></p>
                    )}
                </div>
            )}
        </div>
    );
}

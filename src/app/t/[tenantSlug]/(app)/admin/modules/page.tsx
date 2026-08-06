'use client';

/**
 * WP-2 — per-tenant module gating ("simple mode") admin page.
 *
 * Lists every product module with a Switch. A tenant with no saved
 * settings has ALL modules on (the backward-compatible default); the
 * admin turns modules off to simplify the product surface. Saving an
 * EMPTY list is a real restriction, not a reset to default — the copy
 * makes that explicit.
 *
 * Gating is enforced server-side (`assertModuleEnabled` at the route
 * boundary); this page only edits the stored list. Toggling a module
 * off here does NOT retroactively hide already-rendered nav — it gates
 * the API the next time those routes are called.
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { ALL_MODULES, MODULE_LABELS } from '@/lib/modules';
import type { ModuleKey } from '@prisma/client';

interface ModuleSettings {
    enabledModules: ModuleKey[];
    customized: boolean;
    allModules: ModuleKey[];
}

export default function ModuleSettingsPage() {
    const t = useTranslations('admin.modules');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [settings, setSettings] = useState<ModuleSettings | null>(null);
    const [enabled, setEnabled] = useState<Set<ModuleKey>>(new Set());
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const fetchData = useCallback(() => {
        fetch(apiUrl('/admin/modules'))
            .then((r) => r.json())
            .then((data: ModuleSettings) => {
                setSettings(data);
                setEnabled(new Set(data.enabledModules));
            })
            .catch(() => undefined);
    }, [apiUrl]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    function toggle(key: ModuleKey, on: boolean) {
        setSaved(false);
        setEnabled((prev) => {
            const next = new Set(prev);
            if (on) next.add(key);
            else next.delete(key);
            return next;
        });
    }

    async function handleSave() {
        setSaving(true);
        setSaved(false);
        try {
            // Preserve the canonical module order for a stable payload.
            const enabledModules = ALL_MODULES.filter((m) => enabled.has(m));
            const res = await fetch(apiUrl('/admin/modules'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabledModules }),
            });
            if (res.ok) {
                const updated = await res.json();
                setEnabled(new Set(updated.enabledModules as ModuleKey[]));
                setSettings((s) => (s ? { ...s, enabledModules: updated.enabledModules, customized: true } : s));
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
            }
        } finally {
            setSaving(false);
        }
    }

    if (!settings) {
        return (
            <div className="p-8">
                <div className="h-6 w-full sm:w-48 bg-bg-elevated rounded animate-pulse" />
            </div>
        );
    }

    const allOn = enabled.size === ALL_MODULES.length;

    return (
        <div className="space-y-section animate-fadeIn">
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                        { label: t('breadcrumbModules') },
                    ]}
                    className="mb-1"
                />
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-default">
                <div className="flex flex-wrap items-center gap-compact">
                    <Heading level={1}>{t('heading')}</Heading>
                    <StatusBadge variant={settings.customized ? 'info' : 'neutral'}>
                        {settings.customized ? t('simpleMode') : t('allModulesOn')}
                    </StatusBadge>
                </div>
                <div className="flex items-center gap-compact">
                    {saved && <span className="text-sm text-content-success">{t('saved')}</span>}
                    <Button variant="primary" onClick={handleSave} disabled={saving} loading={saving}>
                        {saving ? t('saving') : t('save')}
                    </Button>
                </div>
            </div>

            <p className="text-sm text-content-muted max-w-2xl">
                {t('description')}
            </p>

            <div className={cn(cardVariants(), 'space-y-default')}>
                {ALL_MODULES.map((key) => {
                    const on = enabled.has(key);
                    return (
                        <div
                            key={key}
                            className="flex items-start justify-between gap-default py-2 border-b border-border-subtle last:border-0"
                        >
                            <div className="min-w-0">
                                <div className="text-sm font-medium">{MODULE_LABELS[key]}</div>
                                <p className="text-xs text-content-subtle mt-0.5">
                                    {t(`desc_${key}`)}
                                </p>
                            </div>
                            <Switch
                                checked={on}
                                onCheckedChange={(v) => toggle(key, v)}
                                aria-label={t('toggleModule', { name: MODULE_LABELS[key] })}
                            />
                        </div>
                    );
                })}
            </div>

            {!allOn && (
                <p className="text-xs text-content-subtle">
                    {enabled.size === 0
                        ? t('everyModuleOff')
                        : t('modulesEnabled', { enabled: enabled.size, total: ALL_MODULES.length })}
                </p>
            )}
        </div>
    );
}

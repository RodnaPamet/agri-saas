'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Heading } from '@/components/ui/typography';
import { Card } from '@/components/ui/card';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function MappingPage() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const t = useTranslations('mapping');
    const [data, setData] = useState<any>(null);
    const [tab, setTab] = useState<'soc2' | 'nis2'>('soc2');

    useEffect(() => { fetch(apiUrl('/mapping')).then(r => r.json()).then(setData); }, [apiUrl]);

    if (!data) return <div className="animate-pulse text-content-muted p-8">{t('loading')}</div>;

    const items = tab === 'soc2' ? data.soc2 : data.nis2;

    return (
        <div className="space-y-section animate-fadeIn">
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: 'Dashboard', href: tenantHref('/dashboard') },
                        { label: t('title') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-content-muted text-sm">{t('subtitle')}</p>
            </div>

            {/* Epic 60 — ToggleGroup replaces raw btn-primary/btn-secondary
                toggle, giving us radiogroup ARIA + keyboard arrow nav. */}
            <ToggleGroup
                ariaLabel="Framework"
                options={[
                    { value: 'soc2', label: t('soc2') },
                    { value: 'nis2', label: t('nis2') },
                ]}
                selected={tab}
                selectAction={(v) => setTab(v as 'soc2' | 'nis2')}
            />

            <div className="space-y-compact">
                {items.map((item: any) => (
                    <Card key={item.code}>
                        <div className="flex items-center justify-between mb-2">
                            <div>
                                <span className="text-xs font-mono text-[var(--brand-default)] mr-2">{item.code}</span>
                                <span className="font-medium text-sm">{item.name}</span>
                            </div>
                            <span
                                className={`text-sm font-bold ${
                                    item.coverage >= 80
                                        ? 'text-content-success'
                                        : item.coverage >= 50
                                          ? 'text-content-warning'
                                          : 'text-content-error'
                                }`}
                            >
                                {item.coverage}%
                            </span>
                        </div>
                        <p className="text-xs text-content-muted mb-3">{item.description}</p>
                        <div className="flex items-center gap-compact">
                            <div className="flex-1">
                                {/* Epic 59 ProgressBar primitive. */}
                                <ProgressBar
                                    value={item.coverage}
                                    size="sm"
                                    variant={
                                        item.coverage >= 80
                                            ? 'success'
                                            : item.coverage >= 50
                                                ? 'warning'
                                                : 'error'
                                    }
                                    aria-label={`${item.name} coverage`}
                                />
                            </div>
                            <span className="text-xs text-content-subtle">{t('practices', { implemented: item.implementedCount, total: item.practiceCount })}</span>
                        </div>
                    </Card>
                ))}
            </div>
        </div>
    );
}

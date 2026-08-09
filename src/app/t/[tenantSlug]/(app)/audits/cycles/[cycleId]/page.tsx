'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppIcon, type AppIconName } from '@/components/icons/AppIcon';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { MetaStrip } from '@/components/ui/meta-strip';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

const FW_META: Record<string, { icon: AppIconName; label: string }> = {
    ISO27001: { icon: 'shield', label: 'ISO/IEC 27001:2022' },
    NIS2: { icon: 'globe', label: 'NIS2 Directive' },
};

export default function CycleDetailPage() {
    const t = useTranslations('audits');
    const params = useParams();
    const router = useRouter();
    const tenantSlug = params.tenantSlug as string;
    const cycleId = params.cycleId as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);

    const [cycle, setCycle] = useState<any>(null);
    const [preview, setPreview] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        Promise.all([
            fetch(apiUrl(`/audits/cycles/${cycleId}`)).then(r => r.ok ? r.json() : null),
            fetch(apiUrl(`/audits/cycles/${cycleId}?action=default-pack-preview`)).then(r => r.ok ? r.json() : null),
        ]).then(([c, p]) => { setCycle(c); setPreview(p); }).finally(() => setLoading(false));
    }, [apiUrl, cycleId]);

    const createDefaultPack = async () => {
        setCreating(true);
        try {
            // 1) Create pack
            const packRes = await fetch(apiUrl('/audits/packs'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auditCycleId: cycleId, name: `${cycle.frameworkKey} Default Pack` }),
            });
            if (!packRes.ok) { setCreating(false); return; }
            const pack = await packRes.json();

            // 2) Add all items from preview
            if (preview?.selection) {
                const items: any[] = [];
                const sel = preview.selection;
                sel.practices?.ids?.forEach((id: string, i: number) => items.push({ entityType: 'PRACTICE', entityId: id, sortOrder: i }));
                sel.policies?.ids?.forEach((id: string, i: number) => items.push({ entityType: 'POLICY', entityId: id, sortOrder: 100 + i }));
                sel.evidence?.ids?.forEach((id: string, i: number) => items.push({ entityType: 'EVIDENCE', entityId: id, sortOrder: 200 + i }));
                sel.issues?.ids?.forEach((id: string, i: number) => items.push({ entityType: 'ISSUE', entityId: id, sortOrder: 300 + i }));

                if (items.length > 0) {
                    await fetch(apiUrl(`/audits/packs/${pack.id}?action=items`), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ items }),
                    });
                }
            }
            router.push(`/t/${tenantSlug}/audits/packs/${pack.id}`);
        } finally { setCreating(false); }
    };

    const breadcrumbs = [
        { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
        { label: t('crumbAudits'), href: `/t/${tenantSlug}/audits` },
        { label: t('crumbCycles'), href: `/t/${tenantSlug}/audits/cycles` },
        { label: cycle?.name ?? t('cycleDetail.crumbCycleFallback') },
    ];
    if (loading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (!cycle) {
        return (
            <EntityDetailLayout empty={{ message: t('cycleDetail.notFound') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const fw = FW_META[cycle.frameworkKey] || { icon: 'shield' as AppIconName, label: cycle.frameworkKey };

    return (
        <EntityDetailLayout
            id="cycle-detail-page"
            breadcrumbs={breadcrumbs}

            title={
                <span className="inline-flex items-center gap-compact" id="cycle-name">
                    <AppIcon name={fw.icon} size={28} />
                    {cycle.name}
                </span>
            }
            meta={
                <MetaStrip
                    items={[
                        { label: t('cycleDetail.metaFramework'), value: fw.label },
                        { label: t('cycleDetail.metaVersion'), value: `v${cycle.frameworkVersion}` },
                        { label: t('cycleDetail.metaStatus'), value: cycle.status },
                    ]}
                />
            }
        >
            {/* Default Pack Preview */}
            <div className={cn(cardVariants(), 'space-y-default')}>
                <div className="flex items-center justify-between">
                    <Heading level={2}>{t('cycleDetail.defaultPackPreview')}</Heading>
                    <Button variant="primary" onClick={createDefaultPack} disabled={creating} id="create-default-pack-btn" icon={<AppIcon name="package" size={16} />}>
                        {creating ? t('cycleDetail.creating') : '+ Pack'}
                    </Button>
                </div>

                {preview ? (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-default" id="preview-counts">
                        <div className="p-4 rounded-lg bg-bg-default border border-border-default">
                            <KPIStat id="preview-practices" value={preview.selection?.practices?.count || 0} label={t('cycleDetail.kpiPractices')} />
                        </div>
                        <div className="p-4 rounded-lg bg-bg-default border border-border-default">
                            <KPIStat id="preview-policies" value={preview.selection?.policies?.count || 0} label={t('cycleDetail.kpiPolicies')} />
                        </div>
                        <div className="p-4 rounded-lg bg-bg-default border border-border-default">
                            <KPIStat id="preview-evidence" value={preview.selection?.evidence?.count || 0} label={t('cycleDetail.kpiEvidence')} tone="success" />
                        </div>
                        <div className="p-4 rounded-lg bg-bg-default border border-border-default">
                            <KPIStat id="preview-issues" value={preview.selection?.issues?.count || 0} label={t('cycleDetail.kpiIssues')} tone="attention" />
                        </div>
                    </div>
                ) : (
                    <p className="text-content-muted text-sm">{t('cycleDetail.previewError')}</p>
                )}

                <p className="text-xs text-content-subtle">
                    {t('cycleDetail.totalItems', { count: preview?.totalItems || 0 })}
                </p>
            </div>

            {/* Existing Packs */}
            {cycle.packs?.length > 0 && (
                <div className="space-y-compact">
                    <Heading level={2}>{t('cycleDetail.packs')}</Heading>
                    {cycle.packs.map((p: any) => (
                        <Link key={p.id} href={`/t/${tenantSlug}/audits/packs/${p.id}`}
                            className={cn(cardVariants({ density: 'compact' }), 'flex items-center justify-between hover:bg-bg-muted/50 transition block')} id={`pack-link-${p.id}`}>
                            <div>
                                <span className="font-medium text-sm">{p.name}</span>
                                <StatusBadge variant={p.status === 'DRAFT' ? 'neutral' : p.status === 'FROZEN' ? 'info' : 'success'} className="ml-2">{p.status}</StatusBadge>
                            </div>
                            <span className="text-xs text-content-subtle">→</span>
                        </Link>
                    ))}
                </div>
            )}
        </EntityDetailLayout>
    );
}

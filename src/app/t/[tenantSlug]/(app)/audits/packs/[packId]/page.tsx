'use client';
import { formatDateTime } from '@/lib/format-date';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { AppIcon, type AppIconName } from '@/components/icons/AppIcon';
import { RequirePermission } from '@/components/require-permission';
import { IconAction } from '@/components/ui/icon-action';
import { Tooltip } from '@/components/ui/tooltip';
import { buttonVariants } from '@/components/ui/button-variants';
import { UpgradeGate } from '@/components/UpgradeGate';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { useCelebration } from '@/components/ui/hooks';
import { scopedMilestone } from '@/lib/celebrations';
import { Package } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { SharePointExportButton } from './SharePointExportButton';
import { Heading } from '@/components/ui/typography';
import { MetaStrip } from '@/components/ui/meta-strip';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

const ENTITY_ICON: Record<string, AppIconName> = {
    PRACTICE: 'practices', POLICY: 'policies', EVIDENCE: 'evidence', FILE: 'overview', ISSUE: 'warning',
    READINESS_REPORT: 'dashboard', FRAMEWORK_COVERAGE: 'frameworks',
};

export default function PackDetailPage() {
    const t = useTranslations('audits');
    const params = useParams();
    const tenantSlug = params.tenantSlug as string;
    const packId = params.packId as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);

    const [pack, setPack] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [freezing, setFreezing] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [shareLink, setShareLink] = useState<string | null>(null);
    const [cloning, setCloning] = useState(false);
    const router = useRouter();

    const loadPack = useCallback(() => {
        fetch(apiUrl(`/audits/packs/${packId}`))
            .then(r => r.ok ? r.json() : null)
            .then(setPack)
            .finally(() => setLoading(false));
    }, [apiUrl, packId]);

    useEffect(() => { loadPack(); }, [loadPack]);

    const freeze = async () => {
        setFreezing(true);
        try {
            const res = await fetch(apiUrl(`/audits/packs/${packId}?action=freeze`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            });
            if (res.ok) loadPack();
            else {
                const err = await res.json();
                alert(err.message || t('packDetail.failedFreeze'));
            }
        } finally { setFreezing(false); }
    };

    const share = async () => {
        setSharing(true);
        try {
            const res = await fetch(apiUrl(`/audits/packs/${packId}?action=share`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            });
            if (res.ok) {
                const data = await res.json();
                const link = `${window.location.origin}/audit/shared/${data.token}`;
                setShareLink(link);
            }
        } finally { setSharing(false); }
    };

    // Epic 62 — celebrate when the pack reaches its "complete" state
    // (FROZEN or its downstream EXPORTED). Per-pack dedupe key so a
    // user managing several packs in the same session gets one
    // celebration per pack, not one per session globally.
    //
    // The effect must sit BEFORE the early returns above so React's
    // hook order stays stable across loading → loaded transitions.
    const { celebrate } = useCelebration();
    const packStatus: string | undefined = pack?.status;
    const packComplete = packStatus === 'FROZEN' || packStatus === 'EXPORTED';
    const packName: string | undefined = pack?.name;
    useEffect(() => {
        if (!packComplete) return;
        celebrate(
            scopedMilestone('audit-pack-complete', packId, {
                descriptionOverride: packName
                    ? t('packDetail.celebrateDescription', { name: packName })
                    : undefined,
            }),
        );
    }, [packComplete, packId, packName, celebrate, t]);

    const breadcrumbs = [
        { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
        { label: t('crumbAudits'), href: `/t/${tenantSlug}/audits` },
        { label: t('crumbCycles'), href: `/t/${tenantSlug}/audits/cycles` },
        { label: pack?.name ?? t('packDetail.crumbPackFallback') },
    ];
    if (loading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (!pack) {
        return (
            <EntityDetailLayout empty={{ message: t('packDetail.notFound') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const isDraft = pack.status === 'DRAFT';
    const isFrozen = pack.status === 'FROZEN' || pack.status === 'EXPORTED';

    // Group items by entity type
    const grouped: Record<string, any[]> = {};
    (pack.items || []).forEach((item: any) => {
        if (!grouped[item.entityType]) grouped[item.entityType] = [];
        grouped[item.entityType].push(item);
    });

    return (
        <EntityDetailLayout
            id="pack-detail-page"
            breadcrumbs={breadcrumbs}

            title={<span id="pack-name">{pack.name}</span>}
            meta={
                <MetaStrip
                    items={[
                        ...(pack.cycle?.frameworkKey
                            ? [
                                  {
                                      label: t('packDetail.metaFramework'),
                                      value: pack.cycle.frameworkKey,
                                  } as const,
                              ]
                            : []),
                        {
                            label: t('packDetail.metaItems'),
                            value: pack._count?.items || 0,
                        },
                        {
                            kind: 'status',
                            id: 'pack-status',
                            label: t('packDetail.metaStatus'),
                            value: pack.status,
                            variant: isDraft ? 'neutral' : 'info',
                        },
                        ...(pack.frozenAt
                            ? [
                                  {
                                      label: t('packDetail.metaFrozen'),
                                      value: `${formatDateTime(pack.frozenAt)} · ${pack.frozenBy?.name || pack.frozenBy?.email || t('packDetail.adminFallback')}`,
                                  } as const,
                              ]
                            : []),
                    ]}
                />
            }
            actions={
                <>
                    {isDraft && (
                        <RequirePermission resource="audits" action="freeze">
                            <IconAction variant="primary" onClick={freeze} loading={freezing} id="freeze-pack-btn" icon={<AppIcon name="lock" size={16} />} label={t('packDetail.freezePack')} />
                        </RequirePermission>
                    )}
                    {isFrozen && (
                        <RequirePermission resource="audits" action="share">
                            <UpgradeGate feature="AUDIT_PACK_SHARING">
                                <IconAction variant="primary" onClick={share} loading={sharing} id="share-pack-btn" icon={<AppIcon name="share" size={16} />} label={t('packDetail.generateShareLink')} />
                            </UpgradeGate>
                        </RequirePermission>
                    )}
                    {isFrozen && (
                        <RequirePermission resource="audits" action="manage">
                            <IconAction
                                variant="secondary"
                                onClick={async () => {
                                    setCloning(true);
                                    try {
                                        const res = await fetch(apiUrl(`/audits/packs/${packId}?action=clone`), {
                                            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                                        });
                                        if (res.ok) {
                                            const cloned = await res.json();
                                            router.push(`/t/${tenantSlug}/audits/packs/${cloned.id}`);
                                        }
                                    } finally { setCloning(false); }
                                }}
                                loading={cloning}
                                id="clone-pack-btn"
                                icon={<AppIcon name="refresh" size={16} />}
                                label={t('packDetail.cloneForRetest')}
                            />
                        </RequirePermission>
                    )}
                    {isFrozen && (
                        <RequirePermission resource="audits" action="manage">
                            <SharePointExportButton packId={packId} />
                        </RequirePermission>
                    )}
                </>
            }
        >
            {/* Share Link */}
            {shareLink && (
                <div className={cn(cardVariants({ density: 'compact' }), 'border border-border-success bg-bg-success animate-fadeIn')} id="share-link-card">
                    <div className="flex items-center justify-between gap-compact">
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-content-success">{t('packDetail.shareLinkGenerated')}</p>
                            <p className="text-xs text-content-muted mt-1 break-all" id="share-link-url">{shareLink}</p>
                        </div>
                        <CopyButton
                            value={shareLink}
                            label={t('packDetail.copyShareLink')}
                            successMessage={t('packDetail.shareLinkCopied')}
                            size="sm"
                        />
                    </div>
                </div>
            )}

            {/* Items grouped by type */}
            {Object.keys(grouped).length === 0 ? (
                <div className={cardVariants({ density: 'none' })}>
                    <EmptyState
                        icon={Package}
                        title={t('packDetail.emptyTitle')}
                        description={t('packDetail.emptyDescription')}
                    />
                </div>
            ) : (
                Object.entries(grouped).map(([type, items]) => (
                    <div key={type} className="space-y-tight">
                        <Heading level={3} className="flex items-center gap-tight">
                            <AppIcon name={ENTITY_ICON[type] || 'overview'} size={16} />
                            <span>{type}</span>
                            <span className="text-content-subtle">({items.length})</span>
                        </Heading>
                        <div className={cn(cardVariants({ density: 'none' }), 'divide-y divide-border-default/50')}>
                            {items.slice(0, 50).map((item: any) => {
                                let snap: any = {};
                                try { snap = JSON.parse(item.snapshotJson || '{}'); } catch { /* */ }
                                const name = snap.code || snap.title || snap.name || item.entityId;
                                const status = snap.status || '';
                                return (
                                    <div key={item.id} className="p-3 flex items-center justify-between text-sm">
                                        <div className="flex-1 min-w-0">
                                            <span className="font-medium truncate block">{name}</span>
                                            {snap.description && <span className="text-xs text-content-subtle truncate block">{snap.description}</span>}
                                        </div>
                                        <div className="flex items-center gap-tight ml-4">
                                            {status && <StatusBadge variant="neutral">{status}</StatusBadge>}
                                            {snap.taskCompletion && (
                                                <span className="text-xs text-content-subtle">
                                                    {t('packDetail.tasksCount', { done: snap.taskCompletion.done, total: snap.taskCompletion.total })}
                                                </span>
                                            )}
                                            {snap.evidenceCount !== undefined && (
                                                <span className="text-xs text-content-subtle">
                                                    {t('packDetail.evidenceCount', { count: snap.evidenceCount })}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))
            )}

            {/* Export area (placeholder) */}
            {isFrozen && (
                <div className={cardVariants()}>
                    <Heading level={3} className="mb-2 inline-flex items-center gap-tight"><AppIcon name="export" size={16} /> {t('packDetail.exports')}</Heading>
                    <div className="flex gap-tight">
                        <Tooltip content={t('packDetail.exportJson')}>
                            <a href={apiUrl(`/audits/packs/${packId}?action=export&format=json`)}
                                target="_blank" rel="noopener" aria-label={t('packDetail.exportJson')} className={buttonVariants({ variant: 'secondary', size: 'icon' })}><AppIcon name="fileJson" size={16} /></a>
                        </Tooltip>
                        <Tooltip content={t('packDetail.exportCsv')}>
                            <a href={apiUrl(`/audits/packs/${packId}?action=export&format=csv`)}
                                target="_blank" rel="noopener" aria-label={t('packDetail.exportCsv')} className={buttonVariants({ variant: 'secondary', size: 'icon' })}><AppIcon name="fileSpreadsheet" size={16} /></a>
                        </Tooltip>
                    </div>
                </div>
            )}
        </EntityDetailLayout>
    );
}

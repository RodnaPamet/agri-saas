'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { formatDate, formatDateTime } from '@/lib/format-date';
import { SkeletonCard } from '@/components/ui/skeleton';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { useTenantMembers } from '@/components/ui/user-combobox';
import { useToastWithUndo } from '@/components/ui/hooks';
import dynamic from 'next/dynamic';
import LinkedTasksPanel from '@/components/LinkedTasksPanel';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { CopyText } from '@/components/ui/copy-text';
import { Button } from '@/components/ui/button';
import { Pen2, Trash } from '@/components/ui/icons/nucleo';
import { Tooltip } from '@/components/ui/tooltip';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import type { AuditLogEntry } from '@/lib/dto/common';
import { Eyebrow } from '@/components/ui/typography';
import { MetaStrip } from '@/components/ui/meta-strip';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { EntityPrevNextNav } from '@/components/ui/entity-prev-next-nav';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { EditAssetModal } from '../EditAssetModal';
import { InheritedEvidencePanel } from '@/components/InheritedEvidencePanel';
import { AttachedEvidencePanel } from '@/components/AttachedEvidencePanel';
import { Heading } from '@/components/ui/typography';
import { InheritedMappingsPanel } from '@/components/InheritedMappingsPanel';
import { hasComplianceModules } from '@/lib/modules';

const TraceabilityPanel = dynamic(() => import('@/components/TraceabilityPanel'), {
    loading: () => <SkeletonCard lines={3} />,
    ssr: false,
});

// B7 — status badge tone. IN_MAINTENANCE previously fell into the `else`
// and rendered green; it now gets its own amber tone.
const STATUS_TONE: Record<string, StatusBadgeVariant> = {
    ACTIVE: 'success',
    IN_MAINTENANCE: 'warning',
    RETIRED: 'neutral',
};

export default function AssetDetailPage() {
    const t = useTranslations('assets');
    const params = useParams();
    const router = useRouter();
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const triggerUndoToast = useToastWithUndo();
    const { permissions, tenantSlug, availableModules } = useTenantContext();
    const assetId = params.id as string;
    // Assets-exoskeleton — the GRC tabs (evidence / mappings / traceability /
    // tests) only render for a tenant that runs a compliance module. A plain
    // farm gets the clean Overview / Tasks / Activity trio.
    const showCompliance = hasComplianceModules(availableModules);

    const [asset, setAsset] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Resolve the "Assigned to" user's display name from the tenant
    // roster so the read view can show a name, not a raw id.
    const { data: members } = useTenantMembers(tenantSlug);
    const assigneeName = asset?.ownerUserId
        ? (members?.find((m) => m.id === asset.ownerUserId)?.name ??
           members?.find((m) => m.id === asset.ownerUserId)?.email ??
           t('assigned'))
        : null;

    // B6 +1 — canonical 7-tab strip on every detail page. Same shape
    // as Controls / Risks: Overview holds the existing asset body;
    // Tasks + Traceability are inline-routed to the already-mounted
    // panels; the other four explain where the related-entity surface
    // lives.
    type Tab =
        | 'overview'
        | 'tasks'
        | 'evidence'
        | 'mappings'
        | 'traceability'
        | 'activity';
    const [activeTab, setActiveTab] = useState<Tab>('overview');
    const tabs: ReadonlyArray<{ key: Tab; label: string }> = [
        { key: 'overview', label: t('tabOverview') },
        { key: 'tasks', label: t('tabTasks') },
        ...(showCompliance
            ? ([
                  { key: 'evidence', label: t('tabEvidence') },
                  { key: 'mappings', label: t('tabMappings') },
                  { key: 'traceability', label: t('tabTraceability') },
              ] as const)
            : []),
        { key: 'activity', label: t('tabActivity') },
    ];
    // Modal-form P2 — the inline-edit panel is replaced by an
    // EditAssetModal launched from the detail header. The page URL
    // stays canonical; modal state is purely overlay. Seeding values
    // are computed from the currently-loaded `asset` row at modal
    // open time.
    const [editing, setEditing] = useState(false);
    const editInitial = asset
        ? {
              name: asset.name || '',
              type: asset.type || 'TRACTOR',
              owner: asset.owner || '',
              ownerUserId: asset.ownerUserId || '',
              location: asset.location || '',
              criticality: asset.criticality || '',
              status: asset.status || 'ACTIVE',
              externalRef: asset.externalRef || '',
              manufacturer: asset.manufacturer || '',
              model: asset.model || '',
              serialNumber: asset.serialNumber || '',
              year: asset.year != null ? String(asset.year) : '',
              purchaseDate: asset.purchaseDate
                  ? String(asset.purchaseDate).slice(0, 10)
                  : '',
              purchaseCost: asset.purchaseCost != null ? String(asset.purchaseCost) : '',
          }
        : {};

    const fetchAsset = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(apiUrl(`/assets/${assetId}`));
            if (!res.ok) throw new Error(`Failed to load (${res.status})`);
            const data = await res.json();
            setAsset(data);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [apiUrl, assetId]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchAsset(); }, [fetchAsset]);

    // B5 — ordered asset-id list for the prev/next nav beside the name.
    // Fetched once (the default list order) so the up/down buttons walk the
    // same sequence the list page shows. Best-effort: failures just hide
    // the affordance.
    const [assetIds, setAssetIds] = useState<string[]>([]);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(apiUrl('/assets'));
                if (!res.ok) return;
                const rows = await res.json();
                const ids = Array.isArray(rows)
                    ? rows.map((r: any) => r?.id).filter(Boolean)
                    : [];
                // eslint-disable-next-line react-hooks/set-state-in-effect
                if (!cancelled) setAssetIds(ids);
            } catch {
                /* best-effort — nav just doesn't render */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [apiUrl]);

    const critColor = (c: string): StatusBadgeVariant => c === 'HIGH' ? 'error' : c === 'MEDIUM' ? 'warning' : 'success';
    const statusLabel = (s: string): string => {
        const key = { ACTIVE: 'statusActive', IN_MAINTENANCE: 'statusInMaintenance', RETIRED: 'statusRetired' }[s];
        return key ? t(key) : s;
    };

    // B1 — per-asset delete. Soft-delete is restorable from the list's
    // Deleted view, so this is a routine reversible action → the Epic-67
    // undo-toast pattern (the DELETE fires only after the 5s window). We
    // navigate back to the list immediately; if the user hits Undo the
    // deferred commit never runs.
    const handleDeleteAsset = () => {
        triggerUndoToast({
            message: t('assetDeleted'),
            undoMessage: t('undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/assets/${assetId}`), { method: 'DELETE' });
                if (!res.ok) throw new Error('Delete failed');
            },
        });
        router.push(tenantHref('/assets'));
    };

    // B6 — per-asset activity feed (loaded lazily when the tab opens).
    const [activity, setActivity] = useState<AuditLogEntry[]>([]);
    const [activityLoading, setActivityLoading] = useState(false);
    useEffect(() => {
        if (activeTab !== 'activity') return;
        setActivityLoading(true);
        fetch(apiUrl(`/assets/${assetId}/activity`))
            .then((r) => (r.ok ? r.json() : []))
            // eslint-disable-next-line react-hooks/set-state-in-effect
            .then(setActivity)
            .catch(() => { /* best-effort — feed just stays empty */ })
            // eslint-disable-next-line react-hooks/set-state-in-effect
            .finally(() => setActivityLoading(false));
    }, [activeTab, apiUrl, assetId]);

    const breadcrumbs = [
        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
        { label: t('breadcrumbAssets'), href: tenantHref('/assets') },
        { label: asset?.name ?? t('assetFallback') },
    ];
    if (loading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (error && !asset) {
        return (
            <EntityDetailLayout error={error} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (!asset) {
        return (
            <EntityDetailLayout empty={{ message: t('notFound') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    return (
        <EntityDetailLayout
            id="asset-detail-page"
            breadcrumbs={breadcrumbs}
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(k) => setActiveTab(k)}
            actions={
                permissions.canAdmin ? (
                    <Tooltip content={t('deleteAsset')}>
                        <Button
                            variant="destructive-outline"
                            size="icon"
                            onClick={handleDeleteAsset}
                            id="delete-asset-btn"
                            aria-label={t('deleteAsset')}
                        >
                            <Trash className="size-4" />
                        </Button>
                    </Tooltip>
                ) : undefined
            }
            title={
                <span className="inline-flex items-center gap-2.5">
                    <span id="asset-title-heading">{asset.name}</span>
                    {/* B5 — step to the prev/next asset in list order. */}
                    <EntityPrevNextNav
                        ids={assetIds}
                        currentId={assetId}
                        hrefFor={(id) => tenantHref(`/assets/${id}`)}
                        labelSingular={t('assetLabelSingular')}
                    />
                </span>
            }
            meta={
                <MetaStrip
                    items={[
                        {
                            label: t('metaType'),
                            value: asset.type?.replace(/_/g, ' '),
                        },
                        ...(asset.criticality
                            ? [
                                  {
                                      kind: 'status' as const,
                                      label: t('criticality'),
                                      value: asset.criticality,
                                      variant: critColor(asset.criticality),
                                  },
                              ]
                            : []),
                        {
                            kind: 'status' as const,
                            label: t('status'),
                            value: statusLabel(asset.status || 'ACTIVE'),
                            variant: STATUS_TONE[asset.status || 'ACTIVE'] ?? 'success',
                        },
                    ]}
                />
            }
        >
            {error && <div className={cn(cardVariants({ density: 'compact' }), 'border-border-error text-content-error text-sm')}>{error}</div>}

            {/* Edit modal — modal-form P2. Always mounted so the
                modal's own open/close state survives tab switches. */}
            {permissions.canWrite && (
                <EditAssetModal
                    open={editing}
                    setOpen={setEditing}
                    assetId={assetId}
                    initial={editInitial}
                    onSaved={(updated) => setAsset(updated)}
                />
            )}

            {activeTab === 'tasks' && (
                <div className={cardVariants()} id="asset-tasks-tab">
                    <LinkedTasksPanel
                        apiBase={apiUrl('')}
                        entityType="ASSET"
                        entityId={assetId}
                        tenantHref={tenantHref}
                        canWrite={permissions.canWrite}
                    />
                </div>
            )}
            {activeTab === 'traceability' && (
                <TraceabilityPanel
                    apiBase={apiUrl('')}
                    entityType="asset"
                    entityId={assetId}
                    canWrite={permissions.canWrite}
                    tenantHref={tenantHref}
                />
            )}
            {activeTab === 'evidence' && (
                <div className="space-y-section">
                    <div className="space-y-default">
                        <Heading level={3}>{t('attachedEvidence')}</Heading>
                        <AttachedEvidencePanel
                            entityId={assetId}
                            entity="asset"
                            endpoint={`/assets/${assetId}/evidence/attached`}
                            apiUrl={apiUrl}
                            tenantHref={tenantHref}
                            canWrite={permissions.canWrite}
                        />
                    </div>
                    <div className="space-y-default">
                        <Heading level={3}>{t('inheritedFromControls')}</Heading>
                        <InheritedEvidencePanel
                            endpoint={apiUrl(`/assets/${assetId}/evidence`)}
                            tenantHref={tenantHref}
                            entityLabel="asset"
                        />
                    </div>
                </div>
            )}
            {activeTab === 'mappings' && (
                <InheritedMappingsPanel
                    endpoint={apiUrl(`/assets/${assetId}/mappings`)}
                    tenantHref={tenantHref}
                    entityLabel="asset"
                />
            )}
            {activeTab === 'activity' && (
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')} id="asset-activity-tab">
                    {activityLoading ? (
                        <div className="p-8 text-center text-content-subtle animate-pulse">{t('activityLoading')}</div>
                    ) : activity.length === 0 ? (
                        <InlineEmptyState
                            title={t('activityTitle')}
                            description={t('activityDescription')}
                        />
                    ) : (
                        <div className="divide-y divide-border-default/50" id="asset-activity-feed">
                            {activity.map((ev) => (
                                <div key={ev.id} className="px-5 py-3 flex items-start gap-compact">
                                    <div className="mt-0.5">
                                        <StatusBadge variant="info">{ev.action}</StatusBadge>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm text-content-default">{ev.details}</p>
                                        <p className="text-xs text-content-subtle mt-0.5">
                                            {ev.user?.name || t('systemActor')} · {formatDateTime(ev.createdAt)}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {activeTab === 'overview' && (
                <>

            {/* Detail card — read-only view; edits flow through EditAssetModal. */}
            <div className={cn(cardVariants(), 'space-y-default')} id="asset-detail">
                {permissions.canWrite && (
                    <div className="flex justify-end -mt-1 -mb-2">
                        {/* B2 — icon-only edit affordance; opens the Edit
                            Asset modal, mirroring the control overview. */}
                        <Tooltip content={t('editAsset')}>
                            <Button
                                variant="secondary"
                                size="icon"
                                onClick={() => setEditing(true)}
                                id="edit-asset-btn"
                                aria-label={t('editAsset')}
                            >
                                <Pen2 className="size-4" />
                            </Button>
                        </Tooltip>
                    </div>
                )}
                <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                            <div><Eyebrow>{t('manufacturer')}</Eyebrow><p className="text-sm">{asset.manufacturer || '—'}</p></div>
                            <div><Eyebrow>{t('model')}</Eyebrow><p className="text-sm">{asset.model || '—'}</p></div>
                            <div>
                                <Eyebrow>{t('serialNumber')}</Eyebrow>
                                {asset.serialNumber ? (
                                    <CopyText
                                        value={asset.serialNumber}
                                        label={t('copySerial', { value: asset.serialNumber })}
                                        successMessage={t('serialCopied')}
                                        className="text-sm text-content-default"
                                    >
                                        {asset.serialNumber}
                                    </CopyText>
                                ) : (
                                    <p className="text-sm">—</p>
                                )}
                            </div>
                            <div><Eyebrow>{t('year')}</Eyebrow><p className="text-sm">{asset.year ?? '—'}</p></div>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                            <div><Eyebrow>{t('assignedTo')}</Eyebrow><p className="text-sm">{assigneeName || '—'}</p></div>
                            <div><Eyebrow>{t('keeper')}</Eyebrow><p className="text-sm">{asset.owner || '—'}</p></div>
                            <div><Eyebrow>{t('location')}</Eyebrow><p className="text-sm">{asset.location || '—'}</p></div>
                            <div>
                                <Eyebrow>{t('externalRef')}</Eyebrow>
                                {asset.externalRef ? (
                                    <CopyText
                                        value={asset.externalRef}
                                        label={t('copyExternalRef', { value: asset.externalRef })}
                                        successMessage={t('externalRefCopied')}
                                        className="text-sm text-content-default"
                                    >
                                        {asset.externalRef}
                                    </CopyText>
                                ) : (
                                    <p className="text-sm">—</p>
                                )}
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-default border-t border-border-default/50 pt-4">
                            <div><Eyebrow>{t('purchaseDate')}</Eyebrow><p className="text-sm">{asset.purchaseDate ? formatDate(asset.purchaseDate) : '—'}</p></div>
                            <div><Eyebrow>{t('purchaseCost')}</Eyebrow><p className="text-sm">{asset.purchaseCost != null ? Number(asset.purchaseCost).toLocaleString() : '—'}</p></div>
                        </div>
                        <div className="grid grid-cols-2 gap-default border-t border-border-default/50 pt-4">
                            <div><Eyebrow>{t('created')}</Eyebrow><p className="text-sm text-content-muted">{formatDate(asset.createdAt)}</p></div>
                            <div><Eyebrow>{t('updated')}</Eyebrow><p className="text-sm text-content-muted">{formatDate(asset.updatedAt)}</p></div>
                        </div>
                    </>
            </div>

                </>
            )}
        </EntityDetailLayout>
    );
}

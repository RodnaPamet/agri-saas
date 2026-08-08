'use client';
/* eslint-disable @typescript-eslint/no-explicit-any -- Tanstack-react-table cell callbacks (tanstack cell callbacks where row/getValue carry the implicit-any annotation) — typing each callback with `CellContext<TData, TValue>` requires importing the right generic per column and adds significant ceremony. The implicit any here is at the render-time boundary; row.original is type-narrowed by the column's accessorKey at runtime. */
import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AppIcon } from '@/components/icons/AppIcon';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { Combobox } from '@/components/ui/combobox';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useToastWithUndo } from '@/components/ui/hooks';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { DataTable, createColumns } from '@/components/ui/table';
import { cn } from '@/lib/cn';

// ── Linked-row shapes ───────────────────────────────────────────────
// The traceability API returns link rows as `{ id, rationale, control|asset }`.
// Typed here so the DataTable column cells read `row.original.*` without
// per-cell `any`. Assigning the `any` API arrays to these types needs no
// cast (any is assignable to a typed target).
interface LinkedControlRow {
    id: string;
    rationale: string | null;
    control: { id: string; code: string; name: string; status: string } | null;
}
interface LinkedAssetRow {
    id: string;
    rationale: string | null;
    asset: { id: string; name: string; type: string; criticality: string } | null;
}

/** Row-level pulse class for optimistic temp rows (mirrors the pre-migration `<tr>` styling). */
const tempRowClass = (id: string | undefined) =>
    id?.startsWith('temp:') ? 'opacity-50 animate-pulse' : undefined;

interface TraceabilityPanelProps {
    apiBase: string;            // e.g. /api/t/acme-corp
    entityType: 'control' | 'asset';
    entityId: string;
    canWrite: boolean;
    tenantHref: (path: string) => string;
    tenantSlug?: string;        // for cache key scoping
}

// Cache key for traceability data
const traceabilityKey = (tenantSlug: string, entityType: string, entityId: string) =>
    ['traceability', tenantSlug, entityType, entityId] as const;

export default function TraceabilityPanel({ apiBase: apiBaseRaw, entityType, entityId, canWrite, tenantHref, tenantSlug: tenantSlugProp }: TraceabilityPanelProps) {
    // Callers pass `apiUrl('')` which yields `/api/t/<slug>/` with a
    // trailing slash. Concatenating `${apiBase}/controls/…` then produces a
    // `//` path which Next.js middleware redirects (308) to the canonical
    // URL — the redirected request drops fetch credentials, and the
    // server-side log shows no traceability call. Strip the trailing
    // slash once so every nested URL is well-formed.
    const t = useTranslations('traceability');
    const apiBase = apiBaseRaw.replace(/\/+$/, '');
    // Extract tenantSlug from apiBase if not provided (e.g. /api/t/acme-corp → acme-corp)
    const tenantSlug = tenantSlugProp || apiBase.split('/t/')[1]?.split('/')[0] || '';
    const queryClient = useQueryClient();
    const triggerUndoToast = useToastWithUndo();

    // Add forms
    const [showAddControl, setShowAddControl] = useState(false);
    const [showAddAsset, setShowAddAsset] = useState(false);
    const [addId, setAddId] = useState('');
    const [addRationale, setAddRationale] = useState('');

    // Available items for dropdown

    const [availableControls, setAvailableControls] = useState<any[]>([]);

    const [availableAssets, setAvailableAssets] = useState<any[]>([]);

    const traceUrl = entityType === 'control'
        ? `${apiBase}/controls/${entityId}/traceability`
        : `${apiBase}/assets/${entityId}/traceability`;

    // ─── Query: traceability data ───
    const traceQuery = useQuery({
        queryKey: traceabilityKey(tenantSlug, entityType, entityId),
        queryFn: async () => {
            const res = await fetch(traceUrl);
            if (!res.ok) return null;
            return res.json();
        },
        enabled: !!entityId && !!tenantSlug,
    });

    const data = traceQuery.data;
    const loading = traceQuery.isLoading;

    // Fetch available items when forms open.
    //
    // B1 — `/assets` and `/controls` both return the cap'd
    // `{ rows, truncated }` shape from `applyBackfillCap`. Pre-B1
    // the panel only knew about (a) bare array and (b) the
    // entity-keyed shape `{ controls: [...] }` / etc. — neither
    // matched, so every linking dropdown silently rendered empty.
    // The `unwrap` helper accepts every shape the API has ever
    // returned for these endpoints; new shapes need an explicit
    // entry.
    //
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unwrap = (d: any, entityKey: 'controls' | 'assets'): any[] => {
        if (Array.isArray(d)) return d;
        if (d && Array.isArray(d.rows)) return d.rows;
        if (d && Array.isArray(d[entityKey])) return d[entityKey];
        if (d && Array.isArray(d.items)) return d.items;
        return [];
    };
    useEffect(() => {
        if (showAddControl) fetch(`${apiBase}/controls`).then(r => r.ok ? r.json() : []).then(d => setAvailableControls(unwrap(d, 'controls')));
    }, [showAddControl, apiBase]);
    useEffect(() => {
        if (showAddAsset) fetch(`${apiBase}/assets`).then(r => r.ok ? r.json() : []).then(d => setAvailableAssets(unwrap(d, 'assets')));
    }, [showAddAsset, apiBase]);

    // ─── Mutation: link ───
    const linkMutation = useMutation({
        mutationFn: async ({ type, linkedId, rationale }: { type: 'control' | 'asset'; linkedId: string; rationale?: string }) => {
            let url = '';

            let body: any = {};
            if (entityType === 'control' && type === 'asset') {
                url = `${apiBase}/assets/${linkedId}/controls`;
                body = { controlId: entityId, rationale: rationale || undefined };
            } else if (entityType === 'asset' && type === 'control') {
                url = `${apiBase}/assets/${entityId}/controls`;
                body = { controlId: linkedId, rationale: rationale || undefined };
            }
            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!res.ok) throw new Error('Link failed');
            return { type, linkedId };
        },
        onMutate: async ({ type, linkedId, rationale }) => {
            await queryClient.cancelQueries({ queryKey: traceabilityKey(tenantSlug, entityType, entityId) });

            const previous = queryClient.getQueryData<any>(traceabilityKey(tenantSlug, entityType, entityId));

            if (previous) {

                const updated = { ...previous };
                const section = type === 'control' ? 'controls' : 'assets';
                const tempEntry = {
                    id: `temp:${crypto.randomUUID()}`,
                    rationale: rationale || null,
                    [type]: { id: linkedId, title: t('loadingItem'), name: t('loadingItem'), status: '—', code: '' },
                };
                updated[section] = [...(updated[section] || []), tempEntry];
                queryClient.setQueryData(traceabilityKey(tenantSlug, entityType, entityId), updated);
            }

            return { previous };
        },
        onError: (_err, _vars, context) => {
            if (context?.previous) {
                queryClient.setQueryData(traceabilityKey(tenantSlug, entityType, entityId), context.previous);
            }
        },
        onSuccess: (_data, vars) => {
            // Only close the form that was just linked — leaving the
            // other open Link forms intact so a user staging multiple
            // links doesn't lose the second form when the first commits.
            setAddId('');
            setAddRationale('');
            if (vars.type === 'control') setShowAddControl(false);
            else if (vars.type === 'asset') setShowAddAsset(false);
        },
        onSettled: (_data, _err, vars) => {
            // Invalidate this entity's traceability
            queryClient.invalidateQueries({ queryKey: traceabilityKey(tenantSlug, entityType, entityId) });
            // Cross-invalidate the linked entity's traceability + list
            if (vars) {
                queryClient.invalidateQueries({ queryKey: traceabilityKey(tenantSlug, vars.type, vars.linkedId) });
                if (vars.type === 'control') {
                    queryClient.invalidateQueries({ queryKey: queryKeys.controls.all(tenantSlug) });
                }
            }
        },
    });

    // ─── Unlink — Epic 67 delayed-commit via useToastWithUndo ───
    //
    // Optimistic removal applies immediately on click via setQueryData
    // so the row visually disappears. The actual DELETE is deferred 5s
    // by the shared hook; clicking Undo restores the snapshot. If the
    // commit fails the snapshot also restores. Cross-entity invalidation
    // runs on commit success, mirroring the pre-Epic-67 mutation's
    // onSettled fan-out.
    const unlinkUrl = (type: 'control' | 'asset', linkedId: string): string => {
        if (entityType === 'control' && type === 'asset') return `${apiBase}/assets/${linkedId}/controls/${entityId}`;
        if (entityType === 'asset' && type === 'control') return `${apiBase}/assets/${entityId}/controls/${linkedId}`;
        return '';
    };

    const UNLINK_LABEL: Record<'control' | 'asset', string> = {
        control: t('controlUnlinked'),
        asset: t('assetUnlinked'),
    };

    const handleLink = (type: 'control' | 'asset') => {
        if (!addId) return;
        linkMutation.mutate({ type, linkedId: addId, rationale: addRationale || undefined });
    };

    const handleUnlink = (type: 'control' | 'asset', linkedId: string) => {
        const cacheKey = traceabilityKey(tenantSlug, entityType, entityId);
        // Snapshot BEFORE the optimistic write so undo restores exactly
        // what the user saw — not a stale snapshot from before some
        // other concurrent mutation.

        const previous = queryClient.getQueryData<any>(cacheKey);

        if (previous) {
            const updated = { ...previous };
            const section = type === 'control' ? 'controls' : 'assets';

            updated[section] = (updated[section] || []).filter((l: any) => {
                const linked = l[type];
                return linked?.id !== linkedId;
            });
            queryClient.setQueryData(cacheKey, updated);
        }

        triggerUndoToast({
            message: UNLINK_LABEL[type],
            undoMessage: t('undo'),
            action: async () => {
                const url = unlinkUrl(type, linkedId);
                const res = await fetch(url, { method: 'DELETE' });
                if (!res.ok) throw new Error('Unlink failed');
                // Invalidate this entity + the linked entity's mirror
                // view + the entity's parent list so RAG counts on the
                // index pages stay correct after a commit.
                queryClient.invalidateQueries({ queryKey: cacheKey });
                queryClient.invalidateQueries({ queryKey: traceabilityKey(tenantSlug, type, linkedId) });
                if (type === 'control') {
                    queryClient.invalidateQueries({ queryKey: queryKeys.controls.all(tenantSlug) });
                }
            },
            undoAction: () => {
                if (previous) queryClient.setQueryData(cacheKey, previous);
            },
            onError: () => {
                if (previous) queryClient.setQueryData(cacheKey, previous);
            },
        });
    };

    if (loading) return <div className="p-6 text-center text-content-subtle animate-pulse">{t('loading')}</div>;
    if (!data) return <div className="p-6 text-center text-content-subtle">{t('loadFailed')}</div>;

    const controls: LinkedControlRow[] = data.controls || [];
    const assets: LinkedAssetRow[] = data.assets || [];

    // Unlink affordance — identical Epic 67 undo flow as before, now
    // rendered as a DataTable actions column (card mode surfaces it in the
    // card footer). `stopPropagation` keeps a future row-click from firing.
    const unlinkCell = (
        type: 'control' | 'asset',
        linkedId: string | undefined,
    ) => (
        <Tooltip content={t(type === 'control' ? 'unlinkControl' : 'unlinkAsset')}>
            <button
                className="text-content-error text-xs hover:text-content-error"
                onClick={(e) => { e.stopPropagation(); handleUnlink(type, linkedId ?? ''); }}
                id={`unlink-${type}-${linkedId}`}
                aria-label={t(type === 'control' ? 'unlinkControl' : 'unlinkAsset')}
            >
                ×
            </button>
        </Tooltip>
    );

    // ── Column defs (mobileFallback="card": each row → a tappable card) ──
    const controlColumns = createColumns<LinkedControlRow>([
        {
            id: 'code',
            header: t('colCode'),
            cell: ({ row }) => (
                <span className={cn('font-mono text-xs text-[var(--brand-muted)]', tempRowClass(row.original.id))}>
                    {row.original.control?.code || '—'}
                </span>
            ),
            meta: { mobileCard: { slot: 'subtitle' } },
        },
        {
            id: 'name',
            header: t('colName'),
            cell: ({ row }) => <span className="text-sm text-content-default">{row.original.control?.name || '—'}</span>,
            meta: { mobileCard: { slot: 'title' } },
        },
        {
            id: 'status',
            header: t('colStatus'),
            cell: ({ row }) => <StatusBadge variant="info">{row.original.control?.status || '—'}</StatusBadge>,
            meta: { mobileCard: { slot: 'status' } },
        },
        {
            id: 'rationale',
            header: t('colRationale'),
            cell: ({ row }) => <span className="text-xs text-content-muted">{row.original.rationale || '—'}</span>,
            meta: { mobileCard: { slot: 'meta', label: t('colRationale') } },
        },
        ...(canWrite
            ? [{
                id: 'actions',
                header: t('colActions'),
                cell: ({ row }: { row: { original: LinkedControlRow } }) => unlinkCell('control', row.original.control?.id),
                meta: { mobileCard: { slot: 'actions' as const } },
            }]
            : []),
    ]);

    const assetColumns = createColumns<LinkedAssetRow>([
        {
            id: 'name',
            header: t('colName'),
            cell: ({ row }) => (
                <span className={cn('text-sm text-content-default', tempRowClass(row.original.id))}>
                    {row.original.asset?.name || '—'}
                </span>
            ),
            meta: { mobileCard: { slot: 'title' } },
        },
        {
            id: 'type',
            header: t('colType'),
            cell: ({ row }) => <StatusBadge variant="info">{row.original.asset?.type || '—'}</StatusBadge>,
            meta: { mobileCard: { slot: 'meta', label: t('colType') } },
        },
        {
            id: 'criticality',
            header: t('colCriticality'),
            cell: ({ row }) => (row.original.asset?.criticality
                ? <StatusBadge variant={row.original.asset.criticality === 'HIGH' ? 'error' : row.original.asset.criticality === 'MEDIUM' ? 'warning' : 'neutral'}>{row.original.asset.criticality}</StatusBadge>
                : <span className="text-content-subtle">—</span>),
            meta: { mobileCard: { slot: 'status' } },
        },
        {
            id: 'rationale',
            header: t('colRationale'),
            cell: ({ row }) => <span className="text-xs text-content-muted">{row.original.rationale || '—'}</span>,
            meta: { mobileCard: { slot: 'meta', label: t('colRationale') } },
        },
        ...(canWrite
            ? [{
                id: 'actions',
                header: t('colActions'),
                cell: ({ row }: { row: { original: LinkedAssetRow } }) => unlinkCell('asset', row.original.asset?.id),
                meta: { mobileCard: { slot: 'actions' as const } },
            }]
            : []),
    ]);

    // Determine which sections to show based on entity type
    const showControls = entityType === 'asset';
    const showAssets = entityType === 'control';

    return (
        <div className="space-y-section" id="traceability-panel">
            {/* Controls section */}
            {showControls && (
                <div>
                    <div className="flex items-center justify-between mb-3">
                        <Heading level={3} className="text-content-emphasis inline-flex items-center gap-tight"><AppIcon name="controls" size={16} /> {t('coveredByControls')} ({controls.length})</Heading>
                        {canWrite && (
                            <Button variant="primary" size="xs" onClick={() => { setShowAddControl(!showAddControl); setAddId(''); }} id="add-control-link-btn">{t('linkControl')}</Button>
                        )}
                    </div>
                    {showAddControl && canWrite && (
                        <div className={cn(cardVariants({ density: 'compact' }), 'mb-3 space-y-tight')}>
                            <Combobox
                                id="control-select"
                                selected={availableControls.map((c: any) => ({ value: c.id, label: c.code ? `${c.code} — ${c.name}` : c.name, meta: { status: c.status } })).find((o: { value: string }) => o.value === addId) ?? null}
                                setSelected={(opt) => setAddId(opt?.value ?? '')}
                                options={availableControls.map((c: any) => ({ value: c.id, label: c.code ? `${c.code} — ${c.name}` : c.name, meta: { status: c.status } }))}
                                optionDescription={(o) => (o.meta?.status ? t('statusMeta', { status: o.meta.status }) : null)}
                                placeholder={t('selectControl')}
                                matchTriggerWidth
                            />
                            <input type="text" className="input w-full text-sm" placeholder={t('rationalePlaceholder')} value={addRationale} onChange={e => setAddRationale(e.target.value)} />
                            <Button variant="primary" size="xs" disabled={!addId || linkMutation.isPending} onClick={() => handleLink('control')} id="confirm-control-link">
                                {linkMutation.isPending ? t('linking') : t('link')}
                            </Button>
                        </div>
                    )}
                    <DataTable<LinkedControlRow>
                        data-testid="linked-controls-table"
                        data={controls}
                        columns={controlColumns}
                        getRowId={(l) => l.id}
                        selectionEnabled={false}
                        mobileFallback="card"
                        emptyState={<div className="p-6 text-center text-content-subtle text-sm" id="no-controls">{t('noControlsLinked')}</div>}
                    />
                </div>
            )}

            {/* Assets section */}
            {showAssets && (
                <div>
                    <div className="flex items-center justify-between mb-3">
                        <Heading level={3} className="text-content-emphasis inline-flex items-center gap-tight"><AppIcon name="package" size={16} /> {entityType === 'control' ? t('coversAssets') : t('affectsAssets')} ({assets.length})</Heading>
                        {canWrite && (
                            <Button variant="primary" size="xs" onClick={() => { setShowAddAsset(!showAddAsset); setAddId(''); }} id="add-asset-link-btn">{t('linkAsset')}</Button>
                        )}
                    </div>
                    {showAddAsset && canWrite && (
                        <div className={cn(cardVariants({ density: 'compact' }), 'mb-3 space-y-tight')}>
                            <Combobox
                                id="asset-select"
                                selected={availableAssets.map((a: any) => ({ value: a.id, label: a.name, meta: { type: a.type } })).find((o: { value: string }) => o.value === addId) ?? null}
                                setSelected={(opt) => setAddId(opt?.value ?? '')}
                                options={availableAssets.map((a: any) => ({ value: a.id, label: a.name, meta: { type: a.type } }))}
                                optionDescription={(o) => (o.meta?.type ? t('typeMeta', { type: o.meta.type }) : null)}
                                placeholder={t('selectAsset')}
                                matchTriggerWidth
                            />
                            <input type="text" className="input w-full text-sm" placeholder={t('rationalePlaceholder')} value={addRationale} onChange={e => setAddRationale(e.target.value)} />
                            <Button variant="primary" size="xs" disabled={!addId || linkMutation.isPending} onClick={() => handleLink('asset')} id="confirm-asset-link">
                                {linkMutation.isPending ? t('linking') : t('link')}
                            </Button>
                        </div>
                    )}
                    <DataTable<LinkedAssetRow>
                        data-testid="linked-assets-table"
                        data={assets}
                        columns={assetColumns}
                        getRowId={(l) => l.id}
                        selectionEnabled={false}
                        mobileFallback="card"
                        emptyState={<div className="p-6 text-center text-content-subtle text-sm" id="no-assets">{t('noAssetsLinked')}</div>}
                    />
                </div>
            )}
        </div>
    );
}

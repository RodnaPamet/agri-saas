'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { formatDate } from '@/lib/format-date';
import { useEffect, useMemo, useState, useCallback, use } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { Pen2, Plus } from '@/components/ui/icons/nucleo';
import { Tooltip } from '@/components/ui/tooltip';
import { DataTable, createColumns } from '@/components/ui/table';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import {
    EntityPicker,
    type EntityPickerKind,
} from '@/components/ui/entity-picker';
import { useToastWithUndo } from '@/components/ui/hooks';
import { normaliseHref } from '@/lib/security/safe-url';
import { StatusBadge } from '@/components/ui/status-badge';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Heading } from '@/components/ui/typography';
import { MetaStrip } from '@/components/ui/meta-strip';
import {
    VENDOR_STATUS_VARIANT,
    VENDOR_CRITICALITY_VARIANT,
    VENDOR_ASSESSMENT_VARIANT,
} from '@/app-layer/domain/entity-status-mapping';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

// Polish PR-1 — STATUS_BADGE / CRIT_BADGE moved to shared domain
// mapping. Local aliases preserved so the dozens of inline-table
// consumers below stay short and readable.
const CRIT_BADGE = VENDOR_CRITICALITY_VARIANT;
const DOC_TYPE_LABELS: Record<string, string> = {
    CONTRACT: 'Contract', SOC2: 'SOC 2', ISO_CERT: 'ISO 27001', DPA: 'DPA',
    SECURITY_POLICY: 'Security Policy', PEN_TEST: 'Pen Test Report', OTHER: 'Other',
};
const DOC_TYPES = Object.keys(DOC_TYPE_LABELS);
const ASSESSMENT_STATUS_BADGE = VENDOR_ASSESSMENT_VARIANT;
const VENDOR_STATUS_OPTIONS: ComboboxOption[] = ['ACTIVE', 'ONBOARDING', 'OFFBOARDING', 'OFFBOARDED'].map(s => ({ value: s, label: s }));
const VENDOR_CRIT_OPTIONS: ComboboxOption[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map(c => ({ value: c, label: c }));
const DOC_TYPE_CB_OPTIONS: ComboboxOption[] = DOC_TYPES.map(t => ({ value: t, label: DOC_TYPE_LABELS[t] || t }));
// B4 — Document filter options. Prepended "All types" sentinel so
// clearing the type filter is a single click.
const DOC_TYPE_FILTER_OPTIONS: ComboboxOption[] = [
    { value: '', label: 'All types' },
    ...DOC_TYPE_CB_OPTIONS,
];
const VENDOR_LINK_TYPE_OPTIONS: ComboboxOption[] = [
    { value: 'ASSET', label: 'Asset' },
    { value: 'ISSUE', label: 'Issue' }, { value: 'CONTROL', label: 'Control' },
];
const VENDOR_LINK_RELATION_OPTIONS: ComboboxOption[] = [
    { value: 'RELATED', label: 'Related' }, { value: 'USES', label: 'Uses' },
    { value: 'MITIGATES', label: 'Mitigates' }, { value: 'STORES_DATA_FOR', label: 'Stores Data' },
];

type Tab = 'overview' | 'documents' | 'assessments' | 'links' | 'bundles' | 'subprocessors';

export default function VendorDetailPage(props: { params: Promise<{ tenantSlug: string; vendorId: string }> }) {
    const params = use(props.params);
    const t = useTranslations('vendors.detail');
    const tv = useTranslations('vendors');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { permissions } = useTenantContext();
    const canWrite = permissions?.canWrite;
    const triggerUndoToast = useToastWithUndo();

    const [vendor, setVendor] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState<Tab>('overview');
    const [docs, setDocs] = useState<any[]>([]);
    const [assessments, setAssessments] = useState<any[]>([]);
    const [templates, setTemplates] = useState<any[]>([]);
    const [editing, setEditing] = useState(false);
    const [editForm, setEditForm] = useState<any>({});

    // Doc form
    const [showDocForm, setShowDocForm] = useState(false);
    const [docForm, setDocForm] = useState({ type: 'CONTRACT', title: '', externalUrl: '', notes: '', folder: '' });
    // B4 — Documents filter state.
    const [docSearch, setDocSearch] = useState('');
    const [docTypeFilter, setDocTypeFilter] = useState('');
    // B8 — folder filter. Empty string = "all folders"; a literal
    // value matches that label exactly; `__none__` matches docs with
    // a null/empty folder so legacy unfoldered docs stay findable.
    const [docFolderFilter, setDocFolderFilter] = useState('');
    // Assessment start
    const [showStartAssessment, setShowStartAssessment] = useState(false);
    const [selectedTemplate, setSelectedTemplate] = useState('');
    // Enrichment
    const [enriching, setEnriching] = useState(false);
    // Links
    const [links, setLinks] = useState<any[]>([]);
    const [showLinkForm, setShowLinkForm] = useState(false);
    const [linkForm, setLinkForm] = useState({ entityType: 'ASSET', entityId: '', relation: 'RELATED' });
    // Bundles
    const [bundles, setBundles] = useState<any[]>([]);
    const [bundleName, setBundleName] = useState('');
    // Subprocessors
    const [subs, setSubs] = useState<any[]>([]);
    const [subForm, setSubForm] = useState({ subprocessorVendorId: '', purpose: '' });

    const fetchVendor = useCallback(async () => {
        setLoading(true);
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}`));
        if (res.ok) {
            const v = await res.json();
            setVendor(v);
            setEditForm({ name: v.name, legalName: v.legalName || '', websiteUrl: v.websiteUrl || '', domain: v.domain || '', country: v.country || '', description: v.description || '', criticality: v.criticality, status: v.status });
        }
        setLoading(false);
    }, [apiUrl, params.vendorId]);

    const fetchDocs = useCallback(async () => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/documents`));
        if (res.ok) setDocs(await res.json());
    }, [apiUrl, params.vendorId]);

    const fetchAssessments = useCallback(async () => {
        const res = await fetch(apiUrl(`/vendors/questionnaires/templates`));
        if (res.ok) setTemplates(await res.json());
        // We get assessments from vendor detail, but need a separate list
        // For now, we'll use a simple approach
        const aRes = await fetch(apiUrl(`/vendors/${params.vendorId}`));
        if (aRes.ok) {
            const v = await aRes.json();
            setAssessments(v.assessments || []);
        }
    }, [apiUrl, params.vendorId]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchVendor(); }, [fetchVendor]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { if (tab === 'documents') fetchDocs(); }, [tab, fetchDocs]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { if (tab === 'assessments') fetchAssessments(); }, [tab, fetchAssessments]);

    const fetchLinks = useCallback(async () => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/links`));
        if (res.ok) setLinks(await res.json());
    }, [apiUrl, params.vendorId]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { if (tab === 'links') fetchLinks(); }, [tab, fetchLinks]);

    const fetchBundles = useCallback(async () => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/bundles`));
        if (res.ok) setBundles(await res.json());
    }, [apiUrl, params.vendorId]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { if (tab === 'bundles') fetchBundles(); }, [tab, fetchBundles]);

    const fetchSubs = useCallback(async () => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/subprocessors`));
        if (res.ok) setSubs(await res.json());
    }, [apiUrl, params.vendorId]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { if (tab === 'subprocessors') fetchSubs(); }, [tab, fetchSubs]);

    const saveEdit = async () => {
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}`), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editForm),
        });
        if (res.ok) { setVendor(await res.json()); setEditing(false); }
    };

    const addDoc = async (e: React.FormEvent) => {
        e.preventDefault();
        const body: any = { type: docForm.type };
        if (docForm.title) body.title = docForm.title;
        if (docForm.externalUrl) body.externalUrl = docForm.externalUrl;
        if (docForm.notes) body.notes = docForm.notes;
        if (docForm.folder) body.folder = docForm.folder.trim();
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/documents`), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (res.ok) {
            const newDoc = await res.json();
            setDocs(prev => [newDoc, ...prev]);
            setShowDocForm(false);
            setDocForm({ type: 'CONTRACT', title: '', externalUrl: '', notes: '', folder: '' });
            // Also call fetchDocs just in case we need uploadedBy info, but state already has the doc
            fetchDocs();
        }
    };

    // Epic 67 — delayed-commit doc removal. The 5-second undo window
    // replaces the previous `confirm()` modal: the user gets a more
    // forgiving "you have time to take it back" affordance instead of
    // a blocking double-click. Snapshot + optimistic-filter pattern,
    // identical shape to tasks/removeLink and the other rolled-out
    // sites — see docs/destructive-actions.md.
    const removeDoc = (docId: string) => {
        const previous = docs;
        setDocs(prev => prev.filter(d => d.id !== docId));
        triggerUndoToast({
            message: t('documentRemoved'),
            undoMessage: t('undo'),
            action: async () => {
                const res = await fetch(
                    apiUrl(`/vendors/${params.vendorId}/documents/${docId}`),
                    { method: 'DELETE' },
                );
                if (!res.ok) throw new Error('Remove document failed');
            },
            undoAction: () => setDocs(previous),
            onError: () => setDocs(previous),
        });
    };

    const startAssessment = async () => {
        if (!selectedTemplate) return;
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/assessments/start`), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ templateKey: selectedTemplate }),
        });
        if (res.ok) {
            const assessment = await res.json();
            window.location.href = tenantHref(`/vendors/${params.vendorId}/assessment/${assessment.id}`);
        }
    };

    const handleEnrich = async () => {
        setEnriching(true);
        const res = await fetch(apiUrl(`/vendors/${params.vendorId}/enrich`), { method: 'POST' });
        if (res.ok) { setVendor(await res.json()); }
        setEnriching(false);
    };

    const breadcrumbs = [
        { label: tv('crumbDashboard'), href: tenantHref('/dashboard') },
        { label: tv('vendorsCrumb'), href: tenantHref('/vendors') },
        { label: vendor?.name ?? tv('vendorFallback') },
    ];
    if (loading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (!vendor) {
        return (
            <EntityDetailLayout empty={{ message: t('notFound') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const fmtDate = (d: string | null) => d ? formatDate(d) : '—';
    const tabs: { key: Tab; label: string; count?: number }[] = [
        { key: 'overview', label: t('tabOverview') },
        { key: 'documents', label: t('tabDocuments'), count: vendor._count?.documents || 0 },
        { key: 'assessments', label: t('tabAssessments'), count: vendor._count?.assessments || 0 },
        { key: 'links', label: t('tabLinks') },
        { key: 'bundles', label: t('tabBundles') },
        { key: 'subprocessors', label: t('tabSubprocessors') },
    ];

    return (
        <EntityDetailLayout
            id="vendor-detail-page"
            breadcrumbs={breadcrumbs}

            title={<span id="vendor-detail-name">{vendor.name}</span>}
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'status',
                            label: t('status'),
                            value: vendor.status,
                            variant:
                                VENDOR_STATUS_VARIANT[vendor.status] ??
                                'neutral',
                        },
                        {
                            kind: 'status',
                            label: t('criticality'),
                            value: vendor.criticality,
                            variant:
                                VENDOR_CRITICALITY_VARIANT[
                                    vendor.criticality
                                ] ?? 'neutral',
                        },
                        ...(vendor.contractEnd
                            ? [
                                  {
                                      label: t('contractEnd'),
                                      value: formatDate(vendor.contractEnd),
                                  } as const,
                              ]
                            : []),
                    ]}
                />
            }
            actions={
                <>
                    {canWrite && (vendor.domain || vendor.websiteUrl) && (
                        <Button variant="secondary" onClick={handleEnrich} disabled={enriching} id="enrich-vendor-btn">
                            {enriching ? t('enriching') : t('autoFill')}
                        </Button>
                    )}
                    {canWrite && !editing && (
                        // B2 — icon-only edit affordance.
                        <Tooltip content={t('editVendor')}>
                            <Button
                                variant="secondary"
                                size="icon"
                                onClick={() => setEditing(true)}
                                id="edit-vendor-btn"
                                aria-label={t('editVendor')}
                            >
                                <Pen2 className="size-4" />
                            </Button>
                        </Tooltip>
                    )}
                </>
            }
            tabs={tabs}
            activeTab={tab}
            onTabChange={(next) => setTab(next as Tab)}
        >
            {/* OVERVIEW */}
            {tab === 'overview' && !editing && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    <div className="grid grid-cols-2 gap-default text-sm">
                        <div><span className="text-content-muted">{t('legalName')}</span> <span className="ml-2">{vendor.legalName || '—'}</span></div>
                        <div><span className="text-content-muted">{t('domain')}</span> <span className="ml-2">{vendor.domain || '—'}</span></div>
                        <div><span className="text-content-muted">{t('website')}</span> <span className="ml-2">{normaliseHref(vendor.websiteUrl) ? <a href={normaliseHref(vendor.websiteUrl)!} target="_blank" rel="noopener noreferrer" className="text-content-info underline">{vendor.websiteUrl}</a> : '—'}</span></div>
                        <div><span className="text-content-muted">{t('country')}</span> <span className="ml-2">{vendor.country || '—'}</span></div>
                        <div><span className="text-content-muted">{t('owner')}</span> <span className="ml-2">{vendor.owner?.name || '—'}</span></div>
                        <div><span className="text-content-muted">{t('dataAccess')}</span> <span className="ml-2">{vendor.dataAccess || '—'}</span></div>
                        <div><span className="text-content-muted">{t('subprocessor')}</span> <span className="ml-2">{vendor.isSubprocessor ? t('yes') : t('no')}</span></div>
                        <div><span className="text-content-muted">{t('inherentRisk')}</span> <span className="ml-2">{vendor.inherentRisk ? <StatusBadge variant={CRIT_BADGE[vendor.inherentRisk]}>{vendor.inherentRisk}</StatusBadge> : '—'}</span></div>
                        <div><span className="text-content-muted">{t('nextReview')}</span> <span className="ml-2">{fmtDate(vendor.nextReviewAt)}</span></div>
                        <div><span className="text-content-muted">{t('contractRenewal')}</span> <span className="ml-2">{fmtDate(vendor.contractRenewalAt)}</span></div>
                    </div>
                    {/* Enrichment Fields */}
                    {(vendor.privacyPolicyUrl || vendor.securityPageUrl || vendor.certificationsJson) && (
                        <div className="border-t border-border-default pt-3 mt-3 space-y-tight">
                            <Heading level={3}>{t('enrichmentData')}</Heading>
                            <div className="grid grid-cols-2 gap-compact text-sm">
                                {normaliseHref(vendor.privacyPolicyUrl) && <div><span className="text-content-muted">{t('privacyPolicy')}</span> <a href={normaliseHref(vendor.privacyPolicyUrl)!} target="_blank" rel="noopener noreferrer" className="text-content-info underline ml-1" id="enrichment-privacy">{t('view')}</a></div>}
                                {normaliseHref(vendor.securityPageUrl) && <div><span className="text-content-muted">{t('securityPage')}</span> <a href={normaliseHref(vendor.securityPageUrl)!} target="_blank" rel="noopener noreferrer" className="text-content-info underline ml-1" id="enrichment-security">{t('view')}</a></div>}
                                {vendor.certificationsJson && Array.isArray(vendor.certificationsJson) && (
                                    <div className="col-span-2"><span className="text-content-muted">{t('certifications')}</span> {(vendor.certificationsJson as string[]).map((c: string) => <StatusBadge variant="info" className="ml-1" key={c}>{c}</StatusBadge>)}</div>
                                )}
                            </div>
                            {vendor.enrichmentLastRunAt && <p className="text-xs text-content-subtle">{t('lastEnriched', { date: fmtDate(vendor.enrichmentLastRunAt), status: vendor.enrichmentStatus })}</p>}
                        </div>
                    )}
                    {vendor.description && <div className="text-sm text-content-default border-t border-border-default pt-3 mt-3">{vendor.description}</div>}
                </div>
            )}

            {/* EDIT FORM */}
            {tab === 'overview' && editing && canWrite && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    <div className="grid grid-cols-2 gap-default">
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{t('name')}</label>
                            <input className="input w-full" value={editForm.name} onChange={e => setEditForm((p: any) => ({ ...p, name: e.target.value }))} />
                        </div>
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{t('legalNameLabel')}</label>
                            <input className="input w-full" value={editForm.legalName} onChange={e => setEditForm((p: any) => ({ ...p, legalName: e.target.value }))} />
                        </div>
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{t('status')}</label>
                            <Combobox hideSearch selected={VENDOR_STATUS_OPTIONS.find(o => o.value === editForm.status) ?? null} setSelected={(opt) => setEditForm((p: any) => ({ ...p, status: opt?.value ?? p.status }))} options={VENDOR_STATUS_OPTIONS} matchTriggerWidth />
                        </div>
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{t('criticality')}</label>
                            <Combobox hideSearch selected={VENDOR_CRIT_OPTIONS.find(o => o.value === editForm.criticality) ?? null} setSelected={(opt) => setEditForm((p: any) => ({ ...p, criticality: opt?.value ?? p.criticality }))} options={VENDOR_CRIT_OPTIONS} matchTriggerWidth />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm text-content-muted mb-1">{t('description')}</label>
                        <textarea className="input w-full h-20" value={editForm.description} onChange={e => setEditForm((p: any) => ({ ...p, description: e.target.value }))} />
                    </div>
                    <div className="flex gap-compact">
                        <Button variant="primary" onClick={saveEdit} id="save-vendor-btn">{t('save')}</Button>
                        <Button variant="secondary" onClick={() => setEditing(false)}>{t('cancel')}</Button>
                    </div>
                </div>
            )}

            {/* DOCUMENTS */}
            {tab === 'documents' && (
                <div className="space-y-default">
                    {/* B4 — Documents filter placement consistency.
                        Pre-B4 the docs tab had only the primary
                        action button on the right; list pages
                        elsewhere in the product carry search + filter
                        controls on the LEFT and the action button on
                        the right. The compact filter row below
                        mirrors that pattern: search input + type
                        filter on the left, "Add document" button on
                        the right. */}
                    <div className="flex flex-wrap items-center gap-compact justify-between">
                        <div className="flex flex-wrap items-center gap-compact min-w-0">
                            <input
                                type="search"
                                className="input w-64 max-w-full"
                                placeholder={t('searchDocuments')}
                                value={docSearch}
                                onChange={(e) => setDocSearch(e.target.value)}
                                id="doc-search-input"
                                aria-label={t('searchDocumentsAria')}
                            />
                            <Combobox
                                hideSearch
                                id="doc-type-filter"
                                selected={DOC_TYPE_FILTER_OPTIONS.find((o) => o.value === docTypeFilter) ?? null}
                                setSelected={(opt) => setDocTypeFilter(opt?.value ?? '')}
                                options={DOC_TYPE_FILTER_OPTIONS}
                                placeholder={t('allTypes')}
                            />
                            {/* B8 — Folder filter. Options are derived
                                from the loaded docs (each unique
                                non-empty `folder` value) plus a
                                "no folder" bucket if any unfoldered
                                doc exists. Hidden entirely when no
                                folder has ever been assigned. */}
                            {(() => {
                                const folderSet = new Set<string>();
                                let hasUnfoldered = false;
                                for (const d of docs as Array<{ folder?: string | null }>) {
                                    const f = (d.folder || '').trim();
                                    if (f) folderSet.add(f);
                                    else hasUnfoldered = true;
                                }
                                if (folderSet.size === 0 && !hasUnfoldered) return null;
                                const folderOptions = [
                                    { value: '', label: t('allFolders') },
                                    ...(hasUnfoldered ? [{ value: '__none__', label: t('noFolderOpt') }] : []),
                                    ...Array.from(folderSet).sort().map((f) => ({ value: f, label: f })),
                                ];
                                return (
                                    <Combobox
                                        hideSearch
                                        id="doc-folder-filter"
                                        data-testid="doc-folder-filter"
                                        selected={folderOptions.find((o) => o.value === docFolderFilter) ?? folderOptions[0]}
                                        setSelected={(opt) => setDocFolderFilter(opt?.value ?? '')}
                                        options={folderOptions}
                                        placeholder={t('allFolders')}
                                    />
                                );
                            })()}
                        </div>
                        {canWrite && (
                            <Button
                                variant="primary"
                                icon={showDocForm ? undefined : <Plus />}
                                onClick={() => setShowDocForm(!showDocForm)}
                                id="add-doc-btn"
                            >
                                {showDocForm ? t('cancel') : t('addDocument')}
                            </Button>
                        )}
                    </div>
                    {showDocForm && canWrite && (
                        <form onSubmit={addDoc} className={cn(cardVariants({ density: 'compact' }), 'space-y-compact')}>
                            <div className="grid grid-cols-2 gap-compact">
                                <div>
                                    <label className="block text-sm text-content-muted mb-1">{t('type')}</label>
                                    <Combobox hideSearch id="doc-type-select" selected={DOC_TYPE_CB_OPTIONS.find(o => o.value === docForm.type) ?? null} setSelected={(opt) => setDocForm(p => ({ ...p, type: opt?.value ?? p.type }))} options={DOC_TYPE_CB_OPTIONS} matchTriggerWidth />
                                </div>
                                <div>
                                    <label className="block text-sm text-content-muted mb-1">{t('title')}</label>
                                    <input className="input w-full" value={docForm.title} onChange={e => setDocForm(p => ({ ...p, title: e.target.value }))} id="doc-title-input" />
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{t('externalUrl')}</label>
                                <input className="input w-full" type="url" value={docForm.externalUrl} onChange={e => setDocForm(p => ({ ...p, externalUrl: e.target.value }))} placeholder="https://..." id="doc-url-input" />
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{t('notes')}</label>
                                <input className="input w-full" value={docForm.notes} onChange={e => setDocForm(p => ({ ...p, notes: e.target.value }))} id="doc-notes-input" />
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1" htmlFor="doc-folder-input">
                                    {t('folder')} <span className="text-content-subtle font-normal">{t('optional')}</span>
                                </label>
                                <input
                                    className="input w-full"
                                    id="doc-folder-input"
                                    placeholder={t('folderPlaceholder')}
                                    list="doc-folder-suggestions"
                                    value={docForm.folder}
                                    onChange={(e) => setDocForm((p) => ({ ...p, folder: e.target.value }))}
                                />
                                {/* B8 — datalist seeds the folder
                                    input with the values already in
                                    use on this vendor's docs so the
                                    user can pick "Contracts/2026"
                                    again without re-typing. */}
                                <datalist id="doc-folder-suggestions">
                                    {Array.from(
                                        new Set(
                                            (docs as Array<{ folder?: string | null }>)
                                                .map((d) => (d.folder || '').trim())
                                                .filter(Boolean),
                                        ),
                                    )
                                        .sort()
                                        .map((f) => (
                                            <option key={f} value={f} />
                                        ))}
                                </datalist>
                            </div>
                            <Button type="submit" variant="primary" icon={<Plus className="-ml-0.5 -mr-2.5" />} id="submit-doc-btn">{t('addDocument')}</Button>
                        </form>
                    )}
                    {/* B4 — apply the search + type filters in-memory.
                        Docs are pre-loaded in a single GET; client-side
                        filter is the right shape for a tab with at
                        most a few dozen rows per vendor. */}
                    <VendorDocsTable
                        docs={docs.filter((d: any) => {
                            if (docTypeFilter && d.type !== docTypeFilter) return false;
                            // B8 — folder filter. `''` keeps every
                            // doc; `'__none__'` keeps only unfoldered;
                            // any other value matches exactly.
                            if (docFolderFilter) {
                                const folder = (d.folder || '').trim();
                                if (docFolderFilter === '__none__') {
                                    if (folder) return false;
                                } else if (folder !== docFolderFilter) {
                                    return false;
                                }
                            }
                            if (docSearch.trim()) {
                                const q = docSearch.trim().toLowerCase();
                                const haystack = `${d.title || ''} ${d.notes || ''} ${d.folder || ''} ${DOC_TYPE_LABELS[d.type] || ''}`.toLowerCase();
                                if (!haystack.includes(q)) return false;
                            }
                            return true;
                        })}
                        canWrite={canWrite}
                        onRemove={removeDoc}
                    />
                </div>
            )}

            {/* ASSESSMENTS */}
            {tab === 'assessments' && (
                <div className="space-y-default">
                    {canWrite && (
                        <div className="flex items-center gap-compact justify-end">
                            {!showStartAssessment ? (
                                <Button variant="primary" onClick={() => setShowStartAssessment(true)} id="start-assessment-btn">
                                    {t('startAssessment')}
                                </Button>
                            ) : (
                                <div className="flex items-center gap-tight">
                                    <Combobox
                                        id="template-select"
                                        selected={templates.map((t: any) => ({ value: t.key, label: `${t.name} (${t._count?.questions || 0} Q)` })).find((o: ComboboxOption) => o.value === selectedTemplate) ?? null}
                                        setSelected={(opt) => setSelectedTemplate(opt?.value ?? '')}
                                        options={templates.map((t: any) => ({ value: t.key, label: `${t.name} (${t._count?.questions || 0} Q)` }))}
                                        placeholder={t('selectTemplate')}
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-48' }}
                                    />
                                    <Button variant="primary" onClick={startAssessment} disabled={!selectedTemplate} id="confirm-start-assessment">{t('start')}</Button>
                                    <Button variant="secondary" onClick={() => setShowStartAssessment(false)}>{t('cancel')}</Button>
                                </div>
                            )}
                        </div>
                    )}
                    <VendorAssessmentsTable
                        assessments={assessments}
                        vendorId={params.vendorId}
                        tenantHref={tenantHref}
                    />
                </div>
            )}

            {/* LINKS / TRACEABILITY */}
            {tab === 'links' && (
                <div className="space-y-default">
                    {canWrite && (
                        <div className="flex justify-end">
                            <Button variant="primary" onClick={() => setShowLinkForm(!showLinkForm)} id="add-link-btn">
                                {showLinkForm ? t('cancel') : t('linkEntity')}
                            </Button>
                        </div>
                    )}
                    {showLinkForm && canWrite && (
                        <div className={cn(cardVariants({ density: 'compact' }), 'flex items-end gap-compact')}>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{t('type')}</label>
                                <Combobox hideSearch id="link-type" selected={VENDOR_LINK_TYPE_OPTIONS.find(o => o.value === linkForm.entityType) ?? null} setSelected={(opt) => setLinkForm(p => ({ ...p, entityType: opt?.value ?? p.entityType }))} options={VENDOR_LINK_TYPE_OPTIONS} matchTriggerWidth />
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{t('entity')}</label>
                                {/* PR-D — entity picker replaces the
                                    legacy "Paste ID" input. The
                                    `Type` Combobox above drives the
                                    candidate set; selecting writes
                                    the cuid into linkForm.entityId
                                    so the existing submit handler is
                                    unchanged. */}
                                <EntityPicker
                                    tenantSlug={params.tenantSlug}
                                    entityType={linkForm.entityType as EntityPickerKind}
                                    value={linkForm.entityId}
                                    onChange={(id) => setLinkForm((p) => ({ ...p, entityId: id }))}
                                    id="link-entity-id"
                                    testId="vendor-link-entity-picker"
                                    placeholder={t('selectEntity')}
                                    className="w-48"
                                />
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{t('relation')}</label>
                                <Combobox hideSearch id="link-relation" selected={VENDOR_LINK_RELATION_OPTIONS.find(o => o.value === linkForm.relation) ?? null} setSelected={(opt) => setLinkForm(p => ({ ...p, relation: opt?.value ?? p.relation }))} options={VENDOR_LINK_RELATION_OPTIONS} matchTriggerWidth />
                            </div>
                            <Button variant="primary" id="submit-link-btn" onClick={async () => {
                                await fetch(apiUrl(`/vendors/${params.vendorId}/links`), {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(linkForm),
                                });
                                setShowLinkForm(false); setLinkForm({ entityType: 'ASSET', entityId: '', relation: 'RELATED' }); fetchLinks();
                            }}>{t('add')}</Button>
                        </div>
                    )}
                    {['ASSET', 'ISSUE', 'CONTROL'].map(type => {
                        const typeLinks = links.filter((l: any) => l.entityType === type);
                        if (typeLinks.length === 0) return null;
                        return (
                            <div key={type} className={cn(cardVariants({ density: 'compact' }), 'space-y-tight')}>
                                <Heading level={3}>{type}s ({typeLinks.length})</Heading>
                                {typeLinks.map((l: any) => (
                                    <div key={l.id} className="flex items-center justify-between text-sm border-b border-border-subtle py-1">
                                        <span><code className="text-xs text-content-info">{l.entityId}</code> <StatusBadge variant="neutral" className="ml-1">{l.relation}</StatusBadge></span>
                                        {canWrite && <button className="text-content-error text-xs" onClick={async () => {
                                            await fetch(apiUrl(`/vendors/${params.vendorId}/links/${l.id}`), { method: 'DELETE' }); fetchLinks();
                                        }}>{t('remove')}</button>}
                                    </div>
                                ))}
                            </div>
                        );
                    })}
                    {links.length === 0 && (
                        <InlineEmptyState
                            title={t('linksEmpty.title')}
                            description={t('linksEmpty.description')}
                        />
                    )}
                </div>
            )}

            {/* EVIDENCE BUNDLES */}
            {tab === 'bundles' && (
                <div className="space-y-default">
                    {canWrite && (
                        <div className="flex items-center gap-tight justify-end">
                            <input className="input w-48" placeholder={t('bundleName')} value={bundleName}
                                onChange={e => setBundleName(e.target.value)} id="bundle-name-input" />
                            <Button variant="primary" disabled={!bundleName} id="create-bundle-btn" onClick={async () => {
                                await fetch(apiUrl(`/vendors/${params.vendorId}/bundles`), {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ name: bundleName }),
                                });
                                setBundleName(''); fetchBundles();
                            }}>{t('createBundle')}</Button>
                        </div>
                    )}
                    {bundles.map((b: any) => (
                        <div key={b.id} className={cn(cardVariants({ density: 'compact' }), 'space-y-tight')}>
                            <div className="flex items-center justify-between">
                                <div>
                                    <span className="font-medium">{b.name}</span>
                                    <span className="ml-2 text-xs text-content-muted">{t('itemsCount', { count: b._count?.items || 0 })}</span>
                                    {b.frozenAt && <StatusBadge variant="success" className="ml-2">{t('frozen')}</StatusBadge>}
                                </div>
                                {canWrite && !b.frozenAt && (
                                    <Button variant="secondary" size="xs" id={`freeze-bundle-${b.id}`} onClick={async () => {
                                        if (!confirm(t('freezeConfirm'))) return;
                                        await fetch(apiUrl(`/vendors/${params.vendorId}/bundles/${b.id}?action=freeze`), { method: 'POST' });
                                        fetchBundles();
                                    }}>{t('freeze')}</Button>
                                )}
                            </div>
                            <div className="text-xs text-content-muted">{t('createdByOn', { name: b.createdBy?.name || '—', date: formatDate(b.createdAt) })}</div>
                        </div>
                    ))}
                    {bundles.length === 0 && (
                        <InlineEmptyState
                            title={t('bundlesEmpty.title')}
                            description={t('bundlesEmpty.description')}
                        />
                    )}
                </div>
            )}

            {/* SUBPROCESSORS */}
            {tab === 'subprocessors' && (
                <div className="space-y-default">
                    {canWrite && (
                        <div className={cn(cardVariants({ density: 'compact' }), 'flex items-end gap-compact')}>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{t('subprocessor2')}</label>
                                {/* PR-D — vendor picker replaces the
                                    legacy "Paste vendor ID" input.
                                    Fetches the tenant's vendor list
                                    so users see vendor names, not
                                    cuids. */}
                                <EntityPicker
                                    tenantSlug={params.tenantSlug}
                                    entityType="VENDOR"
                                    value={subForm.subprocessorVendorId}
                                    onChange={(id) =>
                                        setSubForm((p) => ({ ...p, subprocessorVendorId: id }))
                                    }
                                    id="sub-vendor-id"
                                    testId="vendor-subprocessor-picker"
                                    placeholder={t('selectVendor')}
                                    className="w-48"
                                />
                            </div>
                            <div>
                                <label className="block text-sm text-content-muted mb-1">{t('purpose')}</label>
                                <input className="input w-48" value={subForm.purpose}
                                    onChange={e => setSubForm(p => ({ ...p, purpose: e.target.value }))} id="sub-purpose" placeholder={t('purposePlaceholder')} />
                            </div>
                            <Button variant="primary" disabled={!subForm.subprocessorVendorId} id="add-subprocessor-btn" onClick={async () => {
                                await fetch(apiUrl(`/vendors/${params.vendorId}/subprocessors`), {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(subForm),
                                });
                                setSubForm({ subprocessorVendorId: '', purpose: '' }); fetchSubs();
                            }}>{t('add')}</Button>
                        </div>
                    )}
                    <VendorSubprocessorsTable
                        subs={subs}
                        canWrite={canWrite}
                        onRemove={async (relationId: string) => {
                            await fetch(
                                apiUrl(
                                    `/vendors/${params.vendorId}/subprocessors?relationId=${relationId}`,
                                ),
                                { method: 'DELETE' },
                            );
                            fetchSubs();
                        }}
                    />
                </div>
            )}
        </EntityDetailLayout>
    );
}

// R11-PR7 — vendor documents sub-table routed through DataTable.
// Inline columns derive from the same fields the prior raw <table>
// rendered; canWrite gates the Remove action column.
interface VendorDocRow {
    id: string;
    type: string;
    title?: string | null;
    /** B8 — optional folder label. Empty/null = "no folder". */
    folder?: string | null;
    validTo?: string | null;
    uploadedBy?: { name?: string | null } | null;
    externalUrl?: string | null;
}

function VendorDocsTable({
    docs,
    canWrite,
    onRemove,
}: {
    docs: VendorDocRow[];
    canWrite: boolean;
    onRemove: (id: string) => void;
}) {
    const t = useTranslations('vendors.detail');
    const columns = useMemo(
        () =>
            createColumns<VendorDocRow>([
                {
                    id: 'type',
                    header: 'Type',
                    cell: ({ row }) => (
                        <StatusBadge variant="info">
                            {DOC_TYPE_LABELS[row.original.type] || row.original.type}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'title',
                    header: 'Title',
                    cell: ({ row }) => (
                        <span>{row.original.title || '—'}</span>
                    ),
                },
                {
                    id: 'folder',
                    header: 'Folder',
                    cell: ({ row }) =>
                        row.original.folder ? (
                            <span className="text-xs text-content-muted">{row.original.folder}</span>
                        ) : (
                            <span className="text-content-subtle">—</span>
                        ),
                },
                {
                    id: 'validTo',
                    header: 'Valid To',
                    cell: ({ row }) =>
                        row.original.validTo ? formatDate(row.original.validTo) : '—',
                },
                {
                    id: 'uploadedBy',
                    header: 'Uploaded By',
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {row.original.uploadedBy?.name || '—'}
                        </span>
                    ),
                },
                {
                    id: 'link',
                    header: 'Link',
                    cell: ({ row }) => {
                        const href = normaliseHref(row.original.externalUrl);
                        return href ? (
                            <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-content-info underline text-xs"
                            >
                                {t('open')}
                            </a>
                        ) : (
                            <span>—</span>
                        );
                    },
                },
                ...(canWrite
                    ? [
                          {
                              id: 'actions',
                              header: '',
                              cell: ({ row }) => (
                                  <button
                                      className="text-content-error text-xs hover:underline"
                                      onClick={() => onRemove(row.original.id)}
                                  >
                                      {t('remove')}
                                  </button>
                              ),
                          } as Parameters<typeof createColumns<VendorDocRow>>[0][number],
                      ]
                    : []),
            ]),
        [canWrite, onRemove, t],
    );
    return (
        <DataTable
            data={docs}
            columns={columns}
            getRowId={(d) => d.id}
            emptyState={t('docsEmpty')}
            resourceName={(p) => (p ? 'documents' : 'document')}
            data-testid="vendor-docs-table"
        />
    );
}

// ─── Assessments sub-table (R10-PR3 follow-up) ──────────────────────
// Inline assessment list: Template / Status / Score / Risk / Started
// + open-link action. The "Open →" cell stays a plain Link (no
// per-row write affordance), so this is the cleanest of the four
// migrations — purely a primitive swap, no behaviour change.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function VendorAssessmentsTable({ assessments, vendorId, tenantHref }: { assessments: any[]; vendorId: string; tenantHref: (path: string) => string }) {
    const t = useTranslations('vendors.detail');
    const columns = useMemo(
        () =>
            createColumns<any>([   // eslint-disable-line @typescript-eslint/no-explicit-any
                {
                    id: 'template',
                    header: 'Template',
                    cell: ({ row }) => row.original.template?.name || '—',
                },
                {
                    id: 'status',
                    header: 'Status',
                    cell: ({ row }) => (
                        <StatusBadge variant={ASSESSMENT_STATUS_BADGE[row.original.status]}>
                            {row.original.status}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'score',
                    header: 'Score',
                    cell: ({ row }) =>
                        row.original.score != null ? row.original.score.toFixed(1) : '—',
                },
                {
                    id: 'risk',
                    header: 'Risk Rating',
                    cell: ({ row }) =>
                        row.original.riskRating ? (
                            <StatusBadge variant={CRIT_BADGE[row.original.riskRating]}>
                                {row.original.riskRating}
                            </StatusBadge>
                        ) : (
                            '—'
                        ),
                },
                {
                    id: 'started',
                    header: 'Started',
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {formatDate(row.original.startedAt)}
                        </span>
                    ),
                },
                {
                    id: 'action',
                    header: 'Action',
                    cell: ({ row }) => (
                        <Link
                            href={tenantHref(`/vendors/${vendorId}/assessment/${row.original.id}`)}
                            className="text-content-info hover:underline text-xs"
                            id={`open-assessment-${row.original.id}`}
                        >
                            {t('openArrow')}
                        </Link>
                    ),
                },
            ]),
        [vendorId, tenantHref, t],
    );
    return (
        <DataTable
            data={assessments}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            getRowId={(a: any) => a.id}
            columns={columns}
            selectionEnabled={false}
            emptyState={
                <InlineEmptyState
                    title={t('assessmentsEmpty.title')}
                    description={t('assessmentsEmpty.description')}
                />
            }
        />
    );
}

// ─── Subprocessors sub-table (R10-PR3 follow-up) ────────────────────
// Tracks the vendor's nested subprocessors with per-row Remove
// (canWrite-gated). Same shape as the R11-PR8 task-links template:
// Actions column produced via the gated-spread idiom.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function VendorSubprocessorsTable({ subs, canWrite, onRemove }: { subs: any[]; canWrite: boolean; onRemove: (relationId: string) => void | Promise<void> }) {
    const t = useTranslations('vendors.detail');
    const columns = useMemo(
        () =>
            createColumns<any>([   // eslint-disable-line @typescript-eslint/no-explicit-any
                {
                    id: 'name',
                    header: 'Subprocessor',
                    cell: ({ row }) => (
                        <span className="font-medium">
                            {row.original.subprocessor?.name || row.original.subprocessorVendorId}
                        </span>
                    ),
                },
                {
                    id: 'country',
                    header: 'Country',
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {row.original.subprocessor?.country || row.original.country || '—'}
                        </span>
                    ),
                },
                {
                    id: 'crit',
                    header: 'Criticality',
                    cell: ({ row }) => (
                        <StatusBadge
                            variant={
                                CRIT_BADGE[row.original.subprocessor?.criticality] || 'neutral'
                            }
                        >
                            {row.original.subprocessor?.criticality || '—'}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'risk',
                    header: 'Risk',
                    cell: ({ row }) =>
                        row.original.subprocessor?.inherentRisk ? (
                            <StatusBadge variant={CRIT_BADGE[row.original.subprocessor.inherentRisk]}>
                                {row.original.subprocessor.inherentRisk}
                            </StatusBadge>
                        ) : (
                            '—'
                        ),
                },
                {
                    id: 'purpose',
                    header: 'Purpose',
                    cell: ({ row }) => (
                        <span className="text-content-muted text-xs">
                            {row.original.purpose || '—'}
                        </span>
                    ),
                },
                ...(canWrite
                    ? [
                          {
                              id: 'actions',
                              header: '',
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                              cell: ({ row }: { row: { original: any } }) => (
                                  <button
                                      className="text-content-error text-xs"
                                      onClick={() => onRemove(row.original.id)}
                                  >
                                      {t('remove')}
                                  </button>
                              ),
                          },
                      ]
                    : []),
            ]),
        [canWrite, onRemove, t],
    );
    return (
        <DataTable
            data={subs}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            getRowId={(s: any) => s.id}
            columns={columns}
            selectionEnabled={false}
            emptyState={
                <InlineEmptyState
                    title={t('subsEmpty.title')}
                    description={t('subsEmpty.description')}
                />
            }
        />
    );
}

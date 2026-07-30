'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { RequirePermission } from '@/components/require-permission';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

const SCALE_OPTIONS: ComboboxOption[] = [1,2,3,4,5].map(v => ({ value: String(v), label: String(v) }));

// ─── Types ───

interface StructuredRationale {
    whyThisRisk: string;
    affectedAssetCharacteristics: string[];
    suggestedControlThemes: string[];
}

interface SuggestionItem {
    id: string;
    title: string;
    description: string | null;
    category: string | null;
    threat: string | null;
    vulnerability: string | null;
    likelihoodSuggested: number | null;
    impactSuggested: number | null;
    rationale: string | null;
    suggestedControlsJson: string | null;
    status: string;
    assetId: string | null;
    createdRiskId: string | null;
    confidence: 'high' | 'medium' | 'low' | null;
    structuredRationaleJson: string | null;
    isFallback: boolean | null;
}

interface Session {
    id: string;
    status: string;
    provider: string;
    modelName: string | null;
    createdAt: string;
    items: SuggestionItem[];
    isFallback?: boolean;
}

interface AssetOption {
    id: string;
    name: string;
    type: string;
    criticality: string | null;
}

type ItemDecision = 'accept' | 'reject' | 'pending';
type Phase = 'form' | 'generating' | 'review' | 'applying' | 'done';

// ─── Main Page ───

export default function AIRiskAssessmentPage() {
    const tai = useTranslations('riskAi');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { permissions } = useTenantContext();

    // Phase state
    const [phase, setPhase] = useState<Phase>('form');

    // Form state
    const [assets, setAssets] = useState<AssetOption[]>([]);
    const [assetsLoaded, setAssetsLoaded] = useState(false);
    const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
    const [frameworks, setFrameworks] = useState<string[]>([]);
    const [context, setContext] = useState('');
    const [error, setError] = useState('');

    // Session state
    const [session, setSession] = useState<Session | null>(null);
    const [decisions, setDecisions] = useState<Record<string, ItemDecision>>({});
    const [editingItem, setEditingItem] = useState<string | null>(null);
    const [editForm, setEditForm] = useState<Record<string, any>>({});
    const [appliedCount, setAppliedCount] = useState(0);

    // ─── Load Assets ───
    const loadAssets = async () => {
        if (assetsLoaded) return;
        try {
            const res = await fetch(apiUrl('/assets'));
            if (!res.ok) return;
            const data = await res.json();
            const list = Array.isArray(data) ? data : data.data ?? [];
            setAssets(list.map((a: any) => ({ id: a.id, name: a.name, type: a.type, criticality: a.criticality })));
            setAssetsLoaded(true);
        } catch { /* ignore */ }
    };

    // ─── Generate ───
    const handleGenerate = async () => {
        setError('');
        setPhase('generating');
        try {
            const res = await fetch(apiUrl('/ai/risk-suggestions/generate'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    assetIds: selectedAssetIds,
                    frameworks,
                    context: context || undefined,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: { message: tai('generationFailed') } }));
                throw new Error(err.error?.message ?? tai('generationFailed'));
            }
            const data = await res.json();
            const sess: Session = data.session
                ? { ...data.session, items: data.items ?? [] }
                : data;
            setSession(sess);

            // Initialize decisions: all pending
            const decs: Record<string, ItemDecision> = {};
            for (const item of sess.items) {
                decs[item.id] = 'pending';
            }
            setDecisions(decs);
            setPhase('review');
        } catch (e: any) {
            setError(e.message);
            setPhase('form');
        }
    };

    // ─── Apply ───
    const handleApply = async () => {
        if (!session) return;
        const accepted = Object.entries(decisions).filter(([, d]) => d === 'accept').map(([id]) => id);
        if (accepted.length === 0) { setError(tai('selectAtLeastOne')); return; }

        setError('');
        setPhase('applying');
        try {
            const res = await fetch(apiUrl(`/ai/risk-suggestions/${session.id}/apply`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ acceptedItemIds: accepted }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: { message: tai('applyFailed') } }));
                throw new Error(err.error?.message ?? tai('applyFailed'));
            }
            const updated = await res.json();
            setSession(updated);
            setAppliedCount(accepted.length);
            setPhase('done');
        } catch (e: any) {
            setError(e.message);
            setPhase('review');
        }
    };

    // ─── Dismiss ───
    const handleDismiss = async () => {
        if (!session) return;
        try {
            await fetch(apiUrl(`/ai/risk-suggestions/${session.id}/dismiss`), { method: 'POST' });
            setSession(null);
            setPhase('form');
        } catch { /* ignore */ }
    };

    // ─── Toggle framework ───
    const toggleFramework = (fw: string) => {
        setFrameworks(prev => prev.includes(fw) ? prev.filter(f => f !== fw) : [...prev, fw]);
    };

    // ─── Toggle asset selection ───
    const toggleAsset = (id: string) => {
        setSelectedAssetIds(prev => prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]);
    };

    // ─── Decision helpers ───
    const setDecision = (id: string, d: ItemDecision) => {
        setDecisions(prev => ({ ...prev, [id]: d }));
    };
    const acceptAll = () => {
        const decs: Record<string, ItemDecision> = {};
        for (const id of Object.keys(decisions)) decs[id] = 'accept';
        setDecisions(decs);
    };
    const rejectAll = () => {
        const decs: Record<string, ItemDecision> = {};
        for (const id of Object.keys(decisions)) decs[id] = 'reject';
        setDecisions(decs);
    };

    // ─── Edit helpers ───
    const startEdit = (item: SuggestionItem) => {
        setEditingItem(item.id);
        setEditForm({
            title: item.title,
            description: item.description ?? '',
            likelihoodSuggested: item.likelihoodSuggested ?? 3,
            impactSuggested: item.impactSuggested ?? 3,
        });
    };
    const cancelEdit = () => { setEditingItem(null); setEditForm({}); };

    // ─── Risk Level Badge ───
    const riskBadge = (l: number, i: number) => {
        const score = l * i;
        if (score <= 5) return <StatusBadge variant="success">{tai('low')}</StatusBadge>;
        if (score <= 12) return <StatusBadge variant="warning">{tai('medium')}</StatusBadge>;
        if (score <= 18) return <StatusBadge variant="error">{tai('high')}</StatusBadge>;
        return <StatusBadge variant="error">{tai('critical')}</StatusBadge>;
    };

    // Roadmap-2 PR-7 — confidence indicators are tone-mapped pills
    // identical in shape to every other status across the product.
    // Previously hand-rolled with `px-2 py-0.5 rounded ring-1` —
    // now consumed via the canonical `<StatusBadge>` so a theme flip
    // re-tones the indicator and the visual vocabulary stays
    // singular.
    const confidenceBadge = (c: string | null) => {
        switch (c) {
            case 'high': return <StatusBadge variant="success">{tai('confidenceHigh')}</StatusBadge>;
            case 'medium': return <StatusBadge variant="warning">{tai('confidenceMedium')}</StatusBadge>;
            case 'low': return <StatusBadge variant="neutral">{tai('confidenceLow')}</StatusBadge>;
            default: return null;
        }
    };

    const parseStructuredRationale = (json: string | null): StructuredRationale | null => {
        if (!json) return null;
        try { return JSON.parse(json) as StructuredRationale; } catch { return null; }
    };

    const acceptedCount = Object.values(decisions).filter(d => d === 'accept').length;
    const rejectedCount = Object.values(decisions).filter(d => d === 'reject').length;
    const pendingCount = Object.values(decisions).filter(d => d === 'pending').length;

    return (
        <div className="space-y-section animate-fadeIn max-w-5xl">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <div className="flex items-center gap-compact">
                        <Link href={tenantHref('/risks')} className="text-content-muted hover:text-content-emphasis transition text-lg">←</Link>
                        <div>
                            <Heading level={1} id="ai-risk-title">{tai('title')}</Heading>
                            <p className="text-content-muted text-sm">{tai('subtitle')}</p>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-tight">
                    <StatusBadge variant="info">{tai('aiPowered')}</StatusBadge>
                </div>
            </div>

            {error && (
                <div className={cn(cardVariants({ density: 'compact' }), 'border-border-error text-content-error text-sm')} id="ai-error">
                    {error}
                    <button onClick={() => setError('')} className="ml-4 text-content-error hover:text-content-emphasis">x</button>
                </div>
            )}

            {/* ═══ PHASE: FORM ═══ */}
            {phase === 'form' && (
                <div className={cn(cardVariants(), 'space-y-section')} id="ai-generate-form">
                    <Heading level={2}>{tai('configureAssessment')}</Heading>

                    {/* Framework Selection */}
                    <div>
                        <label className="input-label">{tai('complianceFrameworks')}</label>
                        <div className="flex flex-wrap gap-tight mt-2" id="ai-framework-pills">
                            {['ISO27001', 'NIS2', 'SOC2'].map(fw => (
                                <button
                                    key={fw}
                                    id={`fw-${fw.toLowerCase()}`}
                                    onClick={() => toggleFramework(fw)}
                                    className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                                        frameworks.includes(fw)
                                            ? 'bg-bg-info-emphasis text-content-emphasis ring-2 ring-[var(--border-info)]'
                                            : 'bg-bg-elevated/50 text-content-default hover:bg-bg-muted/50'
                                    }`}
                                >
                                    {fw}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Asset Selection */}
                    <div>
                        <label className="input-label">{tai('assetsToAssess')}</label>
                        <Button
                            variant="secondary"
                            size="xs"
                            className="ml-2"
                            onClick={loadAssets}
                            id="load-assets-btn"
                        >
                            {assetsLoaded ? tai('assetsLoaded', { count: assets.length }) : tai('loadAssets')}
                        </Button>
                        {assetsLoaded && (
                            <div className="mt-2 max-h-48 overflow-y-auto space-y-1" id="ai-asset-list">
                                {assets.length === 0 && <p className="text-sm text-content-subtle">{tai('noAssetsFound')}</p>}
                                {assets.map(a => (
                                    <label key={a.id} className="flex items-center gap-tight px-3 py-2 rounded-lg hover:bg-bg-muted/50 cursor-pointer text-sm">
                                        <input
                                            type="checkbox"
                                            checked={selectedAssetIds.includes(a.id)}
                                            onChange={() => toggleAsset(a.id)}
                                            className="rounded"
                                        />
                                        <span className="text-content-emphasis">{a.name}</span>
                                        <span className="text-xs text-content-muted">{a.type.replace(/_/g, ' ')}</span>
                                        {a.criticality && <StatusBadge variant={a.criticality === 'HIGH' ? 'error' : a.criticality === 'MEDIUM' ? 'warning' : 'success'}>{a.criticality}</StatusBadge>}
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Context */}
                    <div>
                        <label className="input-label" htmlFor="ai-context-input">{tai('additionalContext')}</label>
                        <textarea
                            id="ai-context-input"
                            className="input w-full h-24 resize-none"
                            placeholder={tai('contextPlaceholder')}
                            value={context}
                            onChange={e => setContext(e.target.value)}
                            maxLength={2000}
                        />
                        <p className="text-xs text-content-subtle mt-1">{tai('charCount', { count: context.length })}</p>
                    </div>

                    {/* Generate Button */}
                    <RequirePermission resource="risks" action="create">
                        <Button
                            variant="primary"
                            className="w-full text-center py-3"
                            onClick={handleGenerate}
                            id="ai-generate-btn"
                        >
                            {tai('generateSuggestions')}
                        </Button>
                    </RequirePermission>
                </div>
            )}

            {/* ═══ PHASE: GENERATING ═══ */}
            {phase === 'generating' && (
                <div className={cn(cardVariants({ density: 'spacious' }), 'text-center')} id="ai-generating">
                    <div className="animate-pulse text-4xl mb-4">...</div>
                    <Heading level={2}>{tai('analyzing')}</Heading>
                    <p className="text-content-muted text-sm mt-2">{tai('analyzingDesc')}</p>
                    <p className="text-content-subtle text-xs mt-4">{tai('mayTakeSeconds')}</p>
                </div>
            )}

            {/* ═══ PHASE: REVIEW ═══ */}
            {phase === 'review' && session && (
                <div className="space-y-default" id="ai-review-section">
                    {/* Summary bar */}
                    <div className={cn(cardVariants({ density: 'compact' }), 'flex items-center justify-between')}>
                        <div className="flex items-center gap-default">
                            <span className="text-sm text-content-muted">
                                {tai('suggestionsProvider', { count: session.items.length })} <strong className="text-content-default">{session.provider}</strong>
                            </span>
                            {session.isFallback ? (
                                <span className="text-xs px-2 py-1 rounded bg-bg-warning text-content-warning ring-1 ring-[var(--border-warning)]" id="fallback-notice">
                                    {tai('fallbackNotice')}
                                </span>
                            ) : (
                                <span className="text-xs text-content-subtle">
                                    {tai('aiGeneratedReview')}
                                </span>
                            )}
                        </div>
                        <div className="flex gap-tight">
                            <Button variant="secondary" size="xs" onClick={acceptAll} id="accept-all-btn">{tai('acceptAll')}</Button>
                            <Button variant="secondary" size="xs" onClick={rejectAll} id="reject-all-btn">{tai('rejectAll')}</Button>
                        </div>
                    </div>

                    {/* Decision summary */}
                    <div className="flex gap-compact text-sm">
                        <span className="text-content-success" id="accepted-count">{tai('acceptedCount', { count: acceptedCount })}</span>
                        <span className="text-content-error" id="rejected-count">{tai('rejectedCount', { count: rejectedCount })}</span>
                        <span className="text-content-muted" id="pending-count">{tai('pendingCount', { count: pendingCount })}</span>
                    </div>

                    {/* Suggestion cards */}
                    {session.items.map((item, idx) => {
                        const dec = decisions[item.id] ?? 'pending';
                        const isEditing = editingItem === item.id;
                        const controls: string[] = item.suggestedControlsJson
                            ? (JSON.parse(item.suggestedControlsJson) as string[])
                            : [];
                        const sr = parseStructuredRationale(item.structuredRationaleJson);

                        return (
                            <div
                                key={item.id}
                                id={`suggestion-${idx}`}
                                className={cn(cardVariants(), 'transition-all', dec === 'accept' ? 'ring-1 ring-[var(--border-success)] bg-bg-success' :
                                    dec === 'reject' ? 'ring-1 ring-[var(--border-error)] opacity-60' : '')}
                            >
                                <div className="flex items-start justify-between gap-default">
                                    <div className="flex-1 space-y-compact">
                                        {/* Header */}
                                        <div className="flex items-center gap-tight flex-wrap">
                                            <span className="text-xs text-content-subtle font-mono">#{idx + 1}</span>
                                            {isEditing ? (
                                                <input
                                                    className="input flex-1 text-sm font-semibold"
                                                    value={editForm.title}
                                                    onChange={e => setEditForm(p => ({ ...p, title: e.target.value }))}
                                                    id={`edit-title-${idx}`}
                                                />
                                            ) : (
                                                <Heading level={3}>{item.title}</Heading>
                                            )}
                                            {item.category && <StatusBadge variant="info">{item.category}</StatusBadge>}
                                            {confidenceBadge(item.confidence)}
                                            <StatusBadge variant="neutral">{item.isFallback ? tai('baseline') : tai('aiSuggested')}</StatusBadge>
                                        </div>

                                        {/* Description */}
                                        {isEditing ? (
                                            <textarea
                                                className="input w-full h-20 resize-none text-sm"
                                                value={editForm.description}
                                                onChange={e => setEditForm(p => ({ ...p, description: e.target.value }))}
                                                id={`edit-desc-${idx}`}
                                            />
                                        ) : (
                                            <p className="text-sm text-content-default">{item.description}</p>
                                        )}

                                        {/* Threat / Vulnerability */}
                                        {(item.threat || item.vulnerability) && !isEditing && (
                                            <div className="grid grid-cols-2 gap-default text-xs">
                                                {item.threat && <div><span className="text-content-subtle uppercase font-semibold">{tai('threat')}</span><p className="text-content-muted mt-0.5">{item.threat}</p></div>}
                                                {item.vulnerability && <div><span className="text-content-subtle uppercase font-semibold">{tai('vulnerability')}</span><p className="text-content-muted mt-0.5">{item.vulnerability}</p></div>}
                                            </div>
                                        )}

                                        {/* Ratings */}
                                        <div className="flex items-center gap-default text-sm">
                                            {isEditing ? (
                                                <div className="flex items-center gap-default">
                                                    <label className="text-xs text-content-muted">
                                                        L: <Combobox
                                                            hideSearch
                                                            id={`edit-likelihood-${idx}`}
                                                            selected={SCALE_OPTIONS.find(o => o.value === String(editForm.likelihoodSuggested)) ?? null}
                                                            setSelected={(opt) => setEditForm(p => ({ ...p, likelihoodSuggested: +(opt?.value ?? p.likelihoodSuggested) }))}
                                                            options={SCALE_OPTIONS}
                                                            matchTriggerWidth
                                                            buttonProps={{ className: 'text-xs w-16 inline-block ml-1' }}
                                                        />
                                                    </label>
                                                    <label className="text-xs text-content-muted">
                                                        I: <Combobox
                                                            hideSearch
                                                            id={`edit-impact-${idx}`}
                                                            selected={SCALE_OPTIONS.find(o => o.value === String(editForm.impactSuggested)) ?? null}
                                                            setSelected={(opt) => setEditForm(p => ({ ...p, impactSuggested: +(opt?.value ?? p.impactSuggested) }))}
                                                            options={SCALE_OPTIONS}
                                                            matchTriggerWidth
                                                            buttonProps={{ className: 'text-xs w-16 inline-block ml-1' }}
                                                        />
                                                    </label>
                                                </div>
                                            ) : (
                                                <>
                                                    <span className="text-content-muted">L: <strong className="text-content-emphasis">{item.likelihoodSuggested ?? '—'}</strong></span>
                                                    <span className="text-content-muted">I: <strong className="text-content-emphasis">{item.impactSuggested ?? '—'}</strong></span>
                                                    {item.likelihoodSuggested && item.impactSuggested && riskBadge(item.likelihoodSuggested, item.impactSuggested)}
                                                </>
                                            )}
                                        </div>

                                        {/* Rationale & Explainability */}
                                        {!isEditing && (item.rationale || sr) && (
                                            <div className="bg-bg-default/50 rounded-lg p-3 text-xs text-content-muted space-y-tight">
                                                {item.rationale && (
                                                    <div>
                                                        <span className="text-content-subtle uppercase font-semibold block mb-1">{tai('rationale')}</span>
                                                        {item.rationale}
                                                    </div>
                                                )}
                                                {sr && sr.whyThisRisk && (
                                                    <div>
                                                        <span className="text-content-subtle uppercase font-semibold block mb-1">{tai('whyThisRisk')}</span>
                                                        <p className="text-content-default">{sr.whyThisRisk}</p>
                                                    </div>
                                                )}
                                                {sr && sr.affectedAssetCharacteristics.length > 0 && (
                                                    <div>
                                                        <span className="text-content-subtle uppercase font-semibold block mb-1">{tai('affectedAssetCharacteristics')}</span>
                                                        <div className="flex flex-wrap gap-1">
                                                            {sr.affectedAssetCharacteristics.map((c, ci) => (
                                                                <span key={ci} className="px-2 py-0.5 rounded bg-bg-elevated/60 text-content-default">{c}</span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                                {sr && sr.suggestedControlThemes.length > 0 && (
                                                    <div>
                                                        <span className="text-content-subtle uppercase font-semibold block mb-1">{tai('controlThemes')}</span>
                                                        <div className="flex flex-wrap gap-1">
                                                            {sr.suggestedControlThemes.map((t, ti) => (
                                                                <span key={ti} className="px-2 py-0.5 rounded bg-indigo-900/40 text-indigo-300 ring-1 ring-indigo-500/20">{t}</span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Suggested Controls */}
                                        {controls.length > 0 && !isEditing && (
                                            <div className="flex flex-wrap gap-1.5">
                                                <span className="text-xs text-content-subtle mr-1">{tai('suggestedControls')}</span>
                                                {controls.map((c, ci) => (
                                                    <span key={ci} className="text-xs bg-bg-info text-content-info px-2 py-0.5 rounded">{c}</span>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Decision buttons */}
                                    <div className="flex flex-col gap-tight shrink-0">
                                        {isEditing ? (
                                            <>
                                                <Button
                                                    variant="primary"
                                                    size="xs"
                                                    onClick={() => { cancelEdit(); setDecision(item.id, 'accept'); }}
                                                    id={`save-edit-${idx}`}
                                                >
                                                    {tai('saveAndAccept')}
                                                </Button>
                                                <Button variant="secondary" size="xs" onClick={cancelEdit}>{tai('cancel')}</Button>
                                            </>
                                        ) : (
                                            <>
                                                <Button
                                                    variant={dec === 'accept' ? 'primary' : 'secondary'}
                                                    size="xs"
                                                    className={dec === 'accept' ? 'bg-bg-success-emphasis text-content-inverted' : ''}
                                                    onClick={() => setDecision(item.id, 'accept')}
                                                    id={`accept-${idx}`}
                                                >
                                                    {tai('accept')}
                                                </Button>
                                                <Button
                                                    variant={dec === 'reject' ? 'destructive' : 'secondary'}
                                                    size="xs"
                                                    className={dec === 'reject' ? 'bg-bg-error-emphasis text-content-inverted' : ''}
                                                    onClick={() => setDecision(item.id, 'reject')}
                                                    id={`reject-${idx}`}
                                                >
                                                    {tai('reject')}
                                                </Button>
                                                {permissions.canWrite && (
                                                    <Button
                                                        variant="secondary"
                                                        size="xs"
                                                        onClick={() => startEdit(item)}
                                                        id={`edit-${idx}`}
                                                    >
                                                        {tai('edit')}
                                                    </Button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}

                    {/* Action bar */}
                    <div className={cn(cardVariants({ density: 'compact' }), 'flex items-center justify-between')} id="ai-action-bar">
                        <Button variant="secondary" onClick={handleDismiss} id="dismiss-btn">{tai('dismissAll')}</Button>
                        <RequirePermission resource="risks" action="create">
                            <Button
                                variant="primary"
                                onClick={handleApply}
                                disabled={acceptedCount === 0}
                                id="apply-btn"
                            >
                                {tai('applyAccepted', { count: acceptedCount })}
                            </Button>
                        </RequirePermission>
                    </div>
                </div>
            )}

            {/* ═══ PHASE: APPLYING ═══ */}
            {phase === 'applying' && (
                <div className={cn(cardVariants({ density: 'spacious' }), 'text-center')}>
                    <div className="animate-pulse text-4xl mb-4">...</div>
                    <Heading level={2}>{tai('creatingRecords')}</Heading>
                    <p className="text-content-muted text-sm mt-2">{tai('creatingRecordsDesc')}</p>
                </div>
            )}

            {/* ═══ PHASE: DONE ═══ */}
            {phase === 'done' && (
                <Card className="text-center space-y-default" id="ai-done">
                    <div className="text-4xl">{tai('done')}</div>
                    <Heading level={2}>
                        {tai('risksAdded', { count: appliedCount })}
                    </Heading>
                    <p className="text-sm text-content-muted">
                        {tai('appliedDesc')}
                    </p>
                    <div className="flex gap-compact justify-center pt-2">
                        <Link href={tenantHref('/risks')} className={buttonVariants({ variant: 'primary' })} id="view-risks-btn">
                            {tai('viewRegister')}
                        </Link>
                        <Button variant="secondary" onClick={() => { setPhase('form'); setSession(null); }} id="new-assessment-btn">
                            {tai('newAssessment')}
                        </Button>
                    </div>
                </Card>
            )}
        </div>
    );
}

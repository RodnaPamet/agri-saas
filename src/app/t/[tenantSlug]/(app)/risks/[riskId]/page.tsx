'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { formatDate } from '@/lib/format-date';
import { useTranslations } from 'next-intl';
import { SkeletonCard, SkeletonDetailPage } from '@/components/ui/skeleton';
import { useEffect, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTenantContext, useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import dynamic from 'next/dynamic';
import LinkedTasksPanel from '@/components/LinkedTasksPanel';
import { Eyebrow } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { MetaStrip } from '@/components/ui/meta-strip';
import { RiskScoreExplainer } from '@/components/RiskScoreExplainer';
import {
    RISK_STATUS_VARIANT,
    getRiskScoreBand,
} from '@/app-layer/domain/entity-status-mapping';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
// Epic G-7 — treatment plan card. Dynamic-imported so the modal +
// react-query machinery only loads on risks the user actually opens.
const RiskTreatmentPlanCard = dynamic(
    () =>
        import('@/components/RiskTreatmentPlanCard').then(
            (m) => m.RiskTreatmentPlanCard,
        ),
    {
        loading: () => (
            <SkeletonCard lines={2} />
        ),
        ssr: false,
    },
);
import { Button } from '@/components/ui/button';
import { Pen2 } from '@/components/ui/icons/nucleo';
import { Tooltip } from '@/components/ui/tooltip';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { useTenantMembers } from '@/components/ui/user-combobox';
import { RISK_TREATMENT_OPTIONS } from '../_shared/risk-options';
import { cn } from '@/lib/cn';
import { cardVariants } from '@/components/ui/card';
import { EditRiskModal, type EditRiskForm } from './_modals/EditRiskModal';
import { RiskAssessmentPanel } from './RiskAssessmentPanel';
import { resolveALE } from '@/app-layer/usecases/fair-calculator';
import { formatCompactCurrency } from '@/lib/risk-coherence';
import { formatTailAwareAle } from '@/lib/tail-language';
import { FairAnalysisPanel } from './FairAnalysisPanel';
import { BowTiePanel } from './BowTiePanel';
import { RiskHistoryPanel } from './RiskHistoryPanel';
import { InheritedEvidencePanel } from '@/components/InheritedEvidencePanel';
import { AttachedEvidencePanel } from '@/components/AttachedEvidencePanel';
import { Heading } from '@/components/ui/typography';
import { InheritedMappingsPanel } from '@/components/InheritedMappingsPanel';

const TraceabilityPanel = dynamic(() => import('@/components/TraceabilityPanel'), {
    loading: () => <SkeletonCard lines={3} />,
    ssr: false,
});

type Risk = {
    id: string;
    title: string;
    description: string | null;
    category: string | null;
    threat: string | null;
    vulnerability: string | null;
    status: string;
    treatment: string | null;
    treatmentOwner: string | null;
    treatmentNotes: string | null;
    ownerUserId: string | null;
    likelihood: number;
    impact: number;
    score: number;
    inherentScore: number;
    residualLikelihood: number | null;
    residualImpact: number | null;
    residualScore: number | null;
    nextReviewAt: string | null;
    targetDate: string | null;
    createdAt: string;
    updatedAt: string;
    // RQ-1 FAIR inputs (all nullable).
    threatEventFrequency: number | null;
    contactFrequency: number | null;
    probabilityOfAction: number | null;
    vulnerabilityProbability: number | null;
    threatCapability: number | null;
    controlStrength: number | null;
    primaryLossMagnitude: number | null;
    productivityLoss: number | null;
    responseCost: number | null;
    replacementCost: number | null;
    secondaryLossEventFrequency: number | null;
    secondaryLossMagnitude: number | null;
    fairConfidence: 'LOW' | 'MEDIUM' | 'HIGH' | null;
    /** RQ3-2 — stored PERT triples (range-first estimation). */
    fairInputsJson: Record<string, unknown> | null;
    fairAle: number | null;
    // RQ2-5 — legacy quant inputs feed `resolveALE` for the header chip.
    sleAmount: number | null;
    aroAmount: number | null;
};

// Audit Coherence S1 — MITIGATED sits between MITIGATING and
// ACCEPTED in the RiskStatus enum. The detail-page status combobox
// must offer it; otherwise a reviewer who picks "Mitigated" in the
// list filter cannot land on the corresponding detail-page value.
const STATUS_VALUES = [
    'OPEN',
    'MITIGATING',
    'MITIGATED',
    'ACCEPTED',
    'CLOSED',
] as const;
const STATUS_OPTIONS: ComboboxOption[] = STATUS_VALUES.map(s => ({ value: s, label: s }));
const CATEGORIES = [
    'Technical', 'Operational', 'Compliance', 'Strategic',
    'Financial', 'Reputational', 'Physical', 'Human Resources',
];
const CATEGORY_OPTIONS: ComboboxOption[] = CATEGORIES.map(c => ({ value: c, label: c }));
const TREATMENT_OPTIONS = RISK_TREATMENT_OPTIONS;

// Polish PR-1 — STATUS_VARIANT moved to shared domain mapping.
// Imported from @/app-layer/domain/entity-status-mapping as
// `RISK_STATUS_VARIANT` so risks list / dashboard / detail all read
// the same vocabulary.

function isOverdue(nextReviewAt: string | null): boolean {
    if (!nextReviewAt) return false;
    return new Date(nextReviewAt) < new Date();
}

// getRiskBadge → getRiskScoreBand from shared domain mapping.

export default function RiskDetailPage() {
    const td = useTranslations('riskDetail');
    const { riskId } = useParams<{ riskId: string }>();
    const tenant = useTenantContext();
    const apiUrl = useTenantApiUrl();
    const href = useTenantHref();
    const canWrite = tenant.permissions.canWrite;
    const { data: riskMembers } = useTenantMembers(tenant.tenantSlug);

    const [risk, setRisk] = useState<Risk | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);

    // RQ2-4 — the 10-tab bar is rationalized to 8. `assessment` is
    // the new guided inherent → controls → residual surface. The
    // former `mappings` and `tests` tabs were both inherited-via-
    // controls panels — they now live as sections under Traceability
    // (where the control links themselves are managed). The former
    // `activity` tab was an EmptyState stub; score provenance now
    // lives in the RQ2-3 explainer + History.
    type Tab =
        | 'overview'
        | 'assessment'
        | 'quantification'
        | 'bowtie'
        | 'history'
        | 'tasks'
        | 'evidence'
        | 'traceability';
    // RQ3-7 — honour a `?tab=<key>` deep-link on first mount (the KRI
    // breach card links straight to `?tab=assessment`). Only a valid
    // tab key is accepted; anything else falls back to overview.
    const searchParams = useSearchParams();
    const initialTab = ((): Tab => {
        const t = searchParams?.get('tab');
        const valid: Tab[] = ['overview', 'assessment', 'quantification', 'bowtie', 'history', 'tasks', 'evidence', 'traceability'];
        return t && (valid as string[]).includes(t) ? (t as Tab) : 'overview';
    })();
    const [activeTab, setActiveTab] = useState<Tab>(initialTab);
    const tabs: ReadonlyArray<{ key: Tab; label: string }> = [
        { key: 'overview', label: td('tabOverview') },
        { key: 'assessment', label: td('tabAssessment') },
        { key: 'quantification', label: td('tabQuantification') },
        { key: 'bowtie', label: td('tabBowtie') },
        { key: 'history', label: td('tabHistory') },
        { key: 'tasks', label: td('tabTasks') },
        { key: 'evidence', label: td('tabEvidence') },
        { key: 'traceability', label: td('tabTraceability') },
    ];
    const [editForm, setEditForm] = useState<EditRiskForm>({});

    const fetchRisk = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(apiUrl(`/risks/${riskId}`));
            if (!res.ok) throw new Error(`Failed to load risk (${res.status})`);
            const data = await res.json();
            setRisk(data);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [apiUrl, riskId]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchRisk(); }, [fetchRisk]);

    // RQ3-4 — this risk's tail percentile (RQ3-1 cache). Failure-soft:
    // the header chip renders the mean register without it.
    const [tailP90, setTailP90] = useState<number | null>(null);
    useEffect(() => {
        fetch(apiUrl('/risks/tail-percentiles'))
            .then((r) => (r.ok ? r.json() : null))
            // eslint-disable-next-line react-hooks/set-state-in-effect
            .then((d) => setTailP90(d?.snapshot?.byRisk?.[riskId]?.aleP90 ?? null))
            .catch(() => setTailP90(null));
    }, [apiUrl, riskId]);

    const startEditing = () => {
        if (!risk) return;
        setEditForm({
            title: risk.title,
            description: risk.description ?? '',
            category: risk.category ?? '',
            likelihood: risk.likelihood,
            impact: risk.impact,
            treatmentOwner: risk.treatmentOwner ?? '',
            ownerUserId: risk.ownerUserId ?? '',
            treatment: risk.treatment ?? '',
            treatmentNotes: risk.treatmentNotes ?? '',
            nextReviewAt: risk.nextReviewAt ? risk.nextReviewAt.split('T')[0] : '',
        });
        setEditing(true);
    };

    const handleSave = async (e?: React.FormEvent) => {
        e?.preventDefault();
        setSaving(true);
        setError(null);
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const payload: Record<string, any> = {
                title: editForm.title,
                description: editForm.description || null,
                category: editForm.category || null,
                likelihood: editForm.likelihood,
                impact: editForm.impact,
                treatmentOwner: editForm.treatmentOwner || null,
                ownerUserId: editForm.ownerUserId || null,
                treatment: editForm.treatment || null,
                treatmentNotes: editForm.treatmentNotes || null,
            };
            if (editForm.nextReviewAt) {
                payload.nextReviewAt = new Date(editForm.nextReviewAt as string).toISOString();
            } else {
                payload.nextReviewAt = null;
            }

            const res = await fetch(apiUrl(`/risks/${riskId}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.message || `Failed to save (${res.status})`);
            }
            const { risk: updated } = await res.json();
            setRisk(updated);
            setEditing(false);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    const handleStatusChange = async (newStatus: string) => {
        setError(null);
        try {
            const res = await fetch(apiUrl(`/risks/${riskId}/status`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.message || `Failed to change status (${res.status})`);
            }
            const updated = await res.json();
            setRisk(updated);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            setError(err.message);
        }
    };

    const breadcrumbs = [
        { label: td('breadcrumbDashboard'), href: href('/dashboard') },
        { label: td('breadcrumbRisks'), href: href('/risks') },
        { label: risk?.title ?? td('risk') },
    ];
    if (loading) {
        // RQ3-OB-B — structured skeleton instead of an empty shell.
        // The empty `<>` left a flash of bare layout chrome on slow
        // detail-page loads; `SkeletonDetailPage` paints the breadcrumb,
        // title, meta pills, and a card stub so the page reads as
        // intentional content rather than as a render miss.
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <SkeletonDetailPage />
            </EntityDetailLayout>
        );
    }
    if (error && !risk) {
        return (
            <EntityDetailLayout error={error} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (!risk) {
        return (
            <EntityDetailLayout empty={{ message: td('notFound') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const band = getRiskScoreBand(risk.inherentScore);
    // RQ2-5 — resolved ALE for the header chip (null = not quantified).
    const riskAleValue = resolveALE({
        fairAle: risk.fairAle,
        sleAmount: risk.sleAmount,
        aroAmount: risk.aroAmount,
    });
    // RQ3-4 — the chip speaks the compact tail register when the
    // simulation cache has this risk's P90.
    const riskAleLabel = formatTailAwareAle(riskAleValue, tailP90, {
        money: formatCompactCurrency,
        compact: true,
    });
    const overdue = isOverdue(risk.nextReviewAt);

    return (
        <EntityDetailLayout
            id="risk-detail-page"
            breadcrumbs={breadcrumbs}
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(k) => setActiveTab(k)}

            title={<span id="risk-title-heading">{risk.title}</span>}
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'status',
                            label: td('status'),
                            value: risk.status,
                            variant: RISK_STATUS_VARIANT[risk.status] ?? 'neutral',
                        },
                        {
                            kind: 'status',
                            label: td('inherentScore'),
                            // RQ2-3 — the header score explains itself.
                            value: (
                                <RiskScoreExplainer tenantSlug={tenant.tenantSlug} riskId={riskId} label={`${risk.inherentScore} · ${band.label}`}>
                                    {`${risk.inherentScore} · ${band.label}`}
                                </RiskScoreExplainer>
                            ),
                            variant: band.variant,
                        },
                        // RQ2-5 — qual ↔ quant side by side: the
                        // quantified header carries the compact ALE
                        // next to the score chip.
                        // polish #11 — the ALE chip drills into the
                        // FAIR tab, closing the loop from glance →
                        // inputs. Bare-text fallback when canWrite is
                        // off keeps the value visible without faking
                        // an affordance.
                        ...(riskAleValue !== null
                            ? [
                                  {
                                      label: td('ale'),
                                      value: (
                                          <button
                                              type="button"
                                              className="cursor-pointer bg-transparent border-0 p-0 text-inherit underline underline-offset-2 decoration-dotted"
                                              onClick={() => setActiveTab('quantification')}
                                              aria-label={td('aleAria', { label: riskAleLabel ?? '' })}
                                              data-testid="meta-ale-link"
                                          >
                                              {riskAleLabel}
                                          </button>
                                      ),
                                  } as const,
                              ]
                            : []),
                        ...(risk.treatmentOwner
                            ? [
                                  {
                                      label: td('owner'),
                                      value: risk.treatmentOwner,
                                  } as const,
                              ]
                            : []),
                        ...(risk.ownerUserId
                            ? [
                                  {
                                      label: td('assignedTo'),
                                      value:
                                          riskMembers?.find(
                                              (m) => m.id === risk.ownerUserId,
                                          )?.name ??
                                          riskMembers?.find(
                                              (m) => m.id === risk.ownerUserId,
                                          )?.email ??
                                          td('assigned'),
                                  } as const,
                              ]
                            : []),
                        ...(risk.nextReviewAt
                            ? [
                                  {
                                      label: td('nextReview'),
                                      value: formatDate(risk.nextReviewAt),
                                      tone: overdue
                                          ? ('critical' as const)
                                          : undefined,
                                  } as const,
                              ]
                            : []),
                    ]}
                />
            }
            actions={
                canWrite && (
                    <Combobox
                        hideSearch
                        id="risk-status-select"
                        selected={STATUS_OPTIONS.find(o => o.value === risk.status) ?? null}
                        setSelected={(opt) => { if (opt) handleStatusChange(opt.value); }}
                        options={STATUS_OPTIONS}
                        placeholder={td('statusPlaceholder')}
                        buttonProps={{ className: 'text-sm' }}
                    />
                )
            }
        >
            {error && (
                <div className={cn(cardVariants({ density: 'compact' }), 'border-border-error text-content-error text-sm')}>{error}</div>
            )}

            {activeTab === 'tasks' && (
                <div className={cardVariants()}>
                    <LinkedTasksPanel
                        apiBase={apiUrl('')}
                        entityType="RISK"
                        entityId={riskId}
                        tenantHref={href}
                        canWrite={canWrite}
                    />
                </div>
            )}
            {activeTab === 'traceability' && (
                <div className="space-y-section">
                    <TraceabilityPanel
                        apiBase={apiUrl('')}
                        entityType="risk"
                        entityId={riskId}
                        canWrite={canWrite}
                        tenantHref={href}
                    />
                    {/* RQ2-4 — the former Mappings + Tests tabs were
                        both inherited-via-controls surfaces; they now
                        sit where the control links are managed.
                        polish #7 — each gets a top divider so the
                        block reads as three sections, not one. */}
                    <div className="space-y-default border-t border-border-subtle pt-default">
                        <Heading level={3}>{td('inheritedMappings')}</Heading>
                        <InheritedMappingsPanel
                            endpoint={apiUrl(`/risks/${riskId}/mappings`)}
                            tenantHref={href}
                            entityLabel="risk"
                        />
                    </div>
                </div>
            )}
            {activeTab === 'evidence' && (
                <div className="space-y-section">
                    <div className="space-y-default">
                        <Heading level={3}>{td('attachedEvidence')}</Heading>
                        <AttachedEvidencePanel
                            entityId={riskId}
                            entity="risk"
                            endpoint={`/risks/${riskId}/evidence/attached`}
                            apiUrl={apiUrl}
                            tenantHref={href}
                            canWrite={canWrite}
                        />
                    </div>
                    <div className="space-y-default">
                        <Heading level={3}>{td('inheritedFromControls')}</Heading>
                        <InheritedEvidencePanel
                            endpoint={apiUrl(`/risks/${riskId}/evidence`)}
                            tenantHref={href}
                            entityLabel="risk"
                        />
                    </div>
                </div>
            )}
            {activeTab === 'assessment' && (
                <RiskAssessmentPanel
                    riskId={riskId}
                    risk={{
                        likelihood: risk.likelihood,
                        impact: risk.impact,
                        inherentScore: risk.inherentScore,
                        residualLikelihood: risk.residualLikelihood,
                        residualImpact: risk.residualImpact,
                        residualScore: risk.residualScore,
                        // RQ3-OB-D — drives the adaptive bridge copy.
                        fairAle: risk.fairAle,
                    }}
                    canWrite={canWrite}
                    onRiskUpdated={fetchRisk}
                    onQuantify={() => setActiveTab('quantification')}
                    onLinkControls={() => setActiveTab('traceability')}
                />
            )}
            {activeTab === 'quantification' && risk && (
                <FairAnalysisPanel
                    riskId={riskId}
                    category={risk.category}
                    initial={{
                        threatEventFrequency: risk.threatEventFrequency,
                        contactFrequency: risk.contactFrequency,
                        probabilityOfAction: risk.probabilityOfAction,
                        vulnerabilityProbability: risk.vulnerabilityProbability,
                        threatCapability: risk.threatCapability,
                        controlStrength: risk.controlStrength,
                        primaryLossMagnitude: risk.primaryLossMagnitude,
                        productivityLoss: risk.productivityLoss,
                        responseCost: risk.responseCost,
                        replacementCost: risk.replacementCost,
                        secondaryLossEventFrequency: risk.secondaryLossEventFrequency,
                        secondaryLossMagnitude: risk.secondaryLossMagnitude,
                        fairConfidence: risk.fairConfidence,
                        fairInputsJson: risk.fairInputsJson,
                    }}
                />
            )}

            {activeTab === 'bowtie' && <BowTiePanel riskId={riskId} />}

            {activeTab === 'history' && <RiskHistoryPanel riskId={riskId} />}

            {activeTab === 'overview' && (
                <>
            {/* Detail Card */}
            <div className={cn(cardVariants(), 'space-y-default')} id="risk-detail">
                {canWrite && (
                    <div className="flex justify-end -mt-1 -mb-2">
                        {/* B2 — icon-only edit affordance; opens the Edit
                            Risk modal, mirroring the control detail page. */}
                        <Tooltip content={td('editRisk')}>
                            <Button
                                variant="secondary"
                                size="icon"
                                onClick={startEditing}
                                id="edit-risk-btn"
                                aria-label={td('editRisk')}
                            >
                                <Pen2 className="size-4" />
                            </Button>
                        </Tooltip>
                    </div>
                )}
                {risk.description && (
                    <div>
                        <Eyebrow>{td('description')}</Eyebrow>
                        <p className="text-sm text-content-default whitespace-pre-wrap">{risk.description}</p>
                    </div>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                    <div>
                        <Eyebrow>{td('category')}</Eyebrow>
                        <p className="text-sm">{risk.category || '—'}</p>
                    </div>
                    <div>
                        <Eyebrow>{td('treatmentOwner')}</Eyebrow>
                        <p className="text-sm">{risk.treatmentOwner || '—'}</p>
                    </div>
                    <div>
                        <Eyebrow>{td('treatment')}</Eyebrow>
                        <p className="text-sm">{risk.treatment || td('untreated')}</p>
                    </div>
                    <div>
                        <Eyebrow>{td('targetDate')}</Eyebrow>
                        <p className="text-sm">{risk.targetDate ? formatDate(risk.targetDate) : '—'}</p>
                    </div>
                </div>

                <div className="grid grid-cols-3 gap-default">
                    <div className={cardVariants({ density: 'compact' })}>
                        <KPIStat value={risk.likelihood} label={td('likelihood')} size="sm" />
                    </div>
                    <div className={cardVariants({ density: 'compact' })}>
                        <KPIStat value={risk.impact} label={td('impact')} size="sm" />
                    </div>
                    <div className={cardVariants({ density: 'compact' })}>
                        <KPIStat
                            value={risk.inherentScore}
                            label={td('inherentScore')}
                            size="sm"
                            tone={risk.inherentScore > 12 ? 'critical' : risk.inherentScore > 5 ? 'attention' : 'success'}
                        />
                    </div>
                </div>

                {risk.threat && (
                    <div>
                        <Eyebrow>{td('threat')}</Eyebrow>
                        <p className="text-sm text-content-default">{risk.threat}</p>
                    </div>
                )}
                {risk.vulnerability && (
                    <div>
                        <Eyebrow>{td('vulnerability')}</Eyebrow>
                        <p className="text-sm text-content-default whitespace-pre-wrap">{risk.vulnerability}</p>
                    </div>
                )}
                {risk.treatmentNotes && (
                    <div>
                        <Eyebrow>{td('treatmentNotes')}</Eyebrow>
                        <p className="text-sm text-content-default whitespace-pre-wrap">{risk.treatmentNotes}</p>
                    </div>
                )}

                <div className="grid grid-cols-2 gap-default border-t border-border-subtle pt-4">
                    <div>
                        <Eyebrow>{td('nextReview')}</Eyebrow>
                        <p className={`text-sm ${overdue ? 'text-content-error font-semibold' : ''}`}>
                            {risk.nextReviewAt
                                ? `${overdue ? '! ' : ''}${formatDate(risk.nextReviewAt)}`
                                : '—'
                            }
                        </p>
                    </div>
                    <div>
                        <Eyebrow>{td('created')}</Eyebrow>
                        <p className="text-sm text-content-muted">{formatDate(risk.createdAt)}</p>
                    </div>
                </div>
            </div>

            {/* Epic G-7 — Risk Treatment Plan card. Owner-choices left
              * empty here (panel falls back to the current user as
              * the typed-in owner via the Combobox); the eventual
              * tenant-roster fetch is a bounded follow-up that will
              * wire admin/editor members through. */}
            <div className={cardVariants()}>
                <RiskTreatmentPlanCard
                    tenantSlug={tenant.tenantSlug}
                    riskId={riskId}
                    ownerChoices={[]}
                    canWrite={canWrite}
                    canAdmin={tenant.permissions.canAdmin}
                />
            </div>
                </>
            )}

            {/* Edit Risk modal — opened by the Overview-tab Edit button.
                Mirrors the control detail page's EditControlModal. */}
            {canWrite && (
                <EditRiskModal
                    open={editing}
                    setOpen={setEditing}
                    form={editForm}
                    setForm={setEditForm}
                    saving={saving}
                    error={error}
                    tenantSlug={tenant.tenantSlug}
                    categoryOptions={CATEGORY_OPTIONS}
                    treatmentOptions={TREATMENT_OPTIONS}
                    onCancel={() => setEditing(false)}
                    onSubmit={handleSave}
                />
            )}
        </EntityDetailLayout>
    );
}

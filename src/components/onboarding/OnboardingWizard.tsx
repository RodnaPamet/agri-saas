'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTenantContext, useTenantHref } from '@/lib/tenant-context-provider';
import { Combobox } from '@/components/ui/combobox';
import { Button } from '@/components/ui/button';
import { useEnterSubmit } from '@/components/ui/hooks';
import {
    Building2,
    ShieldCheck,
    AlertTriangle,
    Users,
    CheckCircle2,
    ChevronRight,
    ChevronLeft,
    Loader2,
    Save,
    Sparkles,
} from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { cn } from '@/lib/cn';

// ─── Step Definitions ───
//
// Elevation PR-6 — per-step gradient strings retired. Step icons
// render in the canonical state colours (muted at rest, brand when
// active, success when completed).
// The farm onboarding is intentionally minimal: just the company profile
// and the team. (The compliance-era steps — frameworks, assets, controls,
// risks, review — were dropped from the flow; their step-content
// components remain below but are no longer reachable.)
const STEPS = [
    { key: 'COMPANY_PROFILE', labelKey: 'stepCompanyProfile', icon: Building2 },
    { key: 'TEAM_SETUP', labelKey: 'stepTeam', icon: Users },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StepData = Record<string, any>;

interface OnboardingState {
    status: string;
    currentStep: string;
    completedSteps: string[];
    stepData: StepData;
    startedAt: string | null;
    completedAt: string | null;
}

// ─── API helpers ───

function apiUrl(tenantSlug: string, path: string) {
    return `/api/t/${tenantSlug}/onboarding/${path}`;
}

async function apiFetch<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        const msg = typeof err.error === 'string' ? err.error
            : typeof err.message === 'string' ? err.message
            : JSON.stringify(err.error ?? err);
        throw new Error(msg || `HTTP ${res.status}`);
    }
    return res.json();
}

// ─── Main Wizard Component ───

export default function OnboardingWizard() {
    const t = useTranslations('onboarding');
    const { tenantSlug, permissions } = useTenantContext();
    const tenantHref = useTenantHref();
    const router = useRouter();

    const [state, setState] = useState<OnboardingState | null>(null);
    const [activeStepIdx, setActiveStepIdx] = useState(0);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [localData, setLocalData] = useState<StepData>({});
    const [successBanner, setSuccessBanner] = useState(false);

    // ─── Load state ───
    const loadState = useCallback(async () => {
        if (!permissions.canAdmin) return;
        try {
            setLoading(true);
            const s = await apiFetch<OnboardingState>(apiUrl(tenantSlug, 'state'));
            setState(s);
            setLocalData((s.stepData as StepData) || {});

            // Set active step to current
            const idx = STEPS.findIndex(st => st.key === s.currentStep);
            if (idx >= 0) setActiveStepIdx(idx);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('errLoadState'));
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is a stable next-intl binding
    }, [tenantSlug, permissions.canAdmin]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { loadState(); }, [loadState]);

    // ─── Start onboarding ───
    const handleStart = async () => {
        try {
            setSaving(true);
            const s = await apiFetch<OnboardingState>(apiUrl(tenantSlug, 'start'), 'POST');
            setState(s);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('errStart'));
        } finally {
            setSaving(false);
        }
    };

    // ─── Save step data ───
    const handleSaveStep = async (step: StepKey, data: StepData) => {
        try {
            setSaving(true);
            setError(null);
            await apiFetch(apiUrl(tenantSlug, 'step'), 'POST', { step, action: 'save', data });
            setLocalData(prev => ({ ...prev, [step]: data }));
        } catch (e) {
            setError(e instanceof Error ? e.message : t('errSave'));
        } finally {
            setSaving(false);
        }
    };

    // ─── Complete step ───
    const handleCompleteStep = async (step: StepKey) => {
        try {
            setSaving(true);
            setError(null);
            // Save any local data first
            const stepLocalData = localData[step] || {};
            if (Object.keys(stepLocalData).length > 0) {
                await apiFetch(apiUrl(tenantSlug, 'step'), 'POST', { step, action: 'save', data: stepLocalData });
            }
            // Then complete
            const s = await apiFetch<OnboardingState>(apiUrl(tenantSlug, 'step'), 'POST', { step, action: 'complete' });
            setState(s);
            // Advance to next step
            const nextIdx = activeStepIdx + 1;
            if (nextIdx < STEPS.length) setActiveStepIdx(nextIdx);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('errCompleteStep'));
        } finally {
            setSaving(false);
        }
    };

    // ─── Finish ───
    const handleFinish = async () => {
        try {
            setSaving(true);
            setError(null);
            // Complete the last step first
            await apiFetch(apiUrl(tenantSlug, 'step'), 'POST', { step: 'REVIEW_AND_FINISH', action: 'complete' });
            await apiFetch(apiUrl(tenantSlug, 'finish'), 'POST');
            setSuccessBanner(true);
            setTimeout(() => {
                router.push(tenantHref('/dashboard'));
            }, 2000);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('errFinish'));
        } finally {
            setSaving(false);
        }
    };

    // ─── Save & exit ───
    const handleSaveAndExit = async () => {
        const currentStepKey = STEPS[activeStepIdx].key;
        const stepLocalData = localData[currentStepKey] || {};
        if (Object.keys(stepLocalData).length > 0) {
            await handleSaveStep(currentStepKey, stepLocalData);
        }
        router.push(tenantHref('/dashboard'));
    };

    // ─── Update local step data ───
    const updateStepData = (step: StepKey, data: StepData) => {
        setLocalData(prev => ({ ...prev, [step]: { ...(prev[step] || {}), ...data } }));
    };

    // ─── Admin guard (must be after all hooks) ───
    if (!permissions.canAdmin) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Card className="text-center max-w-md">
                    <ShieldCheck className="w-12 h-12 text-content-subtle mx-auto mb-4" />
                    <Heading level={2} className="text-content-emphasis mb-2">{t('accessRestricted')}</Heading>
                    <p className="text-sm text-content-muted">{t('accessRestrictedDesc')}</p>
                </Card>
            </div>
        );
    }

    // ─── Loading skeleton ───
    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                <div className="h-8 w-48 bg-bg-default rounded animate-pulse" />
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-section">
                    <div className="h-96 bg-bg-default/50 rounded-lg animate-pulse" />
                    <div className="lg:col-span-3 h-96 bg-bg-default/50 rounded-lg animate-pulse" />
                </div>
            </div>
        );
    }

    // ─── Success banner ───
    if (successBanner) {
        return (
            <div className="flex items-center justify-center min-h-[60vh] animate-fadeIn">
                <div className={cn(cardVariants({ density: 'spacious' }), 'text-center max-w-lg')}>
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-success-emphasis flex items-center justify-center">
                        <CheckCircle2 className="w-8 h-8 text-content-inverted" />
                    </div>
                    <Heading level={2} className="text-content-emphasis mb-2">{t('onboardingCompleteBang')}</Heading>
                    <p className="text-content-muted text-sm">{t('workspaceReady')}</p>
                    <div className="mt-4">
                        <Loader2 className="w-5 h-5 mx-auto text-brand-400 animate-spin" />
                    </div>
                </div>
            </div>
        );
    }

    // ─── Not started ───
    if (!state || state.status === 'NOT_STARTED') {
        return (
            <div className="flex items-center justify-center min-h-[60vh] animate-fadeIn">
                <div className={cn(cardVariants({ density: 'spacious' }), 'text-center max-w-lg')}>
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-[var(--brand-default)] flex items-center justify-center">
                        <Sparkles className="w-8 h-8 text-content-inverted" />
                    </div>
                    <Heading level={2} className="text-content-emphasis mb-2">{t('welcome')}</Heading>
                    <p className="text-content-muted text-sm mb-6">{t('welcomeDesc')}</p>
                    <Button variant="primary" size="lg" onClick={handleStart} disabled={saving}>
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                        {t('startSetup')}
                    </Button>
                </div>
            </div>
        );
    }

    // ─── Completed ───
    if (state.status === 'COMPLETED') {
        return (
            <div className="flex items-center justify-center min-h-[60vh] animate-fadeIn">
                <div className={cn(cardVariants({ density: 'spacious' }), 'text-center max-w-lg')}>
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-success-emphasis flex items-center justify-center">
                        <CheckCircle2 className="w-8 h-8 text-content-inverted" />
                    </div>
                    <Heading level={2} className="text-content-emphasis mb-2">{t('onboardingComplete')}</Heading>
                    <p className="text-content-muted text-sm mb-6">{t('onboardingCompleteDesc')}</p>
                    <Button variant="primary" size="lg" onClick={() => router.push(tenantHref('/dashboard'))}>
                        {t('goToDashboard')}
                    </Button>
                </div>
            </div>
        );
    }

    const currentStep = STEPS[activeStepIdx];
    const isComplete = (key: string) => state.completedSteps.includes(key);
    const isLast = activeStepIdx === STEPS.length - 1;

    return (
        <div className="space-y-default animate-fadeIn" data-testid="onboarding-wizard">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-compact">
                <div>
                    <Heading level={1}>{t('setupWizard')}</Heading>
                    <p className="text-content-muted text-sm mt-1">{t('setupWizardDesc')}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={handleSaveAndExit}>
                    <Save className="w-3.5 h-3.5" /> {t('saveAndExit')}
                </Button>
            </div>

            {error && (
                <div className={cn(cardVariants({ density: 'compact' }), 'border-border-error text-sm text-content-error flex items-center gap-tight')}>
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    {error}
                    <button onClick={() => setError(null)} className="ml-auto text-content-error hover:text-content-emphasis text-xs">&times;</button>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-section">
                {/* ─── Progress Sidebar ─── */}
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')}>
                    <div className="p-4 border-b border-border-subtle">
                        <p className="text-xs text-content-muted font-medium uppercase tracking-wider">{t('progress')}</p>
                        <div className="flex items-center gap-tight mt-2">
                            <div className="flex-1 bg-bg-default rounded-full h-2 overflow-hidden">
                                <div className="h-full bg-[var(--brand-default)] rounded-full transition-all duration-500"
                                    style={{ width: `${(state.completedSteps.length / STEPS.length) * 100}%` }} />
                            </div>
                            <span className="text-xs text-content-muted font-medium">{state.completedSteps.length}/{STEPS.length}</span>
                        </div>
                    </div>
                    <nav className="p-2">
                        {STEPS.map((step, i) => {
                            const Icon = step.icon;
                            const completed = isComplete(step.key);
                            const active = i === activeStepIdx;
                            return (
                                <button key={step.key}
                                    onClick={() => setActiveStepIdx(i)}
                                    data-testid={`step-nav-${step.key}`}
                                    className={`w-full flex items-center gap-compact px-3 py-2.5 rounded-lg text-sm transition-colors duration-150 ease-out ${
                                        active ? 'bg-brand-subtle text-content-emphasis font-medium' : 'text-content-muted hover:text-content-emphasis hover:bg-bg-muted/50'
                                    }`}
                                >
                                    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                                        completed ? 'bg-bg-success' : active ? `bg-[var(--brand-default)]` : 'bg-bg-muted/50'
                                    }`}>
                                        {completed ? (
                                            <CheckCircle2 className="w-4 h-4 text-content-success" />
                                        ) : (
                                            <Icon className={`w-3.5 h-3.5 ${active ? 'text-content-inverted' : 'text-content-subtle'}`} />
                                        )}
                                    </div>
                                    <span className="truncate">{t(step.labelKey)}</span>
                                    {active && <ChevronRight className="w-3.5 h-3.5 ml-auto text-content-subtle" />}
                                </button>
                            );
                        })}
                    </nav>
                </div>

                {/* ─── Step Content ─── */}
                <div className="lg:col-span-3">
                    <div className={cardVariants({ density: 'none' })}>
                        <div className="p-5 border-b border-border-subtle flex items-center gap-compact">
                            <div className={`w-9 h-9 rounded-full bg-[var(--brand-default)] flex items-center justify-center`}>
                                <currentStep.icon className="w-4.5 h-4.5 text-content-inverted" />
                            </div>
                            <div>
                                <Heading level={2} className="text-content-emphasis">{t(currentStep.labelKey)}</Heading>
                                <p className="text-xs text-content-muted">{t('stepXofY', { current: activeStepIdx + 1, total: STEPS.length })}</p>
                            </div>
                            {isComplete(currentStep.key) && (
                                <StatusBadge variant="success" className="ml-auto">{t('completed')}</StatusBadge>
                            )}
                        </div>
                        <div className="p-5">
                            <StepContent
                                step={currentStep.key}
                                data={localData[currentStep.key] || {}}
                                onUpdate={(data) => updateStepData(currentStep.key, data)}
                                completedSteps={state.completedSteps}
                                allData={localData}
                            />
                        </div>
                        {/* Navigation footer */}
                        <div className="p-4 border-t border-border-subtle flex items-center justify-between gap-compact">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setActiveStepIdx(Math.max(0, activeStepIdx - 1))}
                                disabled={activeStepIdx === 0}
                            >
                                <ChevronLeft className="w-3.5 h-3.5" /> {t('back')}
                            </Button>
                            <div className="flex items-center gap-tight">
                                {!isLast && (
                                    <Button
                                        variant="primary"
                                        onClick={() => handleCompleteStep(currentStep.key)}
                                        disabled={saving}
                                    >
                                        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                                        {t('continue')} <ChevronRight className="w-3.5 h-3.5" />
                                    </Button>
                                )}
                                {isLast && (
                                    <Button
                                        variant="primary"
                                        size="lg"
                                        onClick={handleFinish}
                                        disabled={saving}
                                    >
                                        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                        {t('completeSetup')}
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Step Content Components ───

function StepContent({ step, data, onUpdate, completedSteps, allData }: {
    // Loose string (not the narrowed StepKey) so the switch can keep cases
    // for the retired steps whose content components still live below.
    step: string;
    data: StepData;
    onUpdate: (d: StepData) => void;
    completedSteps: string[];
    allData: StepData;
}) {
    const t = useTranslations('onboarding');
    switch (step) {
        case 'COMPANY_PROFILE': return <CompanyProfileStep data={data} onUpdate={onUpdate} />;
        case 'FRAMEWORK_SELECTION': return <FrameworkSelectionStep data={data} onUpdate={onUpdate} />;
        case 'CONTROL_BASELINE_INSTALL': return <ControlInstallStep data={data} onUpdate={onUpdate} allData={allData} />;
        case 'TEAM_SETUP': return <TeamSetupStep data={data} onUpdate={onUpdate} />;
        case 'REVIEW_AND_FINISH': return <ReviewStep completedSteps={completedSteps} allData={allData} />;
        default: return <p className="text-content-muted">{t('unknownStep')}</p>;
    }
}

// ─── COMPANY_PROFILE ───

function CompanyProfileStep({ data, onUpdate }: { data: StepData; onUpdate: (d: StepData) => void }) {
    const t = useTranslations('onboarding');
    const industryOptions = [
        { value: 'technology', label: t('industryTechnology') },
        { value: 'finance', label: t('industryFinance') },
        { value: 'healthcare', label: t('industryHealthcare') },
        { value: 'manufacturing', label: t('industryManufacturing') },
        { value: 'government', label: t('industryGovernment') },
        { value: 'energy', label: t('industryEnergy') },
        { value: 'retail', label: t('industryRetail') },
        { value: 'other', label: t('industryOther') },
    ];
    const sizeOptions = [
        { value: '1-50', label: t('size1') },
        { value: '51-200', label: t('size2') },
        { value: '201-1000', label: t('size3') },
        { value: '1000+', label: t('size4') },
    ];
    return (
        <div className="space-y-default max-w-lg animate-fadeIn">
            <p className="text-sm text-content-muted mb-4">{t('companyProfileIntro')}</p>
            <div>
                <label className="input-label">{t('companyName')}</label>
                <input className="input" placeholder={t('companyNamePlaceholder')} value={data.name || ''}
                    onChange={(e) => onUpdate({ name: e.target.value })} data-testid="company-name" />
            </div>
            <div>
                <label className="input-label">{t('industry')}</label>
                <Combobox
                    hideSearch
                    selected={industryOptions.find(o => o.value === (data.industry || '')) ?? null}
                    setSelected={(opt) => onUpdate({ industry: opt?.value ?? '' })}
                    options={industryOptions}
                    placeholder={t('selectIndustry')}
                    matchTriggerWidth
                />
            </div>
            <div className="grid grid-cols-2 gap-compact">
                <div>
                    <label className="input-label">{t('country')}</label>
                    <input className="input" placeholder={t('countryPlaceholder')} value={data.country || ''}
                        onChange={(e) => onUpdate({ country: e.target.value })} />
                </div>
                <div>
                    <label className="input-label">{t('companySize')}</label>
                    <Combobox
                        hideSearch
                        selected={sizeOptions.find(o => o.value === (data.size || '')) ?? null}
                        setSelected={(opt) => onUpdate({ size: opt?.value ?? '' })}
                        options={sizeOptions}
                        placeholder={t('selectPlaceholder')}
                        matchTriggerWidth
                    />
                </div>
            </div>
        </div>
    );
}

// ─── FRAMEWORK_SELECTION ───

function FrameworkSelectionStep({ data, onUpdate }: { data: StepData; onUpdate: (d: StepData) => void }) {
    const t = useTranslations('onboarding');
    const frameworks = [
        { key: 'iso27001', name: t('fwIso'), desc: t('fwIsoDesc'), badge: t('fwIsoBadge') },
        { key: 'nis2', name: t('fwNis2'), desc: t('fwNis2Desc'), badge: t('fwNis2Badge') },
    ];
    const selected: string[] = data.selectedFrameworks || [];

    const toggle = (key: string) => {
        const next = selected.includes(key) ? selected.filter(s => s !== key) : [...selected, key];
        onUpdate({ selectedFrameworks: next });
    };

    return (
        <div className="space-y-default animate-fadeIn">
            <p className="text-sm text-content-muted mb-4">{t('frameworkIntro')}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                {frameworks.map(fw => {
                    const active = selected.includes(fw.key);
                    return (
                        <button key={fw.key} onClick={() => toggle(fw.key)} data-testid={`fw-${fw.key}`}
                            className={`text-left p-4 rounded-lg border-2 transition-colors duration-150 ease-out ${
                                active ? 'border-[var(--brand-default)] bg-brand-subtle' : 'border-border-subtle bg-bg-default/30 hover:border-border-default'
                            }`}
                        >
                            <div className="flex items-center justify-between mb-2">
                                <span className="font-semibold text-content-emphasis text-sm">{fw.name}</span>
                                {fw.badge && <StatusBadge variant="info" size="sm">{fw.badge}</StatusBadge>}
                            </div>
                            <p className="text-xs text-content-muted leading-relaxed">{fw.desc}</p>
                            {active && <div className="mt-2 flex items-center gap-1 text-brand-400 text-xs font-medium"><CheckCircle2 className="w-3.5 h-3.5" /> {t('selected')}</div>}
                        </button>
                    );
                })}
            </div>
            {selected.length === 0 && <p className="text-xs text-content-warning">{t('selectAtLeastOne')}</p>}
        </div>
    );
}

// ─── CONTROL_BASELINE_INSTALL ───

function ControlInstallStep({ data, onUpdate, allData }: { data: StepData; onUpdate: (d: StepData) => void; allData: StepData }) {
    const t = useTranslations('onboarding');
    const selectedFrameworks: string[] = allData['FRAMEWORK_SELECTION']?.selectedFrameworks || [];
    const fwLabels: Record<string, string> = { iso27001: t('fwIso'), nis2: t('fwNis2') };

    return (
        <div className="space-y-default max-w-lg animate-fadeIn">
            <p className="text-sm text-content-muted mb-4">{t('controlIntro')}</p>
            {selectedFrameworks.length === 0 ? (
                <InlineNotice variant="warning" icon={null}>
                    {t('noFrameworksSelected')}
                </InlineNotice>
            ) : (
                <div className="space-y-compact">
                    {selectedFrameworks.map(fw => (
                        <div key={fw} className="flex items-center gap-compact p-3 bg-bg-default/50 rounded-lg">
                            <ShieldCheck className="w-5 h-5 text-brand-400" />
                            <div>
                                <span className="text-sm font-medium text-content-emphasis">{fwLabels[fw] || fw}</span>
                                <p className="text-xs text-content-subtle">{t('baselineInstalled')}</p>
                            </div>
                            <CheckCircle2 className="w-4 h-4 text-content-success ml-auto" />
                        </div>
                    ))}
                </div>
            )}
            <label className="flex items-center gap-tight text-sm text-content-default cursor-pointer">
                <input type="checkbox" checked={data.confirmed || false} onChange={(e) => onUpdate({ confirmed: e.target.checked })}
                    className="w-4 h-4 rounded border-border-default bg-bg-default text-brand-500 focus:ring-brand-500" />
                {t('confirmBaseline')}
            </label>
        </div>
    );
}

// ─── TEAM_SETUP ───

function TeamSetupStep({ data, onUpdate }: { data: StepData; onUpdate: (d: StepData) => void }) {
    const t = useTranslations('onboarding');
    const emails: string[] = data.inviteEmails || [];
    const [newEmail, setNewEmail] = useState('');

    const addEmail = () => {
        const email = newEmail.trim().toLowerCase();
        if (email && email.includes('@') && !emails.includes(email)) {
            onUpdate({ inviteEmails: [...emails, email] });
            setNewEmail('');
        }
    };

    // Epic 60 — same Enter-submit story as the asset input above.
    const { handleKeyDown: emailKeyDown } = useEnterSubmit({ onSubmit: addEmail });

    const removeEmail = (email: string) => {
        onUpdate({ inviteEmails: emails.filter(e => e !== email) });
    };

    return (
        <div className="space-y-default max-w-lg animate-fadeIn">
            <p className="text-sm text-content-muted mb-4">{t('teamIntro')}</p>
            <div className="flex gap-tight">
                <input className="input flex-1" placeholder={t('emailPlaceholder')} type="email" value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)} onKeyDown={emailKeyDown} data-testid="invite-email" />
                <Button variant="primary" onClick={addEmail}>{t('invite')}</Button>
            </div>
            {emails.length > 0 && (
                <div className="space-y-1">
                    {emails.map(e => (
                        <div key={e} className="flex items-center justify-between bg-bg-default/50 rounded-lg px-3 py-2 text-sm">
                            <div className="flex items-center gap-tight">
                                <Users className="w-3.5 h-3.5 text-content-subtle" />
                                <span className="text-content-emphasis">{e}</span>
                            </div>
                            <button onClick={() => removeEmail(e)} className="text-content-subtle hover:text-content-error text-xs">&times;</button>
                        </div>
                    ))}
                </div>
            )}
            <p className="text-xs text-content-subtle">{t('teamHint')}</p>
        </div>
    );
}

// ─── REVIEW_AND_FINISH ───

function ReviewStep({ completedSteps, allData }: { completedSteps: string[]; allData: StepData }) {
    const t = useTranslations('onboarding');
    const summaryItems = [
        { key: 'COMPANY_PROFILE', label: t('summaryCompanyProfile'), detail: allData['COMPANY_PROFILE']?.name || t('detailNotConfigured') },
        { key: 'FRAMEWORK_SELECTION', label: t('summaryFrameworks'), detail: (allData['FRAMEWORK_SELECTION']?.selectedFrameworks || []).join(', ') || t('detailNoneSelected') },
        { key: 'ASSET_SETUP', label: t('summaryAssets'), detail: t('detailAssetsAdded', { count: (allData['ASSET_SETUP']?.assets || []).length }) },
        { key: 'CONTROL_BASELINE_INSTALL', label: t('summaryControls'), detail: allData['CONTROL_BASELINE_INSTALL']?.confirmed ? t('detailBaselineConfirmed') : t('detailPendingConfirmation') },
        { key: 'TEAM_SETUP', label: t('summaryTeam'), detail: t('detailInvitationsPending', { count: (allData['TEAM_SETUP']?.inviteEmails || []).length }) },
    ];

    return (
        <div className="space-y-default animate-fadeIn">
            <p className="text-sm text-content-muted mb-4">{t('reviewIntro')}</p>
            <div className="space-y-tight">
                {summaryItems.map(item => {
                    const done = completedSteps.includes(item.key);
                    return (
                        <div key={item.key} className="flex items-center gap-compact p-3 bg-bg-default/30 rounded-lg" data-testid={`review-${item.key}`}>
                            {done ? (
                                <CheckCircle2 className="w-5 h-5 text-content-success flex-shrink-0" />
                            ) : (
                                <div className="w-5 h-5 rounded-full border-2 border-border-default flex-shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                                <span className="text-sm font-medium text-content-emphasis">{item.label}</span>
                                <p className="text-xs text-content-subtle truncate">{item.detail}</p>
                            </div>
                        </div>
                    );
                })}
            </div>
            <InlineNotice variant="success" icon={null}>
                {t('reviewNotice')}
            </InlineNotice>
        </div>
    );
}

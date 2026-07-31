'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Heading } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function InstallWizardPage() {
    const t = useTranslations('frameworks');
    const params = useParams();
    const searchParams = useSearchParams();
    const tenantSlug = params.tenantSlug as string;
    const frameworkKey = params.frameworkKey as string;
    const requestedPack = searchParams.get('pack');
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);
    const tenantHref = useCallback((path: string) => `/t/${tenantSlug}${path}`, [tenantSlug]);

    const [framework, setFramework] = useState<any>(null);
    const [packs, setPacks] = useState<any[]>([]);
    const [selectedPack, setSelectedPack] = useState<string>('');
    const [preview, setPreview] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [installing, setInstalling] = useState(false);
    const [result, setResult] = useState<any>(null);
    const [error, setError] = useState('');

    // Step: 'select' | 'preview' | 'done'
    const [step, setStep] = useState<'select' | 'preview' | 'done'>('select');

    useEffect(() => {
        (async () => {
            try {
                const [fwRes, packRes] = await Promise.all([
                    fetch(apiUrl(`/frameworks/${frameworkKey}`)),
                    fetch(apiUrl(`/frameworks/${frameworkKey}?action=packs`)),
                ]);
                if (fwRes.ok) setFramework(await fwRes.json());
                if (packRes.ok) {
                    const ps = await packRes.json();
                    setPacks(ps);
                    // Auto-select if only one pack or requested
                    if (requestedPack) {
                        setSelectedPack(requestedPack);
                    } else if (ps.length === 1) {
                        setSelectedPack(ps[0].key);
                    }
                }
            } catch { /* ignore */ }
            setLoading(false);
        })();
    }, [apiUrl, frameworkKey, requestedPack]);

    // Fetch preview when pack selected
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (!selectedPack) { setPreview(null); return; }
        fetch(apiUrl(`/frameworks/${frameworkKey}?action=preview&packKey=${selectedPack}`))
            .then(r => r.ok ? r.json() : null)
            .then(p => { setPreview(p); if (p) setStep('preview'); });
    }, [selectedPack, apiUrl, frameworkKey]);

    const handleInstall = async () => {
        setInstalling(true);
        setError('');
        try {
            const res = await fetch(apiUrl(`/frameworks/${frameworkKey}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ packKey: selectedPack }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Install failed' }));
                setError(err.error || err.message || 'Install failed');
                return;
            }
            const data = await res.json();
            setResult(data);
            setStep('done');
        } catch (e: any) {
            setError(e.message || 'Network error');
        } finally {
            setInstalling(false);
        }
    };

    if (loading) return <div className="p-8 animate-pulse text-content-muted">{t('loadingWizard')}</div>;
    if (!framework) return <div className="p-8 text-content-error">{t('errorNotFound')}</div>;

    return (
        <div className="max-w-2xl mx-auto space-y-section">
            {/* Header */}
            <div>
                <Link href={tenantHref(`/frameworks/${frameworkKey}`)} className="text-content-muted hover:text-content-emphasis transition-colors text-sm">
                    ← {t('backToFramework', { name: framework.name })}
                </Link>
                <Heading level={1} className="mt-2" id="install-wizard-heading">
                    {t('installHeading', { name: framework.name })}
                </Heading>
                <p className="text-sm text-content-muted mt-1">
                    {t('installIntro')}
                </p>
            </div>

            {/* Step indicator */}
            <div className="flex items-center gap-tight text-xs">
                {[t('stepSelectPack'), t('stepPreview'), t('stepInstall')].map((s, i) => (
                    <div key={s} className="flex items-center gap-tight">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${i === 0 && step === 'select' ? 'bg-brand-600 text-content-emphasis' :
                                i === 1 && step === 'preview' ? 'bg-brand-600 text-content-emphasis' :
                                    i === 2 && step === 'done' ? 'bg-bg-success-emphasis text-content-inverted' :
                                        step === 'done' || (step === 'preview' && i === 0) ? 'bg-bg-success text-content-success' :
                                            'bg-bg-elevated text-content-subtle'
                            }`}>{i + 1}</div>
                        <span className="text-content-muted">{s}</span>
                        {i < 2 && <span className="text-content-subtle">→</span>}
                    </div>
                ))}
            </div>

            {/* Step 1: Select Pack */}
            {step === 'select' && (
                <div className={cn(cardVariants({ density: 'none' }), 'space-y-default')}>
                    <Heading level={2}>{t('selectPackHeading')}</Heading>
                    {packs.length === 0 ? (
                        <p className="text-content-subtle">{t('packsEmpty')}</p>
                    ) : (
                        <div className="space-y-tight">
                            {packs.map(p => (
                                <label key={p.key} className={`flex items-center gap-compact p-3 rounded-lg border cursor-pointer transition-colors ${selectedPack === p.key ? 'border-[var(--brand-default)] bg-[var(--brand-subtle)]' : 'border-border-default hover:border-border-emphasis'
                                    }`}>
                                    <input
                                        type="radio"
                                        name="pack"
                                        value={p.key}
                                        checked={selectedPack === p.key}
                                        onChange={() => setSelectedPack(p.key)}
                                        className="accent-[var(--brand-default)]"
                                    />
                                    <div>
                                        <div className="text-sm font-medium text-content-emphasis">{p.name}</div>
                                        <div className="text-xs text-content-subtle">{t('packTemplatesVersion', { count: p._count?.templateLinks || 0, version: p.version || 'latest' })}</div>
                                    </div>
                                </label>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Step 2: Preview */}
            {step === 'preview' && preview && (
                <div className="space-y-default">
                    <div className={cardVariants({ density: 'none' })}>
                        <Heading level={2} className="mb-4">{t('installPreviewHeading')}</Heading>
                        <div className="grid grid-cols-3 gap-default mb-4">
                            <div className="p-3 rounded-lg bg-bg-default/50">
                                <KPIStat id="preview-new-controls" value={preview.newControls} label={t('previewNewControls')} />
                            </div>
                            <div className="p-3 rounded-lg bg-bg-default/50">
                                <KPIStat value={preview.existingControls} label={t('previewAlreadyExist')} tone="attention" />
                            </div>
                            <div className="p-3 rounded-lg bg-bg-default/50">
                                <KPIStat value={preview.totalTemplates} label={t('previewTotalTemplates')} />
                            </div>
                        </div>

                        {/* Template list */}
                        <div className="max-h-64 overflow-y-auto space-y-1 border-t border-border-default/50 pt-3">
                            {preview.templates?.map((tpl: any) => (
                                <div key={tpl.code} className="flex items-center gap-compact px-3 py-1.5 rounded-md text-sm">
                                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${tpl.alreadyInstalled ? 'bg-bg-success-emphasis' : 'bg-[var(--brand-default)]'}`} />
                                    <code className="text-xs text-content-subtle font-mono w-24 flex-shrink-0">{tpl.code}</code>
                                    <span className="text-content-default flex-1">{tpl.title}</span>
                                    {tpl.alreadyInstalled && <span className="text-xs text-content-success">{t('exists')}</span>}
                                    {!tpl.alreadyInstalled && <span className="text-xs text-[var(--brand-default)]">{t('tasksCount', { count: tpl.tasks })}</span>}
                                </div>
                            ))}
                        </div>
                    </div>

                    {error && (
                        <div className={cn(cardVariants({ density: 'none' }), 'border-border-error bg-bg-error text-content-error text-sm')}>{error}</div>
                    )}

                    <div className="flex gap-compact">
                        <Button variant="secondary" onClick={() => { setStep('select'); setSelectedPack(''); }}>
                            ← {t('back')}
                        </Button>
                        <Button
                            variant="primary"
                            className="flex-1"
                            onClick={handleInstall}
                            disabled={installing || preview.newControls === 0}
                            id="confirm-install-btn"
                        >
                            {installing ? (
                                <span className="flex items-center gap-tight">
                                    {t('installing')}
                                </span>
                            ) : preview.newControls === 0 ? (
                                t('allControlsInstalled')
                            ) : (
                                t('installNControls', { count: preview.newControls })
                            )}
                        </Button>
                    </div>
                </div>
            )}

            {/* Step 3: Done */}
            {step === 'done' && result && (
                <div className={cn(cardVariants({ density: 'none' }), 'text-center space-y-default')} id="install-result">
                    <div className="text-4xl"></div>
                    <Heading level={1}>{t('packInstalledSuccess')}</Heading>
                    <div className="grid grid-cols-3 gap-default">
                        <div className="p-3 rounded-lg bg-bg-success">
                            <KPIStat id="result-controls" value={result.controlsCreated} label={t('resultControlsCreated')} tone="success" />
                        </div>
                        <div className="p-3 rounded-lg bg-[var(--brand-subtle)]">
                            <KPIStat id="result-tasks" value={result.tasksCreated} label={t('resultTasksCreated')} />
                        </div>
                        <div className="p-3 rounded-lg bg-bg-info/40">
                            <KPIStat id="result-mappings" value={result.mappingsCreated} label={t('resultMappingsCreated')} />
                        </div>
                    </div>
                    <div className="flex gap-compact justify-center">
                        <Link href={tenantHref('/controls')} className={buttonVariants({ variant: 'primary' })} id="go-to-controls">
                            {t('viewControls')} →
                        </Link>
                        <Link href={tenantHref(`/frameworks/${frameworkKey}`)} className={buttonVariants({ variant: 'secondary' })}>
                            {t('backToFrameworkLink')}
                        </Link>
                    </div>
                </div>
            )}
        </div>
    );
}

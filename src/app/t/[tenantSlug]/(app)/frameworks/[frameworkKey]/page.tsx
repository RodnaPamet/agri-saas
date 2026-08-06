'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { RequirePermission } from '@/components/require-permission';
import { ProgressBar } from '@/components/ui/progress-bar';
import { FrameworkExplorer } from '@/components/frameworks/FrameworkExplorer';
import { FrameworkBuilder } from '@/components/ui/FrameworkBuilder';
import { buttonVariants } from '@/components/ui/button-variants';
import { useCelebration } from '@/components/ui/hooks';
import { MILESTONES, scopedMilestone } from '@/lib/celebrations';
import type { FrameworkTreePayload } from '@/lib/framework-tree/types';
import { Heading, Caption } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { MetaStrip } from '@/components/ui/meta-strip';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

type Tab = 'requirements' | 'packs' | 'coverage' | 'builder';

export default function FrameworkDetailPage() {
    const t = useTranslations('frameworks');
    const params = useParams();
    const tenantSlug = params.tenantSlug as string;
    const frameworkKey = params.frameworkKey as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);
    const tenantHref = useCallback((path: string) => `/t/${tenantSlug}${path}`, [tenantSlug]);

    const [activeTab, setActiveTab] = useState<Tab>('requirements');
    const [framework, setFramework] = useState<any>(null);
    const [tree, setTree] = useState<FrameworkTreePayload | null>(null);
    const [packs, setPacks] = useState<any[]>([]);
    const [coverage, setCoverage] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Epic 62 — celebrate when this framework is fully SATISFIED.
    //
    // This fired on `coveragePercent`, which counts requirements a control row
    // links to — so installing a starter pack set off the confetti on a farm
    // with zero records, congratulating a farmer for pressing Install. The
    // milestone now waits for approved evidence against every applicable
    // control point, which is the thing actually worth celebrating.
    // `scopedMilestone` namespaces the dedupe key per framework so
    // each framework's first reach earns its own moment in the same
    // session (otherwise a single global `framework-100` key would
    // mean only the first framework ever celebrates).
    const { celebrate } = useCelebration();
    useEffect(() => {
        if (coverage?.satisfiedPercent !== 100) return;
        const baseDescription = MILESTONES['framework-100'].description ?? '';
        celebrate(
            scopedMilestone('framework-100', frameworkKey, {
                descriptionOverride: framework?.name
                    ? `${framework.name} — ${baseDescription}`.trim()
                    : undefined,
            }),
        );
    }, [coverage?.satisfiedPercent, frameworkKey, framework?.name, celebrate]);

    useEffect(() => {
        // Epic 46 — fetch the new `/tree` endpoint instead of the
        // flat `?action=requirements` payload. The tree endpoint
        // already includes the `framework` descriptor, so the
        // separate `getFramework` call only stays around to keep the
        // header rendering identical (it carries no data the tree
        // doesn't, but `<FrameworkExplorer>` shouldn't be the source
        // of truth for the page title).
        (async () => {
            setError(null);
            try {
                const [fwRes, treeRes, packRes, covRes] = await Promise.all([
                    fetch(apiUrl(`/frameworks/${frameworkKey}`)),
                    fetch(apiUrl(`/frameworks/${frameworkKey}/tree`)),
                    fetch(apiUrl(`/frameworks/${frameworkKey}?action=packs`)),
                    fetch(apiUrl(`/frameworks/${frameworkKey}?action=coverage`)),
                ]);
                if (fwRes.ok) setFramework(await fwRes.json());
                if (treeRes.ok) setTree((await treeRes.json()) as FrameworkTreePayload);
                else if (treeRes.status === 404) setError(t('errorNotFound'));
                if (packRes.ok) setPacks(await packRes.json());
                if (covRes.ok) setCoverage(await covRes.json());
            } catch {
                setError('Failed to load framework');
            }
            setLoading(false);
        })();
    }, [apiUrl, frameworkKey]);

    const breadcrumbs = [
        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
        { label: t('breadcrumbFrameworks'), href: tenantHref('/frameworks') },
        { label: framework?.name ?? frameworkKey },
    ];
    if (loading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (error || !framework) {
        return (
            <EntityDetailLayout error={error ?? t('errorNotFound')} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const tabs: { key: Tab; label: string; count?: number }[] = [
        { key: 'requirements', label: t('tabRequirements'), count: tree?.totals.requirements },
        { key: 'packs', label: t('tabPacks'), count: packs.length },
        { key: 'coverage', label: t('tabCoverage') },
        // Epic 46.4 — builder MVP. Permission-gated below by
        // wrapping the panel in <RequirePermission>; the tab itself
        // stays visible so non-admins see it exists.
        { key: 'builder', label: t('tabBuilder') },
    ];

    async function handleReorderSave(body: { sections: { sectionId: string; requirementIds: string[] }[] }) {
        const res = await fetch(apiUrl(`/frameworks/${frameworkKey}/reorder`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(j.error ?? `Reorder failed (${res.status})`);
        }
        // Refetch the tree so the explorer reflects the new order.
        const fresh = await fetch(apiUrl(`/frameworks/${frameworkKey}/tree`));
        if (fresh.ok) setTree((await fresh.json()) as FrameworkTreePayload);
    }

    return (
        <EntityDetailLayout
            id="framework-detail-page"
            breadcrumbs={breadcrumbs}

            title={<span id="framework-detail-heading">{framework.name}</span>}
            meta={
                <MetaStrip
                    items={[
                        ...(framework.version
                            ? [
                                  {
                                      kind: 'status' as const,
                                      label: t('metaVersion'),
                                      value: `v${framework.version}`,
                                      variant: 'info' as const,
                                  },
                              ]
                            : []),
                        ...(framework.kind
                            ? [
                                  {
                                      label: t('metaKind'),
                                      value: framework.kind.replace('_', ' '),
                                  } as const,
                              ]
                            : []),
                    ]}
                />
            }
            actions={
                <>
                    <Link href={tenantHref(`/frameworks/${frameworkKey}/templates`)} className={buttonVariants({ variant: 'secondary' })} id="browse-templates-cta">
                        {t('browseTemplates')}
                    </Link>
                    <RequirePermission resource="frameworks" action="install">
                        <Link href={tenantHref(`/frameworks/${frameworkKey}/install`)} className={buttonVariants({ variant: 'primary' })} id="install-pack-cta">
                            {t('installPack')}
                        </Link>
                    </RequirePermission>
                </>
            }
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(next) => setActiveTab(next as Tab)}
        >
            {framework.description && <Caption className="-mt-2">{framework.description}</Caption>}

            {/* Requirements Tab — Epic 46 tree explorer */}
            {activeTab === 'requirements' && (
                <div id="requirements-panel">
                    {tree ? (
                        <FrameworkExplorer tree={tree} coverage={coverage ?? null} />
                    ) : (
                        <div className={cn(cardVariants({ density: 'none' }), 'text-center py-10 text-content-subtle')}>
                            {t('loadingTree')}
                        </div>
                    )}
                </div>
            )}

            {/* Packs Tab */}
            {activeTab === 'packs' && (
                <div className="space-y-default" id="packs-panel">
                    {packs.map((p: any) => (
                        <div key={p.id} className={cardVariants({ density: 'none' })}>
                            <div className="flex items-start justify-between">
                                <div>
                                    <Heading level={2}>{p.name}</Heading>
                                    {p.description && <p className="text-sm text-content-muted mt-1">{p.description}</p>}
                                    <div className="flex items-center gap-compact mt-2 text-xs text-content-subtle">
                                        <span>{t('templatesCount', { count: p._count?.templateLinks || 0 })}</span>
                                        {p.version && <span>v{p.version}</span>}
                                    </div>
                                </div>
                                <RequirePermission resource="frameworks" action="install">
                                    <Link
                                        href={tenantHref(`/frameworks/${frameworkKey}/install?pack=${p.key}`)}
                                        className={buttonVariants({ variant: 'primary' })}
                                        id={`install-pack-${p.key}`}
                                    >
                                        {t('installPack')}
                                    </Link>
                                </RequirePermission>
                            </div>
                        </div>
                    ))}
                    {packs.length === 0 && (
                        <div className={cn(cardVariants({ density: 'none' }), 'text-center py-8 text-content-subtle')}>{t('packsEmpty')}</div>
                    )}
                </div>
            )}

            {/* Coverage Tab */}
            {activeTab === 'coverage' && coverage && (
                <div className="space-y-default" id="coverage-panel">
                    {/* Summary cards — Polish PR-2: KPIStat primitive. */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-default">
                        <div className={cardVariants({ density: 'none' })}>
                            <KPIStat value={coverage.total} label={t('kpiTotalRequirements')} />
                        </div>
                        <div className={cardVariants({ density: 'none' })}>
                            <KPIStat value={coverage.mapped} label={t('kpiMapped')} tone="success" />
                        </div>
                        <div className={cardVariants({ density: 'none' })}>
                            <KPIStat
                                value={coverage.unmapped}
                                label={t('kpiUnmapped')}
                                tone={coverage.unmapped > 0 ? 'attention' : 'success'}
                            />
                        </div>
                    </div>

                    {/* Coverage donut */}
                    <div className={cardVariants({ density: 'none' })}>
                        <div className="flex items-center justify-between mb-4">
                            <Heading level={2}>{t('overallCoverage')}</Heading>
                            <span className={`text-xl font-semibold tabular-nums ${coverage.coveragePercent === 100 ? 'text-content-success' : 'text-[var(--brand-default)]'}`}>
                                {coverage.coveragePercent}%
                            </span>
                        </div>
                        <ProgressBar
                            value={coverage.coveragePercent}
                            size="sm"
                            variant={coverage.coveragePercent === 100 ? 'success' : 'brand'}
                            aria-label={t('frameworkCoverageAria')}
                        />
                    </div>

                    {/* Section breakdown */}
                    {coverage.bySection?.length > 0 && (
                        <div className={cardVariants({ density: 'none' })}>
                            <Heading level={3} className="mb-3">{t('coverageBySection')}</Heading>
                            <div className="space-y-compact">
                                {coverage.bySection.map((s: any) => (
                                    <div key={s.section}>
                                        <div className="flex items-center justify-between text-xs mb-1">
                                            <span className="text-content-default">{s.section}</span>
                                            <span className="text-content-muted">{s.mapped}/{s.total} ({s.coveragePercent}%)</span>
                                        </div>
                                        <ProgressBar
                                            value={s.coveragePercent}
                                            size="sm"
                                            variant={
                                                s.coveragePercent === 100
                                                    ? 'success'
                                                    : s.coveragePercent > 0
                                                        ? 'brand'
                                                        : 'neutral'
                                            }
                                            aria-label={t('sectionCoverageAria', { section: s.section })}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Unmapped requirements */}
                    {coverage.unmappedRequirements?.length > 0 && (
                        <div className={cardVariants({ density: 'none' })}>
                            <Heading level={3} className="text-content-warning mb-3">
                                {t('unmappedRequirementsHeading', { count: coverage.unmappedRequirements.length })}
                            </Heading>
                            <div className="space-y-1 max-h-64 overflow-y-auto">
                                {coverage.unmappedRequirements.map((r: any, i: number) => (
                                    <div key={i} className="flex items-center gap-compact px-3 py-1.5 rounded-md hover:bg-bg-muted/50 text-sm">
                                        <span className="w-2 h-2 rounded-full bg-border-emphasis flex-shrink-0" />
                                        <code className="text-xs text-content-subtle font-mono w-16 sm:w-28 flex-shrink-0 truncate">{r.code}</code>
                                        <span className="text-content-muted">{r.title}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                </div>
            )}

            {/* Builder Tab — Epic 46.4 MVP */}
            {activeTab === 'builder' && (
                <div id="builder-panel">
                    {tree ? (
                        <RequirePermission
                            resource="frameworks"
                            action="install"
                            fallback={
                                <div className={cn(cardVariants({ density: 'none' }), 'text-center py-10 text-content-subtle')}>
                                    {t('builderRestricted')}
                                </div>
                            }
                        >
                            <FrameworkBuilder tree={tree} onSave={handleReorderSave} />
                        </RequirePermission>
                    ) : (
                        <div className={cn(cardVariants({ density: 'none' }), 'text-center py-10 text-content-subtle')}>
                            {t('loadingTree')}
                        </div>
                    )}
                </div>
            )}
        </EntityDetailLayout>
    );
}

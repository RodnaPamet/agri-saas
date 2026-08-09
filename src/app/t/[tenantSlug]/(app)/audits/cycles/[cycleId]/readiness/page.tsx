'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { AppIcon, type AppIconName } from '@/components/icons/AppIcon';
import { buttonVariants } from '@/components/ui/button-variants';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { cn } from '@/lib/cn';

function ScoreRing({ score, size = 120 }: { score: number; size?: number }) {
    const r = (size - 8) / 2;
    const c = 2 * Math.PI * r;
    const offset = c - (score / 100) * c;
    const color = score >= 80 ? '#22c55e' : score >= 50 ? '#eab308' : '#ef4444';
    return (
        <svg width={size} height={size} className="transform -rotate-90">
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="8" />
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="8"
                strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
                className="transition-all duration-1000" />
            <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="central"
                className="transform rotate-90 origin-center" fill="white" fontSize={size / 3} fontWeight="bold">
                {score}
            </text>
        </svg>
    );
}

const GAP_ICON: Record<string, AppIconName> = {
    UNMAPPED_REQUIREMENT: 'overview', MISSING_EVIDENCE: 'evidence', OVERDUE_TASK: 'clock',
    OPEN_ISSUE: 'warning', MISSING_POLICY: 'fileWarning',
};
const SEV_BADGE: Record<string, StatusBadgeVariant> = {
    HIGH: 'error', MEDIUM: 'warning', LOW: 'neutral',
};

export default function CycleReadinessPage() {
    const t = useTranslations('audits');
    const params = useParams();
    const tenantSlug = params.tenantSlug as string;
    const cycleId = params.cycleId as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);

    const [result, setResult] = useState<any>(null);
    const [cycle, setCycle] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        Promise.all([
            fetch(apiUrl(`/audits/cycles/${cycleId}/readiness`)).then(r => r.ok ? r.json() : null),
            fetch(apiUrl(`/audits/cycles/${cycleId}`)).then(r => r.ok ? r.json() : null),
        ]).then(([r, c]) => { setResult(r); setCycle(c); }).finally(() => setLoading(false));
    }, [apiUrl, cycleId]);

    const breadcrumbs = [
        { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
        { label: t('crumbAudits'), href: `/t/${tenantSlug}/audits` },
        { label: t('crumbReadiness'), href: `/t/${tenantSlug}/audits/readiness` },
        { label: cycle?.name || t('readinessDetail.crumbCycleFallback'), href: `/t/${tenantSlug}/audits/cycles/${cycleId}` },
        { label: t('readinessDetail.crumbReadinessReport') },
    ];

    if (loading) {
        return (
            <EntityDetailLayout
                title=""
                breadcrumbs={breadcrumbs}
                loading
            >
                {null}
            </EntityDetailLayout>
        );
    }
    if (!result) {
        return (
            <EntityDetailLayout
                title=""
                breadcrumbs={breadcrumbs}
                error={t('readinessDetail.computeError')}
            >
                {null}
            </EntityDetailLayout>
        );
    }

    const bd = result.breakdown;

    return (
        <EntityDetailLayout
            title={t('readinessDetail.titleSuffix', { name: cycle?.name || t('readinessDetail.crumbCycleFallback') })}
            breadcrumbs={breadcrumbs}
        >
            {/* Score + Breakdown */}
            <div className={cardVariants()}>
                <div className="flex items-start gap-page">
                    <div className="flex-shrink-0 text-center">
                        <ScoreRing score={result.score} />
                        <p className="text-xs text-content-muted mt-2">{t('readinessDetail.frameworkReadiness', { framework: result.frameworkKey })}</p>
                    </div>
                    <div className="flex-1 space-y-compact" id="readiness-breakdown">
                        {bd.coverage && (
                            <BreakdownBar label={t('readinessDetail.barCoverage')} score={bd.coverage.score}
                                detail={t('readinessDetail.detailCoverage', { mapped: bd.coverage.mapped, total: bd.coverage.total })} weight={bd.coverage.weight} />
                        )}
                        {bd.implementation && (
                            <BreakdownBar label={t('readinessDetail.barImplementation')} score={bd.implementation.score}
                                detail={t('readinessDetail.detailImplementation', { implemented: bd.implementation.implemented, total: bd.implementation.total })} weight={bd.implementation.weight} />
                        )}
                        {bd.evidence && (
                            <BreakdownBar label={t('readinessDetail.barEvidence')} score={bd.evidence.score}
                                detail={t('readinessDetail.detailEvidence', { withEvidence: bd.evidence.withEvidence, total: bd.evidence.total })} weight={bd.evidence.weight} />
                        )}
                        {bd.policies && (
                            <BreakdownBar label={t('readinessDetail.barPolicies')} score={bd.policies.score}
                                detail={t('readinessDetail.detailPolicies', { found: bd.policies.found?.length || 0, expected: bd.policies.expected?.length || 0 })} weight={bd.policies.weight} />
                        )}
                        {bd.tasks && (
                            <BreakdownBar label={t('readinessDetail.barTasks')} score={bd.tasks.score}
                                detail={t('readinessDetail.detailTasks', { overdue: bd.tasks.overdue })} weight={bd.tasks.weight} />
                        )}
                        {bd.issues && (
                            <BreakdownBar label={t('readinessDetail.barIssues')} score={bd.issues.score}
                                detail={t('readinessDetail.detailIssues', { open: bd.issues.open })} weight={bd.issues.weight} />
                        )}
                    </div>
                </div>
            </div>

            {/* Recommendations */}
            {result.recommendations?.length > 0 && (
                <div className={cardVariants()} id="recommendations">
                    <Heading level={3} className="mb-3 inline-flex items-center gap-tight"><AppIcon name="info" size={16} /> {t('readinessDetail.recommendedActions')}</Heading>
                    <div className="space-y-tight">
                        {result.recommendations.map((r: string, i: number) => (
                            <div key={i} className="flex items-start gap-tight text-sm">
                                <span className="text-content-warning flex-shrink-0">→</span>
                                <span className="text-content-default">{r}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Gaps */}
            {result.gaps?.length > 0 && (
                <div className="space-y-compact" id="gaps-section">
                    <Heading level={3}>{t('readinessDetail.topGaps', { count: result.gaps.length })}</Heading>
                    <div className={cn(cardVariants({ density: 'none' }), 'divide-y divide-border-default/50')}>
                        {result.gaps.map((g: any, i: number) => (
                            <div key={i} className="p-3 flex items-center justify-between text-sm">
                                <div className="flex items-center gap-compact min-w-0">
                                    <AppIcon name={GAP_ICON[g.type] || 'overview'} size={16} />
                                    <div className="min-w-0">
                                        <span className="font-medium truncate block">{g.title}</span>
                                        <span className="text-xs text-content-subtle">{g.details}</span>
                                    </div>
                                </div>
                                <StatusBadge variant={SEV_BADGE[g.severity] || 'neutral'} className="ml-2">{g.severity}</StatusBadge>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Exports */}
            <div className={cardVariants()} id="exports-section">
                <Heading level={3} className="mb-3 inline-flex items-center gap-tight"><AppIcon name="export" size={16} /> {t('readinessDetail.exports')}</Heading>
                <div className="flex flex-wrap gap-tight">
                    <a href={apiUrl(`/audits/cycles/${cycleId}/readiness?action=export-json`)}
                        target="_blank" rel="noopener" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>{t('readinessDetail.exportJson')}</a>
                    <a href={apiUrl(`/audits/cycles/${cycleId}/readiness?action=export-unmapped-csv`)}
                        target="_blank" rel="noopener" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>{t('readinessDetail.exportUnmapped')}</a>
                    <a href={apiUrl(`/audits/cycles/${cycleId}/readiness?action=export-practice-gaps-csv`)}
                        target="_blank" rel="noopener" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>{t('readinessDetail.exportPracticeGaps')}</a>
                </div>
            </div>
        </EntityDetailLayout>
    );
}

function BreakdownBar({ label, score, detail, weight }: { label: string; score: number; detail: string; weight: number }) {
    const t = useTranslations('audits');
    // Epic 59 ProgressBar primitive. Variant picks the token-backed
    // colour by score band — light-mode compatible (replaces the
    // earlier hardcoded emerald/amber/red Tailwind classes).
    const variant = score >= 80 ? 'success' : score >= 50 ? 'warning' : 'error';
    return (
        <div>
            <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-content-default">{t('readinessDetail.barLabelPct', { label, pct: Math.round(weight * 100) })}</span>
                <span className="text-content-muted">{score}%</span>
            </div>
            <ProgressBar
                value={score}
                size="sm"
                variant={variant}
                aria-label={t('readinessDetail.barScoreAria', { label })}
            />
            <p className="text-xs text-content-subtle mt-0.5">{detail}</p>
        </div>
    );
}

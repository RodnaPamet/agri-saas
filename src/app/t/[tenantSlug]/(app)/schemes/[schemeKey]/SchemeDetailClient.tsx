'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { DataTable, createColumns } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { MetaStrip } from '@/components/ui/meta-strip';
import { Download } from '@/components/ui/icons/nucleo';

interface RequirementRow {
    code: string;
    title: string;
    description: string | null;
    section: string | null;
    mapped: boolean;
    satisfied: boolean;
    controls: Array<{ code: string | null; name: string; status: string }>;
}

interface SchemeDetail {
    framework: { key: string; name: string; description?: string | null; version?: string | null };
    packs: Array<{ key: string; name: string; _count?: { templateLinks: number } }>;
    coverage: {
        total: number;
        mapped: number;
        unmapped: number;
        coveragePercent: number;
        satisfiedRequirements: number;
        applicableRequirements: number;
        satisfiedPercent: number;
    };
    requirements: RequirementRow[];
    adopted: boolean;
}

interface Props {
    tenantSlug: string;
    schemeKey: string;
    initialDetail: SchemeDetail;
    permissions: { canAdopt: boolean };
}

export function SchemeDetailClient({ tenantSlug, schemeKey, initialDetail, permissions }: Props) {
    const t = useTranslations('schemes');
    const router = useRouter();
    const [adopting, setAdopting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const query = useTenantSWR<SchemeDetail>(CACHE_KEYS.schemes.detail(schemeKey), {
        fallbackData: initialDetail,
    });
    const detail = query.data ?? initialDetail;

    /**
     * Adoption is `installPack` — the one path that actually creates controls
     * and requirement links. It existed only at `/frameworks/[key]/install`,
     * reachable through the command palette, so the standard-shaped page a
     * farmer would naturally use could not adopt anything.
     */
    const adopt = async () => {
        const pack = detail.packs[0];
        if (!pack) return;
        setAdopting(true);
        setError(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/frameworks/${schemeKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ packKey: pack.key }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                setError(body.error?.message || t('adoptFailed'));
                return;
            }
            // Refetch this page's own SWR key, then let the server component
            // re-render — adoption creates controls and requirement links, so
            // the satisfaction figures above change too.
            await query.mutate();
            router.refresh();
        } catch {
            setError(t('adoptFailed'));
        } finally {
            setAdopting(false);
        }
    };

    const columns = useMemo(
        () =>
            createColumns<RequirementRow>([
                {
                    accessorKey: 'code',
                    header: t('reqCode'),
                    cell: ({ row }) => (
                        <span className="font-medium text-content-emphasis text-sm tabular-nums">
                            {row.original.code}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    accessorKey: 'title',
                    header: t('reqTitle'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-default">{row.original.title}</span>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    id: 'status',
                    header: t('reqStatus'),
                    cell: ({ row }) => {
                        const r = row.original;
                        // Three states, not two. "Mapped" is a promise that a
                        // control exists; "satisfied" is approved evidence
                        // against it. Collapsing them is what made a fresh
                        // install read as fully covered.
                        if (r.satisfied) {
                            return <StatusBadge variant="success">{t('reqSatisfied')}</StatusBadge>;
                        }
                        if (r.mapped) {
                            return <StatusBadge variant="warning">{t('reqMappedOnly')}</StatusBadge>;
                        }
                        return <StatusBadge variant="neutral">{t('reqUnmapped')}</StatusBadge>;
                    },
                    meta: { mobileCard: { slot: 'status', label: t('reqStatus') } },
                },
                {
                    id: 'controls',
                    header: t('reqControls'),
                    cell: ({ row }) => {
                        const controls = row.original.controls;
                        if (controls.length === 0) {
                            return <span className="text-content-subtle">—</span>;
                        }
                        return (
                            <span className="text-xs text-content-muted">
                                {controls.map((c) => c.code ?? c.name).join(', ')}
                            </span>
                        );
                    },
                    meta: { mobileCard: { slot: 'meta', label: t('reqControls') } },
                },
            ]),
        [t],
    );

    const { coverage } = detail;

    return (
        <EntityDetailLayout
            id="scheme-detail-page"
            breadcrumbs={[
                { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                { label: t('breadcrumbSchemes'), href: `/t/${tenantSlug}/schemes` },
                { label: detail.framework.name },
            ]}
            title={<span id="scheme-title">{detail.framework.name}</span>}
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'metric',
                            label: t('metaSatisfied'),
                            value: `${coverage.satisfiedRequirements}/${coverage.applicableRequirements}`,
                            id: 'scheme-satisfied-count',
                        },
                        {
                            kind: 'metric',
                            label: t('metaReadiness'),
                            value: `${coverage.satisfiedPercent}%`,
                            // Green only when it is genuinely done. A partly-
                            // complete standard rendered as "success" is the
                            // same overstatement the score itself used to make,
                            // so anything short of 100 gets no tone at all.
                            ...(coverage.satisfiedPercent === 100
                                ? { tone: 'success' as const }
                                : {}),
                            id: 'scheme-readiness-percent',
                        },
                        ...(detail.framework.version
                            ? [{
                                kind: 'text' as const,
                                label: t('metaVersion'),
                                value: detail.framework.version,
                            }]
                            : []),
                    ]}
                />
            }
            actions={
                <div className="flex flex-wrap items-center gap-tight">
                    {permissions.canAdopt && detail.packs.length > 0 && (
                        <Button
                            variant={detail.adopted ? 'secondary' : 'primary'}
                            onClick={adopt}
                            disabled={adopting}
                            id="adopt-scheme-btn"
                        >
                            {detail.adopted ? t('adoptAgain') : t('adoptScheme')}
                        </Button>
                    )}
                    {/* Both export routes existed with zero UI callers. */}
                    <Button
                        variant="secondary"
                        icon={<Download className="size-3.5" />}
                        onClick={() => {
                            window.location.href =
                                `/api/t/${tenantSlug}/schemes/${schemeKey}/applicability.csv`;
                        }}
                        id="export-applicability-btn"
                    >
                        {t('exportApplicability')}
                    </Button>
                </div>
            }
            error={error}
        >
            {detail.framework.description && (
                <p className="text-sm text-content-muted">{detail.framework.description}</p>
            )}

            <DataTable<RequirementRow>
                data={detail.requirements}
                columns={columns}
                getRowId={(r) => r.code}
                mobileFallback="card"
                emptyState={
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('noRequirementsTitle')}
                        description={t('noRequirementsDescription')}
                    />
                }
                resourceName={(p) => (p ? t('requirementPlural') : t('requirementSingular'))}
                data-testid="scheme-requirements-table"
            />
        </EntityDetailLayout>
    );
}

'use client';

/**
 * Crop-plan detail page.
 *
 *   Overview   — the plan's config (season, crop, method, succession
 *                schedule, allocation).
 *   Plantings  — the succession BOARD (<PlantingBoard>): a Gantt
 *                timeline + a plan-vs-actual table, with a "Generate"
 *                action that re-runs the succession engine.
 *   Journal    — the field-journal entries that recorded actuals
 *                against this plan's plantings.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { apiPost, apiPatch, apiDelete } from '@/lib/api-client';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { SkeletonDetailPage } from '@/components/ui/skeleton';
import { MetaStrip } from '@/components/ui/meta-strip';
import { StatusBadge } from '@/components/ui/status-badge';
import { AgStatusBadge } from '@/components/ag/ag-status';
import { Button } from '@/components/ui/button';
import { Popover } from '@/components/ui/popover';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/hooks';
import { Dots, PenWriting, Trash } from '@/components/ui/icons/nucleo';
import { Card, cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { PlantingBoard } from './PlantingBoard';
import { EditCropPlanModal } from './EditCropPlanModal';

/**
 * Allowed lifecycle transitions from each status. The status enum + board
 * intend a lifecycle (DRAFT → ACTIVE → COMPLETED, with CANCELLED as an
 * off-ramp); these wire the transitions to PATCH { status }. Reopen sends
 * a COMPLETED/CANCELLED plan back to an editable state.
 */
const STATUS_TRANSITIONS: Record<string, Array<{ to: string; labelKey: string }>> = {
    DRAFT: [
        { to: 'ACTIVE', labelKey: 'activate' },
        { to: 'CANCELLED', labelKey: 'cancel' },
    ],
    ACTIVE: [
        { to: 'COMPLETED', labelKey: 'complete' },
        { to: 'CANCELLED', labelKey: 'cancel' },
    ],
    COMPLETED: [{ to: 'ACTIVE', labelKey: 'reopen' }],
    CANCELLED: [{ to: 'DRAFT', labelKey: 'reopen' }],
};

type Tab = 'overview' | 'plantings' | 'journal';

interface CropPlanDetail {
    id: string;
    name: string;
    status: string;
    method: string;
    firstSowDate: string;
    successions: number;
    intervalDays: number;
    plantsPerSuccession: number | null;
    bedLengthM: number | string | null;
    rowsPerBed: number | null;
    targetAreaM2: number | string | null;
    notes: string | null;
    season?: { id: string; name: string; status: string } | null;
    cropType?: { id: string; name: string } | null;
    variety?: { id: string; name: string; defaultMethod: string | null } | null;
    location?: { id: string; name: string } | null;
    parcel?: { id: string; name: string } | null;
    _count?: { plantings?: number };
}

interface JournalRow {
    id: string;
    type: string;
    title: string;
    occurredAt: string;
}

export default function CropPlanDetailPage() {
    const { formatDate } = useDateFormat();
    const t = useTranslations('planning.detail');
    const tp = useTranslations('planning');
    const te = useTranslations('planningEnums');
    const params = useParams();
    const router = useRouter();
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const toast = useToast();
    const { permissions, tenantSlug } = useTenantContext();

    const METHOD_LABELS: Record<string, string> = {
        DIRECT_SOW: te('method.DIRECT_SOW'),
        TRANSPLANT: te('method.TRANSPLANT'),
    };
    const cropPlanId = params?.cropPlanId as string;

    const [tab, setTab] = useState<Tab>('overview');
    const [generating, setGenerating] = useState(false);
    const [genError, setGenError] = useState<string | null>(null);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [statusBusy, setStatusBusy] = useState(false);

    const planKey = cropPlanId ? `/planning/crop-plans/${cropPlanId}` : null;
    const planSWR = useTenantSWR<CropPlanDetail>(planKey);
    const plan = planSWR.data ?? null;

    const changeStatus = async (to: string) => {
        setActionsOpen(false);
        setStatusBusy(true);
        try {
            await apiPatch(apiUrl(`/planning/crop-plans/${cropPlanId}`), { status: to });
            await planSWR.mutate();
            toast.success(t('statusChanged'));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t('statusChangeFailed'));
        } finally {
            setStatusBusy(false);
        }
    };

    const runDelete = async () => {
        await apiDelete(apiUrl(`/planning/crop-plans/${cropPlanId}`));
        toast.success(t('deleteSuccess'));
        router.push(tenantHref('/planning'));
    };

    // Journal tab — SCOPED to this plan's plantings (via the LogPlanting
    // links Prompt 1 landed), so it shows only the actuals recorded against
    // this plan, not the whole tenant journal.
    const journalSWR = useTenantSWR<JournalRow[]>(
        cropPlanId && tab === 'journal' ? `/journal?cropPlanId=${cropPlanId}` : null,
    );

    const runGenerate = async () => {
        setGenerating(true);
        setGenError(null);
        try {
            await apiPost(apiUrl(`/planning/crop-plans/${cropPlanId}/generate`), {});
            await planSWR.mutate();
        } catch (err) {
            setGenError(err instanceof Error ? err.message : t('genFailed'));
        } finally {
            setGenerating(false);
        }
    };

    if (planSWR.isLoading && !planSWR.data) {
        return (
            <EntityDetailLayout loading title="">
                <SkeletonDetailPage />
            </EntityDetailLayout>
        );
    }
    if (planSWR.error) {
        return (
            <EntityDetailLayout error={planSWR.error.message || t('notFound')} title="">
                {null}
            </EntityDetailLayout>
        );
    }
    if (!plan) {
        return (
            <EntityDetailLayout empty={{ message: t('notFoundMessage') }} title="">
                {null}
            </EntityDetailLayout>
        );
    }

    const tabs: { key: Tab; label: string; count?: number }[] = [
        { key: 'overview', label: t('tabOverview') },
        { key: 'plantings', label: t('tabPlantings'), count: plan._count?.plantings ?? 0 },
        { key: 'journal', label: t('tabJournal') },
    ];

    const headerMeta = (
        <MetaStrip
            items={[
                {
                    // Humanized via AgStatusBadge (same treatment as the list),
                    // so the detail header shows "Draft" not the raw "DRAFT".
                    id: 'crop-plan-status',
                    label: t('statusLabel'),
                    value: <AgStatusBadge entity="cropPlan" status={plan.status} />,
                },
                { label: t('season'), value: plan.season?.name ?? '—' },
                { label: t('crop'), value: plan.variety?.name ?? plan.cropType?.name ?? '—' },
            ]}
        />
    );

    const transitions = STATUS_TRANSITIONS[plan.status] ?? [];
    const headerActions = permissions.canWrite ? (
        <div className="flex items-center gap-tight">
            <Button
                variant="primary"
                onClick={runGenerate}
                loading={generating}
                id="crop-plan-generate-btn"
            >
                {t('generate')}
            </Button>
            <Popover
                openPopover={actionsOpen}
                setOpenPopover={setActionsOpen}
                align="end"
                content={
                    <Popover.Menu aria-label={t('actionsMenuLabel')}>
                        <Popover.Item
                            icon={<PenWriting className="h-3.5 w-3.5" aria-hidden />}
                            onClick={() => {
                                setActionsOpen(false);
                                setEditOpen(true);
                            }}
                            id="crop-plan-edit-action"
                        >
                            {t('edit')}
                        </Popover.Item>
                        {transitions.map((tr) => (
                            <Popover.Item
                                key={tr.to}
                                disabled={statusBusy}
                                onClick={() => void changeStatus(tr.to)}
                                id={`crop-plan-status-${tr.to.toLowerCase()}`}
                            >
                                {t(`lifecycle.${tr.labelKey}`)}
                            </Popover.Item>
                        ))}
                        <Popover.Separator />
                        <Popover.Item
                            destructive
                            icon={<Trash className="h-3.5 w-3.5" aria-hidden />}
                            onClick={() => {
                                setActionsOpen(false);
                                setDeleteOpen(true);
                            }}
                            id="crop-plan-delete-action"
                        >
                            {t('delete')}
                        </Popover.Item>
                    </Popover.Menu>
                }
            >
                <Button
                    variant="secondary"
                    icon={<Dots className="h-4 w-4" aria-hidden />}
                    aria-label={t('actionsMenuLabel')}
                    loading={statusBusy}
                    id="crop-plan-actions-btn"
                />
            </Popover>
        </div>
    ) : null;

    return (
        <EntityDetailLayout
            id="crop-plan-detail-page"
            breadcrumbs={[
                { label: tp('bcDashboard'), href: tenantHref('/dashboard') },
                { label: tp('bcPlanting'), href: tenantHref('/planning') },
                { label: plan.name },
            ]}
            title={<span id="crop-plan-title">{plan.name}</span>}
            meta={headerMeta}
            actions={headerActions}
            tabs={tabs}
            activeTab={tab}
            onTabChange={(next) => setTab(next as Tab)}
        >
            {genError && (
                <div
                    className="rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                    role="alert"
                    id="crop-plan-gen-error"
                >
                    {genError}
                </div>
            )}

            {/* A freshly-created plan with no plantings — most often because
                it has no maturity-bearing variety, so auto-generate was
                skipped. Guide the writer to the next action instead of
                leaving them on a silently-empty plan. */}
            {permissions.canWrite && (plan._count?.plantings ?? 0) === 0 && (
                <Card
                    elevation="inset"
                    density="none"
                    className="px-3 py-2 text-sm text-content-muted"
                    role="note"
                    id="crop-plan-empty-hint"
                >
                    {plan.variety ? t('emptyHintVariety') : t('emptyHintNoVariety')}
                </Card>
            )}

            {tab === 'overview' && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    <div className="grid grid-cols-2 gap-section">
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('method')}</span>
                            <p className="text-sm text-content-default mt-1">
                                {METHOD_LABELS[plan.method] ?? plan.method}
                            </p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('firstSowDate')}</span>
                            <p className="text-sm text-content-default mt-1">{formatDate(plan.firstSowDate)}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('successions')}</span>
                            <p className="text-sm text-content-default mt-1">{plan.successions}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('intervalDays')}</span>
                            <p className="text-sm text-content-default mt-1">{plan.intervalDays}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('plantsPerSuccession')}</span>
                            <p className="text-sm text-content-default mt-1">
                                {plan.plantsPerSuccession ?? '—'}
                            </p>
                        </div>
                        {/* Allocation — the alternative drivers of plant count.
                            Shown only when set (a plan uses ONE of plants /
                            bed geometry / area), so the grid stays honest. */}
                        {plan.bedLengthM != null && (
                            <div>
                                <span className="text-xs text-content-subtle uppercase">{t('bedLength')}</span>
                                <p className="text-sm text-content-default mt-1">
                                    {Number(plan.bedLengthM).toLocaleString()} m
                                </p>
                            </div>
                        )}
                        {plan.rowsPerBed != null && (
                            <div>
                                <span className="text-xs text-content-subtle uppercase">{t('rowsPerBed')}</span>
                                <p className="text-sm text-content-default mt-1">{plan.rowsPerBed}</p>
                            </div>
                        )}
                        {plan.targetAreaM2 != null && (
                            <div>
                                <span className="text-xs text-content-subtle uppercase">{t('targetArea')}</span>
                                <p className="text-sm text-content-default mt-1">
                                    {Number(plan.targetAreaM2).toLocaleString()} m²
                                </p>
                            </div>
                        )}
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('variety')}</span>
                            <p className="text-sm text-content-default mt-1">{plan.variety?.name ?? '—'}</p>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle uppercase">{t('parcel')}</span>
                            <p className="text-sm text-content-default mt-1">
                                {plan.parcel?.name ?? plan.location?.name ?? '—'}
                            </p>
                        </div>
                        {plan.notes && (
                            <div className="col-span-2">
                                <span className="text-xs text-content-subtle uppercase">{t('notes')}</span>
                                <p className="text-sm text-content-default mt-1">{plan.notes}</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {tab === 'plantings' && <PlantingBoard tenantSlug={tenantSlug} cropPlanId={cropPlanId} />}

            {tab === 'journal' && (
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')}>
                    {journalSWR.isLoading && !journalSWR.data ? (
                        <div className="p-8 text-center text-content-subtle animate-pulse">{t('loadingJournal')}</div>
                    ) : (journalSWR.data?.length ?? 0) === 0 ? (
                        <div className="p-8 text-center text-sm text-content-subtle">
                            {t('journalEmpty')}
                        </div>
                    ) : (
                        <div className="divide-y divide-border-default/50" id="crop-plan-journal-feed">
                            {(journalSWR.data ?? []).slice(0, 50).map((e) => (
                                <a
                                    key={e.id}
                                    href={tenantHref(`/journal/${e.id}`)}
                                    className="flex items-center justify-between px-5 py-3 hover:bg-bg-muted"
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm text-content-default">{e.title}</span>
                                        <span className="text-xs text-content-subtle">{formatDate(e.occurredAt)}</span>
                                    </span>
                                    <StatusBadge variant="info" size="sm">
                                        {e.type.replace(/_/g, ' ')}
                                    </StatusBadge>
                                </a>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {permissions.canWrite && (
                <>
                    <EditCropPlanModal
                        open={editOpen}
                        setOpen={setEditOpen}
                        plan={plan}
                        onSaved={() => void planSWR.mutate()}
                    />
                    <ConfirmDialog
                        showModal={deleteOpen}
                        setShowModal={setDeleteOpen}
                        tone="danger"
                        title={t('confirmDeleteTitle')}
                        description={t('confirmDeleteDesc', { name: plan.name })}
                        confirmLabel={t('confirmDeleteLabel')}
                        onConfirm={runDelete}
                    />
                </>
            )}
        </EntityDetailLayout>
    );
}

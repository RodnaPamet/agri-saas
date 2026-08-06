'use client';

/**
 * PlantingBoard — the succession board on the crop-plan Plantings tab.
 *
 * Two views of the same plan-vs-actual payload
 * (`GET /planning/crop-plans/:id?include=progress`):
 *
 *   1. A <GanttTimeline> — one bar per succession from sow → harvest
 *      end. Reuses the shared timeline primitive (a planting's
 *      lifecycle reads as task-like work, so each row maps to a
 *      `task`-category CalendarEvent).
 *   2. A <DataTable> — succession #, planned + actual sow / transplant
 *      / harvest dates, seed grams, plant count, status. The actual
 *      column shows the journal-recorded date where a LogPlanting
 *      exists, so the farmer sees plan vs reality at a glance.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantContext } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';
import { createColumns, DataTable } from '@/components/ui/table';
import { GanttTimeline } from '@/components/ui/GanttTimeline';
import { AgStatusBadge } from '@/components/ag/ag-status';
import { SoilSuitabilityBadge } from '@/components/soil/SoilSuitabilityBadge';
import type { SuitabilityFlag } from '@/lib/soil/suitability';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { SkeletonCard, SkeletonLine } from '@/components/ui/skeleton';
import { Heading } from '@/components/ui/typography';
import { Tooltip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Popover } from '@/components/ui/popover';
import { CircleCheck, Plus } from '@/components/ui/icons/nucleo';
import { formatDate } from '@/lib/format-date';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import type { CalendarEvent } from '@/app-layer/schemas/calendar.schemas';

/** Lifecycle stage a "record actual" click realises. */
type Stage = 'SOW' | 'TRANSPLANT' | 'HARVEST';

/** stage → the LogEntry type its journal record carries. */
const STAGE_LOG_TYPE: Record<Stage, string> = {
    SOW: 'SEEDING',
    TRANSPLANT: 'TRANSPLANTING',
    HARVEST: 'HARVEST',
};

interface PlantingProgressRow {
    plantingId: string;
    successionNumber: number;
    method: string;
    status: string;
    parcel: { id: string; name: string } | null;
    planned: {
        sowDate: string | null;
        transplantDate: string | null;
        harvestStartDate: string | null;
        harvestEndDate: string | null;
    };
    actual: {
        SOW: string | null;
        TRANSPLANT: string | null;
        HARVEST: string | null;
    };
}

interface PlantingDetail {
    id: string;
    seedQuantityGrams: number | string | null;
    plantCount: number | null;
}

interface ProgressPayload {
    plan: { id: string; name: string };
    progress: PlantingProgressRow[];
}

/**
 * Accumulated GDD for one planting (Agro-intel). Lazily fetches the
 * per-planting GDD endpoint; the board has a small bounded set of rows so
 * SWR's per-key dedup keeps this cheap. Renders "—" until weather exists.
 */
function GddCell({ plantingId }: { plantingId: string }) {
    const t = useTranslations('planning.board');
    const { data, isLoading } = useTenantSWR<{
        totalGdd: number;
        baseTempC: number;
        targetGdd: number | null;
        days: unknown[];
    }>(`/planning/plantings/${plantingId}/gdd`);
    if (isLoading && !data) {
        return <SkeletonLine className="h-3 w-8" />;
    }
    const total = data?.totalGdd ?? 0;
    if (!data || (data.days?.length ?? 0) === 0) {
        return <span className="text-xs text-content-subtle">—</span>;
    }
    // Maturity % — only when the variety carries a real GDD target
    // (`gddToMaturity`); otherwise the cell stays raw accumulated GDD.
    const pct =
        data.targetGdd && data.targetGdd > 0
            ? Math.min(100, Math.round((total / data.targetGdd) * 100))
            : null;
    return (
        <Tooltip
            content={
                pct != null
                    ? t('gddTooltipTarget', { temp: data.baseTempC, target: data.targetGdd! })
                    : t('gddTooltip', { temp: data.baseTempC })
            }
        >
            <span className="text-xs text-content-muted tabular-nums">
                {total.toLocaleString()}
                {pct != null ? <span className="text-content-subtle"> · {pct}%</span> : null}
            </span>
        </Tooltip>
    );
}

/**
 * Advisory soil-suitability flag for one planting (Soil integration #37).
 * Lazily fetches the per-planting soil endpoint and renders the suitability
 * badge; `unknown` when the parcel has no soil yet or the variety carries no
 * soil preferences. Same lazy-per-row pattern as {@link GddCell}.
 */
function SoilCell({ plantingId }: { plantingId: string }) {
    const { data, isLoading } = useTenantSWR<{
        suitability: { flag: SuitabilityFlag; reason: string };
    }>(`/planning/plantings/${plantingId}/soil`);
    if (isLoading && !data) {
        return <SkeletonLine className="h-3 w-12" />;
    }
    if (!data) {
        return <span className="text-xs text-content-subtle">—</span>;
    }
    return (
        <SoilSuitabilityBadge
            flag={data.suitability.flag}
            reason={data.suitability.reason}
        />
    );
}

/** A planned date beside its actual realisation (or an em-dash). */
function PlannedActual({ planned, actual }: { planned: string | null; actual: string | null }) {
    const t = useTranslations('planning.board');
    if (!planned && !actual) return <span className="text-content-subtle">—</span>;
    return (
        <span className="flex flex-col leading-tight">
            <span className="text-xs text-content-default">{planned ? formatDate(planned) : '—'}</span>
            {actual ? (
                <Tooltip content={t('actualTooltip')}>
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-content-success">
                        <CircleCheck className="h-2.5 w-2.5" aria-hidden />
                        {formatDate(actual)}
                    </span>
                </Tooltip>
            ) : null}
        </span>
    );
}

/**
 * Per-row "record actual" affordance — closes the plan-vs-actual loop.
 *
 * A menu of the planting's applicable lifecycle stages (SOW always;
 * TRANSPLANT only for transplanted plantings; HARVEST always). Choosing a
 * stage POSTs a journal entry linked to this planting (`plantingLinks`),
 * which writes the LogPlanting row — the ACTUAL date for that milestone —
 * and advances the Planting status server-side. A stage that already has
 * an actual shows a check and can still be re-recorded (the board keeps
 * the earliest occurredAt). On success the board revalidates so the
 * actual + check appear immediately.
 */
function RecordActualMenu({
    row,
    planName,
    onRecorded,
}: {
    row: PlantingProgressRow;
    planName: string;
    onRecorded: () => Promise<unknown>;
}) {
    const t = useTranslations('planning.board');
    const buildUrl = useTenantApiUrl();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<Stage | null>(null);

    const stages: Stage[] = useMemo(
        () => (row.method === 'TRANSPLANT' ? ['SOW', 'TRANSPLANT', 'HARVEST'] : ['SOW', 'HARVEST']),
        [row.method],
    );

    const record = async (stage: Stage) => {
        if (busy) return;
        setBusy(stage);
        try {
            await apiPost(buildUrl('/journal'), {
                type: STAGE_LOG_TYPE[stage],
                title: t('recordTitle', {
                    stage: t(`stageLabel.${stage}`),
                    num: row.successionNumber,
                    plan: planName,
                }),
                occurredAt: new Date().toISOString(),
                status: 'DONE',
                plantingLinks: [{ plantingId: row.plantingId, stage }],
            });
            setOpen(false);
            await onRecorded();
        } finally {
            setBusy(null);
        }
    };

    return (
        <Popover
            openPopover={open}
            setOpenPopover={setOpen}
            align="end"
            content={
                <Popover.Menu aria-label={t('recordMenuLabel')}>
                    {stages.map((s) => {
                        const done = row.actual[s] != null;
                        return (
                            <Popover.Item
                                key={s}
                                selected={done}
                                disabled={busy != null}
                                right={done ? <CircleCheck className="h-3.5 w-3.5 text-content-success" aria-hidden /> : null}
                                onClick={() => void record(s)}
                            >
                                {t(`recordStage.${s}`)}
                            </Popover.Item>
                        );
                    })}
                </Popover.Menu>
            }
        >
            <Button
                variant="ghost"
                size="xs"
                icon={<Plus className="h-3 w-3" aria-hidden />}
                loading={busy != null}
                aria-label={t('recordAria', { num: row.successionNumber })}
                id={`record-actual-${row.plantingId}`}
            >
                {t('record')}
            </Button>
        </Popover>
    );
}

export function PlantingBoard({
    tenantSlug,
    cropPlanId,
}: {
    tenantSlug: string;
    cropPlanId: string;
}) {
    const t = useTranslations('planning.board');
    const tSoil = useTranslations('ag.soil');
    const { permissions } = useTenantContext();
    const canWrite = permissions.canWrite;
    // Plan-vs-actual progress + the planting rows (for seed/plant-count).
    const progressSWR = useTenantSWR<ProgressPayload>(
        `/planning/crop-plans/${cropPlanId}?include=progress`,
    );
    const plantingsSWR = useTenantSWR<PlantingDetail[]>(
        `/planning/plantings?cropPlanId=${cropPlanId}`,
    );

    const progress = useMemo(() => progressSWR.data?.progress ?? [], [progressSWR.data]);
    const plantingById = useMemo(() => {
        const map = new Map<string, PlantingDetail>();
        for (const p of plantingsSWR.data ?? []) map.set(p.id, p);
        return map;
    }, [plantingsSWR.data]);

    // Recording an actual writes a journal entry + advances the planting;
    // revalidate both reads so the actual date, the check, and the new
    // status land on the board immediately.
    const planName = progressSWR.data?.plan?.name ?? '';
    const { mutate: mutateProgress } = progressSWR;
    const { mutate: mutatePlantings } = plantingsSWR;
    const onRecorded = useCallback(
        () => Promise.all([mutateProgress(), mutatePlantings()]),
        [mutateProgress, mutatePlantings],
    );

    // ── Gantt range + events ──
    const { from, to, events } = useMemo(() => {
        const dates: number[] = [];
        for (const row of progress) {
            for (const d of [row.planned.sowDate, row.planned.harvestEndDate]) {
                if (d) dates.push(new Date(d).getTime());
            }
        }
        const now = Date.now();
        const min = dates.length ? Math.min(...dates) : now;
        const max = dates.length ? Math.max(...dates) : now + 30 * 86_400_000;
        // Pad the range a little so end bars aren't flush to the edge.
        const pad = 3 * 86_400_000;
        const events: CalendarEvent[] = progress
            .filter((r) => r.planned.sowDate && r.planned.harvestEndDate)
            .map((r) => ({
                id: `planting:${r.plantingId}`,
                // A planting's lifecycle is task-like work — map onto the
                // shared CalendarEvent's `task` category so the Gantt's
                // tone bundle applies. `href` stays on this plan's page.
                type: 'task-due',
                category: 'task',
                titleKey: 'raw',
                titleParams: { name: `#${r.successionNumber}` },
                date: r.planned.sowDate!,
                end: r.planned.harvestEndDate!,
                status: r.actual.HARVEST ? 'done' : 'scheduled',
                entityType: 'TASK',
                entityId: r.plantingId,
                href: `/t/${tenantSlug}/planning/${cropPlanId}`,
                detail: `Succession ${r.successionNumber}`,
            }));
        return { from: new Date(min - pad), to: new Date(max + pad), events };
    }, [progress, tenantSlug, cropPlanId]);

    const columns = useMemo(
        () =>
            createColumns<PlantingProgressRow>([
                {
                    id: 'succession',
                    header: t('colNum'),
                    accessorFn: (r) => r.successionNumber,
                    cell: ({ row }) => (
                        <span className="text-xs font-medium text-content-emphasis tabular-nums">
                            {row.original.successionNumber}
                        </span>
                    ),
                },
                {
                    id: 'parcel',
                    header: t('colParcel'),
                    accessorFn: (r) => r.parcel?.name ?? '',
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {row.original.parcel?.name ?? '—'}
                        </span>
                    ),
                },
                {
                    id: 'sow',
                    header: t('colSow'),
                    accessorFn: (r) => r.planned.sowDate ?? '',
                    cell: ({ row }) => (
                        <PlannedActual planned={row.original.planned.sowDate} actual={row.original.actual.SOW} />
                    ),
                    meta: { disableTruncate: true },
                },
                {
                    id: 'transplant',
                    header: t('colTransplant'),
                    accessorFn: (r) => r.planned.transplantDate ?? '',
                    cell: ({ row }) => (
                        <PlannedActual
                            planned={row.original.planned.transplantDate}
                            actual={row.original.actual.TRANSPLANT}
                        />
                    ),
                    meta: { disableTruncate: true },
                },
                {
                    id: 'harvest',
                    header: t('colHarvest'),
                    accessorFn: (r) => r.planned.harvestStartDate ?? '',
                    cell: ({ row }) => (
                        <PlannedActual
                            planned={row.original.planned.harvestStartDate}
                            actual={row.original.actual.HARVEST}
                        />
                    ),
                    meta: { disableTruncate: true },
                },
                {
                    id: 'seed',
                    header: t('colSeed'),
                    accessorFn: (r) => plantingById.get(r.plantingId)?.seedQuantityGrams ?? '',
                    cell: ({ row }) => {
                        const g = plantingById.get(row.original.plantingId)?.seedQuantityGrams;
                        return (
                            <span className="text-xs text-content-muted tabular-nums">
                                {g != null ? Number(g).toLocaleString() : '—'}
                            </span>
                        );
                    },
                },
                {
                    id: 'plants',
                    header: t('colPlants'),
                    accessorFn: (r) => plantingById.get(r.plantingId)?.plantCount ?? '',
                    cell: ({ row }) => {
                        const n = plantingById.get(row.original.plantingId)?.plantCount;
                        return (
                            <span className="text-xs text-content-muted tabular-nums">
                                {n != null ? n.toLocaleString() : '—'}
                            </span>
                        );
                    },
                },
                {
                    id: 'gdd',
                    header: t('colGdd'),
                    enableSorting: false,
                    cell: ({ row }) => <GddCell plantingId={row.original.plantingId} />,
                },
                {
                    id: 'soil',
                    header: tSoil('suitabilityTitle'),
                    enableSorting: false,
                    cell: ({ row }) => <SoilCell plantingId={row.original.plantingId} />,
                },
                {
                    accessorKey: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => (
                        <AgStatusBadge entity="planting" status={row.original.status} />
                    ),
                },
                // Record-actual affordance — write-gated, closes the
                // plan-vs-actual loop from the board itself.
                ...(canWrite
                    ? [
                          {
                              id: 'actions',
                              header: '',
                              enableSorting: false,
                              cell: ({ row }: { row: { original: PlantingProgressRow } }) => (
                                  <RecordActualMenu
                                      row={row.original}
                                      planName={planName}
                                      onRecorded={onRecorded}
                                  />
                              ),
                              meta: { disableTruncate: true },
                          },
                      ]
                    : []),
            ]),
        [plantingById, t, tSoil, canWrite, planName, onRecorded],
    );

    if (progressSWR.isLoading && !progressSWR.data) {
        return <SkeletonCard lines={5} />;
    }
    if (progressSWR.error) {
        return (
            <InlineEmptyState
                title={t('loadErrorTitle')}
                description={t('loadErrorDesc')}
            />
        );
    }
    if (progress.length === 0) {
        return (
            <InlineEmptyState
                title={t('emptyTitle')}
                description={t('emptyDesc')}
            />
        );
    }

    return (
        <div className="space-y-section" data-testid="planting-board">
            {/* Succession timeline */}
            <div className={cn(cardVariants({ density: 'compact' }), 'space-y-default')}>
                <Heading level={3}>{t('successionTimeline')}</Heading>
                <GanttTimeline from={from} to={to} events={events} data-testid="planting-gantt" />
            </div>

            {/* Plan-vs-actual table */}
            <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')} id="planting-table">
                <DataTable
                    data={progress}
                    columns={columns}
                    getRowId={(r) => r.plantingId}
                    selectionEnabled={false}
                    virtualize={false}
                />
            </div>
        </div>
    );
}

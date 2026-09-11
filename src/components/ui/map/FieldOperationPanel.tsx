'use client';

/**
 * FieldOperationPanel — the operator's view of a spray job. A read-only
 * parcel map (completed parcels shaded green) plus a per-parcel
 * prescription checklist with mark-done / skip / reopen actions. The
 * job auto-resolves server-side once every line is DONE/SKIPPED.
 *
 * Rendered both on the Task detail page (FIELD_OPERATION tasks) and the
 * Location "Operations" tab.
 */
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { Geometry } from 'geojson';
import { Button } from '@/components/ui/button';
import { AgStatusBadge } from '@/components/ag/ag-status';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPatch, isOfflineError, API_TIMEOUT_CODE } from '@/lib/api-client';
import { totalLabel, haToDca, trimNumber } from '@/lib/agro/rate-calc';
import { haptic } from '@/lib/haptics';
import { playSound } from '@/lib/sound';
import { SprayJobCompletionCard } from '@/components/ui/map/SprayJobCompletionCard';
import type { MapParcel } from '@/components/ui/map/MapCanvas';

// Browser-only (MapLibre touches window) — load client-side only.
const MapCanvas = dynamic(() => import('@/components/ui/map/MapCanvas').then((m) => m.MapCanvas), { ssr: false });

interface Line {
    id: string;
    status: 'PENDING' | 'DONE' | 'SKIPPED';
    doseValue: string | number;
    waterRateValue?: string | number | null;
    parcel?: { id: string; name: string; areaHa?: number | null } | null;
    product?: { id: string; name: string } | null;
    doseUnit?: { id: string; symbol: string } | null;
    waterRateUnit?: { id: string; symbol: string } | null;
}
interface FieldOpView {
    task: { id: string; key?: string | null; title: string; status: string };
    lines: Line[];
    parcels: Array<{ id: string; name: string; areaHa?: number | null; geometry: unknown }>;
    location: { id: string; name: string; boundsJson: unknown } | null;
    progress: { total: number; done: number };
}

export interface FieldOperationPanelProps {
    taskId: string;
}

export function FieldOperationPanel({ taskId }: FieldOperationPanelProps) {
    const t = useTranslations('ag.map');
    const te = useTranslations('taskEnums');
    const buildUrl = useTenantApiUrl();
    const { data, mutate, isLoading } = useTenantSWR<FieldOpView>(`/field-operations/${taskId}`);
    const [busyId, setBusyId] = useState<string | null>(null);
    // A failed mark must SAY so, next to the row it failed on. Every caller is
    // a bare `onClick={() => mark(…)}`, so the old `throw err` was an unhandled
    // rejection — nothing in the app listens, the only `unhandledrejection`
    // handler ignores anything that is not a ChunkLoadError. The row stayed
    // PENDING and the whole story an operator got was a buzz.
    //
    // This panel is NOT manager-only: a MECHANISATOR can open the locations
    // page, the Operations tab renders it, and the list is not filtered by
    // assignee — so an operator can tap Done on a COLLEAGUE'S job and take a
    // 403 while fully online. That, not the offline case, is the common
    // failure here. (#887)
    const [markError, setMarkError] = useState<{ lineId: string; message: string } | null>(null);

    const doneIds = useMemo(
        () => (data?.lines ?? [])
            .filter((l) => l.status === 'DONE' || l.status === 'SKIPPED')
            .map((l) => l.parcel?.id)
            .filter((id): id is string => Boolean(id)),
        [data],
    );
    const mapParcels = useMemo<MapParcel[]>(
        () => (data?.parcels ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            areaHa: p.areaHa ?? null,
            geometry: (p.geometry ?? null) as Geometry | null,
        })),
        [data],
    );
    const bounds = (data?.location?.boundsJson as [number, number, number, number] | null) ?? null;

    const mark = async (lineId: string, status: 'DONE' | 'SKIPPED' | 'PENDING') => {
        setBusyId(lineId);
        try {
            await apiPatch(buildUrl(`/field-operations/${taskId}/parcels/${lineId}`), { status });
            // Sensory confirmation — a DONE feels weightier than a skip/reopen.
            const kind = status === 'DONE' ? 'success' : 'tap';
            haptic(kind);
            playSound(kind);
            await mutate();
        } catch (err) {
            haptic('error');
            // Nothing here is optimistic — the row on screen is still server
            // truth — so there is no rollback to do. What was missing is the
            // SENTENCE.
            //
            // FOUR outcomes, four instructions, because the wrong instruction
            // rewrites a regulatory date. A successful mark stamps
            // `completedAt = new Date()`, and that column is the printed
            // "Дата" of the treatment AND the base for the earliest-harvest
            // date in the БАБХ ДНЕВНИК. Telling an operator to retry a write
            // that actually LANDED makes them re-mark, and the re-mark moves
            // that date — across midnight, by a day.
            //
            // Shape-matched, not `instanceof`: two bundler copies of the error
            // class would silently take the wrong arm.
            const e = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; status?: unknown };
            setMarkError({
                lineId,
                message: isOfflineError(err)
                    // Never reached the server. Safe to promise nothing was saved.
                    ? t('fieldOp.markOffline')
                    : e.code === API_TIMEOUT_CODE
                        // The request may well have landed. Do NOT claim "unchanged".
                        ? t('fieldOp.markTimeout')
                        : e.status === 403
                            // Not the assignee. Retrying can never work, so
                            // "try again" would be a lie.
                            ? t('fieldOp.markForbidden')
                            : t('fieldOp.markFailed'),
            });
            // Re-read so the row agrees with the server — this is what makes
            // the timeout copy actionable. Offline it does NOT reject: the SW
            // serves /field-operations/<id> from DATA_CACHE. Wrapped because a
            // throw here would resurrect the unhandled rejection this patch
            // exists to remove.
            void Promise.resolve(mutate()).catch(() => {});
        } finally {
            setBusyId(null);
        }
    };

    if (isLoading && !data) return <div className="text-sm text-content-secondary">{t('fieldOp.loading')}</div>;
    if (!data) return <div className="text-sm text-content-secondary">{t('fieldOp.notFound')}</div>;

    // Spray-job complete → offer a shareable card. Area covered = the done
    // parcels' hectarage; the job's product is shared across its lines.
    const allComplete = data.progress.total > 0 && data.progress.done === data.progress.total;
    const areaCovered = data.lines
        .filter((l) => l.status === 'DONE')
        .reduce((sum, l) => sum + (l.parcel?.areaHa ?? 0), 0);
    const jobProduct = data.lines.find((l) => l.product?.name)?.product?.name ?? null;

    return (
        <div className="space-y-section">
            {allComplete && (
                <SprayJobCompletionCard
                    title={data.task.title}
                    parcelsDone={data.progress.done}
                    areaCoveredHa={areaCovered}
                    productName={jobProduct}
                />
            )}
            <div className="flex items-center justify-between">
                <div className="text-sm text-content-secondary">
                    {t('fieldOp.parcelsComplete', { done: data.progress.done, total: data.progress.total })}
                </div>
                <div className="text-sm font-medium">
                    {te.has(`status.${data.task.status}`) ? te(`status.${data.task.status}`) : data.task.status}
                </div>
            </div>
            <MapCanvas parcels={mapParcels} bounds={bounds} interactive={false} doneIds={doneIds} className="h-[360px] w-full overflow-hidden rounded-lg border border-border-subtle" />
            <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
                {data.lines.map((l) => (
                    <li key={l.id} className="px-4 py-3">
                        <div className="flex items-center justify-between gap-default">
                        <div>
                            <div className="text-sm font-medium">{l.parcel?.name ?? t('parcel')}</div>
                            <div className="text-xs text-content-secondary">
                                {l.product?.name} · {String(l.doseValue)} {l.doseUnit?.symbol} · {l.parcel?.areaHa != null ? t('fieldOp.areaDca', { dca: trimNumber(haToDca(l.parcel.areaHa)) }) : '–'}
                            </div>
                            {/* Amounts needed for THIS parcel — rate × its area
                                (per the unit's /ha or /dca basis). */}
                            {l.parcel?.areaHa != null && l.doseUnit?.symbol && (
                                <div className="text-xs font-medium text-content-emphasis tabular-nums">
                                    {t('fieldOp.needs', { amount: totalLabel(Number(l.doseValue), l.doseUnit.symbol, l.parcel.areaHa) })}
                                    {l.waterRateValue != null && l.waterRateUnit?.symbol && (
                                        <> · {t('fieldOp.water', { amount: totalLabel(Number(l.waterRateValue), l.waterRateUnit.symbol, l.parcel.areaHa) })}</>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="flex items-center gap-tight">
                            <AgStatusBadge entity="operationParcel" status={l.status} />
                            {l.status === 'PENDING' ? (
                                <>
                                    <Button size="sm" variant="primary" loading={busyId === l.id} disabled={busyId === l.id} onClick={() => mark(l.id, 'DONE')}>{t('fieldOp.done')}</Button>
                                    <Button size="sm" variant="secondary" loading={busyId === l.id} disabled={busyId === l.id} onClick={() => mark(l.id, 'SKIPPED')}>{t('fieldOp.skip')}</Button>
                                </>
                            ) : (
                                <Button size="sm" variant="secondary" loading={busyId === l.id} disabled={busyId === l.id} onClick={() => mark(l.id, 'PENDING')}>{t('fieldOp.reopen')}</Button>
                            )}
                        </div>
                        </div>
                        {markError?.lineId === l.id && (
                            <div role="alert" className="mt-2 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">
                                {markError.message}
                            </div>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default FieldOperationPanel;

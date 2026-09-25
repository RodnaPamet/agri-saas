'use client';

/**
 * A parcel's archive — what it grew, what was done to it, what grew uninvited.
 *
 * ## Why a page and not a panel on the map sheet
 *
 * The sheet is where a farmer taps a parcel, and it is already the densest
 * surface in the app. Three chronological lists inside it would fight for
 * height on exactly the device this is used on. A page can be linked, shared
 * and deep-linked from the sheet, and has room for the archive to grow.
 *
 * ## Three sources, deliberately not merged into one feed
 *
 * Crop seasons, completed operations and weed observations answer different
 * questions — what did this field grow, what did we put on it, what is coming
 * up in it — and a farmer arrives with one of those in mind. Interleaving them
 * by date would make each one harder to read in order to make none of them
 * easier.
 *
 * Only the first and third are authored here. The operations list is a READ of
 * the field-operation register: the same rows that record a spray or a
 * fertiliser application, which is why "completed tasks" and "what was
 * applied" are one section and not two.
 */
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { apiGet, apiPost, apiDelete } from '@/lib/api-client';
import { cropLabel, localizedCropOptions } from '@/lib/agriculture/crop-options';
import { weedLabel, localizedWeedOptions } from '@/lib/agriculture/weed-options';
import { MetaStrip } from '@/components/ui/meta-strip';
import { AddCropSeasonModal } from './AddCropSeasonModal';
import { AddWeedObservationModal } from './AddWeedObservationModal';

interface CropSeason {
    id: string;
    year: number;
    cropType: string;
    sownAt: string | null;
    harvestedAt: string | null;
    notes: string | null;
}
interface HistoryOperation {
    id: string;
    taskId: string;
    operationType: string | null;
    title: string;
    completedAt: string | null;
    productName: string;
    doseValue: string;
    doseUnit: string;
    targetNote: string | null;
}
interface WeedObservation {
    id: string;
    observedAt: string;
    weedKeys: string[];
    otherWeeds: string[];
    notes: string | null;
}
interface ParcelHistory {
    parcel: { id: string; name: string; cropType: string | null };
    cropSeasons: CropSeason[];
    operations: HistoryOperation[];
    weedObservations: WeedObservation[];
    cropSeasonsCursor: string | null;
    operationsCursor: string | null;
    weedObservationsCursor: string | null;
}

/** Dates arrive as ISO strings; render the day only — no time is meaningful here. */
function day(value: string | null): string {
    return value ? value.slice(0, 10) : '—';
}

/**
 * The three sections page INDEPENDENTLY, each from its own cursor.
 *
 * Note older rows are APPENDED here, not prepended as in the exchange thread:
 * these lists read newest-first, so "older" belongs at the bottom. The chat
 * renders oldest-first and therefore prepends. Same mechanism, opposite end,
 * and getting it backwards puts 2019 above 2026.
 */
const SECTIONS = {
    cropSeasons: { cursor: 'cropSeasonsCursor', param: 'seasonsBefore' },
    operations: { cursor: 'operationsCursor', param: 'operationsBefore' },
    weedObservations: { cursor: 'weedObservationsCursor', param: 'weedsBefore' },
} as const;
type SectionKey = keyof typeof SECTIONS;

export default function ParcelHistoryPage() {
    const params = useParams<{ parcelId: string }>();
    const parcelId = params.parcelId;
    const t = useTranslations('ag.parcelHistory');
    const tCrops = useTranslations('crops');
    const tWeeds = useTranslations('weeds');
    const buildUrl = useTenantApiUrl();
    const href = useTenantHref();

    const [older, setOlder] = useState<{
        cropSeasons: CropSeason[];
        operations: HistoryOperation[];
        weedObservations: WeedObservation[];
    }>({ cropSeasons: [], operations: [], weedObservations: [] });
    // `undefined` = not walked yet (fall back to the payload's cursor);
    // `null` = this list has reached its start.
    const [walked, setWalked] = useState<Partial<Record<SectionKey, string | null>>>({});

    const { data, error, isLoading, mutate } = useTenantSWR<ParcelHistory>(
        `/agro/parcels/${parcelId}/history`,
    );

    const [cropOpen, setCropOpen] = useState(false);
    const [weedOpen, setWeedOpen] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<
        { kind: 'crop' | 'weed'; id: string } | null
    >(null);

    const cropOptions = useMemo(() => localizedCropOptions(tCrops), [tCrops]);
    const weedOptions = useMemo(() => localizedWeedOptions(tWeeds), [tWeeds]);

    const confirmDelete = useCallback(async () => {
        if (!pendingDelete) return;
        const path =
            pendingDelete.kind === 'crop'
                ? `/agro/parcels/${parcelId}/crop-seasons/${pendingDelete.id}`
                : `/agro/parcels/${parcelId}/weed-observations/${pendingDelete.id}`;
        await apiDelete(buildUrl(path));
        setPendingDelete(null);
        void mutate();
    }, [pendingDelete, parcelId, buildUrl, mutate]);

    const breadcrumbs = useMemo(
        () => [{ label: t('breadcrumbParcels'), href: href('/locations') }],
        [t, href],
    );

    if (isLoading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (error || !data) {
        return (
            <EntityDetailLayout
                error={error ? (error as Error).message : t('saveFailed')}
                title=""
                breadcrumbs={breadcrumbs}
            >
                <></>
            </EntityDetailLayout>
        );
    }

    const cursorFor = (k: SectionKey): string | null =>
        walked[k] !== undefined ? (walked[k] as string | null) : data[SECTIONS[k].cursor];

    const loadOlder = async (k: SectionKey) => {
        const cur = cursorFor(k);
        if (!cur) return;
        try {
            const page = await apiGet<ParcelHistory>(
                buildUrl(
                    `/agro/parcels/${parcelId}/history?${SECTIONS[k].param}=${encodeURIComponent(cur)}`,
                ),
            );
            setOlder((prev) => ({ ...prev, [k]: [...prev[k], ...page[k]] as never }));
            setWalked((prev) => ({ ...prev, [k]: page[SECTIONS[k].cursor] }));
        } catch {
            // Silent: the reader keeps what they had. An error banner over a
            // section they did not ask to extend is noisier than the failure.
        }
    };

    const olderButton = (k: SectionKey) =>
        cursorFor(k) ? (
            <Button variant="ghost" size="sm" onClick={() => { void loadOlder(k); }}>
                {t('loadOlder')}
            </Button>
        ) : null;

    const { parcel } = data;
    // Payload page first, accumulated older pages after — newest-first order.
    const cropSeasons = [...data.cropSeasons, ...older.cropSeasons];
    const operations = [...data.operations, ...older.operations];
    const weedObservations = [...data.weedObservations, ...older.weedObservations];

    return (
        <EntityDetailLayout
            title={parcel.name}
            breadcrumbs={breadcrumbs}
            meta={
                <MetaStrip
                    items={[
                        {
                            label: t('currentCrop'),
                            value: parcel.cropType
                                ? cropLabel(tCrops, parcel.cropType)
                                : t('noCurrentCrop'),
                        },
                    ]}
                />
            }
        >
            <div className="space-y-section">
                {/* ── Crops by year ── */}
                <section className="space-y-default">
                    <div className="flex items-center justify-between gap-tight">
                        <Heading level={2}>{t('cropsTitle')}</Heading>
                        <Button variant="secondary" size="sm" onClick={() => setCropOpen(true)}>
                            {t('cropsAdd')}
                        </Button>
                    </div>
                    {cropSeasons.length === 0 ? (
                        <p className="text-sm text-content-subtle">{t('cropsEmpty')}</p>
                    ) : (
                        <ul className="space-y-tight">
                            {cropSeasons.map((s) => (
                                <li
                                    key={s.id}
                                    className="flex flex-wrap items-baseline gap-default rounded-md border border-border-subtle px-3 py-2"
                                >
                                    <span className="font-semibold tabular-nums">{s.year}</span>
                                    <span>{cropLabel(tCrops, s.cropType)}</span>
                                    <span className="text-xs text-content-muted">
                                        {t('colSown')}: {day(s.sownAt)} · {t('colHarvested')}:{' '}
                                        {day(s.harvestedAt)}
                                    </span>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="ml-auto"
                                        onClick={() => setPendingDelete({ kind: 'crop', id: s.id })}
                                    >
                                        {t('remove')}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {olderButton('cropSeasons')}
                </section>

                {/* ── Completed operations (a READ of the register) ── */}
                <section className="space-y-default">
                    <Heading level={2}>{t('opsTitle')}</Heading>
                    {operations.length === 0 ? (
                        <p className="text-sm text-content-subtle">{t('opsEmpty')}</p>
                    ) : (
                        <ul className="space-y-tight">
                            {operations.map((o) => (
                                <li
                                    key={o.id}
                                    className="flex flex-wrap items-baseline gap-default rounded-md border border-border-subtle px-3 py-2"
                                >
                                    <span className="tabular-nums">{day(o.completedAt)}</span>
                                    <span>{o.title}</span>
                                    <span className="text-xs text-content-muted">
                                        {o.productName} · {o.doseValue} {o.doseUnit}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                    {olderButton('operations')}
                </section>

                {/* ── Weeds ── */}
                <section className="space-y-default">
                    <div className="flex items-center justify-between gap-tight">
                        <Heading level={2}>{t('weedsTitle')}</Heading>
                        <Button variant="secondary" size="sm" onClick={() => setWeedOpen(true)}>
                            {t('weedsAdd')}
                        </Button>
                    </div>
                    {weedObservations.length === 0 ? (
                        <p className="text-sm text-content-subtle">{t('weedsEmpty')}</p>
                    ) : (
                        <ul className="space-y-tight">
                            {weedObservations.map((w) => (
                                <li
                                    key={w.id}
                                    className="flex flex-wrap items-baseline gap-default rounded-md border border-border-subtle px-3 py-2"
                                >
                                    <span className="tabular-nums">{day(w.observedAt)}</span>
                                    <span className="text-sm">
                                        {/*
                                          * Catalogue keys resolve to Bulgarian common names;
                                          * free-text entries render exactly as typed. Both are
                                          * shown together because the farmer does not think of
                                          * them as two lists — only the storage does.
                                          */}
                                        {[
                                            ...w.weedKeys.map((k) => weedLabel(tWeeds, k)),
                                            ...w.otherWeeds,
                                        ].join(', ')}
                                    </span>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="ml-auto"
                                        onClick={() => setPendingDelete({ kind: 'weed', id: w.id })}
                                    >
                                        {t('remove')}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {olderButton('weedObservations')}
                </section>
            </div>

            <AddCropSeasonModal
                open={cropOpen}
                setOpen={setCropOpen}
                parcelId={parcelId}
                options={cropOptions}
                onSaved={() => void mutate()}
            />
            <AddWeedObservationModal
                open={weedOpen}
                setOpen={setWeedOpen}
                parcelId={parcelId}
                options={weedOptions}
                onSaved={() => void mutate()}
            />
            <ConfirmDialog
                showModal={pendingDelete !== null}
                setShowModal={() => setPendingDelete(null)}
                title={pendingDelete?.kind === 'weed' ? t('removeWeedTitle') : t('removeCropTitle')}
                description={t('removeBody')}
                confirmLabel={t('remove')}
                cancelLabel={t('cancel')}
                onConfirm={confirmDelete}
            />
        </EntityDetailLayout>
    );
}

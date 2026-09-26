'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { haToDca, trimNumber } from '@/lib/agro/rate-calc';
import { cropLabel } from '@/lib/agriculture/crop-options';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { StatusBadge } from '@/components/ui/status-badge';
import { InfoTooltip } from '@/components/ui/tooltip';
import { AskInsuranceModal } from './AskInsuranceModal';

interface LocationOption {
    id: string;
    name: string;
}
interface ParcelsResp {
    parcels: Array<{ id: string; name: string; areaHa?: number | null; cropType?: string | null }>;
}
type RiskLevel = 'good' | 'watch' | 'stress' | 'unknown';
interface ParcelRisk {
    parcelId: string;
    name: string;
    areaHa: number | null;
    cropType: string | null;
    configured: boolean;
    ndvi: number | null;
    ndmi: number | null;
    vegetation: RiskLevel;
    moisture: RiskLevel;
    overall: RiskLevel;
    /** Date of the satellite pass the readings came from — can be older than today. */
    acquiredDate: string | null;
}

const LEVEL_VARIANT: Record<RiskLevel, 'success' | 'warning' | 'error' | 'neutral'> = {
    good: 'success',
    watch: 'warning',
    stress: 'error',
    unknown: 'neutral',
};

export function FarmRiskClient({
    tenantSlug,
    locations,
    geeConfigured,
}: {
    tenantSlug: string;
    locations: LocationOption[];
    /**
     * Whether this deployment has Earth-Engine credentials. Resolved on the
     * server so the loading copy is honest on the FIRST paint — the per-parcel
     * response also carries `configured`, but only after it lands.
     */
    geeConfigured: boolean;
}) {
    const t = useTranslations('ag.risk');
    const [locationId, setLocationId] = useState<string>(locations[0]?.id ?? '');

    const locationOptions = useMemo<ComboboxOption[]>(
        () => locations.map((l) => ({ value: l.id, label: l.name })),
        [locations],
    );
    const parcelsQ = useTenantSWR<ParcelsResp>(locationId ? `/locations/${locationId}/parcels` : null);
    // Which parcels has this tenant already asked about? Fetched ONCE for the
    // whole page rather than per card: the answer is a small id set and the
    // rows are rendered from one list, so N cards would otherwise mean N
    // identical requests on a phone.
    //
    // It drives a NOTE, not a disabled button. This comment used to say
    // `@@unique([parcelId, inquirerTenantId])` made a second request
    // impossible; that unique was dropped on 2026-09-24 precisely so a farmer
    // can re-ask with a corrected land size. What collapses a RETRY now is
    // idempotency on an explicit `Idempotency-Key` (#1119), which is a
    // different guarantee: it de-duplicates the same request without ever
    // refusing a genuinely new one.
    const inquiredQ = useTenantSWR<{ parcelIds: string[] }>('/insurance/leads');
    const inquired = useMemo(
        () => new Set(inquiredQ.data?.parcelIds ?? []),
        [inquiredQ.data],
    );
    const parcels = parcelsQ.data?.parcels ?? [];
    // The selected location's name, for the crop-aggregate chip's label.
    const selectedLocationName =
        locations.find((l) => l.id === locationId)?.name ?? null;

    return (
        <div className="space-y-section p-4">
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('title') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-sm text-content-secondary">{t('description')}</p>
            </div>

            {locations.length === 0 ? (
                <div className="rounded-lg border border-border-subtle bg-bg-default p-6 text-sm text-content-muted">
                    {t('emptyLocations')}
                </div>
            ) : (
                <>
                    <div className="max-w-sm">
                        <Combobox
                            options={locationOptions}
                            selected={locationOptions.find((o) => o.value === locationId) ?? null}
                            setSelected={(o) => setLocationId(o?.value ?? '')}
                            placeholder={t('selectLocation')}
                            aria-label={t('selectLocation')}
                            matchTriggerWidth
                        />
                    </div>

                    {parcels.length === 0 ? (
                        <div className="rounded-lg border border-border-subtle bg-bg-default p-6 text-sm text-content-muted">
                            {t('emptyParcels')}
                        </div>
                    ) : (
                        <ul className="space-y-default">
                            {parcels.map((p) => (
                                <ParcelRiskCard
                                    key={p.id}
                                    parcelId={p.id}
                                    locationId={locationId}
                                    fallbackName={p.name}
                                    fallbackCropType={p.cropType ?? null}
                                    locationName={selectedLocationName}
                                    locationParcels={parcels}
                                    areaHa={p.areaHa ?? null}
                                    geeConfigured={geeConfigured}
                                    hasRequested={inquired.has(p.id)}
                                    onRequested={() => void inquiredQ.mutate()}
                                />
                            ))}
                        </ul>
                    )}
                </>
            )}
        </div>
    );
}

function ParcelRiskCard({
    parcelId,
    locationId,
    fallbackName,
    fallbackCropType,
    locationName,
    locationParcels,
    areaHa,
    geeConfigured,
    hasRequested,
    onRequested,
}: {
    parcelId: string;
    locationId: string;
    fallbackName: string;
    /**
     * The crop from the parcels LIST row. `risk?.cropType` is richer but
     * arrives with the satellite read, so the calculator would lose its
     * preselect whenever that read is slow or failed.
     */
    fallbackCropType: string | null;
    /** For the crop-aggregate chip (#1121) — the location the card belongs to. */
    locationName: string | null;
    locationParcels: readonly { cropType?: string | null; areaHa?: number | null }[];
    areaHa: number | null;
    geeConfigured: boolean;
    /** Has this tenant already asked about THIS parcel? Server-read. */
    hasRequested: boolean;
    /** Refresh the server list after a successful send. */
    onRequested: () => void;
}) {
    const t = useTranslations('ag.risk');
    const tCrops = useTranslations('crops');
    // Path segment, not a query param. iOS writes the full request URL —
    // query included — to the unified log from Apple's own networking layer,
    // below anything the app controls, so an id in a query string becomes an
    // id in a device-local log for every client built on this route. The web
    // does not have that problem; it shares the route with the one that does.
    const riskQ = useTenantSWR<ParcelRisk>(`/agro/parcels/${parcelId}/analysis`);
    const risk = riskQ.data ?? null;
    const levelLabel = (l: RiskLevel) => t(`level.${l}`);

    return (
        <li className="rounded-lg border border-border-subtle bg-bg-default p-4">
            <div className="flex items-start justify-between gap-default">
                <div className="min-w-0">
                    <p className="font-medium text-content-emphasis">{risk?.name ?? fallbackName}</p>
                    <p className="text-xs text-content-subtle">
                        {areaHa != null && <span className="tabular-nums">{t('sizeDca', { dca: trimNumber(haToDca(areaHa)) })}</span>}
                        {areaHa != null && risk?.cropType && ' · '}
                        {risk?.cropType ? cropLabel(tCrops, risk.cropType) : null}
                    </p>
                </div>
                {risk && (
                    <StatusBadge variant={LEVEL_VARIANT[risk.overall]}>{levelLabel(risk.overall)}</StatusBadge>
                )}
            </div>

            {riskQ.isLoading && !risk ? (
                // Only claim imagery analysis when this deployment can actually
                // do it. With no Earth-Engine credentials the request never
                // touches a satellite pass, so it is just a load.
                <p className="mt-2 text-sm text-content-subtle">
                    {geeConfigured ? t('analyzing') : t('loading')}
                </p>
            ) : risk ? (
                <>
                    <div className="mt-3 grid grid-cols-2 gap-default text-sm">
                        <div>
                            <span className="text-xs text-content-subtle">{t('vegetation')}</span>
                            {/* The badge is the signal; the raw index sits beside
                                it with an InfoTooltip because "NDVI 0.62" means
                                nothing to a farm operator on its own. */}
                            <div className="mt-0.5 flex items-center gap-tight">
                                <StatusBadge variant={LEVEL_VARIANT[risk.vegetation]}>{levelLabel(risk.vegetation)}</StatusBadge>
                                {risk.ndvi != null && (
                                    <span className="flex items-center gap-tight text-xs text-content-muted">
                                        <span className="tabular-nums">NDVI {risk.ndvi}</span>
                                        <InfoTooltip
                                            content={t('ndviHelp')}
                                            aria-label={t('ndviHelpLabel')}
                                        />
                                    </span>
                                )}
                            </div>
                        </div>
                        <div>
                            <span className="text-xs text-content-subtle">{t('moisture')}</span>
                            <div className="mt-0.5 flex items-center gap-tight">
                                <StatusBadge variant={LEVEL_VARIANT[risk.moisture]}>{levelLabel(risk.moisture)}</StatusBadge>
                                {risk.ndmi != null && (
                                    <span className="flex items-center gap-tight text-xs text-content-muted">
                                        <span className="tabular-nums">NDMI {risk.ndmi}</span>
                                        <InfoTooltip
                                            content={t('ndmiHelp')}
                                            aria-label={t('ndmiHelpLabel')}
                                        />
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    {/* The date of the pass the readings came from — the composite
                        can fall back to an older window, so this is the real one. */}
                    {risk.acquiredDate && (
                        <p className="mt-2 text-xs text-content-subtle">
                            {t('asOf', { date: risk.acquiredDate })}
                        </p>
                    )}
                    {!risk.configured && <p className="mt-2 text-xs text-content-subtle">{t('unavailable')}</p>}
                </>
            ) : (
                <p className="mt-2 text-sm text-content-subtle">{t('unavailable')}</p>
            )}
            {/*
              * OUTSIDE the risk branch on purpose. The calculator uses no
              * satellite reading, so a cloudy week over Sentinel — or a read
              * still in flight — must not be what stops a farmer getting a
              * price. `risk` is simply null in that case.
              */}
            <div className="mt-3">
                <AskInsuranceModal
                    parcelId={parcelId}
                    locationId={locationId}
                    parcelName={risk?.name ?? fallbackName}
                    risk={risk ? { overall: risk.overall, ndvi: risk.ndvi, ndmi: risk.ndmi } : null}
                    cropType={risk?.cropType ?? fallbackCropType}
                    areaHa={areaHa}
                    locationName={locationName}
                    locationParcels={locationParcels}
                    hasRequested={hasRequested}
                    onRequested={onRequested}
                />
            </div>
        </li>
    );
}

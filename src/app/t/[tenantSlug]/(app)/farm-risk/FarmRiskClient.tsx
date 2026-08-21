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
    // identical requests on a phone. `@@unique([parcelId, inquirerTenantId])`
    // is what makes a second request impossible, and this is what stops the UI
    // offering one anyway.
    const inquiredQ = useTenantSWR<{ parcelIds: string[] }>('/insurance/leads');
    const inquired = useMemo(
        () => new Set(inquiredQ.data?.parcelIds ?? []),
        [inquiredQ.data],
    );
    const parcels = parcelsQ.data?.parcels ?? [];

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
    areaHa,
    geeConfigured,
    hasRequested,
    onRequested,
}: {
    parcelId: string;
    locationId: string;
    fallbackName: string;
    areaHa: number | null;
    geeConfigured: boolean;
    /** Has this tenant already asked about THIS parcel? Server-read. */
    hasRequested: boolean;
    /** Refresh the server list after a successful send. */
    onRequested: () => void;
}) {
    const t = useTranslations('ag.risk');
    const tCrops = useTranslations('crops');
    const riskQ = useTenantSWR<ParcelRisk>(`/agro/parcel-analysis?parcelId=${parcelId}`);
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
                    <div className="mt-3">
                        <AskInsuranceModal
                            parcelId={parcelId}
                            locationId={locationId}
                            risk={{ overall: risk.overall, ndvi: risk.ndvi, ndmi: risk.ndmi }}
                            hasRequested={hasRequested}
                            onRequested={onRequested}
                        />
                    </div>
                </>
            ) : (
                <p className="mt-2 text-sm text-content-subtle">{t('unavailable')}</p>
            )}
        </li>
    );
}

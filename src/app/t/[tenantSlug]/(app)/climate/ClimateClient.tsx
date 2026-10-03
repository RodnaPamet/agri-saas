'use client';

/**
 * Climate (Климат) client — the tenant's weather page.
 *
 * Two complementary sources, top to bottom:
 *  1. Native Open-Meteo weather (collected daily by the `weather-pull` job into
 *     `WeatherObservation`): current conditions, a recent + forecast temperature
 *     chart, and today's spray window, for a selected location. The location
 *     selector drives a `?location=` query param the server component reads.
 *  2. The tenant's own Meteobot station dashboard, embedded when configured.
 *     The embed is permitted by a scoped CSP `frame-src https://*.meteobot.com`
 *     and the stored URL is validated to the same host allowlist. Admins set /
 *     clear the station URL inline. (A native Meteobot data fetch may later
 *     replace the embed — see the 2026-07 climate note.)
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, usePathname } from 'next/navigation';
import { Heading } from '@/components/ui/typography';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Combobox } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import {
    TimeSeriesChart,
    Areas,
    XAxis,
    YAxis,
    type Series,
    type TimeSeriesDatum,
} from '@/components/ui/charts';
import type {
    LocationClimate,
    WeatherLocationOption,
    DailyWeather,
} from '@/app-layer/usecases/climate';
import type { SprayWindowStatus } from '@/lib/agro/rules';

export interface ClimateClientProps {
    tenantSlug: string;
    locations: WeatherLocationOption[];
    selectedLocationId: string | null;
    climate: LocationClimate | null;
    meteobotStationUrl: string | null;
    canConfigure: boolean;
}

const SPRAY_TONE: Record<SprayWindowStatus, 'success' | 'warning' | 'error'> = {
    GOOD: 'success',
    CAUTION: 'warning',
    UNSUITABLE: 'error',
};

const TEMP_MAX_LINE = 'text-content-error';
const TEMP_MIN_LINE = 'text-brand-default';

type TempValues = { max: number; min: number };

function fmtNum(v: number | null, digits = 0): string {
    return v == null ? '—' : v.toFixed(digits);
}

function hh(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00`;
}

function StatTile({ label, value, unit }: { label: string; value: string; unit?: string }) {
    return (
        <div className="rounded-lg border border-border-subtle bg-bg-default p-3">
            <p className="text-xs text-content-subtle">{label}</p>
            <p className="mt-1 text-lg font-semibold text-content-emphasis tabular-nums">
                {value}
                {unit && value !== '—' ? <span className="ml-1 text-sm font-normal text-content-muted">{unit}</span> : null}
            </p>
        </div>
    );
}

/**
 * The tenant's Meteobot station dashboard, embedded when configured. Renders
 * nothing when no station is set AND the viewer can't configure one. Admins get
 * an inline set / clear form; the PUT is validated server-side to a meteobot.com
 * host (matching the CSP `frame-src`).
 */
function MeteobotStationCard({
    meteobotStationUrl,
    canConfigure,
}: {
    meteobotStationUrl: string | null;
    canConfigure: boolean;
}) {
    const t = useTranslations('ag.climate');
    const router = useRouter();
    const buildUrl = useTenantApiUrl();
    const [url, setUrl] = useState(meteobotStationUrl ?? '');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!meteobotStationUrl && !canConfigure) return null;

    const save = async (value: string | null) => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(buildUrl('/climate/meteobot'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ meteobotStationUrl: value }),
            });
            if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                throw new Error((typeof b?.error === 'string' && b.error) || b?.message || t('saveFailed'));
            }
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : t('saveFailed'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Card>
            <div className="flex items-baseline justify-between gap-tight">
                <Heading level={3}>{t('stationTitle')}</Heading>
                {meteobotStationUrl && <span className="text-xs text-content-subtle">{t('attribution')}</span>}
            </div>

            {meteobotStationUrl ? (
                <div className="mt-default space-y-default">
                    <div className="overflow-hidden rounded-lg border border-border-default">
                        <iframe
                            src={meteobotStationUrl}
                            title={t('stationTitle')}
                            className="h-[70vh] w-full"
                            loading="lazy"
                            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                            referrerPolicy="no-referrer"
                        />
                    </div>
                    <p className="text-xs text-content-muted">
                        <a
                            href={meteobotStationUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-content-link hover:underline"
                        >
                            {t('openInNewTab')}
                        </a>
                    </p>
                </div>
            ) : (
                <p className="mt-default text-sm text-content-muted">{t('stationEmpty')}</p>
            )}

            {canConfigure && (
                <div className="mt-default space-y-default border-t border-border-subtle pt-default">
                    <p className="text-xs text-content-muted">{t('settingsHint')}</p>
                    {error && (
                        <div
                            role="alert"
                            className="rounded-md border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                        >
                            {error}
                        </div>
                    )}
                    <FormField label={t('stationUrlLabel')}>
                        <Input
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder={t('urlPlaceholder')}
                            inputMode="url"
                        />
                    </FormField>
                    <div className="flex gap-compact">
                        <Button variant="primary" size="sm" loading={saving} onClick={() => save(url)}>
                            {t('saveStation')}
                        </Button>
                        {meteobotStationUrl && (
                            <Button
                                variant="secondary"
                                size="sm"
                                disabled={saving}
                                onClick={() => {
                                    setUrl('');
                                    void save(null);
                                }}
                            >
                                {t('removeStation')}
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </Card>
    );
}

export function ClimateClient({
    tenantSlug,
    locations,
    selectedLocationId,
    climate,
    meteobotStationUrl,
    canConfigure,
}: ClimateClientProps) {
    const t = useTranslations('ag.climate');
    const router = useRouter();
    const pathname = usePathname();

    const chartData = useMemo<TimeSeriesDatum<TempValues>[]>(
        () =>
            (climate?.daily ?? [])
                .filter((d): d is DailyWeather & { tempMaxC: number; tempMinC: number } =>
                    d.tempMaxC != null && d.tempMinC != null)
                .map((d) => ({
                    date: new Date(`${d.date}T00:00:00Z`),
                    values: { max: d.tempMaxC, min: d.tempMinC },
                })),
        [climate],
    );

    const series = useMemo<Series<TempValues>[]>(
        () => [
            { id: 'max', isActive: true, valueAccessor: (d) => d.values.max, colorClassName: TEMP_MAX_LINE },
            { id: 'min', isActive: true, valueAccessor: (d) => d.values.min, colorClassName: TEMP_MIN_LINE },
        ],
        [],
    );

    const locationOptions = useMemo(
        () => locations.map((l) => ({ value: l.id, label: l.name })),
        [locations],
    );
    const selectedOption = locationOptions.find((o) => o.value === selectedLocationId) ?? null;

    const header = (
        <div>
            <PageBreadcrumbs
                items={[
                    { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t('title') },
                ]}
                className="mb-1"
            />
            <Heading level={1}>{t('title')}</Heading>
            <p className="text-sm text-content-muted">{t('description')}</p>
        </div>
    );

    const current = climate?.current ?? null;
    const spray = climate?.sprayWindow ?? null;

    return (
        <div className="space-y-section p-4">
            {header}

            {locations.length === 0 ? (
                // No locations at all — nothing to show Open-Meteo weather for.
                <EmptyState title={t('noLocationsTitle')} description={t('locationsEmptyBody')}>
                    <Button variant="primary" size="sm" onClick={() => router.push(`/t/${tenantSlug}/locations`)}>
                        {t('goToLocations')}
                    </Button>
                </EmptyState>
            ) : (
                <>
                    <div className="max-w-xs">
                        <Combobox
                            options={locationOptions}
                            selected={selectedOption}
                            setSelected={(opt) => {
                                if (opt) router.push(`${pathname}?location=${encodeURIComponent(opt.value)}`);
                            }}
                            placeholder={t('selectLocation')}
                            matchTriggerWidth
                        />
                    </div>

                    {!climate || climate.daily.length === 0 ? (
                        <EmptyState title={t('noWeatherTitle')} description={t('weatherEmptyBody')} />
                    ) : (
                        <div className="space-y-section">
                            {/* Current conditions + spray verdict */}
                            <Card>
                                <div className="flex items-baseline justify-between gap-tight">
                                    <Heading level={3}>{t('currentTitle', { location: climate.locationName })}</Heading>
                                    {spray && (
                                        <StatusBadge variant={SPRAY_TONE[spray.status]}>
                                            {t(`spray.${spray.status}`)}
                                        </StatusBadge>
                                    )}
                                </div>
                                <div className="mt-default grid grid-cols-2 gap-default sm:grid-cols-3 lg:grid-cols-6">
                                    <StatTile label={t('tempMean')} value={fmtNum(current?.tempMeanC ?? null)} unit="°C" />
                                    <StatTile label={t('tempMax')} value={fmtNum(current?.tempMaxC ?? null)} unit="°C" />
                                    <StatTile label={t('tempMin')} value={fmtNum(current?.tempMinC ?? null)} unit="°C" />
                                    <StatTile label={t('precip')} value={fmtNum(current?.precipMm ?? null, 1)} unit={t('mm')} />
                                    <StatTile label={t('wind')} value={fmtNum(current?.windMaxKmh ?? null)} unit={t('kmh')} />
                                    <StatTile label={t('humidity')} value={fmtNum(current?.humidityMean ?? null)} unit="%" />
                                </div>

                                {/* Spray window strip */}
                                {spray && (
                                    <div className="mt-default border-t border-border-subtle pt-default">
                                        {spray.windows.length > 0 ? (
                                            <p className="text-sm text-content-default">
                                                {t('sprayWindows')}{' '}
                                                <span className="font-medium">
                                                    {spray.windows.map((w) => `${hh(w.startHour)}–${hh(w.endHour)}`).join(', ')}
                                                </span>
                                            </p>
                                        ) : (
                                            <p className="text-sm text-content-muted">{t('sprayNone')}</p>
                                        )}
                                    </div>
                                )}
                            </Card>

                            {/* Temperature trend */}
                            <Card>
                                <div className="mb-3 flex items-baseline justify-between gap-tight">
                                    <Heading level={3}>{t('tempTrendTitle')}</Heading>
                                    <span className="flex items-center gap-default text-xs">
                                        <span className="flex items-center gap-tight">
                                            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-content-error" />
                                            <span className="text-content-muted">{t('tempMax')}</span>
                                        </span>
                                        <span className="flex items-center gap-tight">
                                            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-brand-default" />
                                            <span className="text-content-muted">{t('tempMin')}</span>
                                        </span>
                                    </span>
                                </div>
                                {chartData.length > 0 ? (
                                    <div className="h-48" role="img" aria-label={t('tempTrendAria', { days: chartData.length })}>
                                        <TimeSeriesChart<TempValues> type="area" data={chartData} series={series}>
                                            <YAxis showGridLines />
                                            <Areas />
                                            <XAxis />
                                        </TimeSeriesChart>
                                    </div>
                                ) : (
                                    <p className="text-xs text-content-subtle">{t('weatherEmptyBody')}</p>
                                )}
                                <p className="mt-2 text-xs text-content-subtle">
                                    {t('source', { source: climate.source })}
                                </p>
                            </Card>
                        </div>
                    )}
                </>
            )}

            {/* The tenant's own Meteobot station (embedded when configured). */}
            <MeteobotStationCard meteobotStationUrl={meteobotStationUrl} canConfigure={canConfigure} />
        </div>
    );
}

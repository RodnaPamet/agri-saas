'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useSearchParams } from 'next/navigation';
import type { Geometry } from 'geojson';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { DataTable, createColumns } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { cropLabel, localizedCropOptions } from '@/lib/agriculture/crop-options';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { ParcelOverviewMap } from '@/components/locations/ParcelOverviewMap';
import {
    encodeClusterToken,
    parseClusterToken,
    resolveClusterSelection,
    type ClusterSelection,
} from '@/components/locations/parcel-overview-model';
import type { ParcelOverview } from '@/app-layer/usecases/parcel-overview';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { DatePicker, type DateValue } from '@/components/ui/date-picker';
import { toYMD } from '@/components/ui/date-picker/date-utils';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { apiPost, apiPatch, apiDelete, ApiClientError } from '@/lib/api-client';
import { Popover } from '@/components/ui/popover';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SpatialImportModal } from '@/components/ui/map/SpatialImportModal';
import { PrescriptionPanel } from '@/components/ui/map/PrescriptionPanel';
import { DownloadBasemapButton } from '@/components/ui/map/DownloadBasemapButton';
import { FieldOperationPanel } from '@/components/ui/map/FieldOperationPanel';
import { ParcelDetailSheet, type ParcelSheetData } from '@/components/ui/map/ParcelDetailSheet';
import { ParcelCadastralInfo } from '@/components/ui/map/ParcelCadastralInfo';
import { SoilLegend } from '@/components/soil/SoilLegend';
import { soilColorForTexture, type SoilProfile } from '@/lib/soil/types';
import type { UsdaTextureClass } from '@/lib/soil/texture';
import { SmartDefaultsBanner } from './SmartDefaultsBanner';
import type { LocationSmartDefaults } from '@/app-layer/usecases/smart-defaults';
import { CalendarIcon, LocationPin, MapPosition } from '@/components/ui/icons/nucleo';
import { GridIcon } from '@/components/ui/icons/nucleo/grid';
import { haToDca, trimNumber } from '@/lib/agro/rate-calc';
import { useMediaQuery, useToast } from '@/components/ui/hooks';
import { Tooltip } from '@/components/ui/tooltip';
import { useOfflineSync } from '@/lib/offline/use-offline-sync';
import { cn } from '@/lib/cn';
import type { MapParcel } from '@/components/ui/map/MapCanvas';
import {
    VEGETATION_INDICES,
    vegetationIndexById,
    type VegetationIndex,
} from '@/lib/agro/vegetation-indices';

const MapCanvas = dynamic(() => import('@/components/ui/map/MapCanvas').then((m) => m.MapCanvas), { ssr: false });

type Tab = 'overview' | 'map' | 'operations';

/**
 * The page's filter facets, at module scope so the array identity is
 * stable across renders.
 *
 * `cluster` is the parcel-overview map's selection; `crop` was a bare
 * `useState` until this change. Both live in one `useFilterContext` now
 * because two filter mechanisms narrowing ONE table is how a count ends
 * up disagreeing with the rows beneath it — and because a crop selection
 * that survives a reload and a shared link is worth having anyway.
 *
 * Any facet driven here MUST appear in this array: `pushToUrl` deletes
 * only the keys it is given but writes every key in the next state, so a
 * missing key is written to the URL once and then never removed or
 * re-parsed.
 */
const PARCEL_FILTER_KEYS: string[] = ['cluster', 'crop'];

/** Grid pitch to open at before the canvas has measured itself. */
const DEFAULT_ZOOM_TIER = 9;

interface LocationDetail {
    id: string;
    name: string;
    description?: string | null;
    status: string;
    spatialFormat?: string | null;
    _count?: { parcels?: number };
}
interface ParcelsResp {
    locationId: string;
    bounds: [number, number, number, number] | null;
    parcels: Array<{
        id: string;
        name: string;
        areaHa?: number | null;
        cropType?: string | null;
        geometry: unknown;
        soilType?: string | null;
        soilJson?: SoilProfile | null;
        cadastralId?: string | null;
        ekatte?: string | null;
        properties?: unknown;
        companyOwners?: Array<{ name: string; eik: string; rightType: string | null; subjectKind: string | null }>;
        hasActiveLease?: boolean;
    }>;
}
interface OperationItem {
    id: string;
    key?: string | null;
    title: string;
    status: string;
    assignee?: { id: string; name?: string | null } | null;
    _count?: { operationParcels?: number };
}

// Crop options for the parcel Crop dropdown live in the shared catalogue
// (src/lib/agriculture/crop-options.ts) so the import crop-step (#7), map
// crop icons (#1), and crop planning (#9) all pick from the same list.

/**
 * Inline crop picker for a parcel row in the Parcels dropdown. Choosing a
 * crop PATCHes `cropType` and refreshes the list. An existing crop that
 * isn't one of the six options is still shown (as its own synthetic value)
 * so an imported cropType is never hidden.
 */
function ParcelCropSelect({
    value,
    onChange,
}: {
    value: string | null;
    onChange: (cropType: string) => Promise<void> | void;
}) {
    const t = useTranslations('locations.detail');
    const tCrops = useTranslations('crops');
    const [saving, setSaving] = useState(false);
    const options = localizedCropOptions(tCrops);
    const selected =
        options.find((o) => o.value === value) ??
        (value ? { value, label: cropLabel(tCrops, value), meta: { season: '' } } : null);
    return (
        // Stop the row-click (which opens the parcel sheet) from firing when
        // the operator interacts with the crop dropdown.
        <div onClick={(e) => e.stopPropagation()}>
            <Combobox
                options={options}
                selected={selected}
                setSelected={(o) => {
                    setSaving(true);
                    Promise.resolve(onChange(o?.value ?? '')).finally(() => setSaving(false));
                }}
                optionRight={(o) =>
                    o.meta?.season ? (
                        <span className="text-xs text-content-subtle">{o.meta.season}</span>
                    ) : null
                }
                placeholder={t('setCropPlaceholder')}
                hideSearch
                matchTriggerWidth
                caret
                buttonProps={{ className: 'w-full', disabled: saving }}
            />
        </div>
    );
}

/**
 * The filter context has to sit ABOVE everything that reads it, so the
 * page splits into a provider shell and the body — the same shape
 * `ExchangeClient` uses for the marketplace map.
 */
export default function LocationDetailPage() {
    const filterCtx = useFilterContext([], PARCEL_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <LocationDetailBody />
        </FilterProvider>
    );
}

function LocationDetailBody() {
    const t = useTranslations('locations.detail');
    const tl = useTranslations('locations');
    const tCommon = useTranslations('common');
    const tCrops = useTranslations('crops');
    const tAgStatus = useTranslations('agStatus');
    const tSoil = useTranslations('ag.soil');
    const { tenantSlug, locationId } = useParams<{ tenantSlug: string; locationId: string }>();
    const buildUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { isMobile } = useMediaQuery();
    const toast = useToast();
    const searchParams = useSearchParams();
    // Default to the Map tab — the field view operators reach for first. An
    // explicit `?tab=` deep-link still wins, resolved synchronously here so
    // there's no overview→map flash on load.
    const [tab, setTab] = useState<Tab>(() => {
        const t = searchParams.get('tab');
        return t === 'overview' || t === 'map' || t === 'operations' ? t : 'map';
    });
    // Overview crop filter (#2): null = all crops. Chips are shown only when
    // more than one crop is present on the location.
    //
    // The value lives in the Epic 53 filter context — and therefore in the
    // URL — rather than in local state. Two mechanisms narrowing ONE table
    // is how a count ends up disagreeing with the rows beneath it, and the
    // map's cluster facet had to be on the platform regardless.
    const { state: filterState, set: setFilter, hasActive } = useFilters();
    const cropFilter = filterState.crop?.[0] ?? null;
    // `set(key, '')` deletes the key: an absent facet, not an empty array.
    const setCropFilter = useCallback((v: string | null) => setFilter('crop', v ?? ''), [setFilter]);

    // Parcel-overview map selection.
    //
    // A cluster id is an FNV-1a hash of its member set, and every zoom tier
    // re-cuts that membership — so the URL facet carries the pitch the id
    // was minted at (`c1abc@8`). Without it a shared link resolves to no
    // cluster at all and the table renders a confident "no parcels" on the
    // strength of a failed lookup.
    //
    // `clusterSelection` holds the members SNAPSHOTTED at selection time.
    // The table filters on the snapshot, never on a live re-lookup, so the
    // user can keep zooming and the group they picked stays the group they
    // picked.
    const clusterTokenRaw = filterState.cluster?.[0] ?? null;
    const clusterToken = useMemo(() => parseClusterToken(clusterTokenRaw), [clusterTokenRaw]);
    const [clusterSelection, setClusterSelection] = useState<ClusterSelection | null>(null);
    const needsClusterResolve = clusterToken !== null && clusterSelection?.id !== clusterToken.id;
    const [viewZoomTier, setViewZoomTier] = useState(() => clusterToken?.zoomTier ?? DEFAULT_ZOOM_TIER);
    // Cold load pins the payload to the token's own tier, so the very first
    // response is the one that can answer it.
    const fetchZoomTier = needsClusterResolve && clusterToken ? clusterToken.zoomTier : viewZoomTier;
    const [selected, setSelected] = useState<string[]>([]);
    // Mobile: the tapped parcel surfaced in the bottom-sheet (vaul). The
    // sheet replaces the inline side panel below the map on phones; desktop
    // keeps the side panel.
    // Deep-link entry (QR codes on parcels): `?parcelId` opens that parcel's
    // detail sheet. Seeded from the URL in the state initializer — a mount-only
    // effect would cascade a second render (and trip
    // `react-hooks/set-state-in-effect`). The tab (defaulting to map) is
    // resolved synchronously above, so reading searchParams during render is
    // already this page's established pattern.
    const [sheetParcelId, setSheetParcelId] = useState<string | null>(
        () => searchParams.get('parcelId'),
    );
    const [showImport, setShowImport] = useState(false);
    const [manageOpen, setManageOpen] = useState(false);
    const [showDelete, setShowDelete] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
    const [activeJob, setActiveJob] = useState<string | null>(null);
    // Satellite vegetation-index overlay (Google Earth Engine). At most one
    // index (NDVI / NDMI / NDRE / GNDVI / EVI) is active at a time — they are
    // mutually exclusive. `null` = off (the default). The single inspection
    // date below drives whichever is active; it sets the 30-day composite
    // window (UTC-midnight DateValue per the picker contract, default today).
    const [activeIndex, setActiveIndex] = useState<VegetationIndex | null>(null);
    // Soil view — colour parcels by soil class. Mutually exclusive with the
    // vegetation-index overlay (turning one on clears the other) so the map
    // never carries two competing data layers at once.
    const [soilView, setSoilView] = useState(false);
    // Bulgarian cadastre (КККР / АГКК) overlay toggle. Independent of the
    // soil / vegetation-index layers — it's a reference boundary layer drawn
    // below the tenant's own parcels, so it coexists rather than being mutually
    // exclusive. Online-only (WMS is live, not in the offline pack).
    const [cadastreOn, setCadastreOn] = useState(false);
    // Map tab: swap the satellite renderer for the 2D parcel-group locator.
    // A view switch, not a layer — the two are different libraries and only
    // one can occupy the slot. Every satellite-only control (index chips,
    // soil toggle, imagery date, cadastre overlay, the index legend and the
    // soil legend) hides while the locator is up: they drive a raster that
    // is no longer on screen, and leaving them would offer the operator
    // switches wired to nothing.
    const [showLocator, setShowLocator] = useState(false);
    // `online` gates the cadastre toggle (offline → disabled with a hint). The
    // offline primitive is the canonical connectivity source in the operator PWA.
    const { online } = useOfflineSync();
    const [imageryDate, setImageryDate] = useState<DateValue>(() => {
        const n = new Date();
        return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
    });
    // Merge: name-the-union modal (mirrors the draw → name-parcel flow).
    const [mergeOpen, setMergeOpen] = useState(false);
    const [mergeName, setMergeName] = useState('');
    const [merging, setMerging] = useState(false);
    const [mergeError, setMergeError] = useState<string | null>(null);

    const locQ = useTenantSWR<LocationDetail>(`/locations/${locationId}`);
    const parcelsQ = useTenantSWR<ParcelsResp>(`/locations/${locationId}/parcels`);
    const opsQ = useTenantSWR<OperationItem[]>(tab === 'operations' ? `/locations/${locationId}/operations` : null);
    // Recall + weather + crop-plan suggestions for this field (editable;
    // powers the spray-window/next-task banner + the wizard prefills).
    const smartQ = useTenantSWR<LocationSmartDefaults>(`/locations/${locationId}/smart-defaults`);
    // Proximity clusters for the locator. Fetched wherever it can actually
    // be on screen — above the parcels table on Overview, or holding the
    // map slot on the Map tab — and nowhere else, so the satellite view
    // pays nothing for a view it is not showing.
    const locatorVisible = tab === 'overview' || (tab === 'map' && showLocator);
    const overviewQ = useTenantSWR<ParcelOverview>(
        locatorVisible ? `/locations/${locationId}/parcel-clusters?zoom=${fetchZoomTier}` : null,
    );
    // Active-index tiles (GEE) — fetched only when the Map tab is open AND an
    // index is selected, re-fetched when the index OR the inspection date
    // changes (the SWR key carries both). One query serves whichever of the
    // five indices is active; the route slug comes from the index config.
    const activeSpec = vegetationIndexById(activeIndex);
    const imageryYmd = toYMD(imageryDate);
    // Compact trigger label ("30 Jun", no year) so the index buttons + date
    // practice stay narrow enough to sit on one row. UTC parts mirror the
    // date-utils UTC-midnight contract (no tz drift).
    const imageryShort = imageryDate
        ? `${imageryDate.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][imageryDate.getUTCMonth()]}`
        : t('dateFallback');
    const indexQ = useTenantSWR<{ configured: boolean; tileUrl: string; date?: string; error?: string }>(
        tab === 'map' && activeSpec
            ? `/agro/${activeSpec.route}?locationId=${locationId}${imageryYmd ? `&date=${imageryYmd}` : ''}`
            : null,
    );
    // КАИС cadastre import feature flag (server-computed; the URL is never
    // exposed to the client). Gates the "От кадастъра" tab in the import modal.
    const cadastreImportCfgQ = useTenantSWR<{ enabled: boolean }>(`/locations/${locationId}/cadastre-import`);
    const cadastreEnabled = cadastreImportCfgQ.data?.enabled ?? false;
    const indexConfigured = indexQ.data?.configured ?? true;
    const indexTileUrl = indexQ.data?.tileUrl ?? '';
    // The REAL acquisition date of the rendered composite (the route reports the
    // imagery's own date, which the adaptive-window fallback can push earlier
    // than the requested one). The picker keeps showing the user's selection;
    // this drives the "imagery actually from …" note beside the legend.
    const actualImageryYmd = indexQ.data?.date ?? '';
    const indexLoading = !!activeSpec && !indexQ.data && !indexQ.error;

    // Cadastre overlay availability — a server-only feature flag (the upstream
    // WMS URL never reaches the client). When unconfigured the toggle stays
    // hidden entirely. Fetched only while the Map tab is open.
    const cadastreCfgQ = useTenantSWR<{ configured: boolean }>(
        tab === 'map' ? '/cadastre/config' : null,
    );
    // FREE vector parcels overlay availability (the default that actually
    // renders). Independent server flag; when set the single cadastre toggle
    // PREFERS this vector overlay over the raster WMS path.
    const cadastreParcelsCfgQ = useTenantSWR<{ configured: boolean }>(
        tab === 'map' ? '/cadastre/parcels/config' : null,
    );
    const cadastreRasterConfigured = cadastreCfgQ.data?.configured ?? false;
    const cadastreVectorConfigured = cadastreParcelsCfgQ.data?.configured ?? false;
    // ONE toggle for the cadastre overlay: shown when EITHER source is
    // configured; it drives the vector overlay when that env is set (preferred),
    // else the raster WMS path. Never two cadastre toggles.
    const cadastreConfigured = cadastreVectorConfigured || cadastreRasterConfigured;

    const loc = locQ.data;
    const parcels = useMemo(() => parcelsQ.data?.parcels ?? [], [parcelsQ.data]);
    const totalAreaHa = useMemo(
        () => parcels.reduce((sum, p) => sum + (p.areaHa ?? 0), 0),
        [parcels],
    );
    // Land tenure rollup: how many of the location's parcels are leased (аренда/наем).
    const leasedCount = useMemo(() => parcels.filter((p) => p.hasActiveLease).length, [parcels]);
    const bounds = parcelsQ.data?.bounds ?? null;
    const mapParcels = useMemo<MapParcel[]>(
        () => parcels.map((p) => ({ id: p.id, name: p.name, areaHa: p.areaHa ?? null, geometry: (p.geometry ?? null) as Geometry | null })),
        [parcels],
    );

    // Crop-glyph overlay (#1): parcelId → crop value, plus the distinct set of
    // crops present (for the legend). cropType already flows from the parcels
    // API; the map draws a glyph per parcel that has one.
    const cropById = useMemo<Record<string, string>>(() => {
        const map: Record<string, string> = {};
        for (const p of parcels) {
            if (p.cropType) map[p.id] = p.cropType;
        }
        return map;
    }, [parcels]);
    const cropsPresent = useMemo<string[]>(() => {
        const seen = new Set<string>();
        for (const p of parcels) {
            if (p.cropType) seen.add(p.cropType);
        }
        return Array.from(seen);
    }, [parcels]);
    // Parcel names by id — the overview map holds ids and needs a label
    // once it is zoomed past clustering. The names are already here, so the
    // clusters payload deliberately does not repeat them.
    const parcelNames = useMemo(() => {
        const m = new Map<string, string>();
        for (const p of parcels) m.set(p.id, p.name);
        return m;
    }, [parcels]);

    const clusterMemberIds = useMemo(
        () => (clusterSelection ? new Set(clusterSelection.parcelIds) : null),
        [clusterSelection],
    );

    // Overview parcels list — sorted by area DESCENDING by default (largest
    // fields first, #2), then narrowed by the crop chip and the map's
    // cluster selection. Both facets compose; either alone is the whole
    // list minus that one cut.
    const overviewParcels = useMemo(() => {
        const sorted = [...parcels].sort(
            (a, b) => (b.areaHa ?? 0) - (a.areaHa ?? 0) || a.name.localeCompare(b.name),
        );
        const byCrop = cropFilter ? sorted.filter((p) => p.cropType === cropFilter) : sorted;
        return clusterMemberIds ? byCrop.filter((p) => clusterMemberIds.has(p.id)) : byCrop;
    }, [parcels, cropFilter, clusterMemberIds]);

    // Resolve a URL token once the payload minted at its tier arrives.
    // Gated on `isValidating` so a keepPreviousData response from the
    // PREVIOUS tier can never be mistaken for an answer to this one.
    //
    // This trips `react-hooks/set-state-in-effect` (a warning), and the
    // trade is deliberate: the resolution CANNOT be a lazy initializer
    // like `sheetParcelId`'s, because the payload does not exist at
    // mount, and it cannot be a plain derivation during render, because
    // the result has to be PINNED — re-deriving it against each new
    // payload is precisely the live re-lookup the snapshot exists to
    // avoid. External data arriving and being latched once is the case
    // the rule's own guidance carves out.
    useEffect(() => {
        if (!needsClusterResolve || !clusterToken) return;
        if (!overviewQ.data || overviewQ.isValidating) return;
        const resolved = resolveClusterSelection(overviewQ.data, clusterToken);
        if (resolved) {
            setClusterSelection(resolved);
        } else {
            // The group is genuinely gone (parcels moved or deleted). Clear
            // the facet rather than filtering the table to zero rows and
            // presenting that as an empty holding.
            setClusterSelection(null);
            setFilter('cluster', '');
        }
    }, [needsClusterResolve, clusterToken, overviewQ.data, overviewQ.isValidating, setFilter]);

    const handleClusterSelect = useCallback(
        (sel: ClusterSelection | null) => {
            setClusterSelection(sel);
            setFilter('cluster', sel ? encodeClusterToken(sel.id, sel.zoomTier) : '');
        },
        [setFilter],
    );

    const sheetParcel = useMemo<ParcelSheetData | null>(() => {
        const p = parcels.find((x) => x.id === sheetParcelId);
        return p
            ? {
                id: p.id,
                name: p.name,
                areaHa: p.areaHa ?? null,
                cropType: p.cropType ?? null,
                soilJson: p.soilJson ?? null,
                cadastralId: p.cadastralId ?? null,
                properties: p.properties ?? null,
                companyOwners: p.companyOwners ?? [],
            }
            : null;
    }, [parcels, sheetParcelId]);

    // Soil-view colouring: parcelId → class colour, plus the set of classes
    // present (for the legend) and whether any parcel is still "soil pending".
    const soilColorById = useMemo<Record<string, string>>(() => {
        const map: Record<string, string> = {};
        for (const p of parcels) {
            const texture = p.soilJson?.textureClass ?? null;
            if (texture) map[p.id] = soilColorForTexture(texture);
        }
        return map;
    }, [parcels]);
    const soilClasses = useMemo<UsdaTextureClass[]>(() => {
        const seen = new Set<UsdaTextureClass>();
        for (const p of parcels) {
            const texture = p.soilJson?.textureClass ?? null;
            if (texture) seen.add(texture);
        }
        return Array.from(seen);
    }, [parcels]);
    const soilHasPending = useMemo(
        () => parcels.some((p) => !p.soilJson?.textureClass),
        [parcels],
    );

    // On phones, tapping a parcel both selects it and opens the bottom-sheet
    // for the freshly-tapped parcel; on desktop selection just feeds the
    // inline side panel (no sheet).
    const handleMapSelection = (ids: string[]) => {
        if (isMobile) {
            const added = ids.find((id) => !selected.includes(id));
            if (added) setSheetParcelId(added);
        }
        setSelected(ids);
    };

    type ParcelRow = ParcelsResp['parcels'][number];

    // Set a parcel's crop from the Crop dropdown. Empty ⇒ clear (null).
    const setParcelCrop = useCallback(
        async (parcelId: string, cropType: string) => {
            await apiPatch(buildUrl(`/locations/${locationId}/parcels/${parcelId}`), {
                cropType: cropType || null,
            });
            await parcelsQ.mutate();
        },
        [buildUrl, locationId, parcelsQ],
    );

    const parcelColumns = useMemo(
        () =>
            createColumns<ParcelRow>([
                {
                    accessorKey: 'name',
                    header: t('colName'),
                    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
                    // Mobile (<sm) card heading.
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'crop',
                    header: t('colCrop'),
                    cell: ({ row }) => (
                        <ParcelCropSelect
                            value={row.original.cropType ?? null}
                            onChange={(crop) => setParcelCrop(row.original.id, crop)}
                        />
                    ),
                    // Mobile card key/value row — the parcel's crop.
                    meta: { mobileCard: { slot: 'meta', label: t('colCrop') } },
                },
                {
                    id: 'areaDca',
                    header: t('colAreaDca'),
                    // Area in DECARES (дка = ha × 10, the Bulgarian standard) —
                    // matches the journal + farm-record PDF, which are already dca.
                    cell: ({ row }) =>
                        row.original.areaHa != null ? trimNumber(haToDca(row.original.areaHa)) : '—',
                    // Mobile card key/value row — parcel area.
                    meta: { mobileCard: { slot: 'meta', label: t('colAreaDca') } },
                },
                {
                    id: 'cadastralId',
                    // Expose the value so the mobile card can drop the row when a
                    // parcel has no cadastral identifier (hideWhenEmpty below).
                    accessorFn: (row) => row.cadastralId ?? null,
                    header: t('colCadastralId'),
                    // Bulgarian КАИС cadastral identifier + КАИС deep link, with a
                    // subtle badge when the documentary area diverges >5%.
                    cell: ({ row }) => (
                        <ParcelCadastralInfo
                            cadastralId={row.original.cadastralId ?? null}
                            areaHa={row.original.areaHa ?? null}
                            properties={row.original.properties ?? null}
                            layout="compact"
                        />
                    ),
                    // Mobile card key/value row — the cadastral identifier; hidden
                    // when the parcel has none (no orphaned empty label).
                    meta: { mobileCard: { slot: 'meta', label: t('colCadastralId'), hideWhenEmpty: true } },
                },
                {
                    id: 'viewOnMap',
                    header: '',
                    // Jump to this parcel on the Map tab (frames + selects it via
                    // flyToOnSelect). stopPropagation so the card's row-click
                    // (which opens the parcel sheet) doesn't also fire.
                    cell: ({ row }) => (
                        <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t('viewOnMap')}
                            icon={<MapPosition className="size-4" aria-hidden="true" />}
                            onClick={(e) => {
                                e.stopPropagation();
                                setSelected([row.original.id]);
                                setTab('map');
                            }}
                        />
                    ),
                    // Mobile card: anchored top-right of the card.
                    meta: { mobileCard: { slot: 'status' } },
                },
            ]),
        [setParcelCrop, setSelected, setTab, t],
    );


    const mergeParcels = async () => {
        if (selected.length < 2 || !mergeName.trim()) return;
        setMerging(true);
        setMergeError(null);
        try {
            await apiPost(buildUrl(`/locations/${locationId}/parcels/merge`), {
                parcelIds: selected,
                name: mergeName.trim(),
            });
            setMergeOpen(false);
            setMergeName('');
            setSelected([]);
            await parcelsQ.mutate();
            await locQ.mutate();
        } catch (err) {
            setMergeError(err instanceof ApiClientError ? err.message : t('mergeFailed'));
        } finally {
            setMerging(false);
        }
    };

    const tabs = [
        { key: 'overview' as const, label: t('tabOverview') },
        { key: 'map' as const, label: t('tabMap') },
        { key: 'operations' as const, label: t('tabOperations') },
    ];

    const breadcrumbs: { label: string; href?: string }[] = [
        { label: tl('bcLocations'), href: `/t/${tenantSlug}/locations` },
        { label: loc?.name ?? t('fallbackTitle') },
    ];

    return (
        <EntityDetailLayout<Tab>
            breadcrumbs={breadcrumbs}
            back={{ smart: true }}
            title={loc?.name ?? t('fallbackTitle')}
            loading={locQ.isLoading && !loc}
            error={locQ.error ? t('loadError') : null}
            actions={
                <div className="flex items-center gap-compact">
                    <Popover
                        openPopover={manageOpen}
                        setOpenPopover={setManageOpen}
                        content={
                            <Popover.Menu aria-label={t('manageParcels')}>
                                <Popover.Item onClick={() => { setManageOpen(false); setShowImport(true); }}>
                                    {t('importParcels')}
                                </Popover.Item>
                                <Popover.Item destructive onClick={() => { setManageOpen(false); setShowDelete(true); }}>
                                    {t('deleteParcels')}
                                </Popover.Item>
                            </Popover.Menu>
                        }
                    >
                        <Button variant="secondary" size="sm">{t('manageParcels')}</Button>
                    </Popover>
                    {/* Cadastre (КККР / АГКК) boundaries overlay toggle — icon
                        only, sits just left of the download button. Only on the
                        Map tab (it drives the map overlay) and only when an
                        operator configured an upstream. Online-only: disabled
                        with a hint offline (the overlay isn't in the offline
                        pack). Moved here from the in-map practices row, where its
                        text label overflowed the row on phones. */}
                    {/* Parcel-group locator — a VIEW switch for the map slot,
                        so it lives with the page-level actions rather than
                        among the index/soil chips, which are data layers on
                        the satellite raster. Icon-only to fit the row; the
                        tooltip and aria-label carry the name. */}
                    {tab === 'map' && parcels.length > 0 && (
                        <Tooltip content={t('overviewMapTitle')}>
                            <Button
                                variant={showLocator ? 'primary' : 'secondary'}
                                size="sm"
                                className="min-h-[44px]"
                                icon={<LocationPin className="size-4" aria-hidden="true" />}
                                onClick={() => setShowLocator((on) => !on)}
                                aria-pressed={showLocator}
                                aria-label={t('overviewMapTitle')}
                            />
                        </Tooltip>
                    )}
                    {cadastreConfigured && tab === 'map' && !showLocator && (
                        <Tooltip content={t('cadastreOfflineHint')} disabled={online}>
                            <Button
                                variant={cadastreOn ? 'primary' : 'secondary'}
                                size="sm"
                                className="min-h-[44px]"
                                icon={<GridIcon className="size-4" aria-hidden="true" />}
                                disabled={!online}
                                onClick={() => setCadastreOn((on) => !on)}
                                aria-pressed={cadastreOn}
                                aria-label={
                                    cadastreVectorConfigured
                                        ? t('cadastreBoundariesToggle')
                                        : t('cadastreToggle')
                                }
                            />
                        </Tooltip>
                    )}
                    {/* Offline-map download — icon-only in the header action
                        row. Renders nothing until the location has a bbox.
                        (The per-location farm-record PDF export used to live
                        here; it was removed as redundant — the identical
                        export is reachable from each Journal entry.) */}
                    <DownloadBasemapButton
                        locationId={locationId}
                        bounds={bounds}
                        iconOnly
                        className="min-h-[44px]"
                    />
                </div>
            }
            tabs={tabs}
            activeTab={tab}
            onTabChange={setTab}
        >
            {tab === 'overview' && (
                <div className="space-y-default">
                    <SmartDefaultsBanner data={smartQ.data} />
                    {/* Compact info row below the tabs — just the two headline
                        figures (parcel count + total area). */}
                    <dl className="grid grid-cols-2 gap-default text-sm">
                        <div><dt className="text-content-secondary">{t('overviewParcels')}</dt><dd className="font-medium">{loc?._count?.parcels ?? parcels.length}</dd></div>
                        <div><dt className="text-content-secondary">{t('overviewTotalArea')}</dt><dd className="font-medium">{trimNumber(haToDca(totalAreaHa))} dca</dd></div>
                        {leasedCount > 0 ? (
                            <div><dt className="text-content-secondary">{t('overviewLeased')}</dt><dd className="font-medium">{leasedCount}</dd></div>
                        ) : null}
                    </dl>

                    {/* Land obligations — the full rent roll now lives on the
                        dedicated Rent page; here we deep-link to it scoped to
                        this location, shown only when the location has leases. */}
                    {leasedCount > 0 ? (
                        <a
                            href={tenantHref(`/rent?locationId=${locationId}`)}
                            className="flex items-center justify-between gap-default rounded-lg border border-border-subtle bg-bg-default p-3 text-sm hover:border-border-emphasis"
                        >
                            <span className="font-medium text-content-emphasis">{t('viewRent')}</span>
                            <span aria-hidden="true" className="text-content-link">→</span>
                        </a>
                    ) : null}
                    {loc?.description && <p className="text-sm">{loc.description}</p>}
                    {parcels.length === 0 && (
                        <div className="rounded-lg border border-border-subtle p-6 text-sm text-content-secondary">
                            {t('noParcelsHint')}
                        </div>
                    )}
                    {/* Parcel-overview locator (P3). Sits directly above the
                        crop chips and the parcels list because clicking a
                        group has to be visibly the thing that narrows them —
                        a map in a different tab from the table it filters is
                        a map you have to take on faith. The satellite
                        MapCanvas keeps the Map tab to itself, untouched. */}
                    {parcels.length > 0 && (
                        <ParcelOverviewMap
                            overview={overviewQ.data ?? null}
                            loading={overviewQ.isLoading && !overviewQ.data}
                            error={Boolean(overviewQ.error)}
                            parcelNames={parcelNames}
                            selection={clusterSelection}
                            onSelect={handleClusterSelect}
                            onParcelOpen={setSheetParcelId}
                            zoomTier={viewZoomTier}
                            onZoomTierChange={setViewZoomTier}
                        />
                    )}
                    {/* Per-culture filter chips (#2) — filter the parcels list
                        by crop. Shown only when the location grows more than
                        one crop; "All" clears the filter. */}
                    {cropsPresent.length > 1 && (
                        <ToggleGroup
                            size="sm"
                            ariaLabel={t('cropFilterLabel')}
                            selected={cropFilter ?? 'all'}
                            selectAction={(v) => setCropFilter(v === 'all' ? null : v)}
                            options={[
                                { value: 'all', label: t('cropFilterAll') },
                                ...cropsPresent.map((c) => ({ value: c, label: cropLabel(tCrops, c) })),
                            ]}
                        />
                    )}
                    {/* Parcels list — collapsible dropdown under the
                        Parcels / Total area row. Sorted largest-first (#2). */}
                    {parcels.length > 0 && (
                        <Accordion
                            type="single"
                            collapsible
                            className="rounded-lg border border-border-subtle"
                        >
                            <AccordionItem value="parcels" density="compact">
                                <AccordionTrigger size="sm" className="px-4">
                                    <span className="flex items-center gap-tight">
                                        <span className="font-medium">{t('parcelsAccordion')}</span>
                                        <span className="text-xs text-content-secondary">
                                            {/* Any active facet ⇒ show what is actually
                                                on screen. Keying this off the crop chip
                                                alone would print the unfiltered total
                                                above a cluster-filtered table. */}
                                            {hasActive ? overviewParcels.length : (loc?._count?.parcels ?? parcels.length)}
                                        </span>
                                    </span>
                                </AccordionTrigger>
                                <AccordionContent size="sm">
                                    <DataTable<ParcelRow>
                                        data={overviewParcels}
                                        columns={parcelColumns}
                                        getRowId={(p) => p.id}
                                        // <sm: render each parcel as a card. Tapping a
                                        // card opens the parcel bottom-sheet (area /
                                        // crop / apply-rate calc / "Start operation
                                        // here") — the same sheet a map tap opens.
                                        mobileFallback="card"
                                        onRowClick={(row) => setSheetParcelId(row.original.id)}
                                        loading={parcelsQ.isLoading && parcels.length === 0}
                                    />
                                </AccordionContent>
                            </AccordionItem>
                        </Accordion>
                    )}
                </div>
            )}

            {tab === 'map' && (
                <div className="space-y-default">
                    <SmartDefaultsBanner data={smartQ.data} />
                    <div className="flex flex-wrap items-center gap-compact">
                        {/* Satellite index overlays (GEE) — the toggle row +
                            the shared inspection date sit together as one
                            left-aligned unit (date to the RIGHT of the
                            buttons), in the row position the Select/Draw/Edit/
                            Split toggle used to hold. Only one index is on at a
                            time (mutually exclusive); the single date picker
                            drives whichever is active. The buttons are
                            config-driven from VEGETATION_INDICES so adding an
                            index is one catalogue entry. */}
                        {/* Satellite-only controls. They drive overlays on the
                            MapLibre raster, so they hide entirely while the 2D
                            locator holds the map slot — a toggle wired to a
                            layer that is not on screen is worse than no toggle. */}
                        {!showLocator && (
                        <div className="flex shrink-0 flex-wrap items-center gap-compact">
                            {VEGETATION_INDICES.map((idx) => {
                                const on = activeIndex === idx.id;
                                return (
                                    <Button
                                        key={idx.id}
                                        variant={on ? 'primary' : 'secondary'}
                                        size="sm"
                                        className="min-h-[44px] px-2"
                                        onClick={() => {
                                            setActiveIndex((cur) => (cur === idx.id ? null : idx.id));
                                            setSoilView(false);
                                        }}
                                        aria-pressed={on}
                                    >
                                        {idx.label}
                                    </Button>
                                );
                            })}
                            {/* Soil view toggle — colours parcels by soil
                                class. Clears any active vegetation index so
                                only one data layer shows at a time. */}
                            <Button
                                variant={soilView ? 'primary' : 'secondary'}
                                size="sm"
                                className="min-h-[44px] px-2"
                                onClick={() => {
                                    setSoilView((on) => {
                                        if (!on) setActiveIndex(null);
                                        return !on;
                                    });
                                }}
                                aria-pressed={soilView}
                            >
                                {tSoil('viewToggle')}
                            </Button>
                            {/* Cadastre boundaries toggle moved to the header
                                action row (icon-only, left of the download
                                button) — its text label overflowed this practices
                                row on phones. */}
                            {activeSpec && (
                                <DatePicker
                                    id="imagery-date-input"
                                    value={imageryDate}
                                    onChange={(d) => setImageryDate(d)}
                                    placeholder={t('dateFallback')}
                                    // The indices need a past satellite pass —
                                    // future dates have no imagery.
                                    disabledDays={{ after: new Date() }}
                                    // Compact trigger (icon + "30 Jun") keeps the
                                    // practice narrow so it fits beside the toggles.
                                    trigger={({ open }) => (
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            size="sm"
                                            className="min-h-[44px] shrink-0"
                                            icon={<CalendarIcon className="size-4" aria-hidden="true" />}
                                            aria-haspopup="dialog"
                                            aria-expanded={open}
                                            aria-label={t('imageryAriaLabel', { date: imageryShort })}
                                        >
                                            {imageryShort}
                                        </Button>
                                    )}
                                />
                            )}
                        </div>
                        )}
                        {selected.length >= 2 && (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => { setMergeError(null); setMergeName(''); setMergeOpen(true); }}
                            >
                                {t('merge')}
                            </Button>
                        )}
                    </div>
                    {/* Active-index status line: loading / not-configured /
                        legend / error / no-imagery. Driven by the active
                        index's config (label, ramp, low/high captions). */}
                    {activeSpec && !showLocator && (
                        <div className="flex items-center gap-compact text-xs text-content-subtle">
                            {indexLoading ? (
                                <span>{t('loadingImagery', { index: activeSpec.label })}</span>
                            ) : indexConfigured === false ? (
                                <span>{t('imageryNotConfigured', { index: activeSpec.label })}</span>
                            ) : indexTileUrl ? (
                                <>
                                    <span className="font-medium text-content-secondary">{activeSpec.label}</span>
                                    <span>{activeSpec.lowLabel}</span>
                                    <span
                                        aria-hidden="true"
                                        className={cn('h-2 w-24 rounded-full', activeSpec.legendGradientClass)}
                                    />
                                    <span>{activeSpec.highLabel}</span>
                                    {/* The composite falls back to the latest
                                        available pass when the picked date has no
                                        imagery, so the raster on screen can be
                                        older than the date in the picker. Say so
                                        whenever the two differ — silence would
                                        label old imagery with a fresh date. */}
                                    {actualImageryYmd && actualImageryYmd !== imageryYmd && (
                                        <span className="text-content-muted">
                                            {t('imageryActualDate', { date: actualImageryYmd })}
                                        </span>
                                    )}
                                    {/* Deep-links to the exact section of the
                                        imagery explainer for the active index. */}
                                    <a
                                        href={`${tenantHref('/knowledge/satellite')}#${activeSpec.id}`}
                                        className="ml-1 inline-flex items-center gap-tight text-content-link underline hover:text-content-emphasis"
                                    >
                                        {t('indexLearnMore')}
                                    </a>
                                </>
                            ) : indexQ.data?.error ? (
                                <span>{t('imageryLoadError', { index: activeSpec.label })}</span>
                            ) : (
                                <span>{t('imageryNone', { index: activeSpec.label })}</span>
                            )}
                        </div>
                    )}
                    <div className={cn('gap-section', !isMobile && 'grid grid-cols-1 md:grid-cols-[1fr_320px]')}>
                        {/* One slot, two renderers. MapLibre GL and the 2D
                            canvas have different rendering models — there is
                            no single canvas that is both — so they swap
                            rather than stack. MapCanvas is unmounted while
                            the locator is up, which also drops its WebGL
                            context and tile fetches. */}
                        {showLocator ? (
                            <ParcelOverviewMap
                                overview={overviewQ.data ?? null}
                                loading={overviewQ.isLoading && !overviewQ.data}
                                error={Boolean(overviewQ.error)}
                                parcelNames={parcelNames}
                                selection={clusterSelection}
                                onSelect={handleClusterSelect}
                                onParcelOpen={setSheetParcelId}
                                zoomTier={viewZoomTier}
                                onZoomTierChange={setViewZoomTier}
                                canvasClassName={isMobile
                                    ? 'h-[calc(100dvh-22rem)] min-h-[18rem]'
                                    : 'h-[360px] md:h-[480px]'}
                            />
                        ) : (
                        <MapCanvas
                            parcels={mapParcels}
                            bounds={bounds}
                            selectedIds={selected}
                            onSelectionChange={handleMapSelection}
                            // Frame the parcel when the overview "view on map"
                            // button selects a single one (operator focus).
                            flyToOnSelect
                            // Phone-native: thumb-reachable zoom + find-my-field
                            // (with live-tracking), lifted clear of the fixed
                            // bottom-tab bar.
                            showPractices
                            practicesBottomInset={isMobile ? 76 : 12}
                            liveTracking
                            // Full-bleed on phones — edge-to-edge (cancel the
                            // page's px-4) and near-viewport-tall so the map is
                            // the operator's primary screen. The frame closes on
                            // all four sides (`border-2`, not `border-y-2`): a
                            // top/bottom-only rule read as an unfinished frame
                            // against the page background.
                            className={isMobile
                                ? '-mx-4 h-[calc(100dvh-15rem)] min-h-[22rem] overflow-hidden border-2 border-[var(--brand-default)]'
                                : 'h-[360px] w-full overflow-hidden rounded-lg border-2 border-[var(--brand-default)] md:h-[480px]'}
                            indexOverlay={
                                activeSpec && indexTileUrl
                                    ? { id: activeSpec.id, tileUrl: indexTileUrl }
                                    : null
                            }
                            // Cadastre (КККР) WMS overlay — same-origin proxy
                            // template ({z}/{x}/{y} kept literal for MapLibre to
                            // substitute). Gated on the feature being configured,
                            // the toggle being on, AND online (online-only — the
                            // WMS is never part of the offline basemap pack).
                            // Cadastre VECTOR parcels overlay — the FREE default
                            // that actually renders. Same-origin proxy endpoint;
                            // MapCanvas fetches the viewport bbox as GeoJSON.
                            // Preferred when its env is configured; gated on the
                            // toggle being on AND online (online-only).
                            cadastreParcels={
                                cadastreVectorConfigured && cadastreOn && online
                                    ? { url: buildUrl(`/cadastre/parcels`) }
                                    : null
                            }
                            // Cadastre (КККР) raster WMS overlay — same-origin
                            // proxy template ({z}/{x}/{y} kept literal for
                            // MapLibre to substitute). Only drives the toggle
                            // when the VECTOR source is NOT configured (they never
                            // both render); gated on the toggle being on AND
                            // online (the WMS is never part of the offline pack).
                            cadastreOverlay={
                                !cadastreVectorConfigured && cadastreRasterConfigured && cadastreOn && online
                                    ? { tileUrl: buildUrl(`/cadastre/wms/{z}/{x}/{y}`) }
                                    : null
                            }
                            // Read-only vector-tile source (perf at scale). The
                            // {z}/{x}/{y} placeholders are kept literal for
                            // MapLibre to substitute (buildUrl doesn't encode
                            // the path). This Map tab is interactive (select),
                            // so MapCanvas no-ops the vector source here — it
                            // only engages on pure read-only mounts. Passed so
                            // the prop is exercised + ready for a future
                            // read-only farm view.
                            vectorTileUrl={buildUrl(`/locations/${locationId}/tiles/{z}/{x}/{y}.pbf`)}
                            // Same-origin offline basemap pack (Roadmap-6 P1b).
                            // The {z}/{x}/{y} placeholders stay literal for
                            // MapLibre to substitute. When offline AND the pack
                            // is available, MapCanvas swaps to a same-origin
                            // style backed by this template; online it uses
                            // MapTiler. Cross-origin MapTiler blanks at zero
                            // bars — this is the offline fallback.
                            offlineBasemapTileUrl={buildUrl(`/locations/${locationId}/basemap/{z}/{x}/{y}`)}
                            soilMode={soilView}
                            soilColorById={soilColorById}
                            cropById={cropById}
                        />
                        )}
                        {/* Side column: soil legend (soil view only). Sits in
                            the desktop side column, or stacks under the map on
                            phones. (The crop legend that also lived here was
                            removed — crops are already conveyed by the on-map
                            glyphs + the crop filter above the map.) */}
                        {soilView && !showLocator && (
                            <div className="space-y-default md:col-start-2">
                                <SoilLegend classes={soilClasses} hasPending={soilHasPending} />
                            </div>
                        )}
                        {/* Spray-job panel — desktop-only; on phones the parcel
                            bottom-sheet replaces it. */}
                        {!isMobile && (
                            <div className="rounded-lg border border-border-subtle p-4">
                                <Heading level={3} className="mb-3">{t('newSprayJob')}</Heading>
                                <PrescriptionPanel
                                    locationId={locationId}
                                    tenantSlug={tenantSlug}
                                    selectedParcelIds={selected}
                                    onCreated={() => { setSelected([]); setTab('operations'); }}
                                />
                                {selected.length >= 2 && (
                                    <p className="mt-3 text-xs text-content-subtle">
                                        {t('parcelsSelectedMerge', { count: selected.length })}
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {tab === 'operations' && (
                <div className="space-y-section">
                    {(opsQ.data ?? []).length === 0 ? (
                        <div className="rounded-lg border border-border-subtle p-6 text-sm text-content-secondary">
                            {t('noSprayJobs')}
                        </div>
                    ) : (
                        <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
                            {(opsQ.data ?? []).map((op) => (
                                <li key={op.id}>
                                    <button
                                        type="button"
                                        onClick={() => setActiveJob(activeJob === op.id ? null : op.id)}
                                        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-bg-muted/50"
                                    >
                                        <span className="text-sm font-medium">{op.key ? `${op.key} · ` : ''}{op.title}</span>
                                        <span className="text-xs text-content-secondary">{tAgStatus.has(`operation.${op.status}`) ? tAgStatus(`operation.${op.status}`) : op.status} · {t('opParcels', { count: op._count?.operationParcels ?? 0 })}</span>
                                    </button>
                                    {activeJob === op.id && (
                                        <div className="border-t border-border-subtle p-4">
                                            <FieldOperationPanel taskId={op.id} />
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            <SpatialImportModal
                locationId={locationId}
                open={showImport}
                setOpen={setShowImport}
                cadastreEnabled={cadastreEnabled}
                onImported={({ parcelCount, skipped, notFound }) => {
                    toast.success(
                        t('importedToast', { count: parcelCount }) +
                            (skipped > 0 ? t('importedSkipped', { count: skipped }) : '') +
                            (notFound && notFound.length > 0
                                ? t('importedNotFound', { list: notFound.slice(0, 5).join(', ') })
                                : '') +
                            '.',
                    );
                    locQ.mutate();
                    parcelsQ.mutate();
                }}
            />

            {/* Delete parcels — the "Manage parcels → Delete" surface. Lists the
                location's parcels; each row soft-deletes (confirmed) via the
                per-parcel DELETE route, so a field can be dropped without
                re-importing the whole set. */}
            <Modal showModal={showDelete} setShowModal={setShowDelete}>
                <Modal.Header title={t('deleteParcels')} description={t('deleteParcelsHint')} />
                <Modal.Body>
                    {parcels.length === 0 ? (
                        <p className="text-sm text-content-subtle">{t('deleteParcelsEmpty')}</p>
                    ) : (
                        <ul className="space-y-tight">
                            {parcels.map((p) => (
                                <li
                                    key={p.id}
                                    className="flex items-center justify-between gap-default rounded-lg border border-border-subtle px-3 py-2"
                                >
                                    <span className="min-w-0 truncate text-sm text-content-default">{p.name}</span>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="flex-shrink-0 text-content-error"
                                        onClick={() => setPendingDelete({ id: p.id, name: p.name })}
                                    >
                                        {tCommon('delete')}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </Modal.Body>
            </Modal>
            {pendingDelete && (
                <ConfirmDialog
                    showModal
                    setShowModal={() => setPendingDelete(null)}
                    tone="danger"
                    title={t('deleteParcelConfirmTitle', { name: pendingDelete.name })}
                    description={t('deleteParcelConfirmBody')}
                    confirmLabel={t('deleteParcelConfirmLabel')}
                    onConfirm={async () => {
                        const id = pendingDelete.id;
                        try {
                            await apiDelete(buildUrl(`/locations/${locationId}/parcels/${id}`));
                            setPendingDelete(null);
                            await parcelsQ.mutate();
                            await locQ.mutate();
                        } catch {
                            setPendingDelete(null);
                            toast.error(t('deleteParcelFailed'));
                        }
                    }}
                />
            )}

            {/* Parcel sheet — the single spray/field-operation screen (#3),
                opened by a map tap or a parcel card tap. It IS the create
                form (Fertilizer-XOR-Product + crop + operator), so there is no
                longer a separate multi-step wizard. */}
            <ParcelDetailSheet
                open={sheetParcelId !== null}
                onOpenChange={(o) => { if (!o) setSheetParcelId(null); }}
                parcel={sheetParcel}
                locationId={locationId}
                smartDefaults={smartQ.data}
                onCreated={() => { setSheetParcelId(null); setTab('operations'); void opsQ.mutate(); }}
                onCropChanged={() => { void parcelsQ.mutate(); }}
            />

            <Modal
                showModal={mergeOpen}
                setShowModal={(v) => { if (!v) { setMergeOpen(false); setMergeName(''); setMergeError(null); } }}
                size="sm"
                title={t('mergeTitle')}
                description={t('mergeDescription')}
            >
                <Modal.Header title={t('mergeTitle')} description={t('mergeHeaderDescription', { count: selected.length })} />
                <Modal.Form id="merge-parcels-form" onSubmit={(e) => { e.preventDefault(); void mergeParcels(); }}>
                    <Modal.Body>
                        <FormField label={t('mergeFieldName')} required>
                            <Input value={mergeName} onChange={(e) => setMergeName(e.target.value)} placeholder={t('mergeNamePlaceholder')} />
                        </FormField>
                        {mergeError && (
                            <div role="alert" className="mt-3 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">
                                {mergeError}
                            </div>
                        )}
                    </Modal.Body>
                    <Modal.Actions>
                        <Button variant="secondary" size="sm" type="button" onClick={() => { setMergeOpen(false); setMergeName(''); setMergeError(null); }}>{tCommon('cancel')}</Button>
                        <Button variant="primary" size="sm" type="submit" loading={merging} disabled={selected.length < 2 || !mergeName.trim() || merging}>{t('mergeTitle')}</Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>

        </EntityDetailLayout>
    );
}

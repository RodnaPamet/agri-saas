'use client';

/**
 * MapCanvas — renders a location's parcels as a MapLibre GeoJSON layer
 * and (optionally) lets the user click parcels to multi-select. Used by
 * the Location detail Map tab, the PrescriptionPanel, and the operator's
 * read-only field-operation view.
 *
 * Drawing/editing (Phase-1 fast-follow): when `mode` is 'draw', 'edit',
 * or 'split' a terra-draw (MIT) layer is mounted on the underlying
 * MapLibre map via its official adapter — 'draw' adds a polygon
 * (→ onCreateGeometry), 'edit' makes existing polygons' vertices
 * draggable (→ onUpdateGeometry, debounced), and 'split' draws a single
 * LineString blade across a parcel (→ onCreateSplitLine, then auto-
 * clears the line). 'select' (default) keeps the original click-to-select
 * behaviour and never loads terra-draw, so the read-only/operator and
 * spray-prescription paths are untouched.
 *
 * MapLibre GL (BSD-3) + react-map-gl (MIT) + terra-draw (MIT). Basemap is
 * MapTiler (satellite `hybrid` by default) when NEXT_PUBLIC_MAPTILER_KEY
 * is set, else the bare MapLibre demo style — see `resolveBasemapStyle`
 * in `@/lib/geo/basemap-style`.
 * Geometry is GeoJSON in WGS84.
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, { Layer, Marker, Source, type MapLayerMouseEvent, type MapRef } from 'react-map-gl/maplibre';
import type { Feature, FeatureCollection, Geometry, LineString, Polygon } from 'geojson';
import { validatePolygonGeometry, type PolygonValidity } from '@/lib/geo/polygon-validity';
import bbox from '@turf/bbox';
import { Crosshairs3, MapPosition, Minus, Plus } from '@/components/ui/icons/nucleo';
import { useReducedMotion } from '@/components/ui/hooks';
import { cn } from '@/lib/cn';
import type { StyleSpecification } from 'maplibre-gl';
import { SOIL_PENDING_COLOR } from '@/lib/soil/types';
import { CropGlyph } from '@/components/agriculture/CropGlyph';
import { buildOfflineBasemapStyle } from '@/lib/geo/offline-basemap-style';
import { resolveBasemapStyle } from '@/lib/geo/basemap-style';
import { getOneShotPosition } from '@/lib/geo/one-shot-position';

// Below this zoom the per-parcel crop glyphs are hidden — at a whole-region
// view they'd overlap into noise; they reappear when inspecting fields.
const CROP_ICON_MIN_ZOOM = 12;

// Below this zoom the cadastre VECTOR parcels overlay does NOT fetch — a
// region-wide view would pull thousands of official parcels into noise (and
// past the proxy's bbox-span cap). At/above it the current viewport's parcels
// are fetched on load + move (debounced). Mirrors the server-side span cap.
const CADASTRE_PARCELS_MIN_ZOOM = 15;
// Debounce (ms) between a map move settling and the parcels re-fetch, so a
// pan/zoom gesture fires one request, not one per frame.
const CADASTRE_PARCELS_FETCH_DEBOUNCE_MS = 400;

// Fallback map view when a location has no parcel geometry to fit — the whole
// of Bulgaria in frame (approx. geographic centre), not the world.
const BULGARIA_VIEW = { longitude: 25.49, latitude: 42.73, zoom: 6.4 } as const;

// Soil-region area overlay (soil view). ISRIC SoilGrids WRB "most probable
// soil class" map, served as a WMS raster (CC-BY 4.0, CORS-open, so MapLibre
// fetches tiles directly — no proxy). Drawn UNDER the parcels so a field's own
// classified fill + outline still read on top. `{bbox-epsg-3857}` is the
// MapLibre placeholder MapLibre substitutes per raster tile.
const SOIL_WRB_WMS_TILE =
    'https://maps.isric.org/mapserv?map=/map/wrb.map&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
    '&LAYERS=MostProbable&STYLES=&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:3857' +
    '&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}';
const SOIL_WRB_LEGEND =
    'https://maps.isric.org/mapserv?map=/map/wrb.map&SERVICE=WMS&VERSION=1.1.1' +
    '&REQUEST=GetLegendGraphic&LAYER=MostProbable&FORMAT=image/png';
// Data-source citation for the ISRIC WRB soil raster. The "ISRIC SoilGrids
// — WRB (CC-BY 4.0)" portion is a brand/licence token kept verbatim; only
// the localisable "Soil:" prefix is threaded through i18n at the call site.

export interface MapParcel {
    id: string;
    name: string;
    areaHa?: number | null;
    geometry: Geometry | null;
}

export type MapMode = 'select' | 'draw' | 'edit' | 'split';

export interface MapCanvasProps {
    parcels: MapParcel[];
    /** [west, south, east, north] for initial fit; world view when null. */
    bounds?: [number, number, number, number] | null;
    selectedIds?: string[];
    onSelectionChange?: (ids: string[]) => void;
    /** When false, the map is read-only (operator view). */
    interactive?: boolean;
    /** Parcels rendered as completed (green) — operator progress. */
    doneIds?: string[];
    /** Authoring mode (default 'select'). 'draw'/'edit'/'split' load terra-draw. */
    mode?: MapMode;
    /** Fired when a new polygon is drawn (draw mode). */
    onCreateGeometry?: (geometry: Polygon) => void;
    /** Fired (debounced) when an existing parcel's polygon is reshaped. */
    onUpdateGeometry?: (parcelId: string, geometry: Polygon) => void;
    /** Fired when a split line is drawn across a parcel (split mode). */
    onCreateSplitLine?: (line: LineString) => void;
    /**
     * Optimistic client-side topology feedback. Whenever a polygon is
     * drawn (draw mode) or reshaped (edit mode), the freshly-edited
     * geometry is run through `validatePolygonGeometry` and the result is
     * handed back here — letting the host page show a NON-BLOCKING hint
     * ("shape looks invalid — it will be auto-repaired on save"). This is
     * purely a UX preview: drawing is never blocked, and the server's
     * PostGIS `ST_MakeValid`/`ST_IsValid` remain the authority on persist.
     */
    onGeometryValidity?: (validity: PolygonValidity) => void;
    /**
     * Satellite vegetation-index raster overlay (Agro-intel) — NDVI / NDMI /
     * NDRE / GNDVI / EVI. The indices are mutually exclusive, so the host
     * passes at most ONE: an `{ id, tileUrl }` pair where `tileUrl` is an XYZ
     * `{z}/{x}/{y}` template from Google Earth Engine. A raster
     * `<Source>`/`<Layer>` is drawn over the AOI (the map is already fit to
     * the location's parcel bbox via `bounds`). `null`/absent or an empty
     * `tileUrl` renders nothing — the host page surfaces the loading /
     * not-configured / no-imagery state itself. `id` keys the source so
     * switching indices swaps the raster cleanly.
     */
    indexOverlay?: { id: string; tileUrl: string } | null;
    /**
     * Bulgarian cadastre (КККР / АГКК) WMS overlay — a toggleable reference
     * layer of cadastral parcel boundaries. `tileUrl` is a SAME-ORIGIN
     * `{z}/{x}/{y}` template served by the bounded cadastre proxy route (the
     * upstream WMS URL never reaches the browser — a №8002 licence is IP-bound
     * to the server). Drawn ABOVE the basemap + soil/index rasters but BELOW
     * the tenant's own parcel fills (layer order matters — the operator's
     * fields must stay legible on top) at reduced opacity. `null`/absent or an
     * empty `tileUrl` renders nothing; the host gates it on the feature being
     * configured AND online (online-only — not part of the offline pack).
     */
    cadastreOverlay?: { tileUrl: string } | null;
    /**
     * Bulgarian cadastre (КККР / АГКК) VECTOR parcels overlay — the FREE default
     * that actually renders. `url` is the SAME-ORIGIN `/cadastre/parcels`
     * endpoint served by the bounded proxy route (the upstream ArcGIS URL never
     * reaches the browser). When set AND the map is zoomed to
     * `CADASTRE_PARCELS_MIN_ZOOM`+ (below that too many parcels), the current
     * viewport's parcels are fetched (`?bbox=west,south,east,north`) on load +
     * move (debounced) into a GeoJSON source, drawn as a thin boundary LINE
     * layer ABOVE the basemap + soil/index rasters but BELOW the tenant's own
     * parcel fills (own fields stay prominent on top). `null`/absent or an empty
     * `url` renders nothing; the host gates it on the feature being configured
     * AND online (online-only — not part of the offline pack). Independent of
     * `cadastreOverlay` (the raster WMS path) — the host prefers this vector
     * overlay when its env is configured.
     */
    cadastreParcels?: { url: string } | null;
    /**
     * On-map thumb practices (zoom ±, find-my-field). Opt-in so the read-only
     * operator/prescription paths are unchanged unless they ask for it.
     * Each button is a 36px target (comfortably above the WCAG 2.5.8 AA
     * 24px minimum; the earlier 44px AAA size read as oversized on the
     * map), sat in the bottom-right thumb zone. "Find my field" frames the next field
     * (parcel) and cycles to the next on each tap — NO GPS (the operator
     * wants to jump to their fields, not their own position). Only renders
     * when there is at least one parcel with geometry.
     */
    showPractices?: boolean;
    /**
     * Lift the practice stack this many px off the map's bottom edge so it
     * clears a fixed bottom-tab bar on phones. Defaults to 12px.
     */
    practicesBottomInset?: number;
    /**
     * Stretch — add a live-tracking toggle next to locate-me.
     * `watchPosition()` follows the device and draws a breadcrumb trail;
     * battery-aware (high-accuracy only while tracking, watch cleared on
     * stop/unmount). Requires `showPractices`.
     */
    liveTracking?: boolean;
    /**
     * Ease the camera to frame a parcel when it becomes the sole selection
     * (operator focus). Opt-in so multi-select authoring (merge) on the
     * desktop Map tab isn't disrupted. Honors prefers-reduced-motion
     * (instant jump instead of a fly).
     */
    flyToOnSelect?: boolean;
    /**
     * Vector-tile source for read-only display (perf at scale). When set
     * AND the map is pure read-only (`!interactive` and `mode` is not a
     * drawing mode), a MapLibre `vector` `<Source>` is drawn from this
     * `{z}/{x}/{y}.pbf` template at zoom ≥ 6 (the `parcels` source-layer
     * carries `id` + `name` per feature). In that branch the GeoJSON
     * parcel layers are capped at `maxzoom={6}` so the two never
     * double-draw — GeoJSON below 6, vector tiles at/above 6. Ignored
     * (no-op) when interactive or drawing: selection + sketch stay on the
     * full GeoJSON source exactly as before.
     */
    vectorTileUrl?: string;
    /**
     * Same-origin offline basemap pack template (Roadmap-6 P1b). When set AND
     * the browser reports offline, MapCanvas swaps its `mapStyle` from the
     * cross-origin MapTiler/demotiles style (which blanks at zero bars) to a
     * minimal, glyph-free style backed by this SAME-ORIGIN `{z}/{x}/{y}`
     * template — the service worker serves those tiles from its dedicated
     * basemap cache (filled by the "Download offline map" affordance). Online,
     * the normal basemap is used unchanged. Absent ⇒ behaviour is exactly as
     * before (no offline swap).
     */
    offlineBasemapTileUrl?: string;
    /**
     * Soil view mode — colour each parcel by its soil class instead of the
     * selection/operator-progress palette. `soilColorById` maps parcelId →
     * fill colour (from the colour-blind-safe texture palette); a parcel not
     * in the map renders in the neutral "soil pending" tone with a dashed
     * outline. Mutually exclusive with the operator (done) colouring — the
     * host page owns the toggle. Selection still works (for the click panel).
     */
    soilMode?: boolean;
    /** parcelId → soil fill colour (only read when `soilMode`). */
    soilColorById?: Record<string, string>;
    /**
     * parcelId → crop value (e.g. "Wheat"). When present, a small crop glyph
     * is rendered above each parcel's label, gated by a zoom threshold so it
     * doesn't clutter a zoomed-out view. Coexists with any fill view.
     */
    cropById?: Record<string, string>;
    className?: string;
}

/**
 * Where maplibre loads its web worker from. REQUIRED on maplibre v6 — without
 * it the map does not render at all.
 *
 * v5 inlined the worker as a blob and self-configured. v6 is ESM-only and loads
 * it from a real URL, derived by swapping the filename on its own
 * `import.meta.url`:
 *
 *     let e = import.meta.url;
 *     let t = e.endsWith('-dev.mjs') ? 'maplibre-gl-worker-dev.mjs' : 'maplibre-gl-worker.mjs';
 *     return new URL(`./${t}`, e).href
 *
 * That assumes the published `dist/` layout survives to the served path — true
 * for Vite, false for webpack. Bundled, `import.meta.url` is
 * `/_next/static/chunks/<hash>.js`, so the worker resolves to
 * `/_next/static/chunks/maplibre-gl-worker.mjs`, which webpack never emits. It
 * 404s, the map never initializes, and the page just hangs.
 *
 * `workerUrl` is react-map-gl's first-class escape hatch: `setGlobals` calls
 * `mapLib.setWorkerUrl(workerUrl)` synchronously before the Map constructor in
 * the same resolved `.then()`, so the ordering is guaranteed with no
 * module-level shim.
 *
 * The two files under `public/maplibre/` are checked in and kept in sync by
 * `tests/guards/maplibre-worker-asset-sync.test.ts`. Both are required:
 * `maplibre-gl-worker.mjs` does `import … from "./maplibre-gl-shared.mjs"`, so
 * they must sit in the SAME directory with that relative specifier intact.
 */
const MAPLIBRE_WORKER_URL = '/maplibre/maplibre-gl-worker.mjs';

// MapTiler when a key is configured, the keyless demotiles style otherwise —
// and, under E2E only, an inline network-free fixture. The decision lives in
// `@/lib/geo/basemap-style` so it can be unit-tested in milliseconds; see the
// docblock there for the precedence and why the fixture branch comes first.
const BASEMAP_STYLE: string | StyleSpecification = resolveBasemapStyle();

export function MapCanvas({
    parcels,
    bounds,
    selectedIds = [],
    onSelectionChange,
    interactive = true,
    doneIds = [],
    mode = 'select',
    onCreateGeometry,
    onUpdateGeometry,
    onCreateSplitLine,
    onGeometryValidity,
    indexOverlay = null,
    cadastreOverlay = null,
    cadastreParcels = null,
    showPractices = false,
    practicesBottomInset = 12,
    liveTracking = false,
    flyToOnSelect = false,
    vectorTileUrl,
    offlineBasemapTileUrl,
    soilMode = false,
    soilColorById,
    cropById,
    className,
}: MapCanvasProps) {
    const t = useTranslations('ag.map.canvas');
    const reducedMotion = useReducedMotion();
    const indexActive = !!indexOverlay && indexOverlay.tileUrl.length > 0;
    const cadastreActive = !!cadastreOverlay && cadastreOverlay.tileUrl.length > 0;
    const cadastreParcelsUrl = cadastreParcels?.url ?? '';
    const cadastreParcelsActive = cadastreParcelsUrl.length > 0;
    const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
    const done = useMemo(() => new Set(doneIds), [doneIds]);
    const mapRef = useRef<MapRef | null>(null);
    // terra-draw instance kept off-render; typed loosely to avoid leaking
    // the adapter's map generic across the component boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drawRef = useRef<any>(null);
    const drawing = mode === 'draw' || mode === 'edit' || mode === 'split';
    // Vector tiles only serve PURE read-only display: a tile URL is set,
    // the map is non-interactive, and no sketch mode owns the pointer.
    // In that case the GeoJSON layers cap at maxzoom 6 and the vector
    // source takes over at zoom ≥ 6 (no double-draw). When interactive or
    // drawing this is false → behave exactly as before (GeoJSON only).
    const vectorActive = !!vectorTileUrl && vectorTileUrl.length > 0 && !interactive && !drawing;

    const data = useMemo<FeatureCollection>(() => ({
        type: 'FeatureCollection',
        features: parcels
            .filter((p): p is MapParcel & { geometry: Geometry } => !!p.geometry)
            .map((p): Feature => ({
                type: 'Feature',
                id: p.id,
                properties: {
                    id: p.id,
                    name: p.name,
                    selected: selected.has(p.id),
                    done: done.has(p.id),
                    // Soil-view fill: the class colour, or the neutral tone
                    // when this parcel has no soil yet ("pending").
                    soilColor: soilColorById?.[p.id] ?? SOIL_PENDING_COLOR,
                    soilPending: !soilColorById?.[p.id],
                },
                geometry: p.geometry,
            })),
    }), [parcels, selected, done, soilColorById]);

    // On-parcel labels — the cadastral ID (parcel name, e.g. "15655-3")
    // and the size (ha), anchored at each parcel's bbox centre. Rendered as
    // HTML <Marker>s rather than a MapLibre symbol layer so they don't
    // depend on the basemap style shipping glyphs/fonts (the demo fallback
    // may not), and so the styling matches the app's tokens.
    const parcelLabels = useMemo(
        () =>
            parcels
                .filter((p): p is MapParcel & { geometry: Geometry } => !!p.geometry)
                .map((p) => {
                    const [w, s, e, n] = bbox(p.geometry);
                    return {
                        id: p.id,
                        name: p.name,
                        areaHa: p.areaHa ?? null,
                        lon: (w + e) / 2,
                        lat: (s + n) / 2,
                    };
                }),
        [parcels],
    );

    // Crop-glyph overlay: one marker per parcel that carries a crop, reusing
    // the label's bbox-centre position. Only built when `cropById` is passed.
    const cropLabels = useMemo(
        () =>
            cropById
                ? parcelLabels
                      .map((l) => ({ id: l.id, lon: l.lon, lat: l.lat, crop: cropById[l.id] ?? null }))
                      .filter((l): l is { id: string; lon: number; lat: number; crop: string } => !!l.crop)
                : [],
        [parcelLabels, cropById],
    );

    const initialViewState = useMemo(() => {
        if (bounds) {
            const [w, s, e, n] = bounds;
            return { longitude: (w + e) / 2, latitude: (s + n) / 2, zoom: 12 };
        }
        // No parcel geometry yet → open centred on Bulgaria (the whole country
        // in view) rather than the world, so a new location lands somewhere
        // useful to orient and start drawing. Every tenant here farms in BG.
        return BULGARIA_VIEW;
    }, [bounds]);

    // Live zoom, so the crop glyphs can hide below a threshold (they'd clutter
    // a zoomed-out view). Seeded from the initial view; updated on zoom-end.
    const [zoom, setZoom] = useState<number>(initialViewState.zoom);

    // ── Online/offline basemap swap (Roadmap-6 P1b) ────────────────────
    // Hydration-safe: `online` starts true (matching SSR) and syncs to the
    // real navigator.onLine post-mount (mirrors use-offline-sync.ts). When
    // offline AND an offline pack template is supplied, swap the map style to
    // a same-origin, glyph-free basemap the SW can serve from its dedicated
    // cache — the cross-origin MapTiler/demotiles style blanks at zero bars.
    const [online, setOnline] = useState(true);
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional post-mount sync (hydration-safe)
        setOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
        const onOnline = () => setOnline(true);
        const onOffline = () => setOnline(false);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
        };
    }, []);
    const activeStyle = useMemo(
        () =>
            offlineBasemapTileUrl && offlineBasemapTileUrl.length > 0 && !online
                ? buildOfflineBasemapStyle(offlineBasemapTileUrl)
                : BASEMAP_STYLE,
        [offlineBasemapTileUrl, online],
    );

    // ── Cadastre VECTOR parcels overlay (КККР / АГКК) ──────────────────
    // The current viewport's official parcels, fetched from the same-origin
    // proxy as a GeoJSON FeatureCollection and drawn as a thin boundary line
    // under the tenant's own fields. Fetched on load + move (debounced) while
    // zoomed in; cleared/aborted when toggled off or below the zoom floor.
    const [cadastreParcelData, setCadastreParcelData] = useState<FeatureCollection>(
        () => ({ type: 'FeatureCollection', features: [] }),
    );
    const cadastreFetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cadastreAbort = useRef<AbortController | null>(null);

    const fetchCadastreParcels = useCallback(() => {
        const map = mapRef.current?.getMap();
        if (!map || !cadastreParcelsActive) return;
        // Below the zoom floor there are too many parcels to be useful (and the
        // proxy would refuse the wide bbox) — clear and skip the fetch.
        if (map.getZoom() < CADASTRE_PARCELS_MIN_ZOOM) {
            setCadastreParcelData((prev) =>
                prev.features.length ? { type: 'FeatureCollection', features: [] } : prev,
            );
            return;
        }
        const b = map.getBounds();
        const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
        // Cancel any in-flight request — the viewport moved on.
        cadastreAbort.current?.abort();
        const controller = new AbortController();
        cadastreAbort.current = controller;
        fetch(`${cadastreParcelsUrl}?bbox=${encodeURIComponent(bbox)}`, { signal: controller.signal })
            .then((r) => (r.ok ? r.json() : null))
            .then((json: unknown) => {
                if (
                    json &&
                    typeof json === 'object' &&
                    (json as { type?: unknown }).type === 'FeatureCollection' &&
                    Array.isArray((json as { features?: unknown }).features)
                ) {
                    setCadastreParcelData(json as FeatureCollection);
                }
            })
            .catch(() => {
                /* aborted or network error — keep the last-good parcels */
            });
    }, [cadastreParcelsActive, cadastreParcelsUrl]);

    // Debounced move handler — one fetch per settled pan/zoom, not per frame.
    const handleCadastreMoveEnd = useCallback(() => {
        if (!cadastreParcelsActive) return;
        if (cadastreFetchTimer.current) clearTimeout(cadastreFetchTimer.current);
        cadastreFetchTimer.current = setTimeout(fetchCadastreParcels, CADASTRE_PARCELS_FETCH_DEBOUNCE_MS);
    }, [cadastreParcelsActive, fetchCadastreParcels]);

    // Toggle lifecycle: fetch for the current viewport when turned on; abort +
    // clear when turned off so a re-toggle never flashes stale parcels.
    useEffect(() => {
        if (!cadastreParcelsActive) {
            cadastreAbort.current?.abort();
            if (cadastreFetchTimer.current) clearTimeout(cadastreFetchTimer.current);
            // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on toggle-off (bounded, no loop)
            setCadastreParcelData({ type: 'FeatureCollection', features: [] });
            return;
        }
        fetchCadastreParcels();
        return () => {
            cadastreAbort.current?.abort();
            if (cadastreFetchTimer.current) clearTimeout(cadastreFetchTimer.current);
        };
    }, [cadastreParcelsActive, fetchCadastreParcels]);

    const handleClick = useCallback((e: MapLayerMouseEvent) => {
        if (!interactive || !onSelectionChange || drawing) return;
        const feature = e.features?.[0];
        const id = feature?.properties?.id as string | undefined;
        if (!id) return;
        onSelectionChange(
            selected.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id],
        );
    }, [interactive, onSelectionChange, selected, selectedIds, drawing]);

    // ── Geolocation (locate-me + stretch live-tracking) ────────────────
    // The device's own GPS, surfaced as a blue dot and (while tracking) a
    // breadcrumb trail. All client-side: no ST_* / geo.ts round-trip.
    const geoAvailable = typeof navigator !== 'undefined' && 'geolocation' in navigator;
    const [userLoc, setUserLoc] = useState<{ lon: number; lat: number } | null>(null);
    // "Find my field" cursor — which field the next tap frames (cycles).
    const fieldCycleRef = useRef(-1);
    const [tracking, setTracking] = useState(false);
    const [trail, setTrail] = useState<Array<[number, number]>>([]);
    const [geoError, setGeoError] = useState<string | null>(null);
    const watchId = useRef<number | null>(null);

    const geoErrMessage = useCallback((err: GeolocationPositionError) =>
        err.code === err.PERMISSION_DENIED
            ? t('geoPermissionDenied')
            : t('geoGetFailed'),
    [t]);

    // "Find my field" — frame the next field (parcel) on the map and cycle
    // to the next one on each subsequent tap. NO GPS: the operator wants to
    // jump to where their FIELDS are, not to their own position (which is
    // often nowhere near the fields when planning). Wraps back to the first
    // field after the last.
    const handleFindField = useCallback(() => {
        const fields = parcels.filter(
            (p): p is MapParcel & { geometry: Geometry } => !!p.geometry,
        );
        if (fields.length === 0) {
            setGeoError(t('fieldBoundariesEmpty'));
            return;
        }
        setGeoError(null);
        const next = (fieldCycleRef.current + 1) % fields.length;
        fieldCycleRef.current = next;
        try {
            const [minX, minY, maxX, maxY] = bbox(fields[next].geometry);
            mapRef.current?.fitBounds(
                [[minX, minY], [maxX, maxY]],
                { padding: 64, duration: reducedMotion ? 0 : 800, maxZoom: 16 },
            );
        } catch {
            /* a malformed geometry shouldn't break the cycle */
        }
    }, [parcels, reducedMotion, t]);

    // Ease the camera to frame the sole selected parcel (operator focus).
    // Only fires for a single selection so multi-select authoring isn't
    // disrupted; instant when the user prefers reduced motion.
    useEffect(() => {
        if (!flyToOnSelect || selectedIds.length !== 1) return;
        const parcel = parcels.find((p) => p.id === selectedIds[0] && p.geometry);
        if (!parcel?.geometry) return;
        try {
            const [minX, minY, maxX, maxY] = bbox(parcel.geometry);
            mapRef.current?.fitBounds(
                [[minX, minY], [maxX, maxY]],
                { padding: 64, duration: reducedMotion ? 0 : 800, maxZoom: 16 },
            );
        } catch {
            /* a malformed geometry shouldn't break selection */
        }
        // selectedIds is the trigger; parcels/reducedMotion read at fire time.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedIds, flyToOnSelect]);

    const stopTracking = useCallback(() => {
        if (watchId.current !== null) {
            navigator.geolocation.clearWatch(watchId.current);
            watchId.current = null;
        }
        setTracking(false);
    }, []);

    const startTracking = useCallback(() => {
        if (!geoAvailable) { setGeoError(t('geoUnavailable')); return; }
        setGeoError(null);
        setTrail([]);
        setTracking(true);
        watchId.current = navigator.geolocation.watchPosition(
            (pos) => {
                const { longitude, latitude } = pos.coords;
                setUserLoc({ lon: longitude, lat: latitude });
                // Append to the breadcrumb only on meaningful movement
                // (~2m) so the trail doesn't accrue jitter at a standstill.
                setTrail((t) => {
                    const last = t[t.length - 1];
                    if (last && Math.abs(last[0] - longitude) < 2e-5 && Math.abs(last[1] - latitude) < 2e-5) return t;
                    return [...t, [longitude, latitude]];
                });
                mapRef.current?.easeTo({ center: [longitude, latitude], duration: 500 });
            },
            (err) => { setGeoError(geoErrMessage(err)); stopTracking(); },
            { enableHighAccuracy: true, timeout: 10_000, maximumAge: 5_000 },
        );
    }, [geoAvailable, geoErrMessage, stopTracking, t]);

    // One-shot "where am I" — a single getCurrentPosition fix (no continuous
    // watch, lighter on the battery) that drops the blue dot and re-centres.
    // Live tracking (above) stays the tool for following the device.
    const locateOnce = useCallback(async () => {
        if (!geoAvailable) { setGeoError(t('geoUnavailable')); return; }
        setGeoError(null);
        try {
            const { lon, lat } = await getOneShotPosition();
            setUserLoc({ lon, lat });
            mapRef.current?.easeTo({ center: [lon, lat], duration: reducedMotion ? 0 : 500 });
        } catch (err) {
            setGeoError(
                err && typeof err === 'object' && 'code' in err
                    ? geoErrMessage(err as GeolocationPositionError)
                    : t('geoGetFailed'),
            );
        }
    }, [geoAvailable, geoErrMessage, reducedMotion, t]);

    // Battery-aware: always release the watch when the map unmounts.
    useEffect(() => () => {
        if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    }, []);

    const trailData = useMemo<FeatureCollection>(() => ({
        type: 'FeatureCollection',
        features: trail.length > 1
            ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: trail } }]
            : [],
    }), [trail]);

    const practiceBtn =
        'flex min-h-[36px] min-w-[36px] items-center justify-center bg-bg-default text-content-default ' +
        'transition-colors hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

    // ── terra-draw lifecycle (draw / edit / split modes only) ──────────
    useEffect(() => {
        const map = mapRef.current?.getMap();
        if (!map || !drawing) return;

        let cancelled = false;
        let debounce: ReturnType<typeof setTimeout> | null = null;

        // Dynamic import keeps terra-draw out of the bundle for the
        // read-only/select paths and off the SSR graph entirely.
        (async () => {
            const [
                { TerraDraw, TerraDrawPolygonMode, TerraDrawLineStringMode, TerraDrawSelectMode },
                { TerraDrawMapLibreGLAdapter },
            ] = await Promise.all([import('terra-draw'), import('terra-draw-maplibre-gl-adapter')]);
            if (cancelled) return;

            // terra-draw's adapter registers its sources/layers the instant
            // draw.start() runs, and maplibre's addSource/addLayer THROW when
            // the style isn't loaded yet. The tiny demo basemap was ready
            // instantly; the MapTiler vector style loads async, so on a fresh
            // map draw.start() raced it and the whole setup rejected silently
            // — draw/edit/split looked dead. Wait for the style to finish.
            if (!map.isStyleLoaded()) {
                await new Promise<void>((resolve) => {
                    const ready = () => {
                        if (cancelled || map.isStyleLoaded()) {
                            map.off('styledata', ready);
                            map.off('idle', ready);
                            resolve();
                        }
                    };
                    map.on('styledata', ready);
                    map.on('idle', ready);
                });
                if (cancelled) return;
            }

            const draw = new TerraDraw({
                adapter: new TerraDrawMapLibreGLAdapter({ map }),
                modes: [
                    new TerraDrawPolygonMode(),
                    new TerraDrawLineStringMode(),
                    new TerraDrawSelectMode({
                        flags: {
                            polygon: {
                                feature: {
                                    draggable: false,
                                    coordinates: { midpoints: true, draggable: true, deletable: true },
                                },
                            },
                        },
                    }),
                ],
            });
            draw.start();
            drawRef.current = draw;

            if (mode === 'draw') {
                draw.setMode('polygon');
                draw.on('finish', (id: string | number, context: { action: string }) => {
                    if (context.action !== 'draw') return;
                    const f = draw.getSnapshotFeature(id);
                    if (f && f.geometry.type === 'Polygon') {
                        const geometry = f.geometry as Polygon;
                        // Optimistic preview: flag obvious topology problems
                        // for a non-blocking host hint. Never gates the draw.
                        onGeometryValidity?.(validatePolygonGeometry(geometry));
                        onCreateGeometry?.(geometry);
                        draw.clear();
                    }
                });
            } else if (mode === 'split') {
                // Draw a single LineString blade across the target parcel.
                // On finish, hand the line to the host (→ split API) and
                // clear it — mirroring the draw-mode create+clear so a new
                // attempt starts from a clean slate.
                draw.setMode('linestring');
                draw.on('finish', (id: string | number, context: { action: string }) => {
                    if (context.action !== 'draw') return;
                    const f = draw.getSnapshotFeature(id);
                    if (f && f.geometry.type === 'LineString') {
                        onCreateSplitLine?.(f.geometry as LineString);
                        draw.clear();
                    }
                });
            } else {
                // edit — seed existing single-Polygon parcels as editable
                // features (MultiPolygon imports aren't vertex-editable here).
                const seed = parcels
                    .filter((p) => p.geometry?.type === 'Polygon')
                    .map((p) => ({
                        type: 'Feature' as const,
                        properties: { mode: 'polygon', parcelId: p.id },
                        geometry: p.geometry as Polygon,
                    }));
                if (seed.length) {
                    try {
                        draw.addFeatures(seed);
                    } catch {
                        /* a malformed stored geometry shouldn't break edit mode */
                    }
                }
                draw.setMode('select');
                draw.on('change', (ids: Array<string | number>) => {
                    if (debounce) clearTimeout(debounce);
                    debounce = setTimeout(() => {
                        for (const id of ids) {
                            const f = draw.getSnapshotFeature(id);
                            const parcelId = f?.properties?.parcelId as string | undefined;
                            if (parcelId && f?.geometry?.type === 'Polygon') {
                                const geometry = f.geometry as Polygon;
                                // Optimistic preview on reshape (see draw mode).
                                onGeometryValidity?.(validatePolygonGeometry(geometry));
                                onUpdateGeometry?.(parcelId, geometry);
                            }
                        }
                    }, 700);
                });
            }
        })();

        return () => {
            cancelled = true;
            if (debounce) clearTimeout(debounce);
            try {
                drawRef.current?.stop();
            } catch {
                /* adapter already torn down */
            }
            drawRef.current = null;
        };
        // Re-init when the mode flips. Parcels are seeded once on entry to
        // edit mode (intentionally not a dep — re-seeding on every refresh
        // would fight the user's in-progress edit).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, drawing]);

    // Human-readable description of what the map is doing right now, so
    // screen-reader users get the same context the sighted toolbar hint
    // gives. Mirrors the per-mode copy on the Location detail Map tab.
    const modeLabel =
        mode === 'draw'
            ? t('modeDraw')
            : mode === 'edit'
              ? t('modeEdit')
              : mode === 'split'
                ? t('modeSplit')
                : interactive
                  ? t('modeSelect')
                  : t('modeReadonly');

    return (
        // Keyboard-focusable, labelled map region. MapLibre's own canvas
        // handles arrow-key panning once focused; `tabIndex={0}` + the
        // group role surface it to keyboard + AT users (the bare
        // <Map> wrapper is otherwise an unlabelled, un-focusable div).
        <div
            role="group"
            aria-label={t('parcelMap', { mode: modeLabel })}
            tabIndex={0}
            className={cn(
                // `relative` anchors the absolutely-positioned on-map practice
                // overlay + the geolocation error toast.
                'relative',
                // Focusable region always carries a visible focus ring
                // (keyboard affordance must survive a custom className too).
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                // Default size/skin is responsive (360px on phones, 480px
                // from md: up); a passed className overrides the sizing/skin.
                className ??
                    'h-[360px] w-full overflow-hidden rounded-lg border border-border-subtle md:h-[480px]',
            )}
        >
            <Map
                ref={mapRef}
                // maplibre v6 cannot resolve its own worker under webpack —
                // see MAPLIBRE_WORKER_URL. Without this the map never renders.
                workerUrl={MAPLIBRE_WORKER_URL}
                initialViewState={initialViewState}
                mapStyle={activeStyle}
                interactiveLayerIds={interactive && !drawing ? ['parcel-fill'] : []}
                onClick={handleClick}
                onZoomEnd={(e) => setZoom(e.viewState.zoom)}
                // Cadastre vector parcels: fetch the current viewport on first
                // load, and (debounced) whenever a pan/zoom settles. No-ops when
                // the overlay is off.
                onLoad={fetchCadastreParcels}
                onMoveEnd={handleCadastreMoveEnd}
                style={{ width: '100%', height: '100%' }}
                cursor={interactive && !drawing ? 'pointer' : 'grab'}
                // Google-Maps-style scroll: a plain wheel/one-finger scroll
                // over the map scrolls the PAGE (not the map). Zooming needs
                // Ctrl/⌘ + wheel; panning on touch needs two fingers. Without
                // this the full-bleed field map traps the page scroll. The
                // transient help overlay text is localised via `locale`.
                cooperativeGestures
                locale={{
                    'CooperativeGesturesHandler.WindowsHelpText': t('zoomHintWindows'),
                    'CooperativeGesturesHandler.MacHelpText': t('zoomHintMac'),
                    'CooperativeGesturesHandler.MobileHelpText': t('zoomHintMobile'),
                }}
            >
                {/* Satellite vegetation-index raster overlay (Agro-intel) —
                    NDVI / NDMI / NDRE / GNDVI / EVI (mutually exclusive).
                    Drawn first so the parcel vector layers sit on top. The
                    source id is keyed by index so switching swaps cleanly. */}
                {indexActive && (
                    <Source
                        id={`idx-${indexOverlay!.id}`}
                        key={`idx-${indexOverlay!.id}`}
                        type="raster"
                        tiles={[indexOverlay!.tileUrl]}
                        tileSize={256}
                    >
                        <Layer id={`idx-${indexOverlay!.id}-raster`} type="raster" paint={{ 'raster-opacity': 0.7 }} />
                    </Source>
                )}
                {/* Soil-region area surface — ISRIC WRB soil-class WMS raster,
                    shown in Soil view UNDER the parcels so the whole landscape
                    reads as coloured soil regions with your fields on top. */}
                {soilMode && (
                    <Source
                        id="soil-wrb"
                        type="raster"
                        tiles={[SOIL_WRB_WMS_TILE]}
                        tileSize={256}
                        attribution={t('soilAttribution')}
                    >
                        <Layer id="soil-wrb-raster" type="raster" paint={{ 'raster-opacity': 0.55 }} />
                    </Source>
                )}
                {/* Bulgarian cadastre (КККР / АГКК) WMS overlay — cadastral
                    parcel boundaries, proxied SAME-ORIGIN as XYZ raster tiles.
                    Drawn after the basemap/soil/index rasters but BEFORE the
                    parcels source below, so the operator's own field fills sit
                    on top and stay legible. `minzoom={10}` mirrors the proxy's
                    zoom floor so MapLibre never requests a tile the route would
                    refuse. Reduced opacity keeps the own-parcel strokes clear.
                    Attribution is surfaced via MapLibre's attribution practice. */}
                {cadastreActive && (
                    <Source
                        id="cadastre-wms"
                        key="cadastre-wms"
                        type="raster"
                        tiles={[cadastreOverlay!.tileUrl]}
                        tileSize={256}
                        minzoom={10}
                        attribution={t('cadastreAttribution')}
                    >
                        <Layer id="cadastre-wms-raster" type="raster" paint={{ 'raster-opacity': 0.8 }} />
                    </Source>
                )}
                {/* Bulgarian cadastre (КККР / АГКК) VECTOR parcels overlay — the
                    FREE default. Official parcel boundaries for the current
                    viewport (fetched same-origin as GeoJSON), drawn as a thin
                    amber boundary line ABOVE the basemap/soil/index rasters but
                    BELOW the parcels source below, so the operator's own field
                    fills sit on top and stay legible. Empty until the first
                    viewport fetch resolves; renders nothing below the zoom
                    floor. Attribution via MapLibre's attribution practice. */}
                {cadastreParcelsActive && (
                    <Source
                        id="cadastre-parcels"
                        key="cadastre-parcels"
                        type="geojson"
                        data={cadastreParcelData}
                        attribution={t('cadastreAttribution')}
                    >
                        <Layer
                            id="cadastre-parcels-line"
                            type="line"
                            paint={{
                                'line-color': '#d97706',
                                'line-width': 1,
                                'line-opacity': 0.7,
                            }}
                        />
                    </Source>
                )}
                {/* Hide the static layer while editing so terra-draw owns
                    the on-map render of the editable polygons. */}
                {mode !== 'edit' && (
                    <Source id="parcels" type="geojson" data={data}>
                        <Layer
                            id="parcel-fill"
                            type="fill"
                            // In read-only vector-tile mode, hand off to the
                            // vector source at zoom ≥ 6 so the two never
                            // double-draw. Uncapped otherwise (interactive/draw).
                            {...(vectorActive ? { maxzoom: 6 } : {})}
                            paint={{
                                // Soil view: fill by soil class (per-feature
                                // colour). Otherwise the operator/selection
                                // palette. Pending parcels keep the neutral
                                // tone (set in the feature builder).
                                'fill-color': soilMode
                                    ? ['get', 'soilColor']
                                    : [
                                        'case',
                                        ['boolean', ['get', 'done'], false], '#16a34a',
                                        ['boolean', ['get', 'selected'], false], '#2563eb',
                                        '#94a3b8',
                                    ],
                                'fill-opacity': soilMode ? 0.6 : 0.4,
                            }}
                        />
                        <Layer
                            id="parcel-line"
                            type="line"
                            {...(vectorActive ? { maxzoom: 6 } : {})}
                            paint={{
                                'line-color': [
                                    'case',
                                    ['boolean', ['get', 'selected'], false], '#1d4ed8',
                                    '#475569',
                                ],
                                'line-width': 1.5,
                            }}
                        />
                        {/* Soil-pending outline — a dashed border on parcels
                            with no soil yet, drawn as its own filtered layer so
                            the dash is a static (well-supported) constant, not
                            a data-driven expression on the main outline. */}
                        {soilMode && (
                            <Layer
                                id="parcel-soil-pending"
                                type="line"
                                filter={['==', ['get', 'soilPending'], true]}
                                paint={{
                                    'line-color': '#64748b',
                                    'line-width': 1.5,
                                    'line-dasharray': [2, 2],
                                }}
                            />
                        )}
                    </Source>
                )}

                {/* Vector-tile source for read-only display at scale. Takes
                    over from the GeoJSON layers at zoom ≥ 6 (those cap at
                    maxzoom 6 above). The `parcels` source-layer carries no
                    selected/done state, so the neutral default fill/line
                    colors are used — mirroring the un-selected/un-done
                    GeoJSON paint values exactly. Only rendered for pure
                    read-only display (see `vectorActive`). */}
                {vectorActive && (
                    <Source id="parcels-vector" type="vector" tiles={[vectorTileUrl!]} minzoom={6}>
                        <Layer
                            id="parcels-vector-fill"
                            type="fill"
                            source-layer="parcels"
                            minzoom={6}
                            paint={{
                                'fill-color': '#94a3b8',
                                'fill-opacity': 0.4,
                            }}
                        />
                        <Layer
                            id="parcels-vector-line"
                            type="line"
                            source-layer="parcels"
                            minzoom={6}
                            paint={{
                                'line-color': '#475569',
                                'line-width': 1.5,
                            }}
                        />
                    </Source>
                )}

                {/* On-parcel labels — cadastral ID (parcel name) + size (ha).
                    Hidden while authoring (draw/edit/split) so the toolbars own
                    the canvas, and in the read-only vector-tile-at-scale path
                    (thousands of parcels ⇒ thousands of DOM nodes). */}
                {!drawing && !vectorActive && parcelLabels.map((lbl) => (
                    <Marker
                        key={`label-${lbl.id}`}
                        longitude={lbl.lon}
                        latitude={lbl.lat}
                        anchor="center"
                        // Let clicks fall through to the parcel fill for select.
                        style={{ pointerEvents: 'none' }}
                    >
                        <div
                            aria-hidden="true"
                            className="pointer-events-none select-none rounded-md bg-bg-default/90 px-1.5 py-0.5 text-center shadow-sm ring-1 ring-border-subtle"
                        >
                            <div className="max-w-trunc-tight truncate text-[11px] font-semibold leading-tight text-content-default">
                                {lbl.name}
                            </div>
                            {lbl.areaHa != null && (
                                <div className="text-[10px] leading-tight text-content-secondary">
                                    {Math.round(lbl.areaHa * 10) / 10} ha
                                </div>
                            )}
                        </div>
                    </Marker>
                ))}

                {/* Per-parcel crop glyph — floats just above the label. Same
                    author/vector guards as the labels, plus a zoom threshold
                    so it doesn't clutter a zoomed-out view. Non-interactive so
                    clicks still select the parcel fill. */}
                {!drawing && !vectorActive && zoom >= CROP_ICON_MIN_ZOOM && cropLabels.map((c) => (
                    <Marker
                        key={`crop-${c.id}`}
                        longitude={c.lon}
                        latitude={c.lat}
                        anchor="center"
                        offset={[0, -22]}
                        style={{ pointerEvents: 'none' }}
                    >
                        <div
                            aria-hidden="true"
                            className="pointer-events-none select-none rounded-full bg-bg-default/90 p-1 text-content-emphasis shadow-sm ring-1 ring-border-subtle"
                        >
                            <CropGlyph crop={c.crop} className="h-3.5 w-3.5" />
                        </div>
                    </Marker>
                ))}

                {/* GPS breadcrumb (live-tracking) — drawn under the dot. */}
                {tracking && trail.length > 1 && (
                    <Source id="gps-trail" type="geojson" data={trailData}>
                        <Layer
                            id="gps-trail-line"
                            type="line"
                            paint={{ 'line-color': '#2563eb', 'line-width': 3, 'line-opacity': 0.75 }}
                        />
                    </Source>
                )}

                {/* Device location — the classic "blue dot": a solid centre
                    with a soft accuracy halo. Purely decorative (aria-hidden);
                    the locate button is the labelled control. */}
                {userLoc && (
                    <Marker longitude={userLoc.lon} latitude={userLoc.lat} anchor="center">
                        <div
                            data-testid="map-user-dot"
                            aria-hidden="true"
                            className="relative flex size-7 items-center justify-center"
                        >
                            <span className="absolute size-7 rounded-full bg-[var(--brand-default)] opacity-20" />
                            <span className="size-3.5 rounded-full border-2 border-bg-default bg-[var(--brand-default)] shadow-md" />
                        </div>
                    </Marker>
                )}
            </Map>

            {/* ── On-map thumb practices (opt-in) ──────────────────────────
                Bottom-right thumb zone; each button a ≥44px touch target.
                The container is pointer-events-none so map panning is
                unaffected; only the buttons capture taps. */}
            {showPractices && (
                <div className="pointer-events-none absolute inset-0 z-10">
                    <div
                        className="pointer-events-auto absolute right-3 flex flex-col items-end gap-tight"
                        style={{ bottom: practicesBottomInset }}
                    >
                        {parcels.some((p) => p.geometry) && (
                            <button
                                type="button"
                                onClick={handleFindField}
                                aria-label={t('findMyField')}
                                data-testid="map-find-field"
                                className={cn(practiceBtn, 'rounded-lg border border-border-subtle shadow-md')}
                            >
                                <Crosshairs3 className="size-4" aria-hidden="true" />
                            </button>
                        )}
                        {/* Locate-me (center once). Hidden when `liveTracking`
                            is on — the tracking toggle below uses the same
                            MapPosition glyph, so showing both reads as two
                            identical buttons. Callers without live-tracking
                            still get this single locate practice. */}
                        {geoAvailable && !liveTracking && (
                            <button
                                type="button"
                                onClick={() => void locateOnce()}
                                aria-label={t('locateMe')}
                                data-testid="map-locate"
                                className={cn(practiceBtn, 'rounded-lg border border-border-subtle shadow-md')}
                            >
                                <MapPosition className="size-4" aria-hidden="true" />
                            </button>
                        )}
                        {liveTracking && geoAvailable && (
                            <button
                                type="button"
                                onClick={() => (tracking ? stopTracking() : startTracking())}
                                aria-label={tracking ? t('stopTracking') : t('startTracking')}
                                aria-pressed={tracking}
                                data-testid="map-track"
                                className={cn(
                                    practiceBtn,
                                    'rounded-lg border shadow-md',
                                    tracking
                                        ? 'border-border-emphasis text-content-emphasis ring-2 ring-ring'
                                        : 'border-border-subtle',
                                )}
                            >
                                <MapPosition className="size-4" aria-hidden="true" />
                            </button>
                        )}
                        <div className="flex flex-col overflow-hidden rounded-lg border border-border-subtle shadow-md divide-y divide-border-subtle">
                            <button
                                type="button"
                                onClick={() => mapRef.current?.zoomIn()}
                                aria-label={t('zoomIn')}
                                data-testid="map-zoom-in"
                                className={practiceBtn}
                            >
                                <Plus className="size-4" aria-hidden="true" />
                            </button>
                            <button
                                type="button"
                                onClick={() => mapRef.current?.zoomOut()}
                                aria-label={t('zoomOut')}
                                data-testid="map-zoom-out"
                                className={practiceBtn}
                            >
                                <Minus className="size-4" aria-hidden="true" />
                            </button>
                        </div>
                    </div>

                    {/* Soil-region legend — the WRB soil-class colour key for
                        the area overlay. Scrollable so the ~30-class ISRIC key
                        never dominates the (short, mobile) map pane. */}
                    {soilMode && (
                        <div className="pointer-events-auto absolute bottom-3 left-3 z-10 flex max-h-[45%] w-24 flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-default/95 shadow-md">
                            <p className="flex-shrink-0 border-b border-border-subtle px-2 py-1 text-[10px] font-medium text-content-secondary">
                                {t('soilRegions')}
                            </p>
                            <div className="min-h-0 overflow-y-auto p-1">
                                {/* eslint-disable-next-line @next/next/no-img-element -- external WMS legend, not a local asset */}
                                <img src={SOIL_WRB_LEGEND} alt={t('soilLegendAlt')} className="w-full" loading="lazy" />
                            </div>
                        </div>
                    )}

                    {/* Non-blocking geolocation hint (permission denied /
                        unavailable). aria-live so AT users hear it too. */}
                    {geoError && (
                        <div
                            role="status"
                            aria-live="polite"
                            data-testid="map-geo-error"
                            className="pointer-events-none absolute inset-x-3 top-3 rounded-lg border border-border-subtle bg-bg-default/95 px-3 py-2 text-xs text-content-secondary shadow-md"
                        >
                            {geoError}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default MapCanvas;

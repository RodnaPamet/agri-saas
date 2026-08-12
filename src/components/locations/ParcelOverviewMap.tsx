'use client';

/**
 * ParcelOverviewMap — a 2D locator for a holding with too many parcels to scan.
 *
 * WHY A SECOND MAP. The Map tab already renders `MapCanvas`: MapLibre GL
 * over a MapTiler satellite basemap, with draw / edit / split. That is
 * the tool for working ON a parcel. It is not the tool for FINDING one
 * among a hundred — at a zoom that shows the whole holding, a hundred
 * outlines are a hundred outlines. This view answers a different
 * question: "12 near Драгоево, 8 near Каспичан — which group do I want?"
 * The two are different libraries with different rendering models; they
 * ship as two views and `MapCanvas` is untouched.
 *
 * WHY A BESPOKE `<canvas>`. `docs/charts.md` bans raw `<svg>` and inline
 * percentage-width bars; the chart platform has no primitive for a
 * projected map, and a full GL basemap is overkill for a locator. This is
 * the same deliberate exception `ExchangeMap` already holds — recorded
 * here so the next reader sees a decision rather than an oversight.
 *
 * WHY THE CANVAS IS DARK on a page that follows the theme. Canvas pixels
 * cannot read semantic tokens, and the alternative — sampling computed
 * styles per frame — buys a palette that drifts from the DOM anyway. So
 * the pixels use a fixed dark palette (the product's other map surfaces
 * are dark satellite imagery, so it reads as "a map", not as a theme
 * bug), and every piece of chrome AROUND the canvas is token-driven.
 * That is the same split `ExchangeMap` makes.
 *
 * HOW YOU MOVE AROUND IT. Three ranges, one set of state.
 *   - IN, to a parcel: wheel, the + button, a pinch, or the crosshairs
 *     button, which walks the parcels north to south and flies to each.
 *   - OUT, past the holding, to the whole of Bulgaria: the country
 *     outlines are already drawn through the projection bridge, so the
 *     only thing that stood between a farmer and seeing their land in
 *     national context was the zoom floor. It is now MEASURED from that
 *     same bridge (`minZoomScale`) rather than being a constant, and the
 *     globe button gets there in one press. Individual outlines stop
 *     drawing on the way out — see `shouldDrawParcelShapes`.
 *   - AROUND: mouse drag, or two fingers, which both zoom AND pan. One
 *     finger is left to the page, deliberately.
 *
 * WHERE THE LOGIC LIVES. jsdom implements no 2D context, so `getContext`
 * returns null and every drawing and hit-testing path below no-ops in an
 * ordinary rendered test. The arithmetic that must be verified — zoom
 * tiering, the cluster-token codec, the projection bridge, the zoom floor
 * and clamp extents, the stepping order, selection resolution — is
 * therefore in `./parcel-overview-model`, where an executing unit test
 * can reach it. What remains here is refs, effects and paint.
 *
 * That is not licence for the paint to go unexecuted:
 * `tests/rendered/parcel-overview-map-gestures.test.tsx` installs a
 * recording 2D context and a `Path2D`, then drives real touch events and
 * reads the view back out of the `setTransform` calls — the gestures and
 * the zoom range are pinned by what was PAINTED, not by a grep.
 *
 * The cluster LIST is the accessible counterpart: it performs exactly the
 * same filtering, so the feature never depends on pixels a screen reader
 * cannot see, and the stepper's position is rendered as TEXT beside the
 * canvas for the same reason.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { Plus, Minus, Crosshairs3, Earth } from '@/components/ui/icons/nucleo';
import { loadBgMapGeometry } from '@/lib/geo/bg-geometry-client';
import {
    fitToExtent,
    makeProjector,
    type BgMapGeometry,
} from '@/lib/geo/bg-projection';
import type { ParcelCluster } from '@/lib/geo/parcel-clustering';
import type { ParcelOverview } from '@/app-layer/usecases/parcel-overview';
import {
    bboxSpanMetres,
    bridgedExtent,
    centreOn,
    clampExtentFor,
    clampTranslation,
    composeBridgeTransform,
    farmExtent,
    fitScaleForExtent,
    minZoomScale,
    nextStepIndex,
    orderParcelsForStepping,
    polygonBBox,
    polygonRings,
    projectionBridge,
    shouldDrawParcels,
    shouldDrawParcelShapes,
    zoomTierForSpan,
    UNPOSITIONED_CLUSTER_ID,
    type ClusterSelection,
    type WorldExtent,
} from './parcel-overview-model';
import { cn } from '@/lib/cn';

/** Fixed world space — the geometry file's own 1000×600 frame. */
const WORLD_PADDING = 40;

/** Pick radius for a click, in CSS pixels, squared. */
const PICK_RADIUS_SQ = 26 * 26;

// Canvas palette. Literals by design — see the docblock.
const C_BG = '#0b1016';
const C_OBLAST = 'rgba(148,163,184,.18)';
const C_OUTLINE = 'rgba(148,163,184,.32)';
const C_CLUSTER = '#4ade80';
const C_CLUSTER_SELECTED = '#facc15';
const C_PARCEL = '#38bdf8';
const C_PARCEL_FILL = 'rgba(56,189,248,.22)';
const C_PARCEL_FILL_DIM = 'rgba(56,189,248,.07)';
const C_PARCEL_DIM = 'rgba(56,189,248,.35)';
const C_SELECTED_FILL = 'rgba(250,204,21,.28)';
const C_LABEL = '#e2e8f0';
const C_LABEL_SHADOW = 'rgba(4,8,12,.85)';

/** How long a stepper flight takes, in ms. */
const STEP_FLIGHT_MS = 380;

/** Share of the pane a stepped-to parcel is framed to occupy. */
const STEP_PARCEL_FILL = 0.45;

/** Fallback magnification for a parcel with a point but no outline. */
const STEP_POINT_ZOOM = 8;

/**
 * Slack when asking "is the view at country scale?".
 *
 * The floor is reached by a multiply-by-a-factor zoom, which lands on it
 * only approximately, and a flight eases to it in floating point. An
 * exact comparison would leave the toggle occasionally refusing to come
 * back because the view is a rounding error below where it should be.
 */
const COUNTRY_SCALE_EPSILON = 1.05;

/** A drawn cluster marker, kept from the last frame so hit-testing reads exactly what was painted. */
interface MapItem {
    sx: number;
    sy: number;
    r: number;
    label: string;
    cluster: ParcelCluster;
}

/** A parcel outline plus the world box it occupies, for framing it. */
interface ParcelPath {
    id: string;
    path: Path2D;
    extent: WorldExtent;
}

export interface ParcelOverviewMapProps {
    overview: ParcelOverview | null | undefined;
    loading: boolean;
    error: boolean;
    /** Parcel display names by id — the map holds ids, the page holds names. */
    parcelNames: ReadonlyMap<string, string>;
    /**
     * Parcel outlines, drawn as the shapes they are.
     *
     * The same GeoJSON the satellite renderer gets, so the two views
     * frame identical ground and a field is recognisable by its shape in
     * both. It is already on the page — no second read — which is why the
     * clusters payload carries points and not geometry.
     */
    parcelShapes: ReadonlyArray<{ id: string; geometry: unknown }>;
    selection: ClusterSelection | null;
    /** Filter the list to a group, or clear it with `null`. */
    onSelect: (selection: ClusterSelection | null) => void;
    /** Open one parcel — the click target once the view is past clustering. */
    onParcelOpen: (parcelId: string) => void;
    /** The tier the view currently wants the payload at. */
    zoomTier: number;
    onZoomTierChange: (tier: number) => void;
    className?: string;
    /**
     * Height classes for the canvas pane, replacing the default.
     *
     * Two mount points want two sizes: a compact locator above the parcels
     * table on the Overview tab, and the full map slot on the Map tab when
     * it takes the satellite renderer's place. The pane owns a definite
     * height either way — the canvas measures its wrapper, and a wrapper
     * that collapses to zero gives a backing store of zero.
     */
    canvasClassName?: string;
}

export function ParcelOverviewMap({
    overview,
    loading,
    error,
    parcelNames,
    parcelShapes,
    selection,
    onSelect,
    onParcelOpen,
    zoomTier,
    onZoomTierChange,
    className,
    canvasClassName,
}: ParcelOverviewMapProps) {
    const t = useTranslations('locations.detail');

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    // Pan/zoom lives in a ref so a drag never re-renders the tree.
    const view = useRef({ k: 1, tx: 0, ty: 0, fit: 1 });
    const itemsRef = useRef<MapItem[]>([]);
    const drawRef = useRef<() => void>(() => {});
    const geomRef = useRef<BgMapGeometry | null>(null);

    const [geom, setGeom] = useState<BgMapGeometry | null>(null);
    const [geomFailed, setGeomFailed] = useState(false);

    /**
     * Whether the view is framed on the country rather than the holding.
     *
     * The ONE piece of view state React is told about, and only because
     * the button's label has to say which way it goes — a toggle whose
     * label never changes is a toggle nobody trusts. It is written from
     * `reportTier`, which already runs after every zoom, and React bails
     * out of a set to the same value, so it costs a render exactly when
     * the answer flips rather than once per drag frame.
     *
     * The ACTION never reads it: `toggleCountry` re-derives from
     * `view.current.k`, so a wheel or a pinch that left country scale
     * cannot make the button do the opposite of what it says.
     */
    const [atCountry, setAtCountry] = useState(false);

    useEffect(() => {
        let alive = true;
        loadBgMapGeometry()
            .then((g) => {
                if (alive) setGeom(g);
            })
            .catch(() => {
                if (alive) setGeomFailed(true);
            });
        return () => {
            alive = false;
        };
    }, []);

    /**
     * Frame the real outlines when we have them.
     *
     * The payload's `bbox` spans parcel CENTROIDS, so fitting to it draws
     * the edge parcels half off-canvas. Falling back to it matters only
     * for a holding whose geometry has not loaded yet.
     */
    const bbox = useMemo(
        () => polygonBBox(parcelShapes) ?? overview?.bbox ?? null,
        [parcelShapes, overview],
    );

    /**
     * The farm-scale projection, in the geometry's own 1000×600 world
     * space. Deriving it from a FIXED world rather than from the canvas
     * size keeps it a pure memo — only the view's `fit` depends on how
     * big the pane happens to be.
     */
    const fitted = useMemo(
        () => (geom && bbox ? fitToExtent(geom.proj, bbox, geom.W, geom.H, { padding: WORLD_PADDING }) : null),
        [geom, bbox],
    );

    const bridge = useMemo(
        () => (geom && fitted ? projectionBridge(geom.proj, fitted) : null),
        [geom, fitted],
    );

    const oblastPaths = useMemo(
        () => (geom && typeof Path2D !== 'undefined' ? geom.oblasti.map((o) => new Path2D(o.d)) : []),
        [geom],
    );
    const outlinePath = useMemo(
        () => (geom && typeof Path2D !== 'undefined' ? new Path2D(geom.outlinePath) : null),
        [geom],
    );

    const selectedIds = useMemo(
        () => new Set(selection?.parcelIds ?? []),
        [selection],
    );

    /**
     * One `Path2D` per parcel, in world space, rebuilt only when the fit
     * or the geometry changes — never per frame. That is what keeps
     * `isPointInPath` cheap enough to hit-test on every click, and it is
     * the pattern `ExchangeMap` uses for the oblast outlines.
     */
    const parcelPaths = useMemo(() => {
        if (!fitted || typeof Path2D === 'undefined') return [];
        const project = makeProjector(fitted);
        const out: ParcelPath[] = [];
        for (const p of parcelShapes) {
            const rings = polygonRings(p.geometry);
            if (rings.length === 0) continue;
            const path = new Path2D();
            // The world box is accumulated in the same pass that builds
            // the path — the stepper needs it to frame a parcel, and a
            // second walk over every vertex to recover it would be a
            // second walk over every vertex.
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const ring of rings) {
                for (let i = 0; i < ring.length; i++) {
                    const [x, y] = project(ring[i][0], ring[i][1]);
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    if (i === 0) path.moveTo(x, y);
                    else path.lineTo(x, y);
                }
                path.closePath();
            }
            out.push({ id: p.id, path, extent: { minX, minY, maxX, maxY } });
        }
        return out;
    }, [fitted, parcelShapes]);

    /**
     * The country's own box, in this view's world space.
     *
     * The same bridge that re-places the oblast outlines, read as an
     * extent rather than as a transform: it is what decides how far the
     * view may zoom out and what the pan clamp holds onto once it does.
     */
    const countryExtent = useMemo<WorldExtent | null>(
        () => (geom && bridge ? bridgedExtent(bridge, geom.W, geom.H) : null),
        [geom, bridge],
    );
    const countryExtentRef = useRef<WorldExtent | null>(null);
    useEffect(() => {
        countryExtentRef.current = countryExtent;
    }, [countryExtent]);

    const drawParcelTier = shouldDrawParcels(zoomTier);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || !geom || !fitted || !bridge) return;
        // jsdom has no 2D context; every path below is a no-op under test.
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const { k, tx, ty } = view.current;
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = C_BG;
        ctx.fillRect(0, 0, cw, ch);

        // National context, re-placed into farm space by the bridge. At a
        // farm's scale this is usually off-canvas by construction — it is
        // here for holdings that sit near an oblast border, and because
        // sharing the geometry source means the two can never drift.
        if (oblastPaths.length > 0) {
            ctx.save();
            ctx.setTransform(...composeBridgeTransform(bridge, view.current, dpr));
            const hair = 1 / Math.max(1e-6, k * bridge.scaleX);
            ctx.lineWidth = hair;
            ctx.strokeStyle = C_OBLAST;
            for (const p of oblastPaths) ctx.stroke(p);
            if (outlinePath) {
                ctx.lineWidth = hair * 1.6;
                ctx.strokeStyle = C_OUTLINE;
                ctx.stroke(outlinePath);
            }
            ctx.restore();
        }

        // Parcel outlines — the shapes themselves, in world space, so a
        // field is recognisable here exactly as it is on the satellite
        // map. At cluster pitch they are the texture of the holding, at
        // parcel pitch they are the subject. Line widths divide by `k` so
        // a boundary stays one CSS pixel however far in the operator has
        // zoomed.
        //
        // They stop at country scale. Not as an optimisation: a hundred
        // outlines inside a holding that is now forty pixels wide are a
        // hundred one-pixel marks, which reads as damage to the country
        // outline rather than as fields. The cluster markers below are
        // what carries the holding at that magnification.
        const drawShapes = shouldDrawParcelShapes(geom.W * k);

        if (parcelPaths.length > 0 && drawShapes) {
            const dim = selectedIds.size > 0;
            ctx.save();
            ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
            for (const p of parcelPaths) {
                const on = !dim || selectedIds.has(p.id);
                ctx.fillStyle = on ? (dim ? C_SELECTED_FILL : C_PARCEL_FILL) : C_PARCEL_FILL_DIM;
                ctx.fill(p.path);
                ctx.lineWidth = (on && dim ? 2 : 1) / k;
                ctx.strokeStyle = on ? (dim ? C_CLUSTER_SELECTED : C_PARCEL) : C_PARCEL_DIM;
                ctx.stroke(p.path);
            }
            ctx.restore();
        }

        const project = makeProjector(fitted);
        const items: MapItem[] = [];

        // Cluster markers stand in whenever the shapes are not the
        // subject — either because the tier says clustering still helps,
        // or because the view is too far out for an outline to read. The
        // second half also covers the frame or two where a zoom-out has
        // happened but the payload for the new tier has not arrived: the
        // holding must not blink out of existence in between.
        if ((!drawParcelTier || !drawShapes) && overview) {
            const maxCount = overview.clusters.reduce((m, c) => Math.max(m, c.count), 1);
            for (const c of overview.clusters) {
                const [wx, wy] = project(c.lon, c.lat);
                items.push({
                    sx: wx * k + tx,
                    sy: wy * k + ty,
                    r: 6 + (c.count / maxCount) * 12,
                    label: `${c.label ?? t('clusterUnnamed')} · ${c.count}`,
                    cluster: c,
                });
            }
        }

        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textBaseline = 'middle';

        for (const it of items) {
            const on = selection?.id === it.cluster.id;
            ctx.beginPath();
            ctx.arc(it.sx, it.sy, it.r, 0, Math.PI * 2);
            ctx.fillStyle = on ? C_CLUSTER_SELECTED : C_CLUSTER;
            ctx.globalAlpha = on ? 0.95 : 0.75;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.lineWidth = on ? 2.5 : 1;
            ctx.strokeStyle = on ? C_CLUSTER_SELECTED : 'rgba(11,16,22,.9)';
            ctx.stroke();
        }

        const label = (text: string, x: number, y: number) => {
            ctx.strokeStyle = C_LABEL_SHADOW;
            ctx.lineWidth = 3;
            ctx.strokeText(text, x, y);
            ctx.fillStyle = C_LABEL;
            ctx.fillText(text, x, y);
        };

        ctx.textAlign = 'start';
        for (const it of items) {
            if (it.label) label(it.label, it.sx + it.r + 6, it.sy);
        }

        // Past the clustering floor the shapes carry their own names,
        // centred on the parcel rather than trailing a marker — there is
        // no marker any more.
        if (drawParcelTier && drawShapes && overview) {
            ctx.textAlign = 'center';
            for (const p of overview.parcels) {
                const name = parcelNames.get(p.id);
                if (!name) continue;
                const [wx, wy] = project(p.lon, p.lat);
                label(name, wx * k + tx, wy * k + ty);
            }
            ctx.textAlign = 'start';
        }

        itemsRef.current = items;
    }, [
        geom,
        fitted,
        bridge,
        oblastPaths,
        outlinePath,
        parcelPaths,
        overview,
        drawParcelTier,
        parcelNames,
        selectedIds,
        selection,
        t,
    ]);

    // Latest draw + geometry mirrored for the once-attached handlers.
    useEffect(() => {
        drawRef.current = draw;
        geomRef.current = geom;
    });

    /**
     * Hold the view inside whichever extent the current magnification
     * belongs to — the holding while zoomed in, the country once the
     * view is out past the holding's own framing. See `clampExtentFor`.
     */
    const clampView = useCallback(() => {
        const canvas = canvasRef.current;
        const g = geomRef.current;
        if (!canvas || !g) return;
        const v = view.current;
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        const extent = clampExtentFor(
            v.k,
            v.fit,
            farmExtent(g.W, g.H),
            countryExtentRef.current,
        );
        const next = clampTranslation(extent, v.k, cw, ch, v.tx, v.ty);
        v.tx = next.tx;
        v.ty = next.ty;
    }, []);

    /**
     * Report the tier the current magnification wants, and whether the
     * view has reached country scale.
     *
     * `fit` frames the whole holding, so `fit / k` is the fraction of it
     * on screen — the visible ground span without a second projection.
     *
     * The country flag rides along here because this already runs after
     * every zoom, from every source (wheel, buttons, pinch, a flight
     * settling). Both writes are conditional or React-bailed, so a drag
     * that changes neither answer costs no render.
     */
    const reportTier = useCallback(() => {
        const v = view.current;
        const canvas = canvasRef.current;
        const country = countryExtentRef.current;
        if (canvas && country) {
            const floor = minZoomScale(v.fit, country, canvas.clientWidth, canvas.clientHeight);
            setAtCountry(v.k <= floor * COUNTRY_SCALE_EPSILON);
        }
        if (!bbox) return;
        const span = bboxSpanMetres(bbox) * (v.fit / Math.max(1e-6, v.k));
        const next = zoomTierForSpan(span);
        if (next !== zoomTier) onZoomTierChange(next);
    }, [bbox, zoomTier, onZoomTierChange]);

    // Backing store + fit.
    useEffect(() => {
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        if (!canvas || !wrap || !geom) return;
        const resize = () => {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const rect = wrap.getBoundingClientRect();
            canvas.width = Math.max(1, Math.round(rect.width * dpr));
            canvas.height = Math.max(1, Math.round(rect.height * dpr));
            const fit = Math.min(rect.width / geom.W, rect.height / geom.H) * 0.98;
            const v = view.current;
            // Stay fit-framed until the user zooms; `k` tracks `fit` while untouched.
            if (v.k < 1e-6 || Math.abs(v.k - v.fit) < 1e-6) {
                v.fit = fit;
                v.k = fit;
                v.tx = (rect.width - geom.W * fit) / 2;
                v.ty = (rect.height - geom.H * fit) / 2;
            } else {
                v.fit = fit;
            }
            clampView();
            drawRef.current();
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(wrap);
        return () => ro.disconnect();
    }, [geom, clampView]);

    useEffect(() => {
        drawRef.current();
    }, [draw]);

    /**
     * Report the tier for the CURRENT framing, not just after a zoom.
     *
     * At the initial fit the visible span is the holding's own span, and
     * the tier that follows from it is rarely the page's opening default
     * — without this a wide holding opens clustered at 5 km pitch, which
     * is one dot, and a tight one opens over-split. Idempotent: the
     * report is suppressed unless the tier actually changes, so the
     * payload → bbox → report cycle settles after one step.
     */
    useEffect(() => {
        reportTier();
    }, [reportTier]);

    /**
     * The floor the zoom may reach, measured rather than chosen.
     *
     * It used to be `fit * 0.35` — enough headroom to see a little
     * around the holding and nowhere near enough to see the holding
     * inside the country, which in this world space is tens of times
     * larger. Now it is whichever is further out: that same 0.35, or the
     * scale at which the country fits the pane.
     */
    const minScale = useCallback(() => {
        const canvas = canvasRef.current;
        const v = view.current;
        if (!canvas) return v.fit * 0.35;
        return minZoomScale(v.fit, countryExtentRef.current, canvas.clientWidth, canvas.clientHeight);
    }, []);

    const zoomAt = useCallback(
        (cx: number, cy: number, factor: number) => {
            const v = view.current;
            const nk = Math.max(minScale(), Math.min(v.fit * 64, v.k * factor));
            v.tx = cx - (cx - v.tx) * (nk / v.k);
            v.ty = cy - (cy - v.ty) * (nk / v.k);
            v.k = nk;
            clampView();
            drawRef.current();
            reportTier();
        },
        [clampView, minScale, reportTier],
    );

    const selectAt = useCallback(
        (clientX: number, clientY: number) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const mx = clientX - rect.left;
            const my = clientY - rect.top;
            // Cluster markers first: they are the aggregate affordance and
            // sit on top of the shapes. Nearest-within-radius over the LAST
            // DRAWN frame, so hit and paint cannot drift apart.
            let best: MapItem | null = null;
            let bd = Infinity;
            for (const it of itemsRef.current) {
                const dx = it.sx - mx;
                const dy = it.sy - my;
                const d = dx * dx + dy * dy;
                if (d < bd) {
                    bd = d;
                    best = it;
                }
            }
            if (best && bd <= PICK_RADIUS_SQ) {
                const c = best.cluster;
                if (selection?.id === c.id) {
                    onSelect(null);
                    return;
                }
                onSelect({
                    id: c.id,
                    zoomTier,
                    parcelIds: [...c.parcelIds],
                    label: c.label,
                    count: c.count,
                });
                return;
            }

            // Otherwise: which outline is under the pointer? The screen →
            // world inverse is the VIEW transform only, and the context
            // transform is reset first, so the point is compared in the
            // path's own coordinates — device pixel ratio and zoom
            // deliberately taken out of the comparison.
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const v = view.current;
            const wx = (mx - v.tx) / v.k;
            const wy = (my - v.ty) / v.k;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            for (const p of parcelPaths) {
                if (ctx.isPointInPath(p.path, wx, wy)) {
                    onParcelOpen(p.id);
                    return;
                }
            }
        },
        [onParcelOpen, onSelect, parcelPaths, selection, zoomTier],
    );

    // ── Pointer: mouse only. Touch is handled natively below. ─────────
    const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
    const moved = useRef(false);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
        if (e.pointerType !== 'mouse') return;
        drag.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty };
        moved.current = false;
        e.currentTarget.setPointerCapture(e.pointerId);
    }, []);

    const onPointerMove = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            if (e.pointerType !== 'mouse') return;
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (Math.abs(dx) + Math.abs(dy) > 5) moved.current = true;
            view.current.tx = d.tx + dx;
            view.current.ty = d.ty + dy;
            clampView();
            drawRef.current();
        },
        [clampView],
    );

    const onPointerUp = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            if (e.pointerType !== 'mouse') return;
            drag.current = null;
            if (!moved.current) selectAt(e.clientX, e.clientY);
        },
        [selectAt],
    );

    const onWheel = useCallback(
        (e: React.WheelEvent<HTMLCanvasElement>) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
        },
        [zoomAt],
    );

    /**
     * Native touch, attached with `{ passive: false }` because React's
     * synthetic touch handlers are passive and cannot preventDefault.
     *
     * ONE gesture per target, and one finger is left entirely to the
     * browser: the page scrolls, and the tab panel's own horizontal-swipe
     * navigation keeps working. Two fingers take the gesture and both
     * ZOOM and PAN the map. A one-finger tap that did not move selects.
     * `preventDefault` is called ONLY on the two-finger paths — the #449
     * lesson is that a preventDefault on a single-touch path silently
     * kills the default action of everything underneath it.
     *
     * The pan half is not a separate gesture. Two fingers moving together
     * are a drag and two fingers moving apart are a zoom, but a real hand
     * does both at once, and a map that only honoured the second would
     * slide the ground back under the fingers on every pinch — the thing
     * a user reads as the map fighting them. So the midpoint is carried
     * frame to frame and its travel is applied as a translation, which is
     * exactly what `ExchangeMap` and `MapCanvas` already do. Since one
     * finger deliberately belongs to the page here, two-finger drag is
     * also the ONLY way to pan on a phone: without it, pinch alone leaves
     * the operator able to magnify a corner they cannot move away from.
     */
    const pinch = useRef<{ d: number; cx: number; cy: number } | null>(null);
    const tap = useRef<{ x: number; y: number; moved: boolean } | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const dist = (e: TouchEvent) => {
            const [a, b] = [e.touches[0], e.touches[1]];
            return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        };
        const midpoint = (e: TouchEvent, rect: DOMRect) => ({
            x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top,
        });

        const onStart = (e: TouchEvent) => {
            if (e.touches.length >= 2) {
                e.preventDefault();
                tap.current = null; // a second finger cancels a pending tap
                const m = midpoint(e, canvas.getBoundingClientRect());
                pinch.current = { d: dist(e), cx: m.x, cy: m.y };
                return;
            }
            const touch = e.touches[0];
            tap.current = { x: touch.clientX, y: touch.clientY, moved: false };
        };

        const onMove = (e: TouchEvent) => {
            if (e.touches.length >= 2 && pinch.current) {
                e.preventDefault(); // take the gesture from the page → drive the map
                const d = dist(e);
                const m = midpoint(e, canvas.getBoundingClientRect());
                const p = pinch.current;
                // Zoom about the CURRENT midpoint, then translate by how
                // far that midpoint travelled since the last frame. Order
                // matters: zooming about the old centre and panning after
                // would rotate the ground around the wrong point.
                if (p.d > 0) zoomAt(m.x, m.y, d / p.d);
                const v = view.current;
                v.tx += m.x - p.cx;
                v.ty += m.y - p.cy;
                clampView();
                drawRef.current();
                pinch.current = { d, cx: m.x, cy: m.y };
                return;
            }
            const tp = tap.current;
            if (tp && e.touches.length === 1) {
                const touch = e.touches[0];
                if (Math.abs(touch.clientX - tp.x) + Math.abs(touch.clientY - tp.y) > 10) tp.moved = true;
            }
            // No preventDefault → the browser scrolls the page.
        };

        const onEnd = (e: TouchEvent) => {
            if (e.touches.length < 2) pinch.current = null;
            if (e.touches.length === 0) {
                const tp = tap.current;
                tap.current = null;
                if (tp && !tp.moved) selectAt(tp.x, tp.y);
            }
        };

        canvas.addEventListener('touchstart', onStart, { passive: false });
        canvas.addEventListener('touchmove', onMove, { passive: false });
        canvas.addEventListener('touchend', onEnd, { passive: false });
        canvas.addEventListener('touchcancel', onEnd, { passive: false });
        return () => {
            canvas.removeEventListener('touchstart', onStart);
            canvas.removeEventListener('touchmove', onMove);
            canvas.removeEventListener('touchend', onEnd);
            canvas.removeEventListener('touchcancel', onEnd);
        };
    }, [clampView, selectAt, zoomAt]);

    const zoomButton = useCallback(
        (factor: number) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor);
        },
        [zoomAt],
    );

    // ── Flying the view ───────────────────────────────────────────────

    /**
     * Ease the view to a target, through the SAME ref a drag writes to.
     *
     * Pan/zoom deliberately lives outside React so a drag never re-renders
     * the tree; a jump-to-parcel that set state per frame would undo that
     * for the sake of an animation. So each frame mutates `view.current`
     * and repaints directly, exactly as `onPointerMove` does — React is
     * told once, about the step INDEX, because that is what the position
     * readout renders.
     *
     * A jump would also be the wrong thing to look at: on a map that now
     * reaches country scale, teleporting between two parcels destroys the
     * only cue for how far apart they are. Under
     * `prefers-reduced-motion` it is a jump, because there the cue is
     * worth less than the discomfort.
     */
    const flight = useRef<number | null>(null);

    const cancelFlight = useCallback(() => {
        if (flight.current != null) {
            cancelAnimationFrame(flight.current);
            flight.current = null;
        }
    }, []);

    const flyTo = useCallback(
        (target: { k: number; tx: number; ty: number }) => {
            cancelFlight();
            const v = view.current;
            const from = { k: v.k, tx: v.tx, ty: v.ty };
            const settle = () => {
                clampView();
                drawRef.current();
                reportTier();
            };

            const reduced =
                typeof window !== 'undefined' &&
                typeof window.matchMedia === 'function' &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reduced || typeof requestAnimationFrame !== 'function') {
                v.k = target.k;
                v.tx = target.tx;
                v.ty = target.ty;
                settle();
                return;
            }

            const started = performance.now();
            const frame = (now: number) => {
                const t = Math.min(1, (now - started) / STEP_FLIGHT_MS);
                // easeOutCubic — leaves fast, arrives gently.
                const e = 1 - Math.pow(1 - t, 3);
                v.k = from.k + (target.k - from.k) * e;
                v.tx = from.tx + (target.tx - from.tx) * e;
                v.ty = from.ty + (target.ty - from.ty) * e;
                drawRef.current();
                if (t < 1) {
                    flight.current = requestAnimationFrame(frame);
                    return;
                }
                flight.current = null;
                settle();
            };
            flight.current = requestAnimationFrame(frame);
        },
        [cancelFlight, clampView, reportTier],
    );

    useEffect(() => cancelFlight, [cancelFlight]);

    // ── Whole country ⇄ this holding ──────────────────────────────────

    /** Country framing for the current pane, or null before geometry. */
    const countryFraming = useCallback(() => {
        const canvas = canvasRef.current;
        const country = countryExtentRef.current;
        if (!canvas || !country) return null;
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        const k = minZoomScale(view.current.fit, country, cw, ch);
        return {
            k,
            ...centreOn(
                (country.minX + country.maxX) / 2,
                (country.minY + country.maxY) / 2,
                k,
                cw,
                ch,
            ),
        };
    }, []);

    const toggleCountry = useCallback(() => {
        const canvas = canvasRef.current;
        const g = geomRef.current;
        if (!canvas || !g) return;
        const v = view.current;
        const country = countryFraming();

        // Already out there (or nothing to go out to) → back to the
        // holding, using the framing `resize` computes for a first paint
        // so the two can never disagree about what "the whole holding"
        // looks like.
        if (!country || v.k <= country.k * COUNTRY_SCALE_EPSILON) {
            flyTo({
                k: v.fit,
                tx: (canvas.clientWidth - g.W * v.fit) / 2,
                ty: (canvas.clientHeight - g.H * v.fit) / 2,
            });
            return;
        }
        flyTo(country);
    }, [countryFraming, flyTo]);

    // ── Stepping through the parcels ──────────────────────────────────

    /**
     * The walk order. With a group selected it walks that group — a
     * stepper that wandered outside the active filter would be answering
     * a different question from the one the table is showing.
     */
    const stepOrder = useMemo(
        () =>
            orderParcelsForStepping(
                overview?.parcels ?? [],
                selection ? new Set(selection.parcelIds) : null,
            ),
        [overview, selection],
    );
    const [stepIndex, setStepIndex] = useState(-1);

    // A changed order is a changed walk — restart it rather than resume
    // at a position that now means a different parcel.
    useEffect(() => {
        setStepIndex(-1);
    }, [stepOrder]);

    const stepToNext = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || !fitted || stepOrder.length === 0) return;
        const next = nextStepIndex(stepIndex, stepOrder.length);
        const id = stepOrder[next];
        const point = overview?.parcels.find((p) => p.id === id);
        if (!point) return;

        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        const v = view.current;
        const [wx, wy] = makeProjector(fitted)(point.lon, point.lat);

        // Frame the parcel's own outline where there is one, so a 60 ha
        // field and a 0.4 ha strip both arrive filling a similar share of
        // the pane. A parcel with a centroid but no geometry has no size
        // to frame, so it gets a fixed magnification instead.
        const shape = parcelPaths.find((p) => p.id === id);
        const wanted = shape
            ? fitScaleForExtent(shape.extent, cw, ch) * STEP_PARCEL_FILL
            : v.fit * STEP_POINT_ZOOM;
        const k = Math.max(minScale(), Math.min(v.fit * 64, wanted));

        setStepIndex(next);
        flyTo({ k, ...centreOn(wx, wy, k, cw, ch) });
    }, [fitted, flyTo, minScale, overview, parcelPaths, stepIndex, stepOrder]);

    const steppedId = stepIndex >= 0 ? stepOrder[stepIndex] : null;
    const steppedName = steppedId ? parcelNames.get(steppedId) : null;

    // ── The accessible half ───────────────────────────────────────────

    const clusters = overview?.clusters ?? [];
    const unpositionedCount = overview?.unpositionedCount ?? 0;

    const selectCluster = useCallback(
        (c: ParcelCluster) => {
            if (selection?.id === c.id) {
                onSelect(null);
                return;
            }
            onSelect({
                id: c.id,
                zoomTier,
                parcelIds: [...c.parcelIds],
                label: c.label,
                count: c.count,
            });
        },
        [onSelect, selection, zoomTier],
    );

    const selectUnpositioned = useCallback(() => {
        if (!overview) return;
        if (selection?.id === UNPOSITIONED_CLUSTER_ID) {
            onSelect(null);
            return;
        }
        onSelect({
            id: UNPOSITIONED_CLUSTER_ID,
            zoomTier,
            parcelIds: [...overview.unpositionedParcelIds],
            label: null,
            count: overview.unpositionedCount,
        });
    }, [onSelect, overview, selection, zoomTier]);

    const hasNothingToDraw = !loading && !error && overview != null && overview.positionedCount === 0;

    return (
        <section className={cn('space-y-default', className)} aria-labelledby="parcel-overview-map-title">
            <div className="flex flex-wrap items-baseline justify-between gap-tight">
                <Heading level={3} id="parcel-overview-map-title">
                    {t('overviewMapTitle')}
                </Heading>
                {selection ? (
                    <Button variant="secondary" size="sm" onClick={() => onSelect(null)}>
                        {t('clusterClear')}
                    </Button>
                ) : (
                    <span className="text-xs text-content-muted">{t('overviewMapHelp')}</span>
                )}
            </div>

            {selection && (
                <p aria-live="polite" className="text-xs text-content-secondary">
                    {selection.id === UNPOSITIONED_CLUSTER_ID
                        ? t('clusterActiveUnpositioned', { count: selection.count })
                        : t('clusterActive', {
                              count: selection.count,
                              label: selection.label ?? t('clusterUnnamed'),
                          })}
                </p>
            )}

            <div
                ref={wrapRef}
                className={cn(
                    'relative w-full select-none overflow-hidden rounded-lg border border-border-subtle',
                    canvasClassName ?? 'h-[220px] md:h-[300px]',
                )}
            >
                <canvas
                    ref={canvasRef}
                    role="img"
                    aria-label={t('overviewMapAria')}
                    className="block h-full w-full touch-pan-y"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onWheel={onWheel}
                />

                {(loading || error || geomFailed || hasNothingToDraw) && (
                    <div className="absolute inset-0 flex items-center justify-center p-default text-center text-xs text-content-muted">
                        <span className="rounded-lg bg-bg-default/85 px-3 py-2">
                            {error || geomFailed
                                ? t('overviewMapError')
                                : loading
                                  ? t('overviewMapLoading')
                                  : t('overviewMapEmpty')}
                        </span>
                    </div>
                )}

                <div className="absolute bottom-3 right-3 flex flex-col gap-tight">
                    <Button
                        variant="secondary"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={t('zoomIn')}
                        icon={<Plus />}
                        onClick={() => zoomButton(1.5)}
                    />
                    <Button
                        variant="secondary"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={t('zoomOut')}
                        icon={<Minus />}
                        onClick={() => zoomButton(1 / 1.5)}
                    />
                    {/* One press to the country and one press back.
                        Reaching country scale on the minus button alone is
                        eight presses from the holding's own framing, which
                        on a phone is not a feature anyone finds. */}
                    <Button
                        variant="secondary"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={atCountry ? t('fitHolding') : t('fitCountry')}
                        aria-pressed={atCountry}
                        icon={<Earth />}
                        onClick={toggleCountry}
                    />
                    {stepOrder.length > 0 && (
                        <Button
                            variant="secondary"
                            size="icon"
                            className="h-7 w-7"
                            aria-label={t('stepNextParcel')}
                            icon={<Crosshairs3 />}
                            onClick={stepToNext}
                        />
                    )}
                </div>
            </div>

            {/* Where the walk currently is. A stepper without a position
                readout leaves the operator unable to tell whether they
                have seen everything or gone round twice — and the canvas
                cannot say it, because canvas pixels are not text. */}
            {steppedId && (
                <p
                    aria-live="polite"
                    data-testid="parcel-step-position"
                    className="text-xs text-content-secondary"
                >
                    {t('stepPosition', {
                        name: steppedName ?? t('clusterUnnamed'),
                        index: stepIndex + 1,
                        total: stepOrder.length,
                    })}
                </p>
            )}

            {overview?.truncated && (
                <p className="text-xs text-content-secondary">
                    {t('overviewMapTruncated', { count: overview.positionedCount + overview.unpositionedCount })}
                </p>
            )}

            {/*
              The same filtering, reachable without the canvas. A map that
              is the only route to a filter excludes every keyboard and
              screen-reader user from the feature, so this list is not a
              fallback — it is the other half of the control.
            */}
            {(clusters.length > 0 || unpositionedCount > 0) && (
                <ul
                    aria-label={t('clusterListLabel')}
                    className="flex max-h-48 flex-wrap gap-tight overflow-y-auto"
                >
                    {clusters.map((c) => (
                        <li key={c.id}>
                            <button
                                type="button"
                                aria-pressed={selection?.id === c.id}
                                onClick={() => selectCluster(c)}
                                className={cn(
                                    'flex min-h-[44px] items-center rounded-lg border px-3 text-xs',
                                    selection?.id === c.id
                                        ? 'border-border-emphasis text-content-emphasis'
                                        : 'border-border-subtle text-content-secondary',
                                )}
                            >
                                {t('clusterChip', {
                                    label: c.label ?? t('clusterUnnamed'),
                                    count: c.count,
                                })}
                            </button>
                        </li>
                    ))}
                    {unpositionedCount > 0 && (
                        <li>
                            <button
                                type="button"
                                aria-pressed={selection?.id === UNPOSITIONED_CLUSTER_ID}
                                onClick={selectUnpositioned}
                                className={cn(
                                    'flex min-h-[44px] items-center rounded-lg border px-3 text-xs',
                                    selection?.id === UNPOSITIONED_CLUSTER_ID
                                        ? 'border-border-emphasis text-content-emphasis'
                                        : 'border-border-subtle text-content-secondary',
                                )}
                            >
                                {t('clusterUnpositioned', { count: unpositionedCount })}
                            </button>
                        </li>
                    )}
                </ul>
            )}
        </section>
    );
}

export default ParcelOverviewMap;

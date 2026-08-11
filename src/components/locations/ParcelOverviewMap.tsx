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
 * WHERE THE LOGIC LIVES. jsdom implements no 2D context, so `getContext`
 * returns null and every drawing and hit-testing path below silently
 * no-ops under test. The arithmetic that must be verified — zoom
 * tiering, the cluster-token codec, the projection bridge, selection
 * resolution — is therefore in `./parcel-overview-model`, where an
 * executing unit test can reach it. What remains here is refs, effects
 * and paint. The cluster LIST is the accessible counterpart: it performs
 * exactly the same filtering, so the feature never depends on pixels a
 * screen reader cannot see.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { Plus, Minus } from '@/components/ui/icons/nucleo';
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
    composeBridgeTransform,
    projectionBridge,
    shouldDrawParcels,
    zoomTierForSpan,
    UNPOSITIONED_CLUSTER_ID,
    type ClusterSelection,
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
const C_LABEL = '#e2e8f0';
const C_LABEL_SHADOW = 'rgba(4,8,12,.85)';

interface MapItem {
    kind: 'cluster' | 'parcel';
    id: string;
    sx: number;
    sy: number;
    r: number;
    label: string;
    selected: boolean;
    cluster: ParcelCluster | null;
}

export interface ParcelOverviewMapProps {
    overview: ParcelOverview | null | undefined;
    loading: boolean;
    error: boolean;
    /** Parcel display names by id — the map holds ids, the page holds names. */
    parcelNames: ReadonlyMap<string, string>;
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

    const bbox = overview?.bbox ?? null;

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

        const project = makeProjector(fitted);
        const items: MapItem[] = [];

        if (drawParcelTier && overview) {
            for (const p of overview.parcels) {
                const [wx, wy] = project(p.lon, p.lat);
                items.push({
                    kind: 'parcel',
                    id: p.id,
                    sx: wx * k + tx,
                    sy: wy * k + ty,
                    r: 5,
                    label: parcelNames.get(p.id) ?? '',
                    selected: selectedIds.has(p.id),
                    cluster: null,
                });
            }
        } else if (overview) {
            const maxCount = overview.clusters.reduce((m, c) => Math.max(m, c.count), 1);
            for (const c of overview.clusters) {
                const [wx, wy] = project(c.lon, c.lat);
                items.push({
                    kind: 'cluster',
                    id: c.id,
                    sx: wx * k + tx,
                    sy: wy * k + ty,
                    r: 6 + (c.count / maxCount) * 12,
                    label: `${c.label ?? t('clusterUnnamed')} · ${c.count}`,
                    selected: selection?.id === c.id,
                    cluster: c,
                });
            }
        }

        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textBaseline = 'middle';

        for (const it of items) {
            const base = it.kind === 'parcel' ? C_PARCEL : C_CLUSTER;
            const colour = it.selected ? C_CLUSTER_SELECTED : base;
            ctx.beginPath();
            ctx.arc(it.sx, it.sy, it.r, 0, Math.PI * 2);
            ctx.fillStyle = colour;
            ctx.globalAlpha = it.selected ? 0.95 : 0.75;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.lineWidth = it.selected ? 2.5 : 1;
            ctx.strokeStyle = it.selected ? C_CLUSTER_SELECTED : 'rgba(11,16,22,.9)';
            ctx.stroke();
        }

        for (const it of items) {
            if (!it.label) continue;
            const x = it.sx + it.r + 6;
            ctx.strokeStyle = C_LABEL_SHADOW;
            ctx.lineWidth = 3;
            ctx.strokeText(it.label, x, it.sy);
            ctx.fillStyle = C_LABEL;
            ctx.fillText(it.label, x, it.sy);
        }

        itemsRef.current = items;
    }, [
        geom,
        fitted,
        bridge,
        oblastPaths,
        outlinePath,
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

    const clampView = useCallback(() => {
        const canvas = canvasRef.current;
        const g = geomRef.current;
        if (!canvas || !g) return;
        const v = view.current;
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        const contentW = g.W * v.k;
        const contentH = g.H * v.k;
        v.tx = contentW <= cw ? (cw - contentW) / 2 : Math.min(0, Math.max(cw - contentW, v.tx));
        v.ty = contentH <= ch ? (ch - contentH) / 2 : Math.min(0, Math.max(ch - contentH, v.ty));
    }, []);

    /**
     * Report the tier the current magnification wants.
     *
     * `fit` frames the whole holding, so `fit / k` is the fraction of it
     * on screen — the visible ground span without a second projection.
     */
    const reportTier = useCallback(() => {
        if (!bbox) return;
        const v = view.current;
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

    const zoomAt = useCallback(
        (cx: number, cy: number, factor: number) => {
            const v = view.current;
            const nk = Math.max(v.fit * 0.35, Math.min(v.fit * 64, v.k * factor));
            v.tx = cx - (cx - v.tx) * (nk / v.k);
            v.ty = cy - (cy - v.ty) * (nk / v.k);
            v.k = nk;
            clampView();
            drawRef.current();
            reportTier();
        },
        [clampView, reportTier],
    );

    const selectAt = useCallback(
        (clientX: number, clientY: number) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const mx = clientX - rect.left;
            const my = clientY - rect.top;
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
            if (!best || bd > PICK_RADIUS_SQ) return;
            if (best.kind === 'parcel') {
                onParcelOpen(best.id);
                return;
            }
            const c = best.cluster;
            if (!c) return;
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
        [onParcelOpen, onSelect, selection, zoomTier],
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
     * navigation keeps working. Two fingers take the gesture and zoom the
     * map. A one-finger tap that did not move selects. `preventDefault`
     * is called ONLY on the two-finger paths — the #449 lesson is that a
     * preventDefault on a single-touch path silently kills the default
     * action of everything underneath it.
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

        const onStart = (e: TouchEvent) => {
            if (e.touches.length >= 2) {
                e.preventDefault();
                tap.current = null; // a second finger cancels a pending tap
                const rect = canvas.getBoundingClientRect();
                pinch.current = {
                    d: dist(e),
                    cx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
                    cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top,
                };
                return;
            }
            const touch = e.touches[0];
            tap.current = { x: touch.clientX, y: touch.clientY, moved: false };
        };

        const onMove = (e: TouchEvent) => {
            if (e.touches.length >= 2 && pinch.current) {
                e.preventDefault(); // take the gesture from the page → zoom the map
                const d = dist(e);
                const p = pinch.current;
                if (p.d > 0) zoomAt(p.cx, p.cy, d / p.d);
                p.d = d;
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
    }, [selectAt, zoomAt]);

    const zoomButton = useCallback(
        (factor: number) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor);
        },
        [zoomAt],
    );

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
                </div>
            </div>

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

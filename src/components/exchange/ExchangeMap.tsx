'use client';

/**
 * ExchangeMap — the cross-tenant marketplace map of Bulgaria.
 *
 * A bespoke Canvas renderer (NOT MapLibre): for a Bulgaria-only commodity
 * overview a full GL basemap was overkill and hard to make read like the
 * "grain floor" mockup. Instead we draw our own map on a 2D canvas:
 *   • Dark canvas = the void outside Bulgaria — no spotlight-mask maths, no
 *     neighbour geography competing for attention.
 *   • Oblast (ADM1) polygons filled by a gold liquidity choropleth (share of
 *     offered tonnage), emerald when filter-selected; click toggles the filter.
 *   • Offer markers: SELL green / BUY blue, sized by tonnage, with a soft glow.
 *     At overview zoom offers AGGREGATE per (region · crop · side) into one
 *     marker labelled with that crop's average price; zoom in and they SPLIT
 *     into individual listings, revealing tonnage then location as you push in.
 *   • One national ★ BEST per crop (cheapest ask, or highest bid for buy-only
 *     crops) gets a gold ring. Price chips de-conflict by priority: a chip that
 *     would overlap a stronger one fades back; hover or tap lifts it forward.
 *
 *   • Tap a marker to pin its full line (location · crop · tonnage · price);
 *     a single offer also opens a detail popup. +/- buttons zoom (bottom-left).
 *
 * ── Prices mean ONE thing here ───────────────────────────────────────────
 * Every price on this canvas used to be stamped `€/t` from a module constant,
 * whatever currency the row actually stored, so a 320 BGN listing read
 * "320€/t" on the map and "320 BGN/t" in the card beside it. Prices now carry
 * their OWN currency (`formatPricePerTonne`), and — because a number is only
 * comparable to another number in the same currency — every AGGREGATE
 * (per-group average, the national ★ best-price ring) is computed over a
 * single currency or not computed at all. A lone USD offer keeps its own
 * label on its own marker and takes no part in the comparison.
 *
 * Geometry (projected province paths + outline + the projection params) is the
 * bundled `/geo/bg-map-geometry.json`; live offer lon/lat is projected at
 * runtime with the same params so markers land on the right province.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { makeProjector } from '@/lib/geo/bg-projection';
import { useLocale, useTranslations } from 'next-intl';
import { Plus, Minus } from '@/components/ui/icons/nucleo';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import {
    isAggregatable,
    isAggregatableWith,
    formatPricePerTonne,
} from '@/lib/exchange/currency';
import { localizedRegionName } from '@/lib/geo/bulgaria-regions';
import { type ExchangeMapListing } from './exchange-map-utils';

/** Side colours — shared by the marker paint AND the page's legend/list so they
 *  always match. Green = selling, blue = buying. */
export const EXCHANGE_SIDE_COLORS = { SELL: '#34d399', BUY: '#5b8def' } as const;

/** Grain-gold — the brand accent (wheat + value/money). Chrome + liquidity. */
export const EXCHANGE_ACCENT_GOLD = '#e3b341';

/** Brighter gold reserved for the best-price ring so it out-punches the chrome. */
const BEST_GOLD = '#f5c542';
/** Selected-region fill (emerald, matching the SELL marker family). */
const REGION_ACCENT = '#22c55e';

/** Zoom (= k / fit) thresholds for progressive disclosure. */
const SPLIT_Z = 3.4; // below: aggregate per region·crop; above: individual offers + tonnage
const LOC_Z = 6.5; //  above: chips also carry the region name

export type { ExchangeMapListing };

interface ExchangeMapProps {
    listings: ExchangeMapListing[];
    /** Currently-filtered region codes (highlighted on the map). */
    selectedRegionCodes: string[];
    /** Toggle a region filter (from an oblast click). */
    onRegionClick: (regionCode: string) => void;
    /** Open a listing's detail (from a popup "View details"). */
    onListingSelect: (id: string) => void;
    /** Highlight a listing's marker (row hover in the list). */
    highlightedId?: string | null;
    className?: string;
}

interface Geometry {
    W: number;
    H: number;
    proj: { minX: number; maxX: number; minY: number; maxY: number; cos: number; ox: number; oy: number; s: number };
    oblasti: { d: string; iso: string; name: string }[];
    outlinePath: string;
}

/** An offer projected into the geometry's WxH space, plus derived flags. */
interface POffer {
    id: string;
    listing: ExchangeMapListing;
    side: 'SELL' | 'BUY';
    commodity: string;
    t: number;
    price: number;
    curr: string;
    regionCode: string;
    regionName: string;
    px: number;
    py: number;
    best: boolean;
    // fan-out for offers sharing an exact projected point (revealed on split)
    fx: number;
    fy: number;
    cCount: number;
}

interface OGroup {
    key: string;
    regionCode: string;
    regionName: string;
    commodity: string;
    side: 'SELL' | 'BUY';
    offers: POffer[];
    offerIds: string[];
    cx: number;
    cy: number;
    totalT: number;
    avg: number | null;
    priceStr: string;
    curr: string;
    best: boolean;
}

/** A drawable marker+chip for the current frame (screen space). */
interface Item {
    id: string;
    sx: number;
    sy: number;
    r: number;
    col: string;
    best: boolean;
    glow: number;
    pri: number;
    loc: string;
    crop: string;
    ton: number;
    priceStr: string;
    curr: string;
    single: boolean;
    offerId?: string;
    offerIds?: string[];
    listing?: ExchangeMapListing;
    wx: number;
    wy: number;
    text?: string;
}

interface Rect { x: number; y: number; w: number; h: number }

function lerp(a: number, b: number, t: number): number {
    return Math.round(a + (b - a) * t);
}
/** Land base (heat 0, warm loam) → bright wheat gold (heat 1). */
function heatColor(h: number): string {
    return `rgb(${lerp(42, 156, h)},${lerp(33, 122, h)},${lerp(19, 52, h)})`;
}
function rectsOverlap(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Draw one marker: soft side-coloured glow, gold double-ring when best. */
function drawMarker(ctx: CanvasRenderingContext2D, it: Item): void {
    // Best gets a prominence FLOOR: marker size encodes tonnage, so the
    // cheapest offer (often small tonnage) would otherwise render as a speck
    // with a tiny gold ring — invisible on a phone. Floor it so the best price
    // always stands out regardless of how many tonnes it carries.
    const R = it.best ? Math.max(it.r * 1.28, 6) : it.r;
    ctx.save();
    ctx.shadowColor = it.col;
    ctx.shadowBlur = 13 + it.glow * 12;
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = it.col;
    ctx.beginPath();
    ctx.arc(it.sx, it.sy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (it.best) {
        ctx.strokeStyle = 'rgba(245,197,66,.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(it.sx, it.sy, R + 7.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.save();
        ctx.shadowColor = BEST_GOLD;
        ctx.shadowBlur = 16;
        ctx.strokeStyle = BEST_GOLD;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(it.sx, it.sy, R + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
    ctx.fillStyle = it.col;
    ctx.strokeStyle = '#0b0f18';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(it.sx, it.sy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
}

interface Model {
    offers: POffer[];
    groups: OGroup[];
    heatByIso: Record<string, number>;
    maxT: number;
    maxGT: number;
}

/** Project listings, tag the national best per crop, and pre-aggregate. */
function buildModel(listings: ExchangeMapListing[], geom: Geometry, locale: string): Model {
    // The transform now lives in @/lib/geo/bg-projection — a second
    // consumer (the parcel-overview map) needs the identical arithmetic,
    // and two copies of a projection drift into markers in the wrong
    // field. Behaviour is pinned by tests/unit/geo/bg-projection.test.ts.
    const project = makeProjector(geom.proj);

    const offers: POffer[] = listings.map((l) => {
        const [px, py] = project(l.lon, l.lat);
        return {
            id: l.id,
            listing: l,
            side: l.side,
            commodity: l.commodity,
            t: Number(l.quantityTonnes) || 0,
            price: Number(l.pricePerTonne) || 0,
            curr: l.priceCurrency,
            regionCode: l.regionCode,
            // Chips render the oblast in the READER's language. The row stores
            // the English name (a stable, locale-independent record), so a
            // Bulgarian farmer used to get "Stara Zagora" on a Bulgarian map.
            regionName: localizedRegionName(l.regionCode, locale, l.regionName),
            px,
            py,
            best: false,
            fx: 0,
            fy: 0,
            cCount: 1,
        };
    });

    // National best per CROP (side-agnostic): cheapest sell ask, or — for a
    // buy-only crop — the highest bid. Ties broken by larger tonnage.
    //
    // ONLY offers in the marketplace currency compete. The ring is a claim
    // that one offer beats every other, and comparing raw numbers across
    // currencies makes that claim false: a floating-rate USD price is not
    // "cheaper" than a euro one because its digits are smaller. Non-EUR rows
    // keep their own label on their own marker and simply take no part.
    const byCrop: Record<string, POffer[]> = {};
    for (const o of offers) {
        if (o.price > 0 && isAggregatable(o.curr)) (byCrop[o.commodity] ??= []).push(o);
    }
    for (const arr of Object.values(byCrop)) {
        const sells = arr.filter((o) => o.side === 'SELL');
        const pool = sells.length ? sells : arr;
        const dir = sells.length ? 1 : -1;
        const win = pool.reduce((a, b) =>
            b.price * dir < a.price * dir || (b.price === a.price && b.t > a.t) ? b : a,
        );
        win.best = true;
    }

    // Fan-out dirs for offers sharing an exact projected point (split view).
    const coincident: Record<string, POffer[]> = {};
    for (const o of offers) (coincident[`${Math.round(o.px)}|${Math.round(o.py)}`] ??= []).push(o);
    for (const list of Object.values(coincident)) {
        list.forEach((o, i) => {
            o.cCount = list.length;
            const a = list.length > 1 ? (i / list.length) * Math.PI * 2 - Math.PI / 2 : 0;
            o.fx = Math.cos(a);
            o.fy = Math.sin(a);
        });
    }

    // Aggregate per region · crop · side.
    const groupMap: Record<string, OGroup> = {};
    for (const o of offers) {
        const key = `${o.regionCode}|${o.commodity}|${o.side}`;
        (groupMap[key] ??= {
            key,
            regionCode: o.regionCode,
            regionName: o.regionName,
            commodity: o.commodity,
            side: o.side,
            offers: [],
            offerIds: [],
            cx: 0,
            cy: 0,
            totalT: 0,
            avg: null,
            priceStr: '',
            curr: o.curr,
            best: false,
        }).offers.push(o);
    }
    const groups = Object.values(groupMap).map((g) => {
        g.offerIds = g.offers.map((o) => o.id);
        g.cx = g.offers.reduce((s, o) => s + o.px, 0) / g.offers.length;
        g.cy = g.offers.reduce((s, o) => s + o.py, 0) / g.offers.length;
        g.totalT = g.offers.reduce((s, o) => s + o.t, 0);
        g.best = g.offers.some((o) => o.best);

        // A group's chip price is an AVERAGE, so it may only be computed when
        // every priced member shares one currency. Mixed group → no number at
        // all: the marker still renders (the tonnage and the crop are true
        // regardless), it just declines to quote an average that would mean
        // nothing. After the euro migration a mixed group needs a legacy USD
        // row to exist at all, so this is the rare path, not the common one.
        const priced = g.offers.filter((o) => o.price > 0);
        const shared = isAggregatableWith(priced.map((o) => o.curr));
        if (shared == null) {
            g.avg = null;
            g.priceStr = '';
        } else {
            g.curr = shared;
            g.avg = Math.round(priced.reduce((s, o) => s + o.price, 0) / priced.length);
            g.priceStr = priced.length > 1 ? `⌀${g.avg}` : `${priced[0].price}`;
        }
        return g;
    });

    // Per-region choropleth heat (share of the busiest region's tonnage).
    const tonnesByRegion: Record<string, number> = {};
    for (const o of offers) tonnesByRegion[o.regionCode] = (tonnesByRegion[o.regionCode] ?? 0) + o.t;
    const maxRegion = Math.max(1, ...Object.values(tonnesByRegion));
    const heatByIso: Record<string, number> = {};
    for (const [iso, tonnes] of Object.entries(tonnesByRegion)) heatByIso[iso] = tonnes / maxRegion;

    return {
        offers,
        groups,
        heatByIso,
        maxT: Math.max(1, ...offers.map((o) => o.t)),
        maxGT: Math.max(1, ...groups.map((g) => g.totalT)),
    };
}

export function ExchangeMap({
    listings,
    selectedRegionCodes,
    onRegionClick,
    onListingSelect,
    highlightedId,
    className,
}: ExchangeMapProps) {
    const t = useTranslations('exchangeMap');
    const locale = useLocale();
    // The tonne glyph is a TRANSLATED string, not a latin `t`: the Bulgarian
    // surfaces alternated between `t` and `т` on adjacent chips. Canvas text
    // can't go through <FormattedMessage>, so it is read once here and threaded
    // into the draw pass.
    const tonne = t('unitTonne');
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const popupRef = useRef<HTMLDivElement | null>(null);

    const [geom, setGeom] = useState<Geometry | null>(null);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [pinnedId, setPinnedId] = useState<string | null>(null);
    const [popup, setPopup] = useState<{ listing: ExchangeMapListing; wx: number; wy: number } | null>(null);

    // View transform (pan/zoom) lives in a ref so pointer moves never re-render.
    const view = useRef({ k: 1, tx: 0, ty: 0, fit: 1 });
    // Geometry mirrored into a ref so the (stable) clamp helper reads current
    // W/H without dep threading.
    const geomRef = useRef<Geometry | null>(null);
    // Last frame's drawn items, for pointer hit-testing.
    const itemsRef = useRef<Item[]>([]);
    // Latest draw fn, so once-attached pointer handlers always call the current one.
    const drawRef = useRef<() => void>(() => {});

    // Clamp the pan so the country can never drift off the pane: centre it in an
    // axis where the content is smaller than the viewport, otherwise keep the
    // content edges flush (no dark gaps, no gold country piling against an edge).
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

    useEffect(() => {
        let alive = true;
        fetch('/geo/bg-map-geometry.json')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then((d: Geometry) => {
                if (!alive) return;
                setGeom(d);
                setStatus('ready');
            })
            .catch(() => alive && setStatus('error'));
        return () => {
            alive = false;
        };
    }, []);

    const provincePaths = useMemo(
        () => (geom ? geom.oblasti.map((o) => ({ path: new Path2D(o.d), iso: o.iso })) : []),
        [geom],
    );
    const outlinePath = useMemo(() => (geom ? new Path2D(geom.outlinePath) : null), [geom]);
    const model = useMemo(
        () => (geom ? buildModel(listings, geom, locale) : null),
        [geom, listings, locale],
    );

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        const g = geom;
        const m = model;
        if (!canvas || !g || !m) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const CW = canvas.clientWidth;
        const CH = canvas.clientHeight;
        const { k, tx, ty, fit } = view.current;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#060a12';
        ctx.fillRect(0, 0, CW, CH);

        // Provinces + outline in world (WxH) space.
        ctx.save();
        ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
        const selected = new Set(selectedRegionCodes);
        for (const p of provincePaths) {
            ctx.fillStyle = selected.has(p.iso) ? REGION_ACCENT : heatColor(m.heatByIso[p.iso] ?? 0);
            ctx.fill(p.path);
        }
        ctx.lineWidth = 0.5 / k;
        for (const p of provincePaths) {
            ctx.strokeStyle = selected.has(p.iso) ? REGION_ACCENT : 'rgba(90,74,42,.5)';
            ctx.lineWidth = (selected.has(p.iso) ? 1.6 : 0.5) / k;
            ctx.stroke(p.path);
        }
        if (outlinePath) {
            ctx.lineWidth = 1.1 / k;
            ctx.strokeStyle = 'rgba(227,179,65,.35)';
            ctx.stroke(outlinePath);
        }
        ctx.restore();

        // Build this frame's markers (aggregate below SPLIT, individual above).
        const z = k / fit;
        const items: Item[] = [];
        const col = (side: 'SELL' | 'BUY') => EXCHANGE_SIDE_COLORS[side];
        if (z < SPLIT_Z) {
            for (const gr of m.groups) {
                items.push({
                    id: `g${gr.key}`,
                    sx: gr.cx * k + tx,
                    sy: gr.cy * k + ty,
                    r: 3 + (gr.totalT / m.maxGT) * 3,
                    col: col(gr.side),
                    best: gr.best,
                    glow: gr.totalT / m.maxGT,
                    pri: (gr.best ? 1e6 : 0) + gr.totalT,
                    loc: gr.regionName,
                    crop: gr.commodity,
                    ton: gr.totalT,
                    priceStr: gr.priceStr,
                    curr: gr.curr,
                    single: false,
                    offerIds: gr.offerIds,
                    wx: gr.cx,
                    wy: gr.cy,
                });
            }
        } else {
            const spread = Math.min(36, 16 + (z - SPLIT_Z) * 24);
            for (const o of m.offers) {
                const off = o.cCount > 1;
                items.push({
                    id: `s${o.id}`,
                    sx: o.px * k + tx + (off ? o.fx * spread : 0),
                    sy: o.py * k + ty + (off ? o.fy * spread : 0),
                    r: 2.4 + (o.t / m.maxT) * 3,
                    col: col(o.side),
                    best: o.best,
                    glow: o.t / m.maxT,
                    pri: (o.best ? 1e6 : 0) + o.t,
                    loc: o.regionName,
                    crop: o.commodity,
                    ton: o.t,
                    priceStr: o.price > 0 ? `${o.price}` : '',
                    curr: o.curr,
                    single: true,
                    offerId: o.id,
                    listing: o.listing,
                    wx: o.px,
                    wy: o.py,
                });
            }
        }

        // Compose each chip's text: crop always; +tonnage on split/pin; +region
        // on deep-zoom/pin; price always (when known) with ITS OWN currency —
        // never a blanket unit stamped over whatever the row stored.
        const showLocAll = z >= LOC_Z;
        const showTonAll = z >= SPLIT_Z;
        for (const it of items) {
            const pin = it.id === pinnedId;
            const parts: string[] = [];
            if ((showLocAll || pin) && it.loc) parts.push(it.loc);
            parts.push(it.crop);
            if (showTonAll || pin) parts.push(`${it.ton}${tonne}`);
            if (it.priceStr) parts.push(formatPricePerTonne(it.priceStr, it.curr, tonne));
            it.text = parts.join('·');
        }

        // Which marker the list-row hover maps to (bring its chip forward).
        const hovered = highlightedId
            ? items.find((it) =>
                  it.single ? it.offerId === highlightedId : it.offerIds?.includes(highlightedId),
              )
            : undefined;
        const hoverId = hovered?.id ?? null;

        // Markers first, then chips (so labels sit above every dot).
        for (const it of items) drawMarker(ctx, it);

        // Chip placement — anchored to the RIGHT of the marker by default, but
        // flipped BELOW + centred when a right-anchored chip would clip the east
        // edge (Black Sea coast markers used to get cut off), then clamped so it
        // always stays fully on-screen. `cy` is the chip's vertical centre; `x/y`
        // is the top-left box corner (both the hit rect + the paint use these, so
        // de-confliction and drawing agree).
        const CHIP_PAD = 6;
        const placeChip = (it: Item): { x: number; y: number; w: number; cx0: number; cy: number } => {
            ctx.font = '10px ui-monospace,monospace';
            // Best gets a drawn gold dot (no glyph — keeps the file emoji-free).
            const badge = it.best ? 9 : 0;
            const w = ctx.measureText(it.text ?? '').width + badge + 7;
            let bx = it.sx + 5;
            let cy = it.sy;
            if (bx + w > CW - CHIP_PAD) {
                bx = it.sx - w / 2; // centre the chip under the marker
                cy = it.sy + 16; // and drop it below the dot
            }
            bx = Math.max(CHIP_PAD, Math.min(bx, CW - w - CHIP_PAD));
            return { x: bx, y: cy - 8, w, cx0: bx, cy };
        };
        const rectOf = (it: Item): Rect => {
            const p = placeChip(it);
            return { x: p.x, y: p.y, w: p.w, h: 16 };
        };
        const drawChip = (it: Item, alpha: number) => {
            const p = placeChip(it);
            ctx.globalAlpha = alpha;
            ctx.fillStyle = '#0d1220';
            ctx.strokeStyle = it.best ? BEST_GOLD : '#2a3648';
            ctx.lineWidth = it.best ? 1.2 : 1;
            ctx.beginPath();
            ctx.roundRect(p.x, p.y, p.w, 16, 4);
            ctx.fill();
            ctx.stroke();
            ctx.textBaseline = 'middle';
            let cx = p.cx0 + 4;
            if (it.best) {
                ctx.fillStyle = BEST_GOLD;
                ctx.beginPath();
                ctx.arc(p.cx0 + 7, p.cy, 2.6, 0, Math.PI * 2);
                ctx.fill();
                cx = p.cx0 + 13;
            }
            ctx.font = '10px ui-monospace,monospace';
            ctx.fillStyle = '#ede7d8';
            ctx.fillText(it.text ?? '', cx, p.cy);
            ctx.globalAlpha = 1;
        };

        const placed: Rect[] = [];
        const lift = new Set([hoverId, pinnedId]);
        for (const it of [...items].sort((a, b) => b.pri - a.pri)) {
            if (lift.has(it.id)) continue;
            const rect = rectOf(it);
            const clip = placed.some((r) => rectsOverlap(r, rect));
            if (!clip || it.best) {
                placed.push(rect);
                drawChip(it, 1);
            } else {
                drawChip(it, 0.24);
            }
        }
        const pinItem = items.find((i) => i.id === pinnedId);
        if (pinItem) drawChip(pinItem, 1);
        const hovItem = items.find((i) => i.id === hoverId && i.id !== pinnedId);
        if (hovItem) drawChip(hovItem, 1);

        itemsRef.current = items;

        // Keep the DOM detail popup pinned to its offer through pan/zoom.
        if (popup && popupRef.current) {
            popupRef.current.style.transform = `translate(-50%, -100%) translate(${popup.wx * k + tx}px, ${popup.wy * k + ty - 14}px)`;
        }
    }, [geom, model, provincePaths, outlinePath, selectedRegionCodes, highlightedId, pinnedId, popup, tonne]);

    // Keep the ref pointing at the latest draw so once-attached pointer
    // handlers and the ResizeObserver always call the current closure.
    useEffect(() => {
        drawRef.current = draw;
        geomRef.current = geom;
    });

    // Resize / initial fit — the pane settles after mount, so refit on resize.
    useEffect(() => {
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        if (!canvas || !wrap || !geom) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const resize = () => {
            const rect = wrap.getBoundingClientRect();
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            // 0.9 (not 0.98) leaves a margin so the gold country never sits
            // flush against the pane edges (the "dirty yellow border").
            const fit = Math.min(rect.width / geom.W, rect.height / geom.H) * 0.9;
            const v = view.current;
            // Keep it fit-framed until the user zooms (k tracks fit while untouched).
            if (v.k < 0.5 || Math.abs(v.k - v.fit) < 1e-6) {
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

    // Redraw whenever the frame inputs change.
    useEffect(() => {
        drawRef.current();
    }, [draw]);

    const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
        const v = view.current;
        const nk = Math.max(v.fit * 0.9, Math.min(v.fit * 22, v.k * factor));
        v.tx = cx - (cx - v.tx) * (nk / v.k);
        v.ty = cy - (cy - v.ty) * (nk / v.k);
        v.k = nk;
        clampView();
        drawRef.current();
    }, [clampView]);

    // Pointer: drag to pan, distinguish a tap, hit-test markers then provinces.
    const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
    const moved = useRef(false);
    // Touch gesture state: pinch (two fingers → zoom + pan the map) and a
    // pending single-tap (→ select). One-finger drags are left to the browser
    // so the PAGE scrolls, like an embedded Google map.
    const pinch = useRef<{ dist: number; mx: number; my: number } | null>(null);
    const touchTap = useRef<{ x: number; y: number; moved: boolean } | null>(null);

    const nearest = useCallback((mx: number, my: number): Item | null => {
        let best: Item | null = null;
        let bd = 1e9;
        for (const it of itemsRef.current) {
            const dx = it.sx - mx;
            const dy = it.sy - my;
            const d = dx * dx + dy * dy;
            if (d < bd) {
                bd = d;
                best = it;
            }
        }
        return bd < 676 ? best : null;
    }, []);

    // Select at a screen point: hit-test markers first (pin / open the detail
    // popup), else fall back to a province hit-test that drives the region
    // filter. Shared by the mouse (pointer) path and the touch tap handler.
    const selectAt = useCallback(
        (clientX: number, clientY: number) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const mx = clientX - rect.left;
            const my = clientY - rect.top;
            const hit = nearest(mx, my);
            if (hit) {
                setPinnedId((cur) => (cur === hit.id ? null : hit.id));
                if (hit.single && hit.listing) {
                    setPopup({ listing: hit.listing, wx: hit.wx, wy: hit.wy });
                } else {
                    setPopup(null);
                }
                return;
            }
            // Empty space → clear selection, then province hit-test for the filter.
            setPinnedId(null);
            setPopup(null);
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const v = view.current;
            const wx = (mx - v.tx) / v.k;
            const wy = (my - v.ty) / v.k;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            for (const p of provincePaths) {
                if (ctx.isPointInPath(p.path, wx, wy)) {
                    onRegionClick(p.iso);
                    break;
                }
            }
        },
        [nearest, onRegionClick, provincePaths],
    );

    // Mouse only: press-drag pans, a click (no drag) selects. Touch gestures are
    // handled by the native listeners below — one finger scrolls the PAGE, two
    // fingers zoom the MAP — so the pointer handlers deliberately ignore touch.
    const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
        if (e.pointerType !== 'mouse') return;
        drag.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty };
        moved.current = false;
        e.currentTarget.setPointerCapture(e.pointerId);
    }, []);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
        if (e.pointerType !== 'mouse') return;
        const d = drag.current;
        if (!d) return;
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 5) moved.current = true;
        view.current.tx = d.tx + (e.clientX - d.x);
        view.current.ty = d.ty + (e.clientY - d.y);
        clampView();
        drawRef.current();
    }, [clampView]);

    const onPointerUp = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            if (e.pointerType !== 'mouse') return;
            const wasDrag = moved.current;
            drag.current = null;
            if (wasDrag) return;
            selectAt(e.clientX, e.clientY);
        },
        [selectAt],
    );

    // Native touch gestures (cooperative, embedded-map style). Attached
    // imperatively with { passive: false } because React's synthetic onTouch*
    // handlers are passive and cannot preventDefault. One finger is left to the
    // browser (the PAGE scrolls); two fingers pinch-zoom + pan the MAP; a
    // one-finger tap that didn't move selects.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const spread = (t: TouchList) =>
            Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
        const midpoint = (t: TouchList, rect: DOMRect) => ({
            x: (t[0].clientX + t[1].clientX) / 2 - rect.left,
            y: (t[0].clientY + t[1].clientY) / 2 - rect.top,
        });
        const onStart = (e: TouchEvent) => {
            if (e.touches.length >= 2) {
                const rect = canvas.getBoundingClientRect();
                const m = midpoint(e.touches, rect);
                pinch.current = { dist: spread(e.touches), mx: m.x, my: m.y };
                touchTap.current = null; // a second finger cancels any pending tap
                e.preventDefault();
            } else if (e.touches.length === 1) {
                touchTap.current = {
                    x: e.touches[0].clientX,
                    y: e.touches[0].clientY,
                    moved: false,
                };
            }
        };
        const onMove = (e: TouchEvent) => {
            if (e.touches.length >= 2 && pinch.current) {
                e.preventDefault(); // take the gesture from the page → zoom the map
                const rect = canvas.getBoundingClientRect();
                const nd = spread(e.touches);
                const m = midpoint(e.touches, rect);
                const p = pinch.current;
                if (p.dist > 0) zoomAt(m.x, m.y, nd / p.dist);
                const v = view.current;
                v.tx += m.x - p.mx;
                v.ty += m.y - p.my;
                clampView();
                drawRef.current();
                pinch.current = { dist: nd, mx: m.x, my: m.y };
            } else if (e.touches.length === 1 && touchTap.current) {
                const t = e.touches[0];
                if (
                    Math.abs(t.clientX - touchTap.current.x) +
                        Math.abs(t.clientY - touchTap.current.y) >
                    10
                ) {
                    touchTap.current.moved = true; // it became a scroll, not a tap
                }
                // No preventDefault → the browser scrolls the page.
            }
        };
        const onEnd = (e: TouchEvent) => {
            if (e.touches.length < 2) pinch.current = null;
            if (e.touches.length === 0) {
                const t = touchTap.current;
                touchTap.current = null;
                if (t && !t.moved) selectAt(t.x, t.y);
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
    }, [zoomAt, clampView, selectAt]);

    const onWheel = useCallback(
        (e: React.WheelEvent<HTMLCanvasElement>) => {
            const rect = e.currentTarget.getBoundingClientRect();
            zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
        },
        [zoomAt],
    );

    const zoomButton = useCallback(
        (factor: number) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor);
        },
        [zoomAt],
    );

    const popupListing = popup?.listing ?? null;

    return (
        <div
            ref={wrapRef}
            className={cn(
                'relative h-full w-full select-none overflow-hidden rounded-lg border border-border-default',
                className,
            )}
        >
            <canvas
                ref={canvasRef}
                className="block h-full w-full touch-pan-y"
                style={{ cursor: 'grab' }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onWheel={onWheel}
            />

            {/* Detail popup for a tapped single offer — tracks the marker via a
                transform set in draw(). */}
            {popupListing && (
                <div
                    ref={popupRef}
                    className="pointer-events-auto absolute left-0 top-0 z-10 w-52 space-y-tight rounded-lg border border-border-emphasis bg-bg-elevated p-default"
                >
                    <div className="flex items-center gap-compact">
                        <span
                            aria-hidden="true"
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: EXCHANGE_SIDE_COLORS[popupListing.side] }}
                        />
                        <span className="text-sm font-medium text-content-emphasis">{popupListing.commodity}</span>
                        <span className="text-xs text-content-muted">
                            {popupListing.side === 'SELL' ? t('selling') : t('buying')}
                        </span>
                    </div>
                    {/* This offer's OWN price in its OWN currency — the popup
                        used to relabel it with a blanket €/t. */}
                    <div className="text-xs text-content-secondary">
                        {popupListing.quantityTonnes} {tonne}
                        {popupListing.pricePerTonne
                            ? ` · ${formatPricePerTonne(popupListing.pricePerTonne, popupListing.priceCurrency, tonne)}`
                            : ''}
                    </div>
                    <div className="text-xs text-content-muted">
                        {localizedRegionName(popupListing.regionCode, locale, popupListing.regionName)}
                    </div>
                    <Button
                        variant="secondary"
                        size="sm"
                        className="mt-1 w-full"
                        onClick={() => onListingSelect(popupListing.id)}
                    >
                        {t('viewDetails')}
                    </Button>
                </div>
            )}

            {/* Zoom practices (bottom-right, compact). */}
            {status === 'ready' && (
                <div className="absolute bottom-3 right-3 flex flex-col gap-1">
                    <Button
                        variant="secondary"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={t('zoomIn')}
                        onClick={() => zoomButton(1.5)}
                        icon={<Plus />}
                    />
                    <Button
                        variant="secondary"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={t('zoomOut')}
                        onClick={() => zoomButton(1 / 1.5)}
                        icon={<Minus />}
                    />
                </div>
            )}

            {/* Loading / error / empty. */}
            {status === 'loading' && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg-default/60">
                    <span className="animate-pulse text-sm text-content-muted">{t('loadingMap')}</span>
                </div>
            )}
            {status === 'error' && (
                <div className="absolute inset-0 flex items-center justify-center bg-bg-default/80 p-default">
                    <div className="flex max-w-xs flex-col items-center gap-compact rounded-lg border border-border-subtle bg-bg-elevated p-default text-center">
                        <p className="text-sm font-medium text-content-emphasis">{t('mapLoadError')}</p>
                        <p className="text-xs text-content-muted">{t('mapLoadErrorDetail')}</p>
                    </div>
                </div>
            )}
            {status === 'ready' && listings.length === 0 && (
                <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border-subtle bg-bg-elevated/90 px-3 py-1 text-xs text-content-muted">
                    {t('noOffers')}
                </div>
            )}

            {/* Terminal chrome — wordmark chip + SELL/BUY/best/liquidity key. */}
            {status === 'ready' && (
                <>
                    <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full border border-border-subtle bg-bg-default/70 px-3 py-1.5 backdrop-blur-sm">
                        <span
                            className="inline-flex h-2 w-2 animate-pulse rounded-full"
                            style={{ backgroundColor: EXCHANGE_ACCENT_GOLD }}
                        />
                        <span className="text-xs font-semibold tracking-wide text-content-emphasis">БОРСА</span>
                        <span className="text-xs text-content-muted">· {t('exchangeSuffix')}</span>
                    </div>
                    <div className="pointer-events-none absolute bottom-3 left-3 right-14 flex flex-wrap items-center gap-compact rounded-lg border border-border-subtle bg-bg-default/70 px-3 py-1.5 backdrop-blur-sm">
                        <span className="flex items-center gap-1.5 text-xs text-content-muted">
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: EXCHANGE_SIDE_COLORS.SELL }} />
                            {t('selling')}
                        </span>
                        <span className="flex items-center gap-1.5 text-xs text-content-muted">
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: EXCHANGE_SIDE_COLORS.BUY }} />
                            {t('buying')}
                        </span>
                        <span className="flex items-center gap-1.5 text-xs text-content-muted">
                            <span className="h-2.5 w-2.5 rounded-full border" style={{ borderColor: BEST_GOLD }} />
                            {t('bestPrice')}
                        </span>
                    </div>
                </>
            )}
        </div>
    );
}

export default ExchangeMap;

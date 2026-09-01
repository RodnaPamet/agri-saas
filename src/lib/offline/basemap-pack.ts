/**
 * Offline basemap pack — bounded, per-location tile math + cache budget.
 *
 * Roadmap-6 P1b. The operator orientation map blanks at zero bars because
 * every basemap source (MapTiler satellite, demotiles, GEE rasters, ISRIC
 * WMS) is cross-origin and the service worker passes cross-origin requests
 * through untouched. This module is the shared, side-effect-free core of the
 * fix: it computes the SMALL, bounded set of basemap tiles that cover ONE
 * location's bbox over a capped zoom range, and it holds the LRU-eviction
 * predicate for the dedicated basemap cache.
 *
 * ── Source + licensing ────────────────────────────────────────────────
 * The pack is sourced from the MapLibre **demotiles** vector tiles
 * (`demotiles.maplibre.org`) — Natural Earth data, public domain — the SAME
 * source the app already renders as its keyless fallback basemap (see
 * `resolveBasemapStyle` in `@/lib/geo/basemap-style`). We deliberately do
 * NOT cache live MapTiler tiles: MapTiler's licence for a wholesale/bulk
 * offline copy is unclear, so a bounded, user-initiated download of MapTiler
 * imagery would be a licensing risk. Natural-earth demotiles are unambiguously
 * redistributable, so the offline pack degrades to the same coarse
 * (country / coastline / graticule) backdrop the app shows without a
 * MapTiler key — served SAME-ORIGIN so the service worker can cache it. The
 * operator's own parcels render on top from the same-origin parcel data
 * (cached separately by the field-data DATA_CACHE), so offline the map shows
 * fields on a real backdrop instead of a blank void.
 *
 * The proxy route re-serves these tiles same-origin, strictly bounded to a
 * location's bbox over `[BASEMAP_MIN_ZOOM, BASEMAP_MAX_ZOOM]` (demotiles'
 * native zoom range — higher zooms are overzoomed client-side by MapLibre),
 * with a hard `BASEMAP_PACK_MAX_TILES` ceiling.
 */

/** Demotiles' native vector-tile zoom range (from its tiles.json). */
export const BASEMAP_MIN_ZOOM = 0;
export const BASEMAP_MAX_ZOOM = 6;

/**
 * Hard ceiling on the tiles a single location pack may request. A real farm
 * bbox covers only a handful of tiles across z0–6 (the demotiles grid is
 * coarse), so this is a safety ceiling that a legitimate download never hits
 * — it exists to keep a pathological bbox (or a bug) from fanning out into a
 * bulk crawl.
 */
export const BASEMAP_PACK_MAX_TILES = 256;

/** Upstream (public-domain, natural-earth) tile template proxied same-origin. */
export const BASEMAP_UPSTREAM_TILE_TEMPLATE =
    'https://demotiles.maplibre.org/tiles/{z}/{x}/{y}.pbf';

/**
 * Byte budget for the dedicated basemap cache in the service worker. Vector
 * demotiles tiles are tiny (single-digit KB), so 24 MB comfortably holds many
 * locations' packs; the LRU eviction below sheds the least-recently-used
 * tiles when a farmer with many fields crosses it.
 */
export const BASEMAP_CACHE_BUDGET_BYTES = 24 * 1024 * 1024;

export interface TileCoord {
    z: number;
    x: number;
    y: number;
}

/** Web-Mercator latitude limit (tile grid is undefined beyond the poles). */
const MERCATOR_LAT_LIMIT = 85.05112878;

/**
 * Slippy-map tile (x,y) containing a lon/lat at zoom `z`. Result is clamped
 * into the valid `[0, 2^z)` grid so an out-of-range coordinate never yields a
 * negative / overflowing tile address.
 */
export function lngLatToTileXY(lng: number, lat: number, z: number): { x: number; y: number } {
    const n = 2 ** z;
    const clampLat = Math.min(MERCATOR_LAT_LIMIT, Math.max(-MERCATOR_LAT_LIMIT, lat));
    const latRad = (clampLat * Math.PI) / 180;
    const rawX = Math.floor(((lng + 180) / 360) * n);
    const rawY = Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
    );
    const clamp = (v: number) => Math.min(n - 1, Math.max(0, v));
    return { x: clamp(rawX), y: clamp(rawY) };
}

/**
 * The bounded set of tiles covering `bbox` = [west, south, east, north] over
 * `[minZoom, maxZoom]`, capped at `cap` tiles (returns early once the cap is
 * hit). Used BOTH client-side (the download affordance computes what to
 * fetch) and server-side (the proxy validates a requested tile is in range).
 */
export function tilesForBbox(
    bbox: [number, number, number, number],
    minZoom: number = BASEMAP_MIN_ZOOM,
    maxZoom: number = BASEMAP_MAX_ZOOM,
    cap: number = BASEMAP_PACK_MAX_TILES,
): TileCoord[] {
    const [w, s, e, n] = bbox;
    const tiles: TileCoord[] = [];
    for (let z = minZoom; z <= maxZoom; z++) {
        const nw = lngLatToTileXY(w, n, z);
        const se = lngLatToTileXY(e, s, z);
        const xMin = Math.min(nw.x, se.x);
        const xMax = Math.max(nw.x, se.x);
        const yMin = Math.min(nw.y, se.y);
        const yMax = Math.max(nw.y, se.y);
        for (let x = xMin; x <= xMax; x++) {
            for (let y = yMin; y <= yMax; y++) {
                tiles.push({ z, x, y });
                if (tiles.length >= cap) return tiles;
            }
        }
    }
    return tiles;
}

/**
 * Whether tile (z,x,y) falls inside `bbox`. The proxy route rejects any tile
 * outside the requested location's bbox (404), so the same-origin basemap
 * endpoint can only ever serve that location's bounded pack — never an
 * unbounded crawl of the upstream source.
 */
export function isTileInBbox(
    bbox: [number, number, number, number],
    z: number,
    x: number,
    y: number,
): boolean {
    const [w, s, e, n] = bbox;
    const nw = lngLatToTileXY(w, n, z);
    const se = lngLatToTileXY(e, s, z);
    return (
        x >= Math.min(nw.x, se.x) &&
        x <= Math.max(nw.x, se.x) &&
        y >= Math.min(nw.y, se.y) &&
        y <= Math.max(nw.y, se.y)
    );
}

export interface BasemapCacheEntry {
    /** Cache key (request URL). */
    key: string;
    /** Stored response size in bytes. */
    size: number;
}

/**
 * LRU eviction predicate for the dedicated basemap cache.
 *
 * `entries` MUST be ordered oldest-(least-recently-used)-first — the service
 * worker keeps this order by re-inserting an entry on every cache hit (Cache
 * Storage preserves insertion order, so a delete-then-put moves a touched
 * tile to the newest end). Given the ordered entries and a byte budget, this
 * returns the prefix of keys to evict so the remaining total sits at or under
 * budget. Over budget ⇒ oldest tiles are evicted first; at/under budget ⇒ no
 * eviction (`[]`).
 *
 * Pure + deterministic so it is unit-tested directly; the service worker
 * mirrors this exact logic inline (it cannot import from `src/`), kept in
 * lockstep by the offline-pwa-coverage guardrail.
 */
export function selectBasemapEvictions(
    entries: BasemapCacheEntry[],
    budgetBytes: number,
): string[] {
    let total = entries.reduce((sum, entry) => sum + Math.max(0, entry.size), 0);
    const evict: string[] = [];
    for (let i = 0; i < entries.length && total > budgetBytes; i++) {
        evict.push(entries[i].key);
        total -= Math.max(0, entries[i].size);
    }
    return evict;
}

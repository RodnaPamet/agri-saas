/**
 * ISRIC SoilGrids WRB ("most probable soil class") WMS — URL construction and
 * bounds for the same-origin proxy at
 * `/api/t/[tenantSlug]/soil/wms/[z]/[x]/[y]`.
 *
 * Until #782 the overlay was fetched by MapLibre DIRECTLY from
 * `maps.isric.org`, on the strength of the upstream being CORS-open. That is
 * the property that made it a third-party dependency of the RENDERING path:
 * an operator opening Soil view fetched from ISRIC live, with no proxy, no
 * timeout and no fallback, and every E2E run that enabled Soil view would have
 * reached a third-party origin on a test's critical path.
 *
 * Unlike the cadastre proxy this one has **no geographic envelope**, and that
 * is a deliberate difference rather than an omission. The cadastre envelope
 * exists because its upstream is a paid, IP-METERED №8002 licence
 * (`cadastre-tiles.ts`), so an out-of-country tile is money spent on nothing.
 * ISRIC's WRB WMS is free, global and CC-BY 4.0, and the shipped feature works
 * anywhere; refusing non-Bulgarian tiles would be a silent product regression
 * dressed up as a bound. The zoom ceiling plus the 7-day Redis cache are what
 * bound the traffic profile here.
 */
import { tileTo3857Bbox } from './cadastre-tiles';

/**
 * Upstream base. The `map=` parameter is part of the ENDPOINT for MapServer —
 * it selects the mapfile — so it stays in the base string and is appended to
 * with the correct separator, exactly as `buildCadastreWmsUrl` does.
 *
 * Building the whole query with `URLSearchParams` instead would emit
 * `map=%2Fmap%2Fwrb.map`, changing the request bytes from the form known to
 * work against this MapServer. A rejection there does not surface as an error:
 * the proxy soft-fails to 204 and the operator gets a silently blank overlay.
 * `soil-tiles.test.ts` pins the built URL against the literal that shipped.
 */
export const SOIL_WMS_BASE = 'https://maps.isric.org/mapserv?map=/map/wrb.map';

/** The WRB "most probable soil class" layer. */
export const SOIL_WMS_LAYER = 'MostProbable';

/**
 * Highest tile zoom the proxy will serve, and the value the raster `<Source>`
 * declares as its `maxzoom`.
 *
 * The `<Source>` declaration is the load-bearing half. MapLibre resolves a
 * raster source's tile zoom as `round(map.zoom + log2(512 / tileSize))`, and
 * the soil source uses `tileSize={256}` — so it requests **map zoom + 1**.
 * `MapCanvas` fits parcels with `maxZoom: 16`, which puts a fitted
 * single-parcel view at map zoom ~15-16 and would request z=16-17 tiles.
 * A route ceiling alone would therefore 204 exactly the zoom operators work
 * at; declaring `maxzoom` on the source makes MapLibre OVERZOOM (scale the
 * z16 tile) instead of requesting a tile the route refuses.
 *
 * Keep the two in lockstep: the constant is used by both.
 */
export const SOIL_TILE_MAX_ZOOM = 16;

/** True when the proxy will serve this tile zoom. */
export function isSoilZoomAllowed(z: number): boolean {
    return Number.isInteger(z) && z >= 0 && z <= SOIL_TILE_MAX_ZOOM;
}

/**
 * WMS 1.1.1 `GetMap` for a 256×256 EPSG:3857 tile. Axis order under SRS
 * (1.1.1) is easting,northing → `minX,minY,maxX,maxY`.
 */
export function buildSoilWmsUrl(z: number, x: number, y: number): string {
    const qp = new URLSearchParams({
        SERVICE: 'WMS',
        VERSION: '1.1.1',
        REQUEST: 'GetMap',
        LAYERS: SOIL_WMS_LAYER,
        STYLES: '',
        FORMAT: 'image/png',
        TRANSPARENT: 'true',
        SRS: 'EPSG:3857',
        WIDTH: '256',
        HEIGHT: '256',
        BBOX: tileTo3857Bbox(z, x, y).join(','),
    });
    const sep = SOIL_WMS_BASE.includes('?') ? '&' : '?';
    return `${SOIL_WMS_BASE}${sep}${qp.toString()}`;
}

/** WMS `GetLegendGraphic` for the same layer. */
export function buildSoilLegendUrl(): string {
    const qp = new URLSearchParams({
        SERVICE: 'WMS',
        VERSION: '1.1.1',
        REQUEST: 'GetLegendGraphic',
        LAYER: SOIL_WMS_LAYER,
        FORMAT: 'image/png',
    });
    const sep = SOIL_WMS_BASE.includes('?') ? '&' : '?';
    return `${SOIL_WMS_BASE}${sep}${qp.toString()}`;
}

/** Redis key for a proxied soil tile. Mirrors `cadastreTileCacheKey`. */
export function soilTileCacheKey(z: number, x: number, y: number): string {
    return `soil:wrb:${z}:${x}:${y}`;
}

/**
 * МЗХ orthophoto upstream — SERVER-ONLY (reads env). #2421.
 *
 * The Ministry publishes aerial imagery, flight-date coverage polygons and the
 * physical blocks (ФБ) as an INSPIRE GeoServer. The phone's «Ортофотокарта»
 * draws all three, and every byte reaches it through our proxy rather than
 * from the Ministry directly.
 *
 * Shaped after `cadastre-source.ts` / `cadastre-tiles.ts` and reusing their
 * tile geometry, because a second WMS proxy that drifts from the first is
 * worse than either.
 *
 * ## Unconfigured by default, and that is the licence control
 *
 * No upstream URL is hardcoded. `ORTHO_WMS_URL` turns the feature on, and
 * until it is set every route answers as though the feature does not exist —
 * the same "a hidden feature beats a hardcoded 404" rule the cadastre source
 * states.
 *
 * That is not only convention here. **МЗХ publishes no licence for this
 * data.** The WMS advertises `Fees: NONE` and `AccessConstraints: NONE`, which
 * are GeoServer defaults — the same service's contact is "Claudius Ptolomaeus,
 * Roman Empire" — and the INSPIRE record cites an Art. 13(1)(d)
 * intellectual-property limitation. The owner is asking МЗХ in writing, and
 * the agreed position is TestFlight only until they answer. An env var that
 * nobody sets in production is how that position is enforced by the system
 * rather than remembered by people.
 *
 * ## Measured against the live service, 2026-10-27
 *
 * Probed directly with synthetic coordinates (no farm geometry), because the
 * shape reached me relayed and three parts of it were wrong:
 *
 *   • imagery is served in **EPSG:3857 directly** as `image/jpeg`, ~0.1-0.3 s
 *     per 256² tile, 25 cm native — so z19 is the useful ceiling;
 *   • an area with no imagery for a year answers **HTTP 200 with a blank
 *     909-byte JPEG**, not a 404. Measured exactly: 909 bytes blank against
 *     10,368 bytes for a real tile at the same point in a covered year;
 *   • the coverage property is **`Date`**, an ISO timestamp, NOT `FlightDate`
 *     in `dd/mm/yyyy`;
 *   • `Dates_YYYY` and `Agricultural_Land_YYYY` return geometry in
 *     **EPSG:32635** (UTM 35N) unless `srsName` asks otherwise — which
 *     matters because the phone wants EPSG:4326 lon/lat GeoJSON;
 *   • the WFS `BBOX` in `urn:ogc:def:crs:EPSG::4326` is **lat,lon**, and it
 *     does filter — verified with a positive control, two far-apart boxes
 *     returning disjoint feature ids.
 *
 * One thing that looks like a bug and is not: the first ring vertex of a
 * returned `Dates_YYYY` polygon can lie well outside the query box, because
 * those are whole flight blocks. An intersecting polygon need not begin
 * inside the box. I read that as a broken filter before running the control.
 */

import { env } from '@/env';

/**
 * Years to search, NEWEST FIRST.
 *
 * Six, not the three the relayed shape proposed. At the probe point
 * (~43.08N 24.40E) the covering years are 2023 and 2020, and 2024/2025 are
 * blank — so a three-year window would have reported "no imagery" for an area
 * that is photographed. The layers exist back to 2020.
 */
export const ORTHO_YEARS = [2025, 2024, 2023, 2022, 2021, 2020] as const;
export type OrthoYear = (typeof ORTHO_YEARS)[number];

/** Below this, a national overview fans across the whole country. */
export const ORTHO_MIN_ZOOM = 10;

/** 25 cm native resolution — past z19 the source has nothing more to give. */
export const ORTHO_MAX_ZOOM = 19;

/** The blank tile's exact measured size, for the record. */
export const ORTHO_BLANK_TILE_BYTES = 909;

/**
 * At or below this, treat a 200 as "no imagery here".
 *
 * **The asymmetry decides the number.** A false NEGATIVE (a real tile read as
 * blank) is the damaging direction: the proxy answers 204, and the phone
 * caches a 204 as "no photo here, final" for the whole session — so a farm
 * would see bare ground over land that is photographed, until the app is
 * restarted. A false POSITIVE merely serves one blank tile.
 *
 * So this sits tight around the measured 909 rather than generously below the
 * measured real tile: 1,200 leaves room for encoder variation and is still
 * 8.6x below the 10,368-byte real sample. It is deliberately NOT something
 * like "under 5 KB", which would be the comfortable-looking choice and would
 * risk blanking a genuinely low-detail tile over water or snow.
 */
export const ORTHO_BLANK_TILE_CEILING = 1_200;

export interface OrthoSource {
    /** Operator-configured upstream base. NEVER sent to the client. */
    url: string;
}

/**
 * The active upstream, or `null` when the feature is unconfigured.
 *
 * Null is the shipped state and must stay cheap to handle: every route treats
 * it as "this feature does not exist here" rather than as a misconfiguration
 * to report.
 */
export function resolveOrthoSource(): OrthoSource | null {
    const url = env.ORTHO_WMS_URL;
    return url ? { url } : null;
}

/** True when the zoom is one this source can actually serve. */
export function isOrthoZoomAllowed(z: number): boolean {
    return Number.isInteger(z) && z >= ORTHO_MIN_ZOOM && z <= ORTHO_MAX_ZOOM;
}

/**
 * Is this response body the source's blank tile?
 *
 * Takes a LENGTH rather than the bytes: the decision is about size, and a
 * caller holding a stream should not have to buffer to ask.
 */
export function isBlankOrthoTile(byteLength: number): boolean {
    return byteLength <= ORTHO_BLANK_TILE_CEILING;
}

/** `GetMap` for one year over a Web Mercator bbox. */
export function buildOrthoTileUrl(
    base: string,
    year: number,
    bbox3857: readonly [number, number, number, number],
): string {
    const q = new URLSearchParams({
        service: 'WMS',
        version: '1.1.1',
        request: 'GetMap',
        layers: `RasterData:Orthoimagery_${year}`,
        styles: '',
        bbox: bbox3857.join(','),
        width: '256',
        height: '256',
        // 1.1.1 spells it `srs`; 1.3.0 would be `crs` AND would flip the bbox
        // axis order for EPSG:4326. Staying on 1.1.1 keeps one axis convention
        // for the imagery, which is the half that is in metres anyway.
        srs: 'EPSG:3857',
        format: 'image/jpeg',
    });
    return `${base}?${q.toString()}`;
}

export interface LonLatBbox {
    west: number;
    south: number;
    east: number;
    north: number;
}

/**
 * The WFS `BBOX` value: **lat,lon**, then the CRS urn.
 *
 * The axis order is the whole reason this is a function. `urn:ogc:def:crs:
 * EPSG::4326` means latitude first — the authority's own order — while the
 * GeoJSON that comes back is lon,lat. Writing the two by hand at each call
 * site is how one of them ends up transposed, and a transposed box over
 * Bulgaria lands in the Indian Ocean and returns nothing, which reads as "no
 * blocks here" rather than as an error.
 */
export function latLonBboxParam(bbox: LonLatBbox): string {
    return `${bbox.south},${bbox.west},${bbox.north},${bbox.east},urn:ogc:def:crs:EPSG::4326`;
}

/** Shared WFS query shape — JSON out, lon/lat geometry, bounded count. */
function wfsQuery(typeName: string, bbox: LonLatBbox, count: number): URLSearchParams {
    return new URLSearchParams({
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeNames: typeName,
        outputFormat: 'application/json',
        // Without this the response arrives in EPSG:32635 and the phone would
        // draw UTM metres as degrees — a silent, spectacular misplacement.
        srsName: 'urn:ogc:def:crs:EPSG::4326',
        count: String(count),
        bbox: latLonBboxParam(bbox),
    });
}

/** Flight-date coverage polygons for one year. */
export function buildOrthoCoverageUrl(
    base: string,
    year: number,
    bbox: LonLatBbox,
    count = 5,
): string {
    return `${base}?${wfsQuery(`VectorData:Dates_${year}`, bbox, count).toString()}`;
}

/** Physical blocks (ФБ) for one year. */
export function buildOrthoBlocksUrl(
    base: string,
    year: number,
    bbox: LonLatBbox,
    count: number,
): string {
    return `${base}?${wfsQuery(`VectorData:Agricultural_Land_${year}`, bbox, count).toString()}`;
}

/**
 * Tile cache key — `(year, z, x, y)` and deliberately NO TENANT.
 *
 * These tiles are national public data and byte-identical for every farm. The
 * tenant is in the request path to scope AUTHORISATION, not to partition
 * storage: keying by it would store the same JPEG once per tenant and
 * multiply the cache by the number of farms for no benefit at all.
 *
 * Worth stating because the habit in this codebase runs the other way —
 * `cachedListRead` keys on the tenant, correctly, because its payloads are
 * tenant data. These are not.
 */
export function orthoTileCacheKey(year: number, z: number, x: number, y: number): string {
    return `ortho:tile:v1:${year}:${z}:${x}:${y}`;
}

/**
 * The negative cache key for a tile with no imagery in ANY year.
 *
 * Separate from the positive key because it answers a different question and
 * has a different lifetime: imagery for a year never appears later, but a new
 * flight year does, so this expires sooner than a tile does.
 */
export function orthoTileAbsentKey(z: number, x: number, y: number): string {
    return `ortho:absent:v1:${z}:${x}:${y}`;
}

/** Coverage answers are per AREA, so the key is the rounded bbox. */
export function orthoCoverageCacheKey(bbox: LonLatBbox): string {
    const r = (n: number): string => n.toFixed(3);
    return `ortho:cover:v1:${r(bbox.west)}:${r(bbox.south)}:${r(bbox.east)}:${r(bbox.north)}`;
}

/**
 * The flight date as a CALENDAR DAY in Bulgaria, from the source's timestamp.
 *
 * `Date` arrives as e.g. `2023-10-13T21:00:00Z`, which is
 * `2023-10-14T00:00:00+03:00` — midnight in Sofia on the 14th. The stored
 * value is a local DATE serialised as UTC, so formatting it in UTC yields the
 * 13th and reports the flight as a day earlier than it happened.
 *
 * A farmer reading «заснемане 13.10.2023» against a Ministry record saying the
 * 14th has no way to tell which is wrong. Formatted in `Europe/Sofia`, with
 * `en-CA` because it is the locale that renders ISO `YYYY-MM-DD`.
 */
export function sofiaFlightDate(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Sofia',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(t));
}

/** What the phone prints under the map when it knows nothing more. */
export const ORTHO_ATTRIBUTION = 'Ортофото: МЗХ';

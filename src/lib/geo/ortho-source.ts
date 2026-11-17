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
 * intellectual-property limitation. The owner is asking МЗХ in writing.
 *
 * **What the owner's ruling actually says**, because I first wrote this
 * tighter than the decision and the iOS session was right to push back:
 * TestFlight now, App Store only once МЗХ agrees, with the flag limiting who
 * sees it meanwhile. So setting this variable — and enabling
 * `agro.orthophoto` for the owner's tenant and the testers' cohort — is
 * consistent with the ruling TODAY. What waits for МЗХ is the App Store
 * release, which is the client's gate, not this one.
 *
 * This variable is therefore the MECHANISM, not the deadline: it means the
 * surface cannot serve imagery by accident or by a config drift, and WHEN to
 * set it is the owner's call rather than a constraint this module invents.
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
 *   • `Dates_YYYY` and `Physical_Blocks_YYYY` return geometry in
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

/**
 * The earliest year that could carry a physical-block layer. The
 * `Physical_Blocks_YYYY` layers exist back to 2021 (`Agricultural_Land_YYYY` before the rename).
 */
export const ORTHO_BLOCKS_EARLIEST_YEAR = 2020;

/**
 * The physical-block (ФБ) layer, by year — `VectorData:Physical_Blocks_YYYY`.
 *
 * It was `Agricultural_Land_YYYY` until МЗХ renamed it. Measured live
 * 2026-11-17: every `Agricultural_Land_*` name answers 400 «Feature type …
 * unknown», and GetCapabilities lists `Physical_Blocks_2021`–`_2025` instead,
 * with the same properties (`PHBIDENT`, `USAGEBUL`, `USAGECODE`) and the same
 * EPSG:32635 geometry — 281 blocks over the owner's farm in 2025. The rename
 * reached the farmer as a map with no ФБ at all and a 200, because every year
 * looked like "no layer this year" (agrent-ios report, 2026-11-17).
 * `fetchOrthoBlocks` now logs when no probed year answers at all.
 */
export const ORTHO_BLOCK_LAYER_PREFIX = 'VectorData:Physical_Blocks_';

/**
 * Candidate years for the PHYSICAL BLOCK layer, NEWEST FIRST — a SECOND year
 * list, deliberately.
 *
 * `ORTHO_YEARS` above answers "which years have a PHOTO over this area".
 * This answers "which years could carry physical blocks we can label", and
 * `agrent-ios` measured on the public WFS (2026-11-08, bbox
 * 43.405,24.575,43.415,24.590) that the two differ:
 *
 *   2026  no `Agricultural_Land` layer at all (ExceptionReport)
 *   2025  PHBIDENT features — 56722-1346, 1555, 1608, 1925, 1928, 499, 500, 503
 *   2023  PHBIDENT features — a DIFFERENT numbering: 1346, 1608, 1921, 1922, 1925, 1928
 *   2022  features carry ELGIDENT («56722-1343-10»), eligible-area elements,
 *   2021  with NO PHBIDENT — so every one is dropped and the area shows NO blocks
 *   2020  no layer
 *
 * So two lists is not duplication. One is about imagery, the other about a
 * cadastral product that is published on its own schedule and renumbered
 * between years. Collapsing them would have to pick one question to answer
 * wrongly.
 *
 * DERIVED from the clock rather than hardcoded, so the newest layer is picked
 * up when the Ministry publishes it with no code change — the owner's ask
 * (2026-11-08, relayed). The cost of a year that does not exist yet is one
 * ExceptionReport on a cold lookup, cached like any other answer.
 */
export function orthoBlockYearCandidates(now: Date): number[] {
    const latest = now.getUTCFullYear();
    const out: number[] = [];
    for (let y = latest; y >= ORTHO_BLOCKS_EARLIEST_YEAR; y -= 1) out.push(y);
    return out;
}

/**
 * Which ФБ year was resolved for an AREA. Separate from
 * `orthoCoverageCacheKey` because it answers a different question about the
 * same bbox, and a shared key would make one overwrite the other.
 */
export function orthoBlocksYearCacheKey(bbox: LonLatBbox): string {
    const r = (n: number): string => n.toFixed(3);
    return `ortho:fbyear:v1:${r(bbox.west)}:${r(bbox.south)}:${r(bbox.east)}:${r(bbox.north)}`;
}
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
    return `${base}?${wfsQuery(`${ORTHO_BLOCK_LAYER_PREFIX}${year}`, bbox, count).toString()}`;
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
    /*
     * v1 -> v2 by #3091, and the bump is what makes the fix take effect.
     *
     * A remembered absence outlives its cause by `ABSENT_TTL_SECONDS` — a
     * whole day — so a resolver change alone would leave the first request
     * after a deploy still serving the blank that the old code cached. That
     * reads as "the fix did not work", which is the worst way for a fix to
     * arrive.
     *
     * Bumping the version discards every absence recorded under the old,
     * wrong rule in one move, without an invalidation script that would have
     * to know which areas were affected. Same lever as `SWR_CACHE_VERSION`:
     * the only thing that removes what is already written.
     */
    return `ortho:absent:v2:${z}:${x}:${y}`;
}

/** Coverage answers are per AREA, so the key is the rounded bbox. */
export function orthoCoverageCacheKey(bbox: LonLatBbox): string {
    const r = (n: number): string => n.toFixed(3);
    return `ortho:cover:v1:${r(bbox.west)}:${r(bbox.south)}:${r(bbox.east)}:${r(bbox.north)}`;
}

/**
 * The flight date as a CALENDAR DAY in Bulgaria, from whatever the source gave.
 *
 * ## Three formats, because the Ministry ships three
 *
 * Measured live 2026-11-16 across the six `VectorData:Dates_<year>` layers at
 * two probe points (~43.08N 24.40E, and ~43.55N 27.83E in Dobrudzha):
 *
 * | layer         | property     | value                  |
 * |---------------|--------------|------------------------|
 * | `Dates_2025`  | `FlightDate` | `25/06/2025`           |
 * | `Dates_2023`  | `Date`       | `2023-10-13T21:00:00Z` |
 * | `Dates_2022`  | `Date`       | `28/08/2022`           |
 * | `Dates_2020`  | `DATE`       | `200818`               |
 *
 * So an ISO instant, a `DD/MM/YYYY` calendar date and a bare `YYMMDD`.
 *
 * ## `Date.parse` is the hazard, not the solution (#3097)
 *
 * This function used to be `Date.parse` plus a Sofia format, and it is correct
 * for the ISO shape and silently wrong for the other two:
 *
 *     05/08/2022  ->  "2022-05-08"      5 August read as 8 May
 *     12/08/2022  ->  "2022-12-08"     12 August read as 8 December
 *     28/08/2022  ->  null             day > 12, so NaN
 *     200818      ->  "200818-01-01"   the year two hundred thousand
 *
 * A `DD/MM/YYYY` date whose day is 12 or less parses as US `MM/DD`, so roughly
 * twelve days in every thirty-one were shown as the WRONG date and the rest as
 * none at all. An absent date says "I do not know"; a wrong one is a false
 * fact about the land in the one field the attribution line exists to carry —
 * a farmer comparing a photograph against what they remember planting was
 * being told May for a flight in August.
 *
 * Each format is therefore RECOGNISED EXPLICITLY and `Date.parse` is reached
 * for the ISO shape only. Same rule as `parseZarnoBorsaPrice`, where a
 * European decimal comma had to be validated rather than stripped: a blind
 * transform of an ambiguous format is a silent error with nothing failing.
 *
 * ## Why the ISO branch converts and the other two do not
 *
 * `2023-10-13T21:00:00Z` is `2023-10-14T00:00:00+03:00` — midnight in Sofia on
 * the 14th. That value is a local DATE serialised as UTC, so formatting it in
 * UTC reports the flight a day early, and `en-CA` is the locale that renders
 * ISO `YYYY-MM-DD`. `25/06/2025` and `200818` carry no time and no zone: they
 * are already calendar days, so converting them would be inventing an instant
 * and then re-deriving the day from it.
 *
 * Anything else returns null, which is a correct answer — `ORTHO_ATTRIBUTION`
 * alone is what the phone prints when we know nothing more.
 */
export function sofiaFlightDate(raw: string | number | null | undefined): string | null {
    const value = typeof raw === 'number' && Number.isInteger(raw) ? String(raw) : raw;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    // An ISO 8601 date or instant — the only shape Date.parse is trusted with,
    // and the only one whose day depends on a timezone.
    if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
        const t = Date.parse(trimmed);
        if (Number.isNaN(t)) return null;
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Sofia',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(new Date(t));
    }

    const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
    if (dmy) return calendarDay(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));

    // `200818` is 2020-08-18. The layers begin at 2020 and a two-digit year is
    // read into this century; a `YYMMDD` that is not a real day is refused by
    // the round-trip below rather than wrapped into the next month.
    const ymd = /^(\d{2})(\d{2})(\d{2})$/.exec(trimmed);
    if (ymd) return calendarDay(2000 + Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));

    return null;
}

/**
 * `YYYY-MM-DD` for a real calendar day, or null.
 *
 * The round trip is the validation: `Date.UTC` happily accepts month 13 and
 * day 31 of February and rolls them forward, so comparing the components back
 * is what separates a date from three numbers. Pattern-matching alone is not
 * validation — `31/02/2022` matches `DD/MM/YYYY` perfectly.
 */
function calendarDay(year: number, month: number, day: number): string | null {
    const t = new Date(Date.UTC(year, month - 1, day));
    if (
        t.getUTCFullYear() !== year ||
        t.getUTCMonth() !== month - 1 ||
        t.getUTCDate() !== day
    ) {
        return null;
    }
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
}

/**
 * The flight date out of one WFS feature's properties, whichever key holds it.
 *
 * **Derived from the FEATURE, never from a year→key table.** The schema varies
 * by layer today (`Date`, `DATE`, `FlightDate` — see `sofiaFlightDate`) and a
 * per-year map goes stale silently the next time a layer lands: the date is
 * simply absent, the attribution falls back, and nothing fails.
 *
 * The selection is by KEY NAME rather than by scanning every value, because
 * `Dates_2020` also carries `EXT_ID` as a small integer and a six-digit id
 * would be indistinguishable from `YYMMDD`. Matching `/date/i` catches the
 * three known spellings and any `Flight_Date` to come, while `Area` and
 * `EXT_ID` cannot qualify however they are typed.
 *
 * An unreadable value does not end the search: a feature carrying both an
 * unparseable `DATE` and a readable `FlightDate` still gets a date.
 */
export function orthoFeatureFlightDate(
    properties: Record<string, unknown> | null | undefined,
): string | null {
    if (!properties) return null;
    for (const [key, raw] of Object.entries(properties)) {
        if (!/date/i.test(key)) continue;
        if (typeof raw !== 'string' && !(typeof raw === 'number' && Number.isInteger(raw))) {
            continue;
        }
        const parsed = sofiaFlightDate(raw);
        if (parsed) return parsed;
    }
    return null;
}

/** What the phone prints under the map when it knows nothing more. */
export const ORTHO_ATTRIBUTION = 'Ортофото: МЗХ';

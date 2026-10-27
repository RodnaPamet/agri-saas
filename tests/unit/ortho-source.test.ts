/**
 * МЗХ ortho source helpers — #2421.
 *
 * Pure. Every number and field name here was measured against the live
 * service on 2026-10-27 with synthetic coordinates, because the shape reached
 * me relayed and several parts of it were wrong. These cases pin the measured
 * facts, so a later "simplification" toward the plausible-sounding version
 * fails rather than silently misplacing a farm's imagery.
 */
import {
    ORTHO_BLANK_TILE_BYTES,
    ORTHO_BLANK_TILE_CEILING,
    ORTHO_MAX_ZOOM,
    ORTHO_YEARS,
    buildOrthoBlocksUrl,
    buildOrthoCoverageUrl,
    buildOrthoTileUrl,
    isBlankOrthoTile,
    isOrthoZoomAllowed,
    latLonBboxParam,
    orthoCoverageCacheKey,
    orthoTileAbsentKey,
    orthoTileCacheKey,
    sofiaFlightDate,
} from '@/lib/geo/ortho-source';

const BASE = 'http://example.test/geoserver/ows';
const BBOX = { west: 24.39, south: 43.07, east: 24.41, north: 43.09 };

describe('the year window (#2421)', () => {
    it('searches SIX years, newest first, not three', () => {
        // The relayed shape said "the newest of the last three years". At the
        // probe point the covering years are 2023 and 2020 — so a three-year
        // window would report no imagery for an area that is photographed.
        expect([...ORTHO_YEARS]).toEqual([2025, 2024, 2023, 2022, 2021, 2020]);
        expect(ORTHO_YEARS[0]).toBeGreaterThan(ORTHO_YEARS[ORTHO_YEARS.length - 1]);
    });

    it('stops at z19, because the source is 25 cm native', () => {
        expect(ORTHO_MAX_ZOOM).toBe(19);
        expect(isOrthoZoomAllowed(19)).toBe(true);
        expect(isOrthoZoomAllowed(20)).toBe(false);
        // A floor too: a national overview would fan every tile across the
        // whole country.
        expect(isOrthoZoomAllowed(9)).toBe(false);
        expect(isOrthoZoomAllowed(10)).toBe(true);
        // Not an integer is not a zoom.
        expect(isOrthoZoomAllowed(12.5)).toBe(false);
    });
});

describe('the blank-tile sentinel (#2421)', () => {
    it('is 909 bytes, measured, and the ceiling sits tight above it', () => {
        // An area with no imagery for a year answers HTTP 200 with a blank
        // JPEG, not a 404. Measured: 909 bytes blank against 10,368 for a real
        // tile at the same point in a covered year.
        expect(ORTHO_BLANK_TILE_BYTES).toBe(909);
        expect(ORTHO_BLANK_TILE_CEILING).toBeGreaterThan(ORTHO_BLANK_TILE_BYTES);
        // Tight, NOT generous. A false "blank" makes the proxy answer 204,
        // which the phone caches as final for the session — bare ground over
        // land that is photographed. A comfortable "under 5 KB" would risk
        // that for a low-detail tile over water or snow.
        expect(ORTHO_BLANK_TILE_CEILING).toBeLessThan(2_000);
    });

    it('calls the measured blank blank and the measured real tile real', () => {
        expect(isBlankOrthoTile(909)).toBe(true);
        expect(isBlankOrthoTile(10_368)).toBe(false);
        // The boundary itself, both sides.
        expect(isBlankOrthoTile(ORTHO_BLANK_TILE_CEILING)).toBe(true);
        expect(isBlankOrthoTile(ORTHO_BLANK_TILE_CEILING + 1)).toBe(false);
        // An empty body is not imagery either.
        expect(isBlankOrthoTile(0)).toBe(true);
    });
});

describe('the WMS tile URL (#2421)', () => {
    it('asks for EPSG:3857 directly, as jpeg, at 256²', () => {
        const u = new URL(buildOrthoTileUrl(BASE, 2023, [1, 2, 3, 4]));
        expect(u.searchParams.get('request')).toBe('GetMap');
        expect(u.searchParams.get('layers')).toBe('RasterData:Orthoimagery_2023');
        expect(u.searchParams.get('bbox')).toBe('1,2,3,4');
        expect(u.searchParams.get('format')).toBe('image/jpeg');
        expect(u.searchParams.get('width')).toBe('256');
        expect(u.searchParams.get('height')).toBe('256');
    });

    it('stays on WMS 1.1.1 and spells the projection `srs`', () => {
        // 1.3.0 spells it `crs` AND flips the bbox axis order for geographic
        // CRSs. Staying on 1.1.1 keeps one axis convention for the imagery.
        const u = new URL(buildOrthoTileUrl(BASE, 2023, [1, 2, 3, 4]));
        expect(u.searchParams.get('version')).toBe('1.1.1');
        expect(u.searchParams.get('srs')).toBe('EPSG:3857');
        expect(u.searchParams.get('crs')).toBeNull();
    });

    it('never stacks years into one request', () => {
        // Measured: `layers=2023,2024,2025` returns blank. The year has to be
        // chosen per area, which is what `resolveOrthoCoverage` is for.
        const u = new URL(buildOrthoTileUrl(BASE, 2024, [1, 2, 3, 4]));
        expect(u.searchParams.get('layers')).not.toContain(',');
    });
});

describe('the WFS axis order (#2421)', () => {
    it('writes BBOX as lat,lon with the urn CRS', () => {
        // `urn:ogc:def:crs:EPSG::4326` means LATITUDE first — the authority's
        // own order — while the GeoJSON that comes back is lon,lat. A
        // transposed box over Bulgaria lands in the Indian Ocean and returns
        // nothing, which reads as "no blocks here" rather than as an error.
        expect(latLonBboxParam(BBOX)).toBe('43.07,24.39,43.09,24.41,urn:ogc:def:crs:EPSG::4326');
    });

    it('forces the RESPONSE into 4326, because the default is UTM 35N', () => {
        // Measured: without `srsName` both vector layers answer in EPSG:32635.
        // The phone would draw UTM metres as degrees.
        for (const url of [
            buildOrthoCoverageUrl(BASE, 2023, BBOX),
            buildOrthoBlocksUrl(BASE, 2023, BBOX, 10),
        ]) {
            const u = new URL(url);
            expect(u.searchParams.get('srsName')).toBe('urn:ogc:def:crs:EPSG::4326');
            expect(u.searchParams.get('outputFormat')).toBe('application/json');
            expect(u.searchParams.get('bbox')).toContain('urn:ogc:def:crs:EPSG::4326');
        }
    });

    it('names the measured layers and bounds the count', () => {
        expect(new URL(buildOrthoCoverageUrl(BASE, 2021, BBOX)).searchParams.get('typeNames')).toBe(
            'VectorData:Dates_2021',
        );
        const blocks = new URL(buildOrthoBlocksUrl(BASE, 2021, BBOX, 42));
        expect(blocks.searchParams.get('typeNames')).toBe('VectorData:Agricultural_Land_2021');
        expect(blocks.searchParams.get('count')).toBe('42');
    });
});

describe('cache keys (#2421)', () => {
    it('key a tile by year and address, and by NOTHING else', () => {
        // No tenant. These tiles are national public data, byte-identical for
        // every farm; the tenant is in the request path to scope AUTH. Keying
        // by it would store the same JPEG once per tenant.
        const k = orthoTileCacheKey(2023, 15, 1, 2);
        expect(k).toBe('ortho:tile:v1:2023:15:1:2');
        expect(k).not.toMatch(/tenant|acme|t1/i);
    });

    it('separate the negative from the positive', () => {
        // Different questions with different lifetimes: imagery for a past
        // year never appears later, but a new flight year does.
        expect(orthoTileAbsentKey(15, 1, 2)).not.toBe(orthoTileCacheKey(2023, 15, 1, 2));
        // And the negative carries no year — it means "no year has this".
        expect(orthoTileAbsentKey(15, 1, 2)).not.toMatch(/2023/);
    });

    it('round coverage keys, so neighbouring viewports share one answer', () => {
        const a = orthoCoverageCacheKey({ west: 24.3901, south: 43.07, east: 24.41, north: 43.09 });
        const b = orthoCoverageCacheKey({ west: 24.3902, south: 43.07, east: 24.41, north: 43.09 });
        expect(a).toBe(b);
        // But a genuinely different area is a different key.
        expect(a).not.toBe(orthoCoverageCacheKey({ ...BBOX, west: 25.0 }));
    });
});

describe('the flight date (#2421)', () => {
    it('reads the calendar day in BULGARIA, not UTC', () => {
        // Measured: `Date` arrives as `2023-10-13T21:00:00Z`, which is
        // `2023-10-14T00:00:00+03:00` — midnight in Sofia on the 14th. The
        // stored value is a local date serialised as UTC, so formatting in UTC
        // reports the flight a day early, and a farmer comparing «заснемане»
        // against a Ministry record has no way to tell which is wrong.
        expect(sofiaFlightDate('2023-10-13T21:00:00Z')).toBe('2023-10-14');
    });

    it('and the UTC reading would differ — the discriminator', () => {
        // Without this the case above passes for any formatter that happens to
        // agree on the day, which most timestamps do.
        expect(new Date('2023-10-13T21:00:00Z').toISOString().slice(0, 10)).toBe('2023-10-13');
    });

    it('handles winter time too, where the offset is +02:00', () => {
        // 22:00Z in January is midnight Sofia on the next day; the same date
        // in July would be 21:00Z. A fixed +03:00 would get one of them wrong.
        expect(sofiaFlightDate('2024-01-15T22:00:00Z')).toBe('2024-01-16');
        expect(sofiaFlightDate('2024-07-15T22:00:00Z')).toBe('2024-07-16');
        expect(sofiaFlightDate('2024-01-15T21:00:00Z')).toBe('2024-01-15');
    });

    it('returns null rather than inventing a date', () => {
        expect(sofiaFlightDate(null)).toBeNull();
        expect(sofiaFlightDate(undefined)).toBeNull();
        expect(sofiaFlightDate('')).toBeNull();
        expect(sofiaFlightDate('not a date')).toBeNull();
    });
});

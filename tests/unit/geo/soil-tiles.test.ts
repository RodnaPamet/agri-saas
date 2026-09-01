/**
 * The ISRIC WRB WMS URL builder (#782).
 *
 * WHY A GOLDEN ASSERTION AND NOT `toContain('maps.isric.org')`.
 *
 * Before #782 the URL was a hand-written literal in `MapCanvas.tsx` that was
 * known to work against this MapServer. Rebuilding it with `URLSearchParams`
 * changes the request BYTES, and the most dangerous change is silent:
 * `map=/map/wrb.map` selects the mapfile, so a MapServer that rejects
 * `map=%2Fmap%2Fwrb.map` returns an error, the proxy soft-fails to 204, and
 * the operator gets a blank overlay with every test still green.
 *
 * So the assertions below pin the two things that can break invisibly:
 *   1. the `map=` parameter is byte-identical and UNENCODED;
 *   2. every other parameter decodes to the value the shipped literal used.
 *
 * (2) is a decoded comparison on purpose: percent-encoding `image/png` and
 * `EPSG:3857` is legal and MapServer decodes it, so pinning those bytes would
 * be pinning an accident. Pinning `map=` is pinning the contract.
 */
import { buildSoilWmsUrl, buildSoilLegendUrl, isSoilZoomAllowed, SOIL_TILE_MAX_ZOOM } from '@/lib/geo/soil-tiles';
import { tileTo3857Bbox } from '@/lib/geo/cadastre-tiles';

/** The literal that shipped in MapCanvas.tsx before #782, params only. */
const SHIPPED_PARAMS: Record<string, string> = {
    SERVICE: 'WMS',
    VERSION: '1.1.1',
    REQUEST: 'GetMap',
    LAYERS: 'MostProbable',
    STYLES: '',
    FORMAT: 'image/png',
    TRANSPARENT: 'true',
    SRS: 'EPSG:3857',
    WIDTH: '256',
    HEIGHT: '256',
};

describe('buildSoilWmsUrl', () => {
    it('keeps `map=/map/wrb.map` unencoded — the parameter that selects the mapfile', () => {
        const url = buildSoilWmsUrl(10, 585, 385);
        expect(url.startsWith('https://maps.isric.org/mapserv?map=/map/wrb.map&')).toBe(true);
        expect(url).not.toContain('map=%2Fmap%2Fwrb.map');
    });

    it('sends every parameter the shipped literal sent, with the same values', () => {
        const url = buildSoilWmsUrl(10, 585, 385);
        const qs = new URLSearchParams(url.slice(url.indexOf('?') + 1));
        for (const [k, v] of Object.entries(SHIPPED_PARAMS)) {
            expect(`${k}=${qs.get(k)}`).toBe(`${k}=${v}`);
        }
    });

    it('substitutes a real bbox rather than MapLibre’s placeholder', () => {
        // The old literal ended `BBOX={bbox-epsg-3857}` and relied on MapLibre
        // to substitute per tile. The proxy resolves it server-side, so the
        // placeholder must be GONE — leaving it would send the literal string.
        const url = buildSoilWmsUrl(10, 585, 385);
        expect(url).not.toContain('bbox-epsg-3857');
        const qs = new URLSearchParams(url.slice(url.indexOf('?') + 1));
        expect(qs.get('BBOX')).toBe(tileTo3857Bbox(10, 585, 385).join(','));
    });

    it('orders BBOX easting,northing (WMS 1.1.1 SRS axis order)', () => {
        const qs = new URLSearchParams(buildSoilWmsUrl(10, 585, 385).split('?')[1]);
        const [minX, minY, maxX, maxY] = qs.get('BBOX')!.split(',').map(Number);
        expect(minX).toBeLessThan(maxX);
        expect(minY).toBeLessThan(maxY);
    });
});

describe('buildSoilLegendUrl', () => {
    it('is a GetLegendGraphic on the same layer, with `map=` unencoded', () => {
        const url = buildSoilLegendUrl();
        expect(url.startsWith('https://maps.isric.org/mapserv?map=/map/wrb.map&')).toBe(true);
        const qs = new URLSearchParams(url.slice(url.indexOf('?') + 1));
        expect(qs.get('REQUEST')).toBe('GetLegendGraphic');
        expect(qs.get('LAYER')).toBe('MostProbable');
        expect(qs.get('FORMAT')).toBe('image/png');
    });
});

describe('isSoilZoomAllowed', () => {
    it('serves the whole window the source declares, and nothing above it', () => {
        // The ceiling and the <Source maxzoom> read the SAME constant. If they
        // ever diverge the overlay goes blank at working zoom rather than
        // erroring, which is why this asserts the boundary and not a number.
        expect(isSoilZoomAllowed(0)).toBe(true);
        expect(isSoilZoomAllowed(SOIL_TILE_MAX_ZOOM)).toBe(true);
        expect(isSoilZoomAllowed(SOIL_TILE_MAX_ZOOM + 1)).toBe(false);
        expect(isSoilZoomAllowed(-1)).toBe(false);
        expect(isSoilZoomAllowed(1.5)).toBe(false);
    });

    it('covers the zoom a fitted parcel view actually requests', () => {
        // MapCanvas fits parcels with maxZoom 16 and the source is tileSize
        // 256, so MapLibre asks for map zoom + 1 = 17 — above the ceiling.
        // `maxzoom` on the <Source> caps the request at 16 instead. If someone
        // lowers SOIL_TILE_MAX_ZOOM below the fit zoom, the overlay silently
        // disappears at the zoom operators work at.
        expect(SOIL_TILE_MAX_ZOOM).toBeGreaterThanOrEqual(16);
    });
});

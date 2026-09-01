/**
 * Unit tests — the E2E basemap fixture tile.
 *
 * The tile's entire justification is that the layer it carries is the layer
 * the offline style paints. Without this test a rename on either side leaves
 * the offline map a blank void with every test still green — which is the
 * exact failure `offline-basemap.spec.ts` exists to catch, arriving through
 * the one door that spec cannot see.
 *
 * The coupling is asserted WITHOUT a protobuf decoder: a protobuf string
 * field stores the layer name as raw ASCII, so a byte-substring check is a
 * valid decode-free assertion. That keeps `@mapbox/vector-tile` and `pbf` out
 * of the dependency list (both are phantom deps today, present only under
 * maplibre-gl).
 */
import { basemapFixtureTile, BASEMAP_FIXTURE_TILE_BASE64 } from '@/lib/offline/basemap-fixture-tile';
import { buildOfflineBasemapStyle } from '@/lib/geo/offline-basemap-style';

describe('basemap fixture tile', () => {
    it('decodes to a non-empty, small tile', () => {
        const tile = basemapFixtureTile();
        expect(tile.byteLength).toBe(38);
        // A 0-byte 200 would satisfy every assertion in the E2E suite while
        // making the offline map the blank void the spec exists to disprove.
        expect(tile.byteLength).toBeGreaterThan(0);
    });

    it('carries the source-layer that the offline land fill paints', () => {
        const style = buildOfflineBasemapStyle('/x/{z}/{x}/{y}');
        const land = style.layers.find((l) => l.id === 'offline-land') as
            | { 'source-layer': string }
            | undefined;
        expect(land).toBeDefined();

        // DERIVED from the style rather than hardcoded, so renaming the
        // source-layer on either side fails here instead of silently
        // producing an empty map.
        const layerName = Buffer.from(land!['source-layer'], 'ascii');
        expect(basemapFixtureTile().includes(layerName)).toBe(true);
    });

    it('is a stable constant, not a rebuilt artefact', () => {
        // Two calls must not diverge — the route hands these bytes straight to
        // a Response with a Content-Length computed from them.
        expect(basemapFixtureTile()).toEqual(basemapFixtureTile());
        expect(Buffer.from(BASEMAP_FIXTURE_TILE_BASE64, 'base64')).toEqual(basemapFixtureTile());
    });
});

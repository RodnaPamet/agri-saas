/**
 * A 38-byte Mapbox Vector Tile served by the E2E fixture mode of the
 * per-location basemap proxy (`E2E_BASEMAP_FIXTURE_TILES=1`).
 *
 * Hand-encoded: ONE layer, `countries`, holding ONE polygon filling the tile
 * extent (0,0)-(4096,4096). `countries` is the source-layer that
 * `buildOfflineBasemapStyle`'s `offline-land` fill paints, so the offline
 * basemap spec gets a real LAND-COLOURED backdrop out of a real vector tile —
 * the same rendering path production uses — with no network.
 *
 * WHY NOT A 0-BYTE 200. It would satisfy every assertion in the suite (the
 * service worker caches a 200, the offline probe resolves) while making the
 * offline map exactly the blank void that `offline-basemap.spec.ts` exists to
 * disprove. A fixture that makes the test pass by removing what it tests is
 * the failure mode CLAUDE.md names as "green over less code".
 *
 * VERIFIED by execution (maplibre-gl 6.6.0, headless chromium): rendering
 * `buildOfflineBasemapStyle` against these bytes at z6 reaches `idle` with
 * zero error events, and `queryRenderedFeatures` at the map centre returns
 * `['offline-land']` — the land fill genuinely paints.
 * Decoded (@mapbox/vector-tile): layers `['countries']`, extent 4096,
 * version 2, 1 feature, type 3 (polygon), ring
 * `[[0,0],[4096,0],[4096,4096],[0,4096],[0,0]]`.
 *
 * A base64 CONSTANT rather than a checked-in binary: no asset to COPY into the
 * runtime image, no secret-scanner or LFS question, and no path from `src/`
 * into `tests/` (which has no precedent in this repo).
 *
 * The SAME bytes serve every in-bounds (z,x,y). At z>0 the geometry is not
 * coordinate-correct for the requested tile, and that is deliberate: nothing
 * asserts on basemap pixels, and returning real bytes at every zoom keeps the
 * service worker caching the same NUMBER of tiles it caches today, so the
 * offline spec's cache semantics are unchanged rather than quietly narrowed.
 *
 * SERVER-ONLY by convention — imported only by the basemap proxy route.
 */
export const BASEMAP_FIXTURE_TILE_BASE64 =
    'GiR4AgoJY291bnRyaWVzEhIYAyIOCQAAGoBAAACAQP8/AA8ogCA=';

export function basemapFixtureTile(): Buffer {
    return Buffer.from(BASEMAP_FIXTURE_TILE_BASE64, 'base64');
}

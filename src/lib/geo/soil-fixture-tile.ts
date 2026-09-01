/**
 * Fixture bytes served by the E2E mode of the soil WMS proxy
 * (`E2E_SOIL_FIXTURE_TILES=1`), so a spec that turns Soil view on reaches no
 * third-party origin. Mirrors `src/lib/offline/basemap-fixture-tile.ts`.
 *
 * Both are REAL PNGs with real dimensions (8×8 tile, 16×16 legend), not 0-byte
 * 200s and not 1×1 pixels. That distinction is the whole point of the file:
 *
 *   - a 0-byte 200 satisfies "the request succeeded" while rendering nothing,
 *     which is the failure mode `basemap-fixture-tile.ts` documents;
 *   - the legend is an `<img className="w-full">` with NO intrinsic height, so
 *     Playwright's `toBeVisible()` is only meaningful if the image decodes to
 *     a non-zero box. A 1×1 would make that assertion pass on a sliver.
 *
 * Translucent soil-brown rather than transparent, so a human looking at a
 * failure screenshot can see the overlay painted rather than guessing.
 *
 * Base64 CONSTANTS rather than checked-in binaries, for the reasons given in
 * `basemap-fixture-tile.ts`: no asset to COPY into the runtime image, no
 * secret-scanner question, and no path from `src/` into `tests/`.
 *
 * SERVER-ONLY by convention — imported only by the soil proxy routes.
 */
const SOIL_FIXTURE_TILE_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mOoiLPpwYcZRoYCAF7jZ4GqvqU4AAAAAElFTkSuQmCC';

const SOIL_FIXTURE_LEGEND_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mOoiLP5TwlmGDVg1IBRA4aLAQARfhEfPz238QAAAABJRU5ErkJggg==';

export function soilFixtureTile(): Buffer {
    return Buffer.from(SOIL_FIXTURE_TILE_BASE64, 'base64');
}

export function soilFixtureLegend(): Buffer {
    return Buffer.from(SOIL_FIXTURE_LEGEND_BASE64, 'base64');
}

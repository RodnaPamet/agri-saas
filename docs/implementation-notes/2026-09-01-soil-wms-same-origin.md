# 2026-09-01 — the second third-party map origin (#782)

**Commit:** `<pending>` fix(map): proxy the ISRIC soil WMS same-origin

## Design

#764 removed `demotiles.maplibre.org` from the E2E path. **A second hard-coded
third-party origin sat in the same component** and every survey of #764 missed
it — including the one that produced #764's own fix list:

```ts
// MapCanvas.tsx, before this change
const SOIL_WRB_WMS_TILE = 'https://maps.isric.org/mapserv?map=/map/wrb.map&…';
const SOIL_WRB_LEGEND   = 'https://maps.isric.org/mapserv?map=/map/wrb.map&…';
```

The comment above them justified the direct fetch by ISRIC being *"CORS-open,
so MapLibre fetches tiles directly — no proxy"*. CORS-openness is precisely the
property that made it a third-party dependency **of the rendering path**: an
operator opening Soil view fetched from ISRIC live, with no proxy, no timeout,
no cache and no fallback.

Now: two same-origin routes, one for tiles and one for the legend, mirroring
the cadastre proxy that already existed a directory away.

## Files

| file | role |
|---|---|
| `src/lib/geo/soil-tiles.ts` | URL construction, zoom window, cache key |
| `src/lib/geo/soil-fixture-tile.ts` | real PNG fixture bytes for E2E |
| `src/app/api/t/[tenantSlug]/soil/wms/[z]/[x]/[y]/route.ts` | tile proxy |
| `src/app/api/t/[tenantSlug]/soil/legend/route.ts` | legend proxy |
| `src/components/ui/map/MapCanvas.tsx` | takes `soilOverlay`; no hard-coded origin |
| `tests/e2e/map-basemap-hermetic.spec.ts` | allowlist entry dropped; spec now turns Soil view ON |

## Decisions

- **No geographic envelope, deliberately.** The obvious move was to reuse the
  cadastre proxy's `isTileInBulgaria`. That would have been a silent product
  regression: the cadastre envelope exists because its upstream is a paid,
  IP-METERED №8002 licence, so an out-of-country tile is money spent on
  nothing. ISRIC's WRB WMS is free, global and CC-BY 4.0, and the shipped
  feature works anywhere today. The zoom ceiling and the 7-day Redis cache are
  what bound the traffic profile here.

- **`maxzoom` on the `<Source>` is load-bearing, not decoration.** MapLibre
  resolves a raster source's tile zoom as `round(map.zoom + log2(512 /
  tileSize))`; with `tileSize={256}` that is **map zoom + 1**. `MapCanvas` fits
  parcels at `maxZoom: 16`, so a fitted single-parcel view would request z17
  tiles. A route ceiling *alone* would 204 exactly the zoom operators work at —
  the overlay would go blank in normal use and the failure would look like an
  upstream problem. Declaring `maxzoom` makes MapLibre overzoom the z16 tile
  instead. Route and source read the same constant.

- **`map=/map/wrb.map` stays unencoded, and a test pins it.** Building the
  whole query with `URLSearchParams` emits `map=%2Fmap%2Fwrb.map`, changing the
  request bytes from the form known to work against this MapServer. That
  failure mode is invisible: MapServer rejects, the proxy soft-fails to 204,
  the operator gets a blank overlay, and every test stays green. So `map=` sits
  in the base URL and the rest is appended with the `?`/`&` separator, exactly
  as `buildCadastreWmsUrl` does — and `soil-tiles.test.ts` asserts both that
  the literal is byte-identical and that every other parameter still decodes to
  the value the shipped literal used. The other parameters ARE percent-encoded
  now; that is legal, MapServer decodes it, and pinning those bytes would be
  pinning an accident rather than a contract.

- **The legend moves too, or neither does.** It was an `<img>` pointing at
  `maps.isric.org` in the rendered DOM. Proxying only the tiles would have left
  the origin on the page and the allowlist entry still earning its keep.

- **No fallback to the upstream when `soilOverlay` is absent.** The raster and
  legend simply do not render. A default would restore the third-party origin
  on exactly the code paths that forgot to pass the prop — which is how the
  original hard-coding survived a dedicated hunt for it.

- **An upstream timeout, which the cadastre proxy still lacks.** A soil raster
  is decoration; it is never worth holding a Next worker on a hanging upstream.
  (The same gap in the cadastre route is untouched here — different licence,
  different route, and widening scope mid-fix is how the zoom bug nearly
  shipped.)

- **Dropping the allowlist entry proves nothing on its own, so the spec now
  turns Soil view on.** The entry's own comment said the origin was *"unreached
  unless Soil view is on"* and no spec turned it on — so removing it from a
  suite that never exercises the feature would have been a green check over an
  untested path. `map-basemap-hermetic.spec.ts` clicks the Soil toggle, waits
  for the legend image to actually load, and re-asserts the external-request
  list is empty.

- **`X-Soil-Source` on every response.** Every failure degrades to a 204 so the
  map skips the tile, which means a blank overlay has four possible causes that
  look identical from outside. The header separates them
  (`fixture` / `cache` / `upstream` / `upstream-unreachable` / `upstream-error`
  / `upstream-empty` / `out-of-zoom`). This is the #781 lesson applied at the
  point of failure rather than after it: an observation that cannot distinguish
  two states is not evidence.

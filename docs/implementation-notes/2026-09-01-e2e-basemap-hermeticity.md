# 2026-09-01 — E2E basemap hermeticity (#764)

**Commit:** `07795f1f4` fix(e2e): make the map surface hermetic instead of depending on a CDN

## Design

Every Playwright run that mounted a map fetched `demotiles.maplibre.org`. The
fix removes that from both halves of the request path, which turn out to need
different mechanisms:

```
                 ┌─────────────────────── browser ────────────────────────┐
  MapCanvas ──▶ resolveBasemapStyle()          Playwright CAN see this,
                  │                            but the seam is cheaper in
                  ├─ fixture flag ⇒ inline style object   (0 requests)
                  ├─ MapTiler key ⇒ api.maptiler.com/…
                  └─ neither      ⇒ demotiles.maplibre.org/style.json
                 └────────────────────────────────────────────────────────┘

                 ┌──────────────────── Next server ───────────────────────┐
  /api/t/…/basemap/{z}/{x}/{y} ──▶ fetch(demotiles…/{z}/{x}/{y}.pbf)
                                   Playwright CANNOT see this — it is a
                                   Node fetch, not a browser one.
                 └────────────────────────────────────────────────────────┘
```

So: **two flags, one per process.**

- `NEXT_PUBLIC_MAP_BASEMAP_FIXTURE=1` — client. `resolveBasemapStyle` returns
  an inline, sources-free `StyleSpecification` **object**. Not a URL: `mapStyle`
  already accepts an object (the offline branch passes one), so an inline style
  needs no new shape and makes **zero** requests, which is strictly stronger
  than "same-origin requests" — there is no `public/` asset, no route, and
  nothing to keep in sync. `NEXT_PUBLIC_*` is inlined at **build** time, so it
  lives on the build step in `ci.yml` and `scripts/e2e-local.mjs`.
- `E2E_BASEMAP_FIXTURE_TILES=1` — server. The per-location tile proxy returns a
  checked-in 38-byte MVT and never calls `fetch`. A plain runtime var, so ONE
  site (`playwright.config.ts`'s `webServer.command`) covers CI, `e2e-local`
  and a bare `npx playwright test`.

### The enforcement, and why the obvious one does not work

Both runner-up designs in the panel proposed blackholing the CDN — via
`--host-resolver-rules` or `/etc/hosts` — as the permanent ratchet, on the
theory that a client-half regression then turns the map specs red. **Measured:
it does not.**

- `canvas.maplibregl-canvas` is created synchronously in the MapLibre `Map`
  constructor, before any style request — so it is visible whether or not the
  style ever loads, and it is asserted in exactly one spec.
- The controls the map specs interact with are React siblings of `<Map>`, not
  children of a rendered basemap.
- `ag-map-visual.spec.ts` only `test.info().attach()`es its screenshot.
- Nothing in the suite asserts on console output — `e2e-utils.ts` logs browser
  errors and explicitly suppresses `Failed to load resource`.

The empirical check agrees: in the run cited by #764 the demotiles style fetch
failed **twice** and both affected tests passed.

Adding the blackhole as *the* ratchet would therefore have made things worse
than the status quo — today a client-half break still renders a real basemap
when the CDN is up; with a blackhole and a broken flag, every map spec renders
no basemap at all, deterministically and silently green. That is "green over
less code" exactly as CLAUDE.md describes it.

So enforcement is two **executing** assertions:

1. `tests/e2e/map-basemap-hermetic.spec.ts` — a live `page.on('request')`
   observer collecting every non-localhost host against a written allowlist,
   paired with an absence-of-`AJAXError` assertion so a style MapLibre
   *rejected* cannot pass trivially.
2. `X-Basemap-Source: fixture`, asserted in `offline-basemap.spec.ts`. This is
   the **only** observable that distinguishes "server half wired" from "server
   half unwired but the CDN happened to be up": the proxy soft-fails to 204 and
   `DownloadBasemapButton` counts a 204 as success (#780), so from the client
   the two are identical.

The `/etc/hosts` blackhole is kept — as belt-and-braces and as standing proof
for a sceptic that the suite passes with the origin unreachable — but it is
labelled as such in both the workflow and CLAUDE.md.

## Files

| file | role |
|---|---|
| `src/lib/geo/basemap-style.ts` | **new** — `DEMO_STYLE`, `buildFixtureBasemapStyle`, `resolveBasemapStyle`, extracted out of MapCanvas |
| `src/lib/offline/basemap-fixture-tile.ts` | **new** — the 38-byte MVT as a base64 constant |
| `src/components/ui/map/MapCanvas.tsx` | drops the resolver, `DEMO_STYLE` and its `@/env` import; widens `BASEMAP_STYLE` to `string \| StyleSpecification` |
| `…/locations/[id]/basemap/[z]/[x]/[y]/route.ts` | fixture short-circuit, `X-Basemap-Source`, `AbortSignal.timeout(5s)`, shared `tileResponse` helper |
| `src/env.ts` | both flags, `.optional()`, no zod default |
| `playwright.config.ts` | server flag on `webServer.command` |
| `.github/workflows/ci.yml` | client flag on the build step + the blackhole step |
| `scripts/e2e-local.mjs` | client flag on the local build |
| `tests/unit/geo/basemap-style.test.ts` | **new** — the resolver's three branches |
| `tests/unit/offline/basemap-fixture-tile.test.ts` | **new** — tile ↔ offline-style coupling |
| `tests/unit/api/basemap-tile-proxy.test.ts` | **new** — the proxy handler, previously untested |
| `tests/e2e/map-basemap-hermetic.spec.ts` | **new** — the runtime request observer |
| `tests/e2e/mobile/offline-basemap.spec.ts` | server-half assertion; strict byte probe; two false comments corrected |
| `ExchangeClient.tsx`, `exchange-map-utils.ts`, `exchange-create.spec.ts` | three stale "maplibre" comments corrected |

## Decisions

- **Extract the resolver rather than test it through MapCanvas.** The decision
  had never been executed anywhere: `DEMO_STYLE` / `resolveBasemapStyle` /
  `demotiles` had exactly one hit across `tests/`, and it was a comment. The
  rendered MapCanvas suite could not have covered it either — its `Map` stub
  discards `mapStyle`. Extraction makes the restoration cost milliseconds
  instead of a multi-minute render, and removes any need for
  `jest.isolateModules`, because `@/env` is a `process.env` Proxy under jest
  and the extracted function reads env at call time.
- **A real vector tile, not a 0-byte 200.** A bodyless 200 would satisfy every
  assertion in the suite — the SW caches it, the offline probe resolves —
  while making the offline map exactly the blank void `offline-basemap.spec.ts`
  exists to disprove. The 38-byte fixture carries one full-extent polygon in
  the `countries` source-layer, which is the layer `buildOfflineBasemapStyle`'s
  `offline-land` fill paints. Verified by execution: rendering that style
  against these bytes reaches `idle` with zero errors and
  `queryRenderedFeatures` at the centre returns `['offline-land']`.
- **Ship the tile as a base64 constant, not a checked-in `.pbf`.** No asset to
  COPY into the runtime image, no secret-scanner or LFS question, and no path
  from `src/` into `tests/` (which has no precedent here).
- **Two flags, not one.** A single `NEXT_PUBLIC_*` would couple the server half
  to a build-time value and break the bare `npx playwright test` path, which
  builds without it.
- **The fixture branch is checked FIRST**, ahead of the MapTiler key, so a
  runner that happens to carry a key still stays hermetic. And it sits **after**
  every address/bbox validation in the proxy route, so fixture mode is exactly
  as bounded as the real one rather than a bypass.
- **Fixed `maps/undefined/style.json` while passing through.**
  `NEXT_PUBLIC_MAP_BASEMAP_STYLE`'s zod `.default('hybrid')` fires under
  neither `SKIP_ENV_VALIDATION=1` (env-core returns `runtimeEnv` verbatim) nor
  the jest env mock, so the in-code `?? 'hybrid'` is load-bearing. The unit test
  pins the key-set/style-unset case that would otherwise have been green about
  a broken URL.
- **Added a 5s `AbortSignal` to the upstream fetch.** There was none, and
  `DownloadBasemapButton` walks up to `BASEMAP_PACK_MAX_TILES = 256` tiles
  sequentially — so a hanging upstream was a production stall, not the fast 204
  the route's comment promised. An abort throws, which the existing catch
  already maps to 204.
- **Correction to #764's own evidence.** The failure it cites was a **localhost**
  `apiRequestContext.post: socket hang up` at `map.spec.ts:43`, ~3 minutes after
  the last demotiles console line, in a run where the `mobile-android` twin of
  that test passed and `offline-basemap.spec.ts` passed in both projects. The
  two demotiles lines were the only `BROWSER CONSOLE ERROR` entries in a 2.1 MB
  log, both inside `field-op-conflict-resolution.spec.ts`, and **both tests
  passed**. The dependency is real and has already failed in CI; the cited
  causation was adjacency in a scrolled log. The localhost hang belongs to #748.
- **The demotiles fallback is untouched.** It is a product feature (the map
  renders without a MapTiler signup) and — verified against the running
  container — a live **production** path: the published image is built with
  `ARG NEXT_PUBLIC_MAPTILER_KEY=""` and `deploy.yml` passes no `build-args`, so
  the deployed map renders from demotiles. That is now tracked as #781, along
  with the signal CI gives up by going hermetic.

## Deliberately out of scope

Filed rather than folded in, per "a merged PR body is not a tracker":

- **#779** — `fonts.googleapis.com` (a remote `@import` on every page load) and
  `api.pwnedpasswords.com` (HIBP on every isolated-tenant registration) are
  still reached. Blocking the fonts moves font metrics, which several
  responsive assertions depend on, so it needs its own measurement.
- **#780** — the offline-map success toast fires over an empty pack.
- **#781** — nothing watches whether demotiles is still a valid style, and
  production renders from it.
- **#782** — `maps.isric.org` is a second hard-coded third-party map origin,
  dormant only because no spec enables Soil view.

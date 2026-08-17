# 2026-08-17 — maplibre-gl v6: serving the worker ourselves

**Commit:** `<pending> feat(map): migrate maplibre-gl to v6 and serve its worker as a static asset`

## Problem

The v6 bump (#577) failed CI and the failure was mis-labelled as a mobile
horizontal-drift regression. It was not. Every failing test ran for **exactly
3.0 minutes, three retries deep** — a timeout. A real overflow fails instantly
with a `scrollWidth N > viewport M` message, and `detail pages do not drift`
hung alongside the map spec. Nothing was drifting; the map never rendered.

v5 inlined its web worker as a blob and self-configured. v6 is ESM-only and
loads the worker from a real URL, derived by swapping the filename on its own
`import.meta.url`:

```js
function bi(){ let e = import.meta.url;
               if (!/^https?:/.test(e)) return ``;
               let t = e.endsWith(`-dev.mjs`) ? `maplibre-gl-worker-dev.mjs`
                                              : `maplibre-gl-worker.mjs`;
               return new URL(`./${t}`, e).href }
```

That assumes the published `dist/` layout survives to the served path — true for
Vite, false for webpack. Bundled, `import.meta.url` is
`/_next/static/chunks/<hash>.js`, so the worker resolves to
`/_next/static/chunks/maplibre-gl-worker.mjs`. **Confirmed by build inspection:
`find .next -name '*maplibre*'` returns nothing.** It 404s, the map never
initializes, the page hangs.

## Design

Serve the worker ourselves and point maplibre at it.

`@vis.gl/react-maplibre` (which `react-map-gl/maplibre` re-exports) already
exposes this as a first-class prop. `setGlobals` calls
`mapLib.setWorkerUrl(workerUrl)` **synchronously before** the Map constructor in
the same resolved `.then()`, so ordering is guaranteed with no module-level shim:

```jsx
<Map workerUrl="/maplibre/maplibre-gl-worker.mjs" … />
```

MapCanvas is the single seam — it renders exactly one `<Map>`, and the cadastre
overlay, soil WMS and vector parcels are all `<Source>`/`<Layer>` children of it.
`ExchangeMap` and `ParcelOverviewMap` are bespoke 2D canvas renderers with no
maplibre dependency.

**TWO files ship, not one.** `maplibre-gl-worker.mjs` (18 KB) does
`import … from "./maplibre-gl-shared.mjs"` (482 KB), so both must sit in the same
directory with that relative specifier intact. Shipping only the worker yields a
404 on the shared chunk and the same dead map — a mistake my own probe made
first, which is how I know the failure mode is immediate.

## Files

| file | role |
|---|---|
| `package.json` / `package-lock.json` | `maplibre-gl` 5.24.0 → 6.3.0, still exact-pinned |
| `public/maplibre/maplibre-gl-worker.mjs` | the worker, served at a stable path |
| `public/maplibre/maplibre-gl-shared.mjs` | its static import — required |
| `src/components/ui/map/MapCanvas.tsx` | `workerUrl` prop + the why |
| `tests/guards/maplibre-worker-asset-sync.test.ts` | byte-identity with `node_modules` |
| `.github/dependabot.yml` | maplibre-gl major hold REMOVED |

## Decisions

- **react-map-gl needed no bump, and the version range said nothing.**
  `react-map-gl@8.1.2` declares `maplibre-gl: ">=1.13.0"`, which is useless. But
  it is a 3-line re-export shim; the implementation is `@vis.gl/react-maplibre`,
  whose devDependency moved `^5.0.0 → ^6.0.0` *at exactly 8.1.2*. **8.1.2 is the
  maplibre-v6 support release and we were already on it.** Its
  `'Map' in module ? module : module.default` line is precisely the v6 shim —
  v6 has no default export, which my probe hit head-on.

- **Checked-in copies, not generated.** Both obvious generation hooks are dead
  ends in this repo's Docker pipeline: `postinstall` runs in the `deps` stage,
  which has no `public/` and whose only export to the builder is `node_modules`;
  and a `prebuild` script never fires because the builder runs
  `npx next build --webpack` directly, not `npm run build`. Checked-in files ride
  the existing `COPY . .` and `COPY --from=builder /app/public` with no pipeline
  change. The cost is two copies of a version-specific artifact, which is exactly
  what the sync guard exists to police.

- **The guard asserts byte-identity, not existence.** A stale copy does not fail
  the build; it runs last release's worker against this release's main thread,
  and surfaces as an inexplicable rendering bug months later. The failure message
  carries the one-line `cp` that fixes it. It also pins that every import in the
  worker is a same-directory sibling, so if upstream inlines or renames the
  shared chunk, `REQUIRED_ASSETS` is wrong loudly rather than at runtime.

- **~500 KB is served when a map opens, and that is inherent.** The shared chunk
  is bundled into the app chunk AND fetched separately by the worker, because a
  worker is a separate execution context. maplibre's own intended deployment has
  the same duplication. On a data-cost-sensitive product this is worth knowing;
  it is not something the workaround introduced.

  **Measured and then tested, 2026-08-17 — the obvious fix does not work.**
  A cold first map open (local `next start`, real login, location detail with
  `?tab=map`) transfers **4488 KB across 101 responses**, of which maplibre is
  ~1040 KB: a **551 KB** bundled chunk plus **471 KB**
  `maplibre-gl-shared.mjs` plus the 18 KB worker.

  The tempting fix is to stop bundling maplibre and load it from the same served
  ESM the worker uses, via react-map-gl's `mapLib` prop with a
  `webpackIgnore`'d dynamic import, so the shared chunk is fetched once. That was
  built and measured. It works — `map.spec.ts` and `offline-basemap.spec.ts` both
  pass against it, and the bundled chunk is genuinely no longer fetched — and it
  saves **nothing**:

  | | bundled (current) | served ESM |
  |---|---|---|
  | main thread | 551 KB (one chunk) | 550 KB + 471 KB |
  | worker | 18 KB + 471 KB | 18 KB + (shared, cached) |
  | **maplibre total** | **~1040 KB** | **~1039 KB** |

  The reason is that webpack tree-shakes `maplibre-gl.mjs` and
  `maplibre-gl-shared.mjs` TOGETHER down to 551 KB, while serving them raw costs
  1021 KB. Bundling is the more efficient main-thread representation; sharing one
  copy with the worker just moves the cost. The worker's second copy is the price
  of a separate execution context and there is no arrangement that avoids it.

  So: **do not re-litigate this without new information** — e.g. maplibre
  shipping a worker that does not import the shared chunk, or webpack gaining the
  ability to emit a `new URL(dynamic, import.meta.url)` worker asset.

- **WebGL2 is not a second blocker.** v6 removes WebGL1, so this needed checking
  rather than assuming: probed Playwright's headless Chromium in both mobile
  projects — `{"webgl2":true}` on Pixel 5 and iPhone 13.

- **The v6 release note about CSP is wrong for this code path.** It claims
  `worker-src blob:` is no longer required. The cross-origin branch still calls
  `URL.createObjectURL(new Blob([…]))`. `src/lib/security/csp.ts` keeps
  `'worker-src': ["'self'", 'blob:']` — same-origin covers our served path.

## Verification

The mechanism was proved in a real browser before touching the app: a standalone
page served the two files, called `setWorkerUrl` exactly as `setGlobals` does,
built a map, and added a **GeoJSON source — which is parsed in the worker**.

```
Desktop Chrome  {"stage":"worker-parsed-geojson","version":"6.3.0","features":1}
                worker requests: [shared.mjs, worker.mjs, shared.mjs]
Pixel 5         {"stage":"worker-parsed-geojson","version":"6.3.0","features":1}
```

The request list is the interesting part: the worker is fetched, and then fetches
its sibling from inside the worker context — both files demonstrably load and the
worker demonstrably runs.

Also: `next build --webpack` succeeds under `NODE_ENV=production`, `tsc --noEmit`
clean, and the sync guard passes 6/6.

**The end-to-end check is CI's E2E job**, which runs
`tests/e2e/mobile/{map,horizontal-drift,offline-basemap}.spec.ts` against a real
`next start`. Those are the specs that timed out on #577; they are the gate that
matters, and they are why this migration is verifiable at all.

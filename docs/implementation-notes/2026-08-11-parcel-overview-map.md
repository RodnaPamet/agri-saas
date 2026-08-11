# 2026-08-11 — Parcel overview: clustered endpoint + shared projector

**Commits:** `200a98e3` (projector extraction, #522), `6cea1893` (clusters endpoint, #526)

## Design

A location detail page can hold 100+ parcels. Rendering was already
solved — `MapCanvas` caps GeoJSON at maxzoom 6 and hands off to a
vector-tile source above it. The unsolved problem was **findability**:
orienting among many parcels. The answer is a proximity-clustered
overview: "12 parcels near Драгоево, 8 near X", click through to filter.

```
Parcel.geometry (PostGIS MultiPolygon, Unsupported in Prisma)
        │  ST_PointOnSurface  ← src/lib/db/geo.ts
        ▼
ParcelRepository.listForOverview      one bounded raw query, tenantId in SQL
        │
        ▼
splitPositioned()                     positioned │ unpositioned (counted, never dropped)
        │
        ▼
clusterParcels(cellMetresForZoom(z))  grid-snap on projected centroids
        │
        ▼
labelClusters(SETTLEMENTS)            nearest settlement, rank-weighted
        │
        ▼
GET …/parcel-clusters                 jsonWithETag → 304 on re-open
```

Rendering consumes `src/lib/geo/bg-projection.ts` — extracted from
`ExchangeMap`, which now shares it.

## Files

| File | Role |
|---|---|
| `src/lib/geo/bg-projection.ts` | `makeProjector` / inverse / `fitToExtent` / `bboxOf`. Pure. |
| `src/lib/geo/parcel-clustering.ts` | Grid-snap clustering, `clusterIdFor`, nearest-settlement. Pure. |
| `src/lib/db/geo.ts` | `pointOnSurfaceLonSql` / `…LatSql`. The only legal home for `ST_*`. |
| `src/app-layer/repositories/ParcelRepository.ts` | `listForOverview` — one bounded raw query. |
| `src/app-layer/usecases/parcel-overview.ts` | `splitPositioned`, `cellMetresForZoom`, `getParcelOverview`. |
| `src/app/api/t/[tenantSlug]/locations/[id]/parcel-clusters/route.ts` | The endpoint. |
| `tests/guards/bg-projection-single-source.test.ts` | One transform, structurally enforced. |
| `tests/guards/parcel-clusters-etag.test.ts` | The route keeps its conditional-GET behaviour. |
| `src/components/locations/ParcelOverviewMap.tsx` | The canvas + the cluster list. Refs, effects, paint. |
| `src/components/locations/parcel-overview-model.ts` | Zoom tiering, token codec, projection bridge, selection. Pure. |
| `src/lib/geo/bg-geometry-client.ts` | One memoised fetch of the 100 KB geometry asset per page load. |
| `…/locations/[locationId]/page.tsx` | `FilterProvider` shell; both facets narrow one table. |

## Decisions

**Proximity clustering, not oblast.** The marketplace map aggregates by
administrative region, and that is right *there* — offers are spread
across the country. A single farm is not. Essentially every parcel of one
holding sits inside one oblast, so an oblast choropleth would draw one
shape containing everything and answer nothing. The question a farmer
actually asks — "which of my plots are near each other" — is distance,
not administration.

**Grid-snap, not agglomerative.** Chosen for determinism rather than
simplicity: the cluster id feeds a URL filter facet, so two people
opening the same link must resolve identical members, and agglomerative
clustering is iteration-order dependent. Accepted trade-off: two parcels
either side of a cell boundary stay separate even when metres apart.

**Cluster identity is the member set, not the grid cell.** The first
implementation used `` `c${gx}:${gy}` ``. That is wrong in a way that
only shows up in production: the cell pitch derives from zoom, so the
same parcels clustered under a *different* id at a different zoom, and a
shared `?cluster=…` link resolved to different parcels or none. It
presents as "the map lost my selection", not as an identity bug. Identity
is now an FNV-1a hash of the sorted member ids — stable at any pitch,
short enough for a URL (a 300-parcel cluster's raw id list would be
kilobytes), with a separator byte mixed in so `['ab','c']` and
`['a','bc']` cannot collide onto one filter value.

**`ST_PointOnSurface`, not `ST_Centroid`.** `Parcel.geometry` is a
`MultiPolygon`. A parcel split by a road or track is two polygons, and
the centroid of that pair lands *between* them — on the road, in whatever
field lies opposite. `ST_PointOnSurface` is guaranteed to lie on the
geometry, which is what "where is this parcel" has to mean once the
answer becomes a marker. Costs marginally more; irrelevant at one row per
parcel.

*Not changed:* `ParcelRepository.centroidLonLat` still uses
`ST_Centroid`, and `soil.ts` uses it to pick a ~100 m soil-grid cell.
The `SoilSample` cache is keyed on those rounded coordinates, so
switching it would shift the key, miss every cached sample and re-fetch.
A separate decision with data implications, deliberately out of scope.

**Unpositioned parcels are counted, never dropped.** A farm with 30
un-geocoded parcels seeing "70 parcels" on a map labelled as its holding
has been silently lied to and has no way to notice. The rule extends past
NULL geometry to **non-finite coordinates and half-null pairs**: a `NaN`
is the same data loss wearing a different hat — it enters the cluster
maths, produces an undrawable marker, and vanishes with no NULL anywhere
to see. A conservation test asserts `positioned + unpositioned === total`,
which is what makes either number trustworthy.

**Settlement labels resolve server-side.** `bg-settlements.json` is 7239
entries; shipping it to a phone on rural LTE so the client could linear-scan
would defeat the point of clustering. Ties break by rank within a 3 km
band rather than on exact equality — strict ties never occur with real
coordinates, so an exact tie-break would never fire and the hamlet would
always beat the town. Rank does not override distance outright: a
high-rank city 60 km away still loses to a local hamlet.

**Two renderers coexist; they do not merge.** `MapCanvas` is MapLibre GL
over a MapTiler satellite basemap, with draw/edit/split. The overview is
a bespoke 2D canvas in the spirit of `ExchangeMap`. Different libraries
with different rendering models — there is no single canvas that is both.
`MapCanvas` is untouched.

*Amended by the UI work below:* the toggle between them is the page's
existing **tab bar**, not a switcher inside the Map tab. The reason is
mechanical rather than aesthetic — see "Where the overview lives".

**A bespoke `<canvas>` is a deliberate exception to `docs/charts.md`,**
which bans raw `<svg>` and inline percentage-width bars. `ExchangeMap`
already holds this exception: a full GL basemap is overkill for a
country-scale overview, and the chart platform has no primitive for a
projected map. Recorded so the next reader sees a decision rather than an
oversight.

## The view (P3)

The endpoint above is consumed by `ParcelOverviewMap`, mounted in the
location detail page's **Overview** tab, directly above the crop chips
and the parcels table it filters.

```
GET …/parcel-clusters?zoom=<tier>
        │
        ▼
ParcelOverviewMap        canvas (pixels) + cluster list (DOM)
        │  onSelect(ClusterSelection)      ← member ids SNAPSHOTTED
        ▼
useFilterContext(['cluster','crop'])       ← Epic 53, URL-synced
        │
        ▼
overviewParcels  =  parcels ∩ crop ∩ cluster.parcelIds
        │
        ▼
<DataTable>              the thing the click visibly narrows
```

### Where the overview lives

The brief described a switcher inside the Map tab. It went in the
Overview tab instead, because the parcels table is in the Overview tab
and `MapCanvas` is in the Map tab — they are mutually exclusive
siblings. "Click a cluster, watch the list narrow" needs one viewport,
and a filter you have to change tabs to observe is a filter the user
takes on faith. The tab bar is then the toggle the brief asked for:
**Map** is the satellite work surface, **Overview** is the locator.

### Cluster identity survives zooming — because the URL carries the pitch

`clusterIdFor` hashes the member set, and `cellMetresForZoom` re-cuts
membership at every tier, so a bare `?cluster=c1abc` set at tier 8
matches nothing at tier 12. The failure is not a blank map: the table
filters to zero rows and renders its EMPTY state, announcing "no
parcels" on the strength of a lookup that failed. That is the exact
shape `docs/implementation-notes/2026-07-25-grain-contract-defect-fixes.md`
was written about.

Two mechanisms, together:

- The facet value is `<id>@<tier>` — the pitch the id was minted at. A
  cold load pins the very first request to that tier, so the payload
  that arrives is the one that can answer the token. One param, so the
  facet stays a single filter key and `hasActive` keeps counting truthfully.
- Once resolved, the member ids are **snapshotted**. The table filters
  on the snapshot for the rest of the session; the user is free to keep
  zooming and the group they picked stays the group they picked.

A token that resolves to nothing (parcels moved or deleted) **clears the
facet** rather than filtering to zero rows.

### Per-parcel points, and why the payload grew

`ParcelOverview` gained `parcels: [{ id, lon, lat }]`. Without it "zoom
in and clusters split into individual parcels" was unreachable, not
merely unimplemented: `cellMetresForZoom` floors at 200 m, so tiers 13
and 14 cluster identically and two parcels 150 m apart never separate at
any zoom. Past `PARCEL_TIER_THRESHOLD` the view stops drawing the grid
and draws parcels.

Ids and coordinates only. Name, area and crop are already on the page
from `/locations/:id/parcels`, and a second copy is a second thing that
can disagree with the table under the map. The join is by id, and the
7239-entry settlement file stays server-side: clusters are labelled with
a settlement, individual parcels with their own name, so the client
never needs the lookup.

### One filter mechanism, not two

`cropFilter` was a bare `useState`. Leaving it there while the cluster
facet went onto Epic 53 would have left one table narrowed by two
independent mechanisms — and the accordion's count, which keyed off
`cropFilter` alone, would have printed the unfiltered total above a
cluster-filtered table. Both facets now live in one `useFilterContext`,
the count keys off `hasActive`, and a crop selection survives a reload.
The chips keep their `ToggleGroup` appearance; only the state moved.

### The list is not a fallback

A canvas is invisible to assistive tech, and `ExchangeMap` — the model
for this component in every other respect — has three a11y attributes in
985 lines and no keyboard path to any action. That is the one thing not
mirrored. Every cluster is also a real `<button aria-pressed>` in a
scrollable list beneath the canvas, calling the same handler. It is
complete (never truncated), it is how the rendered tests drive the
filter, and under jsdom — where `getContext('2d')` returns null and the
canvas paints nothing at all — it is the only thing that works, which is
a fair approximation of a screen reader's experience.

### Gestures

One per target. Mouse: drag pans, click selects. Touch: one finger is
left entirely to the browser (the page scrolls, and the tab panel's own
horizontal-swipe navigation keeps working), two fingers zoom the map, a
one-finger tap that did not move selects. `preventDefault` is called on
the two-finger paths only — #449's lesson is that a `preventDefault` on
a single-touch path silently kills the default action of everything
underneath it.

### Where the logic lives, and why

jsdom implements no 2D context, so every draw and hit-test path in the
component is unreachable by a rendered test — which is why `ExchangeMap`
has zero executing coverage. The arithmetic therefore sits outside the
component in `parcel-overview-model.ts`: zoom tiering, the token codec,
the projection bridge, selection resolution. `projectionBridge` measures
itself through `makeProjector` with two probe points rather than
re-deriving `(to.cos * to.s) / (from.cos * from.s)` from the parameters —
a ratio built from the projection's internals is the same drift
`bg-projection-single-source` exists to prevent, just wearing different
clothes.

## Environment note

`docker-compose.test.yml` moved the test database to port **5435**.
Distinct database *names* (`agri_saas_test` vs `inflect_test`) were not
enough: the `inflect-compliance` stack on the same machine binds 5434
with a Postgres that has **no PostGIS**, so whenever that stack is up,
agri-saas silently connects somewhere every geometry migration fails —
surfacing as `relation "Parcel" does not exist`, several layers from the
cause.

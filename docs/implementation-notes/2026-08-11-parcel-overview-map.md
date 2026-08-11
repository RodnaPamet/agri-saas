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
They ship as two views the user toggles between, and `MapCanvas` is
untouched.

**A bespoke `<canvas>` is a deliberate exception to `docs/charts.md`,**
which bans raw `<svg>` and inline percentage-width bars. `ExchangeMap`
already holds this exception: a full GL basemap is overkill for a
country-scale overview, and the chart platform has no primitive for a
projected map. Recorded so the next reader sees a decision rather than an
oversight.

## Environment note

`docker-compose.test.yml` moved the test database to port **5435**.
Distinct database *names* (`agri_saas_test` vs `inflect_test`) were not
enough: the `inflect-compliance` stack on the same machine binds 5434
with a Postgres that has **no PostGIS**, so whenever that stack is up,
agri-saas silently connects somewhere every geometry migration fails —
surfacing as `relation "Parcel" does not exist`, several layers from the
cause.

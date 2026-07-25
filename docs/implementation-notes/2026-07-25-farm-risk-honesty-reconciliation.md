# 2026-07-25 — Farm Risk: reconciling the docs with the engine

**Prompt:** two paired audits of the `/farm-risk` + Agro-intel satellite
surfaces. The finding in both: *the engine is real; the docs and dead seams
lie.* The Google Earth Engine Sentinel-2 pipeline, the band math, the honest
degradation, the whole-farm Claude briefing and the tenancy/authz model were
all explicitly out of scope to change — the job was to make every docstring,
DTO, export and label describe what the code actually does, and to fix three
correctness/ops defects found alongside them.

## Design

Two classes of change, kept deliberately separate in review terms:

**(A) Reconciliation — delete the false promises.** A docstring that describes
an unbuilt feature reads, to the next engineer, exactly like a delivered one.
Three seams advertised work that never happened; all three were closed by
REMOVING the claim, not by building the feature (see the forks below).

**(B) Correctness + ops — three real defects.**

1. *Cache poisoning.* `analyzeParcelRisk` cached its result unconditionally.
   A transient Earth-Engine error degrades to null indices and `unknown`
   levels by design — but persisting that pinned "No data" on the parcel for
   the full 6h TTL, long after EE recovered. The fix mirrors the existing
   `if (briefing && redis)` rule in `satellite-briefing.ts`: cache only a
   reading that actually had imagery; return the degraded shape uncached so
   the next request retries. A PARTIAL reading (one usable index) still
   counts as imagery and is cached.

2. *Stale date label.* `adaptiveS2Collection` falls back to a window ending
   on the latest available acquisition whenever the requested window holds no
   imagery — the common case being the wall clock outrunning the published
   Sentinel-2 archive. The tile route then reported the *requested* date, so
   old imagery got labelled with a fresh date. The composite's real
   acquisition date is now read out of Earth Engine
   (`aggregate_max('system:time_start')`) and threaded through both the tile
   path and the two means paths. It is issued inside the same `Promise.all`
   as the main `getMap`/`reduceRegion` evaluate, so honesty costs no extra
   serial round-trip, and it is fail-soft: any EE hiccup resolves `null` and
   the caller falls back to the requested date rather than sinking a request
   that otherwise succeeded.

3. *Silent satellite outage.* With no GEE credentials every satellite surface
   degrades honestly and nothing errors — which is precisely why a prod deploy
   that never got its keys goes dark unnoticed. Made observable without
   making it fatal (the degradation is a feature, not an outage).

## Forks

Both forks were resolved the same way, for the same reason: the alternative
was to build a second AI/imagery surface next to one that already exists.

**Fork 1 — per-parcel "AI summary": REMOVED, not implemented.**
`parcel-risk.ts` hardcoded `summary = null` while the module docstring, the
`ParcelRiskResult` DTO ("Short AI summary (Claude)…"), and the route doc all
described a Claude summary; `FarmRiskClient` carried a dead
`{risk.summary && …}` branch and the page called itself an "AI risk page".
Implementing it was rejected on three counts: the whole-farm briefing
(`satellite-briefing.ts`) already produces localised Claude prose over the
same readings in ONE call; a per-parcel variant means one Claude call per card
per page render, since each card fetches independently; and the usecase has no
locale to generate in (the client renders every level through next-intl). The
traffic-light levels plus the NDVI/NDMI numbers — now with plain-language
tooltips — carry the signal. So the DTO field, the dead client branch, the
docstring claims and the "AI" framing all went, and the docstring now records
*why* there is no summary, so the next reader doesn't re-litigate it.

**Fork 2 — per-parcel risk map overlay: REMOVED the dead export.**
`RISK_COLORS` was exported "for the per-parcel risk map overlay" with zero
consumers, and `/farm-risk` renders no imagery despite the satellite framing.
Rendering the overlay was feasible — `MapCanvas` already has a per-parcel fill
seam (`soilMode`/`soilColorById`) that a `riskColorById` sibling would mirror,
and the page already knows its `locationId` — but it is a second feature, not a
reconciliation: it needs parcel geometry client-side, a generalisation of a
prop currently documented as soil-specific on a primitive shared by four call
sites, and its own i18n + tests. The page's framing was made truthful instead:
it presents satellite-DERIVED readings (which is literally what Sentinel-2
means give it) and no longer claims imagery it doesn't show. `RISK_COLORS` is
deleted; if the overlay is ever wanted, four traffic-light hex values are not
the hard part.

Both decisions are recorded as superseding notes in the two older
implementation notes that promised the deferred work, so the historical record
points forward rather than stranding a reader on a stale plan.

## Files

| File | Role |
|---|---|
| `src/lib/agro/gee-config.ts` | **New.** EE-free credential predicate — `isGeeConfigured` + `geeConfigStatus`. Split out so a page shell, health probe and startup hook can ask "is satellite on?" without importing the heavy `@google/earthengine` client. |
| `src/lib/agro/earth-engine.ts` | `isGeeConfigured` moved out + re-exported (every existing import path and route-test mock still works). New `resolveAcquiredDate` helper; `getIndexTileUrl` now returns `IndexTileResult { tileUrl, acquiredDate }`; `FieldIndexMeans` gained `acquiredDate`. |
| `src/lib/agro/index-tiles-handler.ts` | Reports the REAL acquisition date as `date`. Cache value became a `{ tileUrl, acquiredDate }` JSON pair, so the key prefix moved `clip2` → `clip3`; a legacy entry falls through and regenerates instead of throwing. |
| `src/app-layer/usecases/parcel-risk.ts` | Conditional cache (imagery-only); `summary` field and `RISK_COLORS` export deleted; `acquiredDate` threaded; docstring records the no-summary decision. |
| `src/app/api/t/[tenantSlug]/agro/parcel-analysis/route.ts` | Route doc no longer promises a Claude summary. |
| `src/app/api/t/[tenantSlug]/agro/ndvi-config/` | **Deleted.** Dead route — the EE `<index>-tiles` routes are the real overlay. |
| `src/env.ts` | `AGRO_NDVI_TILE_URL` removed (schema + runtimeEnv) — its only consumer was the deleted route. |
| `src/app/t/[tenantSlug]/(app)/farm-risk/page.tsx` | Drops the "AI" framing; resolves `geeConfigured` server-side and passes it down. |
| `src/app/t/[tenantSlug]/(app)/farm-risk/FarmRiskClient.tsx` | Loading copy gated on `geeConfigured`; NDVI/NDMI `InfoTooltip`s; dead `summary` branch replaced by the honest "Satellite pass: {date}" line. |
| `src/app/t/[tenantSlug]/(app)/locations/[locationId]/page.tsx` | Shows "Imagery from {date}" beside the legend when the rendered composite is older than the date in the picker. |
| `src/app/api/readyz/route.ts` | New `capabilities.satellite` block — reported, deliberately OUTSIDE `checks`/`failed` so it can never 503 the probe. |
| `src/instrumentation.ts` | Prod startup WARN naming the missing GEE keys. Not fail-fast: the product degrades honestly by design. |
| `deploy/env.prod.example` | Documents both GEE keys, what they power, and where to look when the satellite pages are empty. |

## Decisions

- **`capabilities` is a new, non-gating section of `/api/readyz`.** Satellite
  is a degradable capability, not a dependency — putting it in `checks` would
  503 a perfectly serving instance over an optional feature. It sits outside
  `checks`/`failed` so probe automation is unaffected while dashboards get a
  machine-readable signal. The pattern generalises to the next optional
  integration.
- **Startup emits WARN, never `exit(1)`.** Mirrors the DEK dev-fallback
  warning rather than the GAP-03 fail-fast: a missing GEE key must not
  crash-loop a farm tenant that never bought satellite.
- **The cache key moved `clip2` → `clip3` in the same diff as the value-shape
  change.** A shape change without a key change would have the new code
  `JSON.parse` a bare URL string written by the old deploy. The handler also
  tolerates an unreadable entry by regenerating, so a rollback is safe in both
  directions.
- **The picker keeps showing the user's selection.** The imagery-date
  `DatePicker` is an input; relabelling it with the fallback date would make
  the control lie about its own value. The real date is surfaced as a separate
  note beside the legend, and only when the two actually differ — an
  always-on note would be noise on the common path.
- **`isGeeConfigured` is re-exported from `earth-engine.ts` rather than
  migrated at every call site.** The five tile-route unit tests mock
  `@/lib/agro/earth-engine` wholesale; moving the import path would have
  churned all five for no behavioural gain. New light-weight callers import
  from `gee-config` directly.
- **`acquiredDate` is fail-soft everywhere.** A label is never worth failing a
  composite that rendered. `null` at every layer means "EE didn't say", and
  each consumer falls back to the requested date.

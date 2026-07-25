# 2026-06-15 — Agro-intel (weather, GDD, agronomic rules → Risk register)

**Commit:** `<sha>` feat(agro): weather obs, GDD, spray/disease rules → Risk, NDVI, data streams

## Design

A data-driven layer that turns weather into action across spray, planning,
and the risk register.

```
Open-Meteo ──weather-pull job──▶ WeatherObservation (per location/day)
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                        ▼                       ▼
   accumulateGdd (per planting)   evaluateSprayWindow     evaluateDiseaseRisk
              │                        │                       │
        GDD on plantings        AgroSignal(SPRAY) ─▶ Notification
                                 AgroSignal(DISEASE) ─▶ createRisk (reuse register)
```

The agronomic MATH is isolated in `src/lib/agro/{gdd,rules}.ts` — pure,
Prisma-free, clean-room (generic agronomy, no GPL source). The schema
persists the weather the rules consume + the signals they emit; a
disease-risk signal **reuses** the GRC Risk register rather than inventing
a parallel alert model. `AgroSignal`'s unique key is the idempotency
backbone so the daily job is safe to re-run.

A separate, feature-flagged, token-gated ingestion endpoint accepts
sensor readings (the farmOS data-stream concept) — modelled on the
existing public vendor-assessment submit route.

## Files

| File | Role |
|---|---|
| `src/lib/agro/gdd.ts`, `rules.ts` | PURE GDD accumulation + spray/disease evaluators (18 tests) |
| `prisma/schema/agro.prisma` + migration | 4 RLS-scoped models (drift-stripped, RLS trio) |
| `src/lib/weather/open-meteo-client.ts` | free no-key Open-Meteo client (timeout, mockable) |
| `src/app-layer/jobs/weather-pull.ts` | daily per-tenant→per-location fetch → upsert obs → signals |
| `src/app-layer/usecases/agro-signals.ts` | claim-then-act signals → Notification + reused Risk |
| `src/app-layer/usecases/agro-gdd.ts` | per-planting GDD from obs (`GET …/plantings/:id/gdd`) |
| `src/app-layer/usecases/data-stream.ts` + `src/app/api/agro/.../ingest/route.ts` | data-stream CRUD + public token-gated ingestion |
| `src/components/ui/map/**` (NDVI layer) | raster NDVI layer over the parcel-bbox AOI |
| `src/env.ts` | `AGRO_DATASTREAMS_ENABLED`, `AGRO_NDVI_TILE_URL` flags |

## Decisions

- **The math is pure + clean-room.** GDD (average method, cap + base
  floor) and the spray/disease evaluators are first-principles agronomy
  in `src/lib/agro` — Prisma-free + fully unit-tested, GPL-safe.
- **Disease risk REUSES the Risk register.** A HIGH disease signal
  `createRisk(category:'Agronomic')` rather than a bespoke alert model —
  the matrix, treatment plans, ownership, and review all come for free.
  `AgroSignal.riskId` back-links the provenance.
- **AgroSignal is the idempotency key.** `@@unique([tenantId, locationId,
  kind, signalDate])` + a **claim-then-act** pattern: the daily job claims
  the signal row (catch the unique violation), and only a *new* claim
  fires the side effects (Notification / Risk). Re-running the job the
  same day is a no-op. `createRisk` runs OUTSIDE the claim (it opens its
  own transaction).
- **The ingestion endpoint is public + token-gated + flagged.** SHA-256
  constant-time token compare, tenant resolved from the matched stream,
  a uniform 401 for every denial (anti-enumeration), and a feature flag
  (`AGRO_DATASTREAMS_ENABLED`) so an operator opts in. `data-stream.ts`
  uses the global prisma client pre-auth (allowlisted, same rationale as
  `vendor-assessment-response.ts`) then `runWithAuditContext`.
- **GDD base temp is a flat constant (10 °C).** CropVariety has no
  base-temp column; a per-variety base is a deferred follow-up.
- **NDVI is a tile-URL passthrough**, not a satellite pipeline — the
  layer renders from `AGRO_NDVI_TILE_URL`; real Sentinel/COG provisioning
  is out of scope.
  > **Superseded.** The real Google Earth Engine Sentinel-2 pipeline landed
  > later (`/agro/<index>-tiles` + `src/lib/agro/earth-engine.ts`), which made
  > the passthrough dead: `AGRO_NDVI_TILE_URL` and its `/agro/ndvi-config`
  > route were deleted 2026-07-25 — see
  > `2026-07-25-farm-risk-honesty-reconciliation.md`.

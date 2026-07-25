# 2026-07-08 — Farm Risk: per-parcel satellite AI + insurer offer

**Prompt:** #13 — replace the farm "Risk" nav with a per-parcel,
satellite-driven risk page that can request an insurance offer, WITHOUT
deleting the GRC risk module (keep it behind CERTIFICATION, off the farm nav).

## Design

- **Nav repoint.** The "Risk" sidebar entry is split by tenant type: the GRC
  Risk Register (`/risks`) stays `visible: certAvailable`; a new farm Risk page
  (`/farm-risk`) is `visible: !certAvailable`. Exactly one "Risk" entry shows.
  The GRC route group + its CERTIFICATION layout gate are untouched.
- **Per-parcel satellite analysis.** `getIndexMeansForPolygon(geometry, win)`
  (a polygon-AOI variant of `getIndexMeansForBounds`) reduces a single parcel's
  exact geometry — via a new `ParcelRepository.geometryForParcel` — over a
  30-day cloud-masked Sentinel-2 window to mean NDVI + NDMI. The
  `analyzeParcelRisk` usecase derives traffic-light levels (vegetation from
  NDVI, moisture from NDMI, overall = worst), Redis-cached per parcel per day
  (6h). It **degrades gracefully**: no Earth-Engine creds → null indices,
  "No data" levels, and the page still renders the parcel + the insurer action.
  Exposed at `GET /agro/parcel-analysis?parcelId=`.
- **Farm Risk page.** `/farm-risk` picks a location and lists each parcel with
  its vegetation/moisture/overall `StatusBadge`, the NDVI/NDMI values, and an
  "Ask for insurance offer" button. Each parcel card fetches its analysis
  on-demand (SWR → the cached route).
- **Insurer lead.** `InsuranceLead` clones the #12 `PromotionLead` no-RLS lead
  pattern (`inquirerTenantId` is a plain FK, `parcelId` context, `riskJson`
  snapshot). `createInsuranceLead` commits the lead then fires a fail-open
  confirmation notification. `AskInsuranceModal` clones `AskForOfferModal`.

## Files

| File | Role |
| --- | --- |
| `src/lib/agro/earth-engine.ts` | `getIndexMeansForPolygon` (polygon-AOI reduce) |
| `src/app-layer/repositories/ParcelRepository.ts` | `geometryForParcel` (single-parcel GeoJSON) |
| `src/app-layer/usecases/parcel-risk.ts` | `analyzeParcelRisk` + risk levels + `RISK_COLORS` (Redis-cached) |
| `src/app-layer/usecases/insurance.ts` | `createInsuranceLead` + fail-open notify |
| `prisma/schema/insurance.prisma` · migration | `InsuranceLead` (no RLS, plain FK) |
| `src/app/api/.../agro/parcel-analysis/route.ts` | `GET ?parcelId=` |
| `src/app/api/.../insurance/leads/route.ts` | `POST` lead |
| `src/app/.../farm-risk/{page,FarmRiskClient,AskInsuranceModal}.tsx` | Farm Risk page + client + lead modal |
| `src/components/layout/SidebarNav.tsx` | Risk nav repoint (cert vs farm) |
| `messages/en.json` · `messages/bg.json` | `ag.risk` block (EN + BG) |

## Decisions

- **Redis-cached on-the-fly, no persistence model.** The satellite means/levels
  are cheap-to-recompute derived data, cached like the existing tile/briefing
  paths — no `ParcelRiskAssessment` table (avoids a tenant-model RLS + index
  migration). Only the *leads* persist (`InsuranceLead`).
- **Deterministic risk levels, no server prose summary.** A Claude summary
  can't be localised server-side, and the whole-farm `field-briefing` input
  shape (season/task/journal context) doesn't fit a single parcel. The
  traffic-light levels + NDVI/NDMI carry the read; a localised per-parcel
  Claude briefing is a clean follow-up seam (the DTO already has a `summary`).
- **`InsuranceLead` not tenant-scoped.** Mirrors `PromotionLead` /
  `ExchangeInquiry` — `inquirerTenantId` is a plain FK, so no RLS trio.
- **Map risk overlay deferred.** `RISK_COLORS` is exported for a future
  `riskColorById` MapCanvas side-channel (mirroring `soilColorById`); the page
  conveys the same risk via colored `StatusBadge`s for now.
  > **Superseded 2026-07-25.** Both deferrals above were resolved by
  > *closing* them: the `summary` DTO field and the `RISK_COLORS` export were
  > REMOVED rather than implemented, because a docstring/DTO that describes an
  > unbuilt feature reads as a delivered one. See
  > `2026-07-25-farm-risk-honesty-reconciliation.md` for both fork decisions.

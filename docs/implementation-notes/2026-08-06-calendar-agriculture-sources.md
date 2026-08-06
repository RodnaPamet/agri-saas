# 2026-08-06 — Calendar agriculture sources

**Commit range:** `e9f75765..HEAD` (PR 2 of a 3-part calendar roadmap)

## Design

PR 1 (`2026-08-05-calendar-consolidation.md`) made the calendar a single
month grid and merged the curated `AgriEvent` catalogue into it, but every
*farm's own* data still lived in thirteen agriculture models with zero
calendar presence. This PR wires up four of them and hardens the fan-out
they now share with the twelve pre-existing (mostly compliance) sources.

```
BEFORE (PR 1)                           AFTER (PR 2)

Sources: 12 compliance + AgriEvent      Sources: 12 compliance + AgriEvent
                                                  + ParcelLease (lease term)
                                                  + Contract (delivery window)
                                                  + Planting (sow → harvest)
                                                  + AgroSignal (spray window)

Titles: English strings built in the    Titles: i18n keys + params,
        usecase                                 resolved by the renderer

Fan-out: Promise.all, no orderBy on     Fan-out: Promise.allSettled, every
         truncating loaders                      loader ordered + truncation-
                                                  honest, raised tx timeout
```

Farm work (`Task.type === 'FARM_TASK'`) was split into its own
`farm-task` category/vocabulary in a companion commit, and raw enum
values (`vendor · due_soon`) were replaced with translated category/status
labels — both land alongside the four new sources so the grid reads as a
farm schedule end to end, not a compliance calendar with crops bolted on.

## Decisions

**Four sources, not seven.** Thirteen agriculture models carry a
date column; four were chosen for having a clear "this belongs on a
schedule a farmer checks" shape — a land obligation (`ParcelLease`), a
commercial commitment (`Contract` delivery window), a crop cycle
(`Planting` sow→harvest), and a time-sensitive advisory
(`AgroSignal` spray window / disease risk). Three were deferred,
each for a different reason:
  - `Season` spans months, so on a month grid it would smear across
    every cell rather than marking a day — it needs its own
    presentation (a banner/range strip), not a point/duration event.
  - `CropPlan.firstSowDate` is largely redundant with
    `Planting.sowDate` — the plan's own first-sow date and its first
    planting's sow date say the same thing twice.
  - `InventoryLot.expiresAt` is regulatory-relevant (expired ag-chem
    stock), but a farm running many lots would swamp the grid before
    there is a per-category filter to hide it. Revisit once category
    filtering ships.

**The Timeline view stays removed.** PR 1 deleted it because it only
drew events with an `end`, and `AuditCycle` was the only source that
ever set one — it rendered empty for every farm. This PR adds three
more duration pairs (`ParcelLease`, `Contract`, `Planting`) that
*would* fill it now. Restoring a view removed one PR earlier, together
with its toggle and i18n keys, is churn spread across two PRs for a
view that isn't blocking anything today: the month grid is the
primary surface and now carries the same duration data via `end` on
`CalendarEvent`, and `GanttTimeline` itself was never deleted —
`PlantingBoard` still mounts it for crop successions. Restoring the
calendar's own Timeline toggle later, once there's a concrete reason
a farmer wants a Gantt-style read of leases/contracts/plantings
together, is cheap. The option is deliberately parked, not forgotten.

**Titles became i18n keys, resolved by the renderer.** Every event
title used to be an English string assembled in the usecase
(`` `Review evidence: ${title}` ``) — invisible to
`tests/guards/no-hardcoded-ui-strings.test.ts`, which scans only
`src/app` + `src/components`. `CalendarEvent` now carries
`titleKey` + `titleParams`; `CalendarMonth` / `GanttTimeline` call
`te(titleKey, titleParams)` to resolve them at render time. Two
wins: the ratchet can actually see calendar strings once they cross
into a component, and the aggregation response becomes
locale-independent — one cached payload serves both `en` and `bg`
sessions instead of baking a locale into the usecase result.
Curator-supplied free text (the `AgriEvent` catalogue's `title`) uses
a passthrough key literally named `raw` (`{ "raw": "{name}" }` in
both message files) rather than a name drawn from the agriculture
vocabulary — `PlantingBoard`'s succession-number labels
(`titleKey: 'raw', titleParams: { name: '#3' }`) needed the exact
same non-translatable escape hatch, so the key is shared rather than
duplicated under two names.

**`AgriEvent` remains the only loader with no tenant predicate.**
Carried over from PR 1: the model has no `tenantId` column — it's a
global, platform-curated catalogue written only through the
`PLATFORM_ADMIN_API_KEY` admin route. The four new agriculture
sources are all real tenant data and filter by `tenantId` like every
other loader; the aggregation test's cross-tenant isolation check
excludes only `AgriEvent`, with the same written reason as before.

**Leases, contracts, and plantings link to the nearest existing
page, not a fabricated one.** None of the three has a standalone
per-entity detail page. `ParcelLease` and `Contract` hrefs point at
their register pages (`/rent`, `/grain/contracts`); `Planting` has no
per-succession page either, so its href points at the parent crop
plan's detail page, where `PlantingBoard` renders that succession as
a row. All three follow the same shape `loadAgriEventEvents`
established in PR 1 for a URL-less catalogue entry: link to the best
real destination rather than invent one or emit a broken link.

**The transaction timeout was raised, not split.** See
`CALENDAR_TX_TIMEOUT_MS` in `compliance-calendar.ts` — growing the
fan-out from 12 to 17 loaders inside one `runInTenantContext`
interactive transaction (one PgBouncer connection, Prisma's 5s/2s
default `timeout`/`maxWait`) left no headroom for a slow loader
before the whole transaction — and therefore the whole calendar —
gets killed. Four of the pre-existing loaders (`Evidence.nextReviewDate`,
`AuditCycle.periodStartAt`/`periodEndAt`, `Risk.nextReviewAt`/`targetDate`,
`Finding.dueDate`) had no index behind their date predicate at all,
so they were the likeliest source of a slow statement; a migration
adds `[tenantId, <date>]` indexes for all five columns (two apiece
for `AuditCycle` and `Risk`, since their loaders `OR` two independent
columns — a single composite would only serve the leading one).
Splitting the fan-out into 17 separate transactions was considered
and rejected: each `runInTenantContext` call opens its own PgBouncer
connection, so 17 separate calls trade one connection held a few
seconds longer for up to 17 held *concurrently* per calendar page
load — worse for a shared pool under real traffic — and it would
also lose the single consistent read snapshot the sources currently
share. Raising `timeout`/`maxWait` to 15s/10s (scaled down from the
60s/10s precedent in `audit-readiness/packs.ts` and
`framework/install.ts`, which cover heavier multi-step writes) keeps
RLS semantics, `assertCanRead`, and per-query `tenantId` filtering
completely unchanged — it is a ceiling raise, not a structural
change, and the new indexes are what should keep the fan-out well
under either number in practice.

## Files

| File | Role |
|---|---|
| `usecases/compliance-calendar.ts` | Four new loaders (`loadParcelLeaseEvents`, `loadContractEvents`, `loadPlantingEvents`, `loadAgroSignalEvents`); `Promise.all` → `allSettled`; `orderBy` + truncation on every loader; raised transaction timeout |
| `schemas/calendar.schemas.ts` | New event types/categories for the four sources; `titleKey`/`titleParams` on `CalendarEvent` |
| `components/ui/CalendarMonth.tsx`, `GanttTimeline.tsx` | Resolve `titleKey`/`titleParams` via `te(...)` instead of rendering a pre-built string |
| `prisma/schema/compliance.prisma` | `Evidence.nextReviewDate`, `Risk.nextReviewAt`/`targetDate`, `Finding.dueDate` indexes |
| `prisma/schema/audit.prisma` | `AuditCycle.periodStartAt`/`periodEndAt` indexes |
| `prisma/migrations/20260806090000_calendar_agri_source_date_indexes/` | The five hand-authored `CREATE INDEX IF NOT EXISTS` statements above |
| `messages/en.json`, `messages/bg.json` | New event title/category/status keys, incl. the shared `raw` passthrough key |
| `tests/guardrails/schema-index-coverage.test.ts` | Registers `AgroSignal`'s first `findMany` (its existing `[tenantId, signalDate]` index already covers it — no new index needed there) |

# 2026-08-05 — Calendar consolidation

**Commit range:** `ac726b08..HEAD` (PR 1 of a 3-part calendar roadmap)

## Design

The calendar was inherited from a GRC product and still looked like one:
three views, twelve compliance sources, zero agriculture. This PR makes it a
single month view, merges the agriculture catalogue into it, retires the
separate `/events` page, and fixes two production defects found on the way.

```
BEFORE                                  AFTER

/calendar  ─ Month ─┐                   /calendar ─ Month grid
           ─ Heatmap┤ toggle                       + AgriEvents on their dates
           ─ Gantt ─┘                              + create button
/events    ─ AgriEvent card feed        /events    (gone)
```

## Decisions

**The two removed views were not carrying their weight.** The timeline could
only draw events with an `end`, and `AuditCycle` was the only source that set
one — so it rendered empty for every farm. The heatmap showed activity density
for a workload nobody was tracking. Both also forced a wider query range than a
month needs. `GanttTimeline` itself survives; `PlantingBoard` mounts it for crop
successions, where duration data actually exists.

**Fork (b), not the recommended (a).** The brief offered a ~30-line side-panel
section or a full merge into the grid, and recommended the former first. We took
the latter, because the stated product goal was that events added to the
catalogue appear *in* the calendar — a side panel leaves that unmet, and the
migration cost arrives a week later anyway with a panel to unpick. It is also
the substrate the AI-derived news events (PR 3) will write into.

**`next/link` was the real cost of (b), as predicted.** Every prior source was a
tenant fact with a tenant-relative href, so both render sites used `next/link`
directly. An `AgriEvent` links to an organiser's own site, and `next/link`
cannot navigate to an absolute URL. Rather than branch at both call sites, the
choice moved into one `CalendarEventLink`. `rel="noopener noreferrer"` is kept
and documented as non-negotiable — an e2e asserts it, and without `noopener` the
opened page can reach back through `window.opener`.

**Two pieces of `/events` reasoning were carried over rather than reinvented.**
The category map is an exhaustive `Record<AgriEventCategory, …>`, so a new
curated category is a compile error rather than a silently mis-toned dot — this
is what once caught a subsidy deadline rendering as "Fair". And catalogue
entries are never `overdue`: they are announcements, not obligations the tenant
is measured against, so they go `scheduled → done`.

**The prefetch fix is structural.** `page.tsx` built `now ± 180d` carrying
time-of-day while the client built a midnight-aligned month window, then
compared them as ISO strings — so `initialMatches` was never true and every load
ran the full aggregation server-side, serialised it into the RSC payload,
discarded it and refetched. Both sides now derive the range from one shared
`range.ts` helper. Making two independent calculations agree today would have
left them free to drift again; having one removes the class. The prefetch also
shrank from 360 days to ~45.

**Two HIGH defects were pulled forward from PR 2**, because they are wrong in
production now rather than gaps in a feature. Six of twelve loaders and four of
five badge counters omitted `deletedAt: null` — there is no global soft-delete
extension, so a deleted farm task showed on the calendar and inflated the nav
badge permanently, and the deadline job emailed people about findings they had
deleted. Separately, the three deadline scans had neither `take` nor `orderBy`,
and the scheduled run passes no tenantId, so each was a whole-table read across
every tenant at 07:00 UTC.

**`AgriEvent` is the one loader with no tenant predicate, deliberately.** The
model has no `tenantId` column — it is a global, platform-curated catalogue. The
loader documents this, and the aggregation test's cross-tenant check excludes it
with a written reason so the exclusion reads as a decision rather than a gap.

## Files

| File | Role |
|---|---|
| `calendar/range.ts` | New. The single month-range calculation, shared by server and client |
| `calendar/CalendarClient.tsx` | One view; create button; skeleton; shared range |
| `calendar/page.tsx` | Prefetches the range the client actually renders |
| `components/ui/CalendarEventLink.tsx` | New. Internal vs external click-through in one place |
| `components/ui/CalendarMonth.tsx` | Uses the link component |
| `components/ui/CalendarHeatmap.tsx` | Deleted |
| `usecases/compliance-calendar.ts` | Agri loader; soft-delete filters |
| `jobs/calendar-deadlines.ts` | Bounded + ordered scans; findings soft-delete filter |
| `schemas/calendar.schemas.ts` | `agri-event` category, four types, `AGRI_EVENT`, `external` |
| `lib/design/status-tone.ts` | Info tone for the catalogue |
| `layout.tsx`, `SidebarNav.tsx`, `use-palette-commands.ts`, `tenant-context-provider.tsx` | `/events` retirement |
| `e2e/mobile/agri-catalogue-calendar.spec.ts` | Renamed from `events.spec.ts`, retargeted |

## Known follow-ups

- `hasUpcomingAgriEvents` and `listUpcomingAgriEvents` now have no production
  caller — the former's entire purpose (hiding a nav link to a possibly-empty
  page) no longer exists. Both are still exercised by their own unit tests,
  which is the "unreachable code pinned by a test" shape worth removing. Left
  for a separate decision rather than deleted under a feature PR.
- The timeline view may deserve restoring **after** PR 2 lands the duration
  sources (planting, season, lease, contract) that would actually fill it.

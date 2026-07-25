# 2026-07-25 — Farm tasks: full task UI (surface the existing backend)

## Design

`/farm-tasks` was create + list only. Every capability below already had a
working backend on the shared IC Task module (`usecases/task.ts` + the
`/api/t/<slug>/tasks/[taskId]/*` and `tasks/bulk/*` routes); this change
SURFACES them without forking or re-implementing any of it.

- **Single task detail — `/farm-tasks/[taskId]`.** New route
  (`page.tsx` server wrapper → `FarmTaskDetailClient.tsx`) built on
  `EntityDetailLayout`, adapted from the proven compliance task-detail page.
  It reuses the shared endpoints verbatim: `GET /tasks/[id]` (detail),
  `POST …/status` (complete, with a resolution note on terminal states),
  `POST …/assign` (reassign), `PATCH …/[id]` (edit),
  `DELETE …/[id]` (delete — Epic-67 undo-toast), `GET|POST …/comments`,
  `GET|POST …/evidence` + `DELETE …/evidence/[id]`,
  `GET|POST …/links` + `DELETE …/links/[id]` (traceability), `GET …/activity`.
  It is farm-first (leads with the LiteFarm catalog type, hides
  severity/control/audit fields unless the row carries them) yet type-agnostic,
  so it renders any `Task` — the detail is the app's single task destination
  (see the retirement note).
- **Queue rows are clickable** → the detail. The old
  `FarmTasksClient.tsx:329` "no detail route" comment is gone.
- **Complete for all roles.** An inline "Mark done" affordance on the queue
  (one-click, default resolution) and the detail (prompts for a resolution
  note) is shown to the assignee **and** OWNER/ADMIN/EDITOR (`canWrite`).
  `setTaskStatus` already authorises assignee self-serve (`task.ts:320-323`);
  the current user id is threaded from the server page (no client
  `SessionProvider` read). Previously completion existed only on the
  operator-locked `/my-work`, so a manager had no completion path.
- **Filter / search / KPIs.** `EntityListPage` now receives a `filters` prop
  (`farm-tasks/filter-defs.ts`: status · assignee · due) + a KPI strip
  (total / open / overdue / due-this-week). Filtering is client-side over the
  bounded queue (mirrors the Journal page; `no-client-side-filtering` scans a
  curated list that farm-tasks is deliberately not on).
- **Manager scope.** For the assignee filter to be meaningful — and for
  `/farm-tasks` to replace the compliance list — the page now loads the
  tenant-wide queue via a thin `?scope=all` extension of `listMyFarmTasks`
  (reuses `listTasks` without an assignee filter; still gated by task READ
  permission). Operators stay on `/my-work` (`?open=1`, unchanged).
- **Bulk.** Selection + bulk assign / status / due / delete via
  `tasks/bulk/*` (delete through the shared `useBulkDelete`).
- **FAB honesty (fork 6).** "Start Field Operation" only ever navigated to a
  field's parcel map. Relabelled to **"Open field map"** (the honest minimal
  fix) rather than building a net-new FIELD_OPERATION creation flow — the FAB
  is navigation, not a hidden create.
- **Operator vocabulary (fork 7).** `taskEnums` priority `P0..P3` →
  Urgent / High / Normal / Low, status `TRIAGED` → Planned, `RESOLVED` → Done
  (en + bg). Enum VALUES unchanged; only labels. Applied in the shared
  `taskEnums` namespace since its remaining consumers (farm-tasks, my-work,
  linked-tasks panel, calendar) are all operator/field surfaces.

## Files

| File | Role |
|---|---|
| `farm-tasks/[taskId]/page.tsx` | server wrapper — resolves slug + caller id |
| `farm-tasks/[taskId]/FarmTaskDetailClient.tsx` | the universal task detail (reuses all shared task routes) |
| `farm-tasks/FarmTasksClient.tsx` | queue → filters/KPIs/bulk/mark-done/clickable rows/relabelled FAB |
| `farm-tasks/filter-defs.ts` | status/assignee/due filter config |
| `farm-tasks/page.tsx` | passes `currentUserId` to the client |
| `app-layer/usecases/farm-task.ts` | `scope` option on `listMyFarmTasks` |
| `api/t/[tenantSlug]/farm-tasks/route.ts` | `?scope=all` query param |
| `messages/{en,bg}.json` | vocabulary relabel + new farm strings |

## Decisions

- **Adapt the proven detail, don't reimplement.** The farm detail is a
  faithful adaptation of the 1160-line compliance detail (same mutation
  handlers, same shared primitives) so the 8 capabilities are correct by
  construction. It reuses the `tasks.detail` i18n namespace for generic
  strings (kept in `messages/`) and adds a small `farmTasks.detail` namespace.
- **Mark-done targets RESOLVED**, matching `/my-work`'s existing completion
  semantic, and is only offered from statuses that can legally reach RESOLVED
  (`OPEN/TRIAGED/IN_PROGRESS/PENDING_REVIEW`) — BLOCKED must be unblocked first
  per `WORK_ITEM_TRANSITIONS`.
- **Client-side filtering** is correct here: the queue is a bounded (200) merged
  FARM_TASK + FIELD_OPERATION union re-sorted by due date, so a server cursor
  isn't well-defined without a repository redesign; the flat GET stays
  ETag/304-guarded.
- **Create gates on `canWrite`** now that the page is the management view
  (operators reach the field map / my-work, not this page).

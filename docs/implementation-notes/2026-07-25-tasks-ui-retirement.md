# 2026-07-25 — Retire the /tasks compliance product UI

## Meta-answer + fork decision (recorded per the prompt)

- **Is the compliance / GRC surface (controls, issues, evidence, risk) staying?**
  **No — GRC is also being retired**, but NOT in this change (that is a separate,
  larger effort). So the GRC pages still exist here; their inbound task
  deep-links are therefore **repointed, not orphaned**, so nothing 404s in the
  interim.
- **Central fork — the shared `/tasks/[taskId]` detail:** **Fork B.**
  `/farm-tasks/[taskId]` (built in the companion note) is now the SINGLE task
  detail; `/tasks/[taskId]` is deleted and all inbound deep-links repoint to
  the farm detail. Compliance tasks (control-remediation, issue-linked,
  evidence) now render inside the farm-styled detail — accepted, since the farm
  detail is type-agnostic and GRC is going away anyway.

## What changed

**Deleted (UI only — grep-proven /tasks-UI-only):**
`tasks/{page,TasksClient,TaskDetailSheet,filter-defs,loading,dashboard/page,
new/page,[taskId]/page,[taskId]/_modals/EditTaskModal}` and the dead bare
`src/app/api/tasks/route.ts` (non-tenant; only a test imported it).

**Relocated (shared, imported by the KEPT calendar + LinkedTasksPanel):**
`tasks/NewTaskModal.tsx`, `tasks/_form/useNewTaskForm.ts`,
`tasks/_form/NewTaskFields.tsx` → `src/components/tasks/…`. Importers updated:
`calendar/CalendarClient.tsx`, `components/LinkedTasksPanel.tsx`. Its default
post-create destination is now `/farm-tasks/[taskId]`.

**KEPT (shared backend — untouched):** `usecases/task.ts`,
`TaskRepository`/`WorkItemRepository`, the Task/TaskLink/WorkItem models,
`farm-task.ts`, `control/tasks.ts` + the controls tasks route, the
assignment/notification pipeline, and ALL `/tasks/[taskId]/*` + `tasks/bulk/*`
API routes (farm-tasks + my-work + LinkedTasksPanel consume them).

**Repointed inbound links (→ /farm-tasks or /farm-tasks/[id]):**
- 3 list links: `notifications/templates.ts` (assignment email),
  `next-best-action-logic.ts` (`?filter=overdue`), `issues/page.tsx` redirect.
- 10 detail deep-links (the prompt named 8; two notification builders,
  `notifications/assignment.ts` + `task-due.ts`, also emit `/tasks/${id}` and
  were easy to miss): global search, compliance-calendar, field-operation
  approval, evidence sheet, risk-appetite, issues `[issueId]` redirect,
  LinkedTasksPanel (title + row-click), + the two notification linkPaths.
- The `/issues/{dashboard,new}` redirect shims (pointed into the deleted
  subtree) now redirect to `/farm-tasks`.
- Nav metadata: `nav/canonical-parents.ts` + `nav/page-segregation.ts`
  (`/tasks/[taskId]` → `/farm-tasks/[taskId]`; dashboard/new ids dropped).

## Decisions

- **Fork B over Fork A** because GRC is retiring: keeping a second detail
  namespace alive for a surface that is going away is churn, and the farm
  detail already renders any `Task`. The cost — compliance tasks wear farm
  chrome — is temporary and acceptable.
- **The backend is the contract, the UI is disposable.** Nothing under
  `usecases/`, the repositories, the models, or the `/api/t/<slug>/tasks/**`
  routes changed. This was a pure UI retirement + link repoint; the shared
  Task engine that issues, planning field-tasks, control tasks, control-test
  scheduling, Epic-67 traceability, calendar, and notifications depend on is
  byte-for-byte unchanged.
- **~40 test baselines** that hardcoded `tasks/*` UI paths (path-coverage
  ratchets, import-path guards, e2e navigations) were repointed/removed in the
  same diff; the `issues.spec.ts` e2e (which drove the retired compliance task
  workflow end-to-end) was deleted rather than adapted.

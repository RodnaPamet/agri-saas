# 2026-07-29 — CANCELED is terminal but not completed (`Task.completedAt`)

**Commit:** `<pending>` fix(tasks): stop counting cancelled work as completed

Resolves the first of the two inconsistencies that
`docs/implementation-notes/2026-07-29-coverage-wave-21.md` pinned rather
than fixed (a coverage PR is the wrong place to change behaviour), and
re-decides the second one against the note's original reading.

## The defect

`WorkItemRepository.setStatus` gated the `completedAt` stamp on
`isTerminalStatus`, and `TERMINAL_WORK_ITEM_STATUSES` includes
`CANCELED`. So cancelling a task stamped a completion timestamp.

Two readers consume that timestamp with **no status predicate of their
own** — they trust the write-side invariant completely:

| Reader | Query |
|---|---|
| `WorkItemRepository.farmTaskTrendRows` | `OR: [{createdAt: {gte}}, {completedAt: {gte}}]` → dashboard "created vs completed" trendline |
| `WorkItemRepository.metrics` | `count({ completedAt: { gte: ago30d } })` → `trend.resolved30d` |

Net effect: **a cancelled task was counted as resolved work on the
dashboard.** A farmer who cancels a spray job because it rained saw the
job move into the "completed" series.

What hid it: the two linked-task counters in the *same file*
(`countLinkedToControls`, `countLinkedToEntities`) partition on `status`
and got it right, so the file was self-inconsistent rather than
uniformly wrong — and the `farmTaskTrendRows` docblock asserted the
*correct* invariant while the code two hundred lines below violated it.

## Which side is correct, and why

The **write side** was wrong. `completedAt` should not be stamped for
`CANCELED`. Evidence, in the order it was weighed:

- **Nothing depends on a cancelled task having a `completedAt`.** The
  column has exactly two writers (`setStatus`, `bulkSetStatus`) and is
  read in five places. No retention sweep, archival job, export, or
  cursor ordering touches it. `Task.retentionUntil` exists but is never
  queried. The БАБХ ДНЕВНИК regulatory generator
  (`reports/pdf/farm-record-diary.ts`) filters and orders on
  `completedAt` — but that is **`OperationParcel.completedAt`**, a
  different column with a different writer, and is unaffected.
- **The only ordering read is already immune.** `achievements.ts` does
  `orderBy: { completedAt: 'asc' }` but pre-filters `status: 'RESOLVED'`.
- **Three of four in-file consumers already assume the fix.** Both
  linked-task counters exclude CANCELED with a written rationale ("a
  CANCELED task is terminal but not completed work"), and the
  `farmTaskTrendRows` docblock states the invariant outright.
- **The UI already reads it as completion.**
  `FarmTaskDetailClient.tsx` renders the field as a **green**
  (`text-content-success`) "Completed At" / "Завършена на". A cancelled
  job displayed a green completion timestamp.
- **The counter-hypothesis fails on cost and on naming.** If
  `completedAt` were a generic "reached a terminal state at" column, the
  fix would instead be a status predicate on *both* trend queries — and
  the UI label, the `resolved30d` field name, the column name, and three
  existing docblocks would all still be wrong. One write-side fix makes
  every one of them true.

Crucially the fix is **not** to narrow `isTerminalStatus`. That
predicate is correct for what it does — dropping items out of active
views and overdue checks, and requiring a closing `resolution`. CANCELED
genuinely *is* terminal. The bug was conflating two different questions
under one predicate.

## Design

Split the concept in `app-layer/domain/work-item-status.ts`:

```
TERMINAL_WORK_ITEM_STATUSES  = RESOLVED | CLOSED | CANCELED
    → "has it stopped moving?"  → active views, overdue, resolution-required
COMPLETED_WORK_ITEM_STATUSES = RESOLVED | CLOSED             (strict subset)
    → "did the work get done?"  → completedAt, every "done" tally
```

`isCompletedStatus()` joins `isTerminalStatus()`. The gap between them
is exactly `['CANCELED']`, and a test asserts that literally, so a
future edit that re-merges them fails rather than silently restoring
this bug.

Both repository writers now apply the same two-predicate rule:

```ts
completedAt: isCompletedStatus(status) ? new Date() : null   // did it get done?
if (isTerminalStatus(status) && resolution !== undefined)    // does it owe a why?
    updateData.resolution = resolution;
```

Keeping `resolution` on the *terminal* predicate is deliberate: Audit
Coherence S8 requires a non-empty resolution on every terminal write,
including a cancellation, and the auditor needs the cancellation reason.

The four inline `['RESOLVED', 'CLOSED']` literals in the repository now
route through the shared constant — the definition of "done" lives in
one place, which is what the domain module's own header asks for.

## Files

| File | Role |
|---|---|
| `src/app-layer/domain/work-item-status.ts` | Adds `COMPLETED_WORK_ITEM_STATUSES` / `isCompletedStatus` / `CompletedWorkItemStatus`; documents terminal ≠ completed |
| `src/app-layer/repositories/WorkItemRepository.ts` | `setStatus` + `bulkSetStatus` split the predicate; inline `['RESOLVED','CLOSED']` literals replaced; stale docblock corrected |
| `src/app-layer/automation/action-executor.ts` | `UPDATE_STATUS` on a Task now maintains `completedAt` (third writer, same rule) |
| `tests/unit/repositories/work-item-repository.test.ts` | Characterization tests re-pointed at the corrected behaviour |
| `tests/unit/usecases/work-item-state-machine.test.ts` | Containment invariant for the new predicate |
| `tests/unit/automation-action-executor.test.ts` | Covers the Task branch of `UPDATE_STATUS`, which had no mock and no test |

## Decisions

- **`bulkSetStatus` now clears `completedAt` on a non-completed target,
  reversing wave 21's call.** That note judged the asymmetry
  "defensible — adding `completedAt: null` to the bulk non-terminal
  branch would wipe the real timestamps of rows already terminal in the
  selection". The premise does not hold: both callers
  (`bulkSetTaskStatus`, issue `bulkSetStatus`) run the S8
  all-or-nothing transition gate *before* the repository call, and
  `CLOSED` / `CANCELED` have empty out-sets in `WORK_ITEM_TRANSITIONS`.
  The only terminal row that can legally reach a non-completed target
  is `RESOLVED → IN_PROGRESS` — a genuine re-open, where clearing is
  precisely correct. There is also no performance argument: the column
  rides the same single `updateMany`, adding zero reads. Leaving it
  would have reproduced, on the bulk path only, the exact bug the
  sibling `setStatus` test names — and a task's completion timestamp
  would have depended on whether it was re-opened individually or from
  the list page's checkbox column.

- **A third writer was found and fixed.** The `UPDATE_STATUS` automation
  action writes `Task.status` via its own `updateMany`, bypassing the
  repository, and never touched `completedAt`. Its allowlist permits
  both terminal and active targets, so a rule-driven close produced
  completed work with no timestamp (undercount) and a rule-driven
  re-open left a stale timestamp on a visibly-open task (overcount).
  This is scope the brief did not name, and it was included anyway
  because the two trend queries carry **no status predicate** — the
  invariant is only worth documenting if every writer honours it. The
  Task branch of that switch previously had no `task.updateMany` mock
  at all, so it was structurally untestable; only the `Risk` branch was
  covered.

- **No backfill.** Rows cancelled before this change keep their bogus
  `completedAt`. A backfill would need `AND status = 'CANCELED'`, which
  is safe, but the affected window is a rolling 30 days for
  `resolved30d` and 14–60 days for the trendline, so the wrong numbers
  age out on their own. Writing a migration to correct a dashboard
  number that self-heals inside two months is not worth the migration's
  own risk. If a tenant reports a specific discrepancy, the one-line
  `UPDATE "Task" SET "completedAt" = NULL WHERE status = 'CANCELED'` is
  the remedy.

- **`Task.completedAt` is unindexed.** Both trend reads are range scans
  over it (`TreatmentMilestone` has `@@index([tenantId, completedAt])`;
  `Task` does not). Out of scope here — this PR changes which rows carry
  the value, not how they are read — but it is the next thing to look at
  if the dashboard gets slow on a large tenant.

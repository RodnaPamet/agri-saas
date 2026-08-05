# 2026-08-05 — Evidence visibility and truthfulness

**Commit:** `feat(evidence): make derived evidence visible, distinguishable, and true`

Six defects in auto-evidence and the readiness it feeds. They divide cleanly
into two halves: things the database knew and no surface showed, and claims the
product made that the code did not keep.

## Design

### What the database knew and nobody could see

`evidenceListSelect` did not select `content`, `category`, or
`sourceLogEntryId`. Three consequences, none of which look like a missing
`select`:

- Auto-evidence stores a deep link back to the journal entry in `content`. The
  link was written on every attach and returned by nothing, so the traceability
  it existed for was unreachable from the evidence table.
- The list-row edit affordance seeds its description from `ev.content`. On a
  list row that is always `undefined`, so opening Edit from the table always
  showed an empty description regardless of what the row held.
- `category = 'AUTO_FARM_RECORD'` distinguishes a derived row from one a person
  filed. Not being selected, every auto-collected farm record rendered as a
  generic "Link" — indistinguishable from a URL someone pasted by hand, which
  is the exact difference that decides whether a row still needs review.

The href is now built from `sourceLogEntryId`, not from the stored `content`
string. A row written under a previous tenant slug still resolves, and the link
cannot drift from the record it points at.

### The English baked into the database

`attachAutoEvidenceFromLogEntry` persisted its titles as
`` `Farm record — ${logEntry.title}` ``. Written server-side, into a column, in
English. next-intl cannot reach a value that is already in the database, so a
Bulgarian operator saw an English marker on every auto-collected row and no
amount of render-time translation could fix it.

Titles are now stored as the journal entry's own, and the "farm record" marker
is rendered from `category` in the reader's locale. Migration
`20260805140000_strip_auto_evidence_title_prefix` strips the legacy prefix from
rows this job wrote (`category = 'AUTO_FARM_RECORD' AND sourceLogEntryId IS NOT
NULL`), so a title a person happened to begin with those words is untouched —
a hand-filed row has no `sourceLogEntryId`.

### The promise in the schema comment

`Evidence.sourceLogEntryId` carries a comment naming the *"which farm records
back this scheme"* query, and `@@index([tenantId, sourceLogEntryId])` was added
to serve it. Neither had a caller: the index was maintained on every evidence
write and read by nothing.

`listFarmRecordsBackingFramework` implements it. The forward direction answers
"this spray record proves these control points". This is the other one, and the
other one is the question an auditor actually asks out loud: *show me the field
records behind this certification*. Four bulk queries down the graph
(framework → requirements → the tenant's mapping → derived evidence → the
entries), never per row. Each record carries the status of the evidence linking
it, because "backed by a record nobody has reviewed" and "backed by an approved
record" are different answers and collapsing them is how a traceability panel
starts overstating a certification. Exposed at
`GET …/frameworks/{key}?action=farm-records`.

### The claim readiness did not keep

`auto-evidence.ts` states its safety argument in its own header:

> STATUS = SUBMITTED, deliberately. […] Readiness scoring only counts APPROVED
> evidence, so nothing unreviewed silently inflates a scheme's readiness — a
> person still signs off.

`generateReadinessReport` counted `c.evidence.length > 0`. Every clause was
false. Filing a spray record minted SUBMITTED evidence, which removed the
control from `controlsMissingEvidence` **on creation**, which raised
`readinessScore` — the number the farm dashboard displays as the certification
score. The product reported a sign-off that had not happened, and the sharper
case is REJECTED: a reviewer explicitly refused the evidence and the control
still read as covered.

Coverage now requires an APPROVED row. `controlsMissingEvidence` entries gained
`awaitingReview`, because "nobody has filed anything" and "something is filed
and waiting on a reviewer" are the same number and two different jobs.

### The idempotency that was a race

The attach guarded itself with a read-then-write check: SELECT the controls
already carrying evidence for this entry, INSERT for the rest. That is TOCTOU,
and it runs inside a transaction opened by a journal write — a retry or a
concurrent field-operation save could have two callers each read "not attached"
and each insert. One control point apparently backed by two copies of the same
record, and a duplicate row a reviewer has to approve twice.

`@@unique([tenantId, sourceLogEntryId, controlId])` makes the database the
authority. NULLs do not collide in Postgres, so hand-filed evidence is
unaffected. The insert became a single `createMany({ skipDuplicates: true })`
for the whole batch, so a loser resolves its conflict inside the statement
rather than raising a 23505 that would abort the caller's transaction. The
migration collapses any pre-existing duplicates first, keeping the oldest of
each group — the one whose id the audit trail already references.

### Derived evidence that stopped being true

Both ways the source record can move left the claim behind. Editing the entry's
title left the evidence's copy, so the same record appeared under two names.
Soft-deleting the entry left the evidence entirely, so the control kept
reporting itself backed by a record the operator had just removed, deep-linking
to a page that now 404s.

`syncDerivedEvidenceTitle` and `setDerivedEvidenceWithdrawn` live beside the
attach, and `updateLogEntry` / `deleteLogEntry` / `restoreLogEntry` call them.
Withdrawal is a soft delete for the same reason the entry's is: restoring the
entry has to restore the claim with it.

### The cadence that never advanced

`ReviewCadence` (MONTHLY / QUARTERLY / SEMI_ANNUALLY / ANNUALLY),
`nextReviewDate`, the dashboard's overdue and due-soon tiles, and the
`EVIDENCE_DUE_SOON` / `EVIDENCE_OVERDUE` notification types all existed. The
two things that would have made any of it happen did not:

- Nothing swept for due reviews. `evidence-expiry-monitor` looked only at
  `retentionUntil` and `expiredAt`.
- Nothing advanced the date. Approving evidence — the one action that means "a
  person has looked at this" — left `nextReviewDate` where it was.

Together those made a cadence strictly worse than none: set one, and the date
passes, and the tile goes red permanently, so people stop reading the tile.

A third piece turned out to exist already. `evidence-stale-review-sweep.ts` was
written in 2026-05, is fully documented, flips APPROVED rows past their
`nextReviewDate` to NEEDS_REVIEW — and had **zero callers**. It was never
registered in the executor registry and never scheduled. Its own docblock
describes the exact failure it was left unable to prevent:

> evidence silently aged past its review date with `status = APPROVED`, and the
> audit readiness score continued to count it as fresh.

Revived rather than removed, because every part of this is user-visible and
settable, and most of it was already written. Registering the sweep (daily
04:30 UTC, after retention-sweep and before notification-dispatch, so the same
day's digest reports what it just flipped) is what makes `nextReviewDate` mean
anything. The monitor gained a separate `scanEvidenceDueForReview` so somebody
is told — retention asks "may we still keep this?", review asks "is this still
true?", different dates and different remedies — and `reviewEvidence` rolls the
date forward on APPROVED via `nextReviewDateAfter`.

The three parts close a loop: approval sets the next date, the sweep flips the
row when that date passes, and readiness (now requiring APPROVED) stops
counting it. None of the three worked alone.

The notification-dispatch query budget rose from 2 evidence reads to 3. That is
a deliberate raise recorded in the test's own comment, not drift: the review
axis previously had no scan at all.

The month arithmetic is the whole subject of `review-cadence.ts`. `setMonth`
alone overflows: 31 January + 1 month lands on 3 March, so a monthly cadence set
on the 31st walks itself to the 3rd within a year. `addMonths` clamps to the
target month's length instead. The interval is measured from the review, not
from the date that was missed — anchoring to the old date means a review
completed three months late immediately schedules the next one in the past, and
the row lands back on the overdue tile the moment it is signed off.

## Files

| File | Role |
|---|---|
| `src/app-layer/repositories/EvidenceRepository.ts` | list select gains `content`, `category`, `sourceLogEntryId` |
| `src/app/…/evidence/EvidenceClient.tsx` | title deep-links to the journal entry; farm-record rows get their own type cell |
| `src/lib/evidence/auto-evidence-constants.ts` | **new** — the category shared by writer and readers |
| `src/app-layer/usecases/auto-evidence.ts` | locale-neutral titles; race-safe batch insert; title-sync + withdraw/reinstate helpers |
| `src/app-layer/usecases/journal.ts` | update / delete / restore keep derived evidence in step |
| `src/app-layer/usecases/farm-record-traceability.ts` | **new** — the reverse query |
| `src/app/api/…/frameworks/[frameworkKey]/route.ts` | `?action=farm-records` |
| `src/app-layer/usecases/framework/coverage.ts` | readiness requires APPROVED; `awaitingReview` breakdown |
| `src/app-layer/jobs/evidence-expiry-monitor.ts` | `scanEvidenceDueForReview`; scans made sequential |
| `src/app-layer/jobs/executor-registry.ts`, `schedules.ts`, `types.ts` | register + schedule the stale-review sweep that had no callers |
| `src/lib/evidence/review-cadence.ts` | **new** — clamped month arithmetic |
| `src/app-layer/usecases/evidence.ts` | APPROVED advances `nextReviewDate` |
| `prisma/migrations/20260805140000_…` | strip the persisted English prefix |
| `prisma/migrations/20260805150000_…` | dedupe, then the `(tenantId, sourceLogEntryId, controlId)` unique |

## Decisions

- **Deep link from the FK, not from `content`.** The stored string embeds a
  tenant slug captured at write time. Deriving the href from
  `sourceLogEntryId` means the link cannot go stale independently of the row.
- **The marker is rendered, not stored.** Anything persisted server-side is
  outside next-intl's reach by construction. Storing `category` and translating
  at render is the only shape that can be bilingual.
- **Revive the review cadence rather than delete it.** Removal was the cheaper
  option and would have deleted a feature operators can see and set. The
  missing pieces were two small ones, not a subsystem.
- **Measure the next review from the review, not from the missed date.** Both
  are defensible; only one avoids scheduling the next review in the past the
  moment a late one is signed off.
- **A unique constraint, not a better read-then-write.** No amount of care in
  the SELECT closes a TOCTOU window. The database is the only thing in a
  position to arbitrate.
- **`awaitingReview` alongside the missing-evidence count.** Tightening the
  count to APPROVED makes more controls look uncovered, and without the
  breakdown an operator cannot tell which of them need a record collected
  versus a reviewer's five minutes.

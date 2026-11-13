# 2026-11-13 — the raw-position retention sweep

**Issue:** #3012. **Owner ruling it implements:** #2948 §2 (2026-11-09) —
raw positions kept 30 days, derived records kept indefinitely.

## Why it is not a nicety

The ruling's own reason: **this is employee location data.** A track shows
where a named driver was, minute by minute, because the task link names them.
The phone states the window to owners and admins in words — «маршрутите се
пазят 30 дни» — and `/track` already answers `retained: false` outside it.

Until this job, nothing deleted anything. The first half of the ruling was a
policy with no implementation, and the sentence shown to farmers was false.
Nothing failed, no screen looked wrong, and that is the shape of the problem:
a promise about deletion is invisible when unkept.

## Design

| | |
|---|---|
| schedule | 03:10 UTC nightly, **after** the derivation at 02:20 |
| window | `RAW_POSITION_RETENTION_DAYS`, imported — never restated |
| default | **dry run**; `MACHINE_POSITION_SWEEP=delete` arms it |
| armed in production | **yes, by owner decision 2026-11-13** — set after this merges |
| bound | 50,000 rows per run, oldest first |
| attempts | 1 |

## Decisions

- **The window is imported, not restated.** `isDayRetained` decides what
  `/track` serves and `sweepCutoff` decides what goes; the constant's docblock
  said so before this job existed — "The sweep does not exist yet; when it
  lands it imports this." If the two disagreed, the endpoint would either claim
  a day it had deleted (an empty track reading as "the machine sat idle") or
  disclaim a day it still holds. The test asserts the two are exact
  **complements** across ages 0–35 rather than trusting one arithmetic, with a
  control proving both states occur in that range.

- **Dry run by default, and the polarity is the opposite of the audit kill
  switch.** `AUDIT_FAIL_CLOSED_ENABLED` defaults to enforcing because an audit
  control must not be disarmed by a typo. This defaults to NOT deleting
  because a destructive control must not be armed by a deploy — and deploying
  this job is what schedules its first run, so a `delete` default would make
  merging the PR the authorisation for destroying production data. Exact
  string match, so `DELETE` and `true` are both dry runs.

- **The unconfigured state is LOUD.** A control that is off and silent is
  indistinguishable from one that is working (#1669), so every dry run logs at
  WARN with the backlog it would have removed and the env var that arms it.
  "0 deleted" armed and "0 deleted" unarmed are different facts.

- **`process.env` read per call, exempted in `no-fallbacks` with the reason.**
  Not for arming — that can wait for a restart — but for **disarming**:
  stopping a job that is deleting location data cannot wait for one, and the
  `env.ts` snapshot freezes at import.

- **A day with no derivation marker is deleted anyway, and counted.** Deleting
  a day the derivation never processed destroys that work permanently. Keeping
  it instead would break a 30-day promise made to a person who cannot choose,
  to protect a farm's convenience. #3012 proposed refusing; that is the
  safer-sounding option and it quietly converts a privacy commitment into "we
  keep it until the job catches up", which is not what anybody was told. The
  loss is surfaced as `daysWithoutMarker` rather than absorbed. **Owner
  ruling, 2026-11-13: delete anyway and report the loss**, chosen over holding
  such days and over holding them for a grace period past the window.

- **Oldest first, bounded.** A first armed run over a long backlog must make
  progress at the far end rather than nibbling wherever the planner looked,
  and `remaining` is reported as what is left for tomorrow — not a failure
  count, which is why `success` stays true.

- **The sweep runs AFTER the derivation**, fifty minutes later. That is not
  the guarantee — the guarantee is the 29-day margin the window leaves — but
  running it first would make that margin the only thing between a slow
  derivation and a permanent loss, for no reason.

## Verification

Ten executing tests, five mutations killed: arming by default, an off-by-one
that sweeps the boundary day, deleting newest-first, ignoring the batch bound,
and reporting zero unmarked days unconditionally.

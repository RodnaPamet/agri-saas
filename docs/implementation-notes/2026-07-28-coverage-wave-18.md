# 2026-07-28 — Coverage wave 18: the process-map repository

**Commit:** _(this PR)_

`ProcessMapRepository` at **94 uncovered branches / 30.9%**, taken to **79.41%
branches / 97.01% statements / 100% functions**. 28 tests.

## Files

| File | Role |
|---|---|
| `tests/unit/repositories/process-map-repository.test.ts` | new — 28 tests |

## Why this one is about ordering, not query shape

`replaceGraph` is destructive by construction: it deletes the map's entire node
and edge set and re-inserts. Three guards sit in front of the first
`deleteMany` — structural validation (every edge endpoint and `parentNodeKey`
must resolve inside the payload), the tenant + soft-delete lookup, and the
optimistic-concurrency version check.

Move any one of them *after* the delete and the behaviour still looks correct
from outside: the save is refused, the caller gets an error. But the graph is
already gone. A rejected request would silently empty the user's canvas.

So each guard test asserts the throw **and** that no `deleteMany` / `createMany`
ever fired. The structural check in particular cannot be delegated to the
database — `nodeKey` is per-map, not globally unique, so there is no FK to
enforce it. This code is the only guard.

Delete ordering is likewise load-bearing rather than stylistic: edges must go
before nodes or the FK rejects the batch. That is asserted via
`invocationCallOrder`, not by inspecting arguments.

## The in-memory soft-delete guard

`listMapsByControl` does **not** filter deleted maps in the query. The SQL
returns them and a plain `.filter(r => r.edge.processMap.deletedAt === null)`
drops them afterwards. So that invariant lives in application memory, invisible
to any test that only inspects the emitted `where` — which is what the rest of
this suite does. It needs a row fed *through* the method and asserted absent,
and it has one. Drop that line and deleted process maps reappear in the control
detail panel.

## Decisions

- **Four mutations, each caught by the intended test**: disabling the edge
  source-key check, removing the optimistic-concurrency comparison, deleting
  the in-memory deleted-map filter, and dropping `deletedAt: null` from
  `softDelete`'s where-clause.
- **Lines 445–449 left uncovered** — a narrow arm of the post-commit version
  reconciliation, reachable only when a concurrent write lands between the
  up-front check and the conditional `updateMany`. Constructing that race
  against a recording double would assert the mock's scheduling, not the
  repository's behaviour.
- **Two rounds of fixes to the test double, both mine.** The first run failed
  eight happy-path tests: the double lacked a `processMapSnapshot` model, the
  `edge()` fixture omitted `controls` (mapped unguarded when building the
  snapshot payload), and the `findFirst` stub was too thin for the
  `getByIdWithGraph` that closes `replaceGraph`. The second failure was an
  assertion against `processEdge.createMany` when edges are in fact inserted
  one at a time via `processEdge.create` — each edge's generated id is needed
  to attach its controls in the follow-up `processEdgeControl.createMany`.
  Worth recording: in both cases the *guard* tests passed and only the
  fixtures broke, which is the right way round, but both were assertions
  written from inference rather than from reading the call site.

## Sweep caveat, unchanged

`tests/guards` + `tests/guardrails` reports 619/619, but `rls-coverage` is
still self-skipping (`DB_AVAILABLE ? describe : describe.skip`) because host
port 5434 belongs to another checkout's test database. Green here means
"everything else passed"; it is not evidence about RLS. See the wave 17 note.

# 2026-08-17 — BullMQ real-API smoke test

**Commit:** `<pending> test(jobs): execute BullMQ for real, not through a mock`

## Problem

PR #576 bumped `bullmq` 5.81.2 → 6.1.1 — a major — and CI reported **19 of 19
checks green**. The pass carried no information about whether the queue still
worked, because nothing in the repo executes BullMQ:

| surface | what it does |
|---|---|
| `tests/integration/bullmq-queue.test.ts` | opens with `jest.mock('bullmq', …)` |
| `tests/integration/bullmq-scheduler.test.ts` | opens with `jest.mock('bullmq', …)` |
| `tests/integration/redis-connection.test.ts` | maps `ioredis` → `ioredis-mock` |
| `scripts/worker.ts` | the only `new Worker(...)` — **outside `tsconfig.json`** |
| `scripts/scheduler.ts` | the only scheduler registration — **outside `tsconfig.json`** |

The three tests are good tests of *our wiring* and never touch the library. The
two files that actually construct a `Worker` and register schedulers are not
even type-checked. So a rewritten constructor, a renamed scheduler verb, or a
changed `getJobSchedulers()` return shape would all pass CI and surface as a
worker that will not start behind a perfectly healthy web tier — the web app
serves traffic, background jobs silently stop.

The CI job also had no Redis service at all. Only the E2E job did.

This is the third variant of the failure mode CLAUDE.md already names under
"Green is not the same as executed": guards that assert on source text, suites
that skip themselves, and branches unreachable under jsdom. This one is
"the dependency is mocked, so the test cannot see the dependency change".

## Design

`tests/integration/bullmq-real-api.test.ts` — **no mocks**, real Redis, scoped
to the API surface the three real call sites use, in the call *shapes* they use:

```
new Queue(name, { connection, defaultJobOptions:{attempts,backoff,removeOnComplete,removeOnFail} })
new Worker(name, fn, { connection, concurrency, limiter })
queue.add(name, data)                → worker processes it, payload asserted
queue.upsertJobScheduler(name, { pattern, tz, limit }, { name, data })
queue.getJobSchedulers()             → .name / .pattern / .next
queue.removeJobScheduler(name)
close() on both
```

It is a tripwire for the contract we depend on, not a test of BullMQ's
semantics — upstream owns those.

Three properties make it hard to render vacuous:

- **It asserts the module is real.** `expect(jest.isMockFunction(Queue)).toBe(false)`.
  Adding `jest.mock('bullmq')` to this file would turn every assertion into a
  tautology, so that is checked directly.
- **A skip is visible.** An always-running test prints a banner naming what did
  not run, modelled on `tests/guardrails/rls-coverage.test.ts`. A skipped suite
  and a passing suite are otherwise indistinguishable in a CI summary.
- **A skip in CI is a failure.** `BULLMQ_SMOKE_REQUIRE_REDIS=1` is set on the
  `test` job, which now declares a `redis:7-alpine` service. Where Redis is
  *guaranteed*, absence means the service broke — not that the environment
  lacks one.

`typeof found.next === 'number'` is a deliberate assertion, not incidental:
`scripts/scheduler.ts` does `new Date(s.next)`.

## Files

| file | role |
|---|---|
| `tests/integration/bullmq-real-api.test.ts` | the smoke test |
| `.github/workflows/ci.yml` | `redis:7-alpine` service + `REDIS_URL` / `BULLMQ_SMOKE_REQUIRE_REDIS` on the `test` job |
| `CLAUDE.md` | records the mocked-dependency variant of the green-but-unexecuted rule |

## Decisions

- **Connections are quit explicitly.** BullMQ does not own a connection handed
  to it — `Queue.close()` / `Worker.close()` leave an externally-supplied
  ioredis client open. The first run produced *"A worker process has failed to
  exit gracefully"*. This repo has already paid for that once: a leaked handle
  killed a jest **worker process** while the tests themselves passed, showing a
  flaky shard with no failure summary (the `@/lib/storage` specifier incident).
  Every client is tracked and quit in `afterAll`.

- **CI sets `REDIS_URL_TEST`, never `REDIS_URL`** — and this one was learned the
  expensive way. The first version set `REDIS_URL` job-wide, which looks like the
  obvious choice. But `getRedisClient()` in `src/lib/redis.ts` returns `null`
  when `REDIS_URL` is unset, and the whole suite leans on that
  graceful-degradation path. Setting it flipped every Redis-aware code path in
  every suite to opening real connections: **shard runtime went from ~500 s to
  the 35-minute job timeout**, and shards 3 and 4 were cancelled. That surfaces
  as a red check with *no failing test*, which is a genuinely confusing signal
  to hand someone. The variable is now read by this one test file and nothing
  else in the repo.

  The general shape is worth naming: **adding an env var to a CI job is a
  global change to every test in it.** A var that switches production code
  between a real backend and an in-memory fallback will silently re-route the
  entire suite.

- **Queue names are unique per process + jest worker.** A crashed previous run
  cannot poison the next one, and two concurrent runs never share queue state.

- **The `coverage` job deliberately does NOT get Redis.** The test exercises the
  library, not `src/`, so it adds no runtime coverage. There it skips with the
  banner, which is honest and free.

- **Scope is the call sites, not the library.** Growing this into a broad BullMQ
  conformance suite would make it a maintenance burden that rots. The rule is
  narrow and stated in the file: when you add a BullMQ verb to `queue.ts`,
  `worker.ts` or `scheduler.ts`, add it here.

- **`scripts/` is still outside `tsconfig.json`.** This test covers the runtime
  contract but not the type contract of those two files. Bringing `scripts/`
  under type-checking is a separate change with its own blast radius, and is
  left tracked rather than smuggled in here.

## Verification

Both directions were proved rather than assumed:

- Redis up → 4 passed, no leaked handles under `--detectOpenHandles`.
- Redis down, no escalation → passes, banner printed naming what did not run.
- Redis down + `BULLMQ_SMOKE_REQUIRE_REDIS=1` → **fails** with the reason.
- `tsc --noEmit` clean; 483 guard suites + all three bullmq/redis suites pass.

The bump itself (6.1.1) was verified against real Redis by hand before #576
merged; this file is that check made repeatable.

# 2026-09-17 — the worker container healthcheck

**Commit:** `ce2f36b4c feat(ops): prove the worker is CONSUMING, not merely running`

## Design

`deploy/docker-compose.vm.yml` gave four of five services a `healthcheck:`.
The worker had none, so `docker inspect` reported `health=none` next to
`healthy` for app, db, pgbouncer and redis — and a worker that had stopped
consuming kept its container `running` with the web tier green.

The failure modes that produce that state are all *inside* a live process:
a blocked event loop, a Redis connection that dropped without the client
noticing, every concurrency slot held by a hung handler. A process-existence
probe reports all three as healthy, which is why #809 ruled one out
explicitly.

So the probe reads a heartbeat that only a working consumer can write:

```
  schedules.ts  --(health-check, */2)-->  Redis  --> worker pulls a job
                                                         |
                                            runs it, emits 'completed'
                                                         |
                                         beat() SET agrent:worker:heartbeat EX 480
                                                         |
  compose healthcheck --> dist/worker-healthcheck.mjs --> GET the key
                                            fresh -> exit 0 | missing -> exit 1
```

Reaching `beat()` means the worker pulled a job off the queue, executed it,
and came back — Redis reachable, event loop responsive, a slot free, the
executor registry loadable. None of that is inferred; it is what having
emitted `completed` *is*.

**The beat hangs off a BullMQ event, not a `setInterval`.** A timer keeps
firing through a severed Redis connection, so a timer-driven heartbeat
reports a wedged worker as healthy — the precise gap this issue is about,
reintroduced one layer down.

**An idle worker still has to beat**, and that is the second half. Events
need jobs. `health-check` is now a 2-minute repeatable; the executor had
existed in `executor-registry.ts` since the queue was built and *nothing had
ever dispatched it*. It also means a green healthcheck proves the
SCHEDULER's repeatables are still registered, since `scheduler.mjs` runs
before `worker.mjs` in the same command.

**The probe only READS.** A probe that enqueued its own job would add load
proportional to its interval, and would keep passing while the worker's own
consumption was dead — testing Redis rather than the worker.

## Files

| file | role |
|---|---|
| `src/app-layer/jobs/worker-heartbeat.ts` | the key, the TTL, and `beat()` — swallows its own errors so a Redis blip never fails a job that already succeeded |
| `scripts/worker.ts` | `worker.on('completed')` → `beat()`, for both workers |
| `src/app-layer/jobs/schedules.ts` | `health-check` at `*/2 * * * *`, first in `ALL_SCHEDULES` |
| `scripts/worker-healthcheck.ts` | the probe: reads the key, exits 0/1 |
| `scripts/build-worker.mjs` | third esbuild entrypoint → `dist/worker-healthcheck.mjs` |
| `deploy/docker-compose.vm.yml` | the `healthcheck:` block on `worker` |
| `tests/guards/worker-heartbeat-wiring.test.ts` | pins all four links |

## Decisions

- **TTL 8 minutes against a 2-minute cron — four missed beats, not one.**
  Equal values would expire the key between beats and flap a healthy
  container. A healthcheck that reports failure on a healthy system trains
  people to ignore it, which is worse than not having one. The margin is
  asserted, not just chosen: the guard parses the cron out of
  `schedules.ts` and requires `ttl >= cron * 3`.

- **`start_period: 300s`.** Nothing beats until the scheduler has registered
  the repeatable and the first job has run, so a shorter grace window would
  mark every fresh deploy unhealthy for a reason that is not a fault.

- **A missing `REDIS_URL` exits 1, not 0.** Reporting healthy because the
  probe could not run is the same silent pass the whole issue is about.

- **Verified against a real Redis before it was believed.** Five states on a
  throwaway instance: no key → 1, fresh → 0, expired → 1, Redis unreachable
  → 1, `REDIS_URL` unset → 1. The unreachable case first read as exit 0 and
  was nearly recorded as a defect — the measurement was piping through
  `head`, so it was reading `head`'s exit code, not node's.

- **The guard's own first version failed at baseline**, asserting the probe
  contains no `enqueue` and matching the word in the probe's DOCBLOCK, which
  explains why it does not enqueue. It strips comments now. The reason this
  is worth recording: a red baseline makes every mutation delta unreadable —
  the first "remove the beat" mutation reported the same failure count as the
  baseline, so it proved nothing and had to be re-run.

- **Ordering: the image must carry the probe BEFORE the compose runs it.**
  Verified on the running container — `dist/worker-healthcheck.mjs` does not
  exist in the deployed image. Applying the compose change first marks the
  worker unhealthy for a missing file, which has nothing to do with the
  worker's state. Merge → GHCR publishes → Watchtower pulls → then
  `deploy/apply.sh`.

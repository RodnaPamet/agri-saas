# 2026-10-02 — a tenant transaction needs only ONE pool connection

**Commit:** see the PR for `fix(db): resolve the tenant DEK before the transaction opens`

Fixes the DEK half of #1223. The audit half is measured here and left open.

## The invariant

A transaction holding one of the pool's `max` connections and then asking for a
SECOND one cannot make progress once every slot is held in that state: nobody
can acquire, so nobody can release. `pg` is given no `connectionTimeoutMillis`
(deliberately — `pool-config.ts` explains why), so the wait is unbounded and
what the caller sees is Prisma's 5s interactive-transaction timeout (`P2028`) or
its 2s `maxWait`. Neither error names a connection pool, which is why this
reads as a Prisma bug.

## Design

```
BEFORE                                  AFTER
runInTenantContext(ctx, cb)             runInTenantContext(ctx, cb)
  $transaction(tx => {                    prewarmTenantKeys(ctx.tenantId)  ← NEW, no tx open
     SET LOCAL ROLE app_user                $transaction(tx => {
     set_config(app.tenant_id)                 SET LOCAL ROLE app_user
     cb(tx)                                    set_config(app.tenant_id)
       └ tx.task.findFirst()                   cb(tx)
           └ extension                           └ tx.task.findFirst()
               └ getTenantDek()                      └ extension
                   └ GLOBAL prisma  ← slot 13            └ getTenantDek()
  })                                                         └ cache HIT
                                          })
```

`withEncryptionExtension`'s `resolveTenantDekPair` awaits `getTenantDek(tenantId)`
on every model read and write, and `tenant-key-manager` reads the `Tenant` row
through the GLOBAL prisma client — never through the `tx` the caller holds. The
value is cached per tenant per process, so the cost is one extra connection per
COLD tenant: a fresh container, or a sweep touching many tenants at once.

Pre-resolving costs the same one-or-two queries it always cost; the only thing
that changes is that they run with no transaction open, so they need the pool's
FIRST connection rather than its second. On a warm cache both calls are `Map`
lookups, so the steady-state request pays nothing.

The alternative shape the issue offered — teach the extension to read the
`Tenant` row on the transaction's own client — needs the extension to know it is
inside a transaction, which the Prisma 7 query-extension API does not tell it.

## Measurement

Local test database, `PG_POOL_MAX = 12`, one `withTenantDb` per task, model read
(`tx.task.findFirst`), cold DEK cache, tenants created WITH a wrapped DEK so the
lazy-init write path is not what is being measured.

| sweep | before | after |
|---|---|---|
| cold burst at `max`, unsynchronised | **9/12 stall** | 0/12 |
| cold sweep at `max`, barrier-synchronised | **12/12 stall** | 0/12 |
| warm at `max`, barrier-synchronised | 0/12 (6/12 as collateral of the run above) | 0/12 |
| explicit second connection at `max` (positive control) | 12/12 stall | **12/12 stall** |

The unsynchronised burst is load-dependent — some DEK lookups finish before all
twelve transactions are open — which is why the suite also carries the
barrier-synchronised form. The barrier releases only once all `max` callbacks
have run their `set_config`, so every slot is provably held by a transaction
that has not yet touched a model.

## What is NOT fixed: `appendAuditEntry`, and it fails silently

Measured 2026-10-02, every DEK warm (so the DEK path is out of the picture),
disjoint tenant sets per run, barrier-synchronised, `tx.task.create`:

| n | tasks written | audit rows | rejections |
|---|---|---|---|
| 1 | 1 | 1 | 0 |
| 11 (`max - 1`) | 11 | 11 | 0 |
| 12 (`max`) | 12 | **0** | **0** |
| 12 (`max`, repeat) | 12 | **4** | 0 |

`appendAuditEntry` opens its own `$transaction` on the global client for every
audited write and is not cached. At `max` its 2s `maxWait` expires inside the
caller's 5s budget, the audit extension's best-effort `catch` swallows the error
(it logs only under `NODE_ENV === 'development'`), and the caller's own write
then commits normally. So the caller is told it succeeded and the hash-chained
trail has no entry.

That is worse than the visible stall #1223 predicted, and it is why this PR does
not also "fix" it in passing: the obvious shape — queue the audit write with
`afterCommit` — **does not work**. That queue is addressed through
`AsyncLocalStorage`, and a Prisma query extension runs detached from the ALS
chain; that detachment is the documented reason `audit-context.ts` uses a
module-level stack rather than ALS in the first place. `afterCommit` called from
inside the extension finds no scope and fires the effect inline, changing
nothing. Writing the audit row on the caller's `tx` instead would work but
changes the documented "best-effort, never breaks the original write" contract
and holds `pg_advisory_xact_lock(hashtext(tenantId))` for the whole of the
caller's transaction. Both want their own measurement.

## A second defect found while measuring (filed separately)

The same sweep shows the audit trail MISATTRIBUTING rows across tenants: 11
concurrent writes to 11 DISTINCT tenants produced 11 audit rows all carrying ONE
tenant's id. `getAuditContext()` returns the TOP of a module-level stack
(`audit-context.ts:91`), so under concurrent requests the audit extension reads
whichever request pushed last. CLAUDE.md already warns about this stack — as the
reason `afterCommit` uses ALS instead — but the audit trail itself still reads
it. `resolveTenantDekPair` reads the same context, so the blast radius may
include encrypting a row under the wrong tenant's DEK. Not touched here.

## Files

| file | role |
|---|---|
| `src/lib/db-context.ts` | `prewarmTenantKeys` + one call in each of the two tenant helpers, before `$transaction` |
| `src/lib/db/pool-config.ts` | docblock correction — #1224 removed one route to the deadlock, not the class |
| `tests/integration/tenant-tx-single-connection.test.ts` | the property at `max` concurrency, cold, plus the positive control |
| `CLAUDE.md` | the pool section now separates the fixed half from the silent-loss half |

## Decisions

* **Pre-resolve rather than read on the transaction's client.** Three lines in
  the helpers against a change to how the extension discovers its client. The
  issue named both; this is the one that does not need new machinery.
* **`prewarmTenantKeys` never throws.** `resolveTenantDekPair` treats a failed
  lookup as "use the global KEK" and logs it, and must stay the authority on
  that. A propagating prewarm would make `withTenantDb` for a tenant row that
  does not exist start failing where it previously proceeded.
* **`previous` is attempted only if `primary` resolved**, mirroring the
  middleware, where a `getTenantDek` throw returns the empty pair and
  `getTenantPreviousDek` is never reached.
* **Skipped when the caller injects a client — and the second half of that
  reason is cost, not correctness.** `getTenantDek` is bound to the global
  singleton, so with an injected client the transaction and the DEK read sit in
  DIFFERENT pools and cannot deadlock each other; there is nothing to
  pre-resolve. It also stops `tests/unit/db-context-after-commit.test.ts`, which
  drives both helpers against a FAKE client, from dialling a database to no
  purpose. **Measured rather than assumed:** deleting the condition and running
  that suite against an unreachable database leaves it 5/5 GREEN, because the
  prewarm swallows the connection error by design. The first reason is why the
  condition is there; the second is a saving, and writing it up as a
  test-correctness guarantee would have been wrong.
* **`runInUserContext` is left alone.** It sets no `app.tenant_id` and its audit
  context carries no `tenantId`, so `resolveTenantDekPair` returns the empty
  pair and no second connection is ever wanted.
* **Executing tests, not a source guard.** A guard asserting the call sits
  before `$transaction` would pass for any rearrangement that reintroduces a
  second acquisition by another route, and would keep passing if Prisma changed
  which client an extension's queries run on.
* **The positive control is the load-bearing test.** Three green concurrency
  tests are also what a harness that never achieved concurrency produces, so one
  test takes a second connection BY HAND and asserts it still deadlocks. If that
  one ever goes green, the others have stopped measuring anything.
* **`awaitPoolReclaimed` in `beforeEach` is a measured precondition, not
  hygiene.** A test whose transactions time out leaves connections being
  reclaimed after Prisma has already rejected the caller, so the next test starts
  with a pool smaller than `max` and reports a partial stall count belonging to
  its predecessor — observed while taking the before-the-fix numbers, where the
  warm control came back `stalls: 6`. It runs on the fixture client, whose pool is
  separate, so it can ask even when the global pool is fully held.
* **Tenants are created WITH a wrapped DEK.** Without one, `getTenantDek` takes
  its lazy-init branch and WRITES, which is a different and more expensive path
  than the steady state under test.

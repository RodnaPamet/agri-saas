# 2026-10-01 — P0.8: notifications fire after the commit, and an explicit pg pool

**Commit:** see the PR for `<sha> fix(exchange): P0.8 — notify after the outermost commit`

Part of the social-network roadmap phase P0 (#1191).

## Design

Three pieces, one of which is a new seam.

```
runInTenantContext / withTenantDb
  └─ runWithAfterCommit(                 ← NEW: owns the queue, drains after COMMIT
       runWithAuditContext(
         prisma.$transaction(tx => {
            … usecase body …
            afterCommit('name', fn)      ← NEW: queue, never run inline
         })))
     then: drain the queue sequentially  ← outermost frame only
     on reject: discard the queue unrun
```

`afterCommit` addresses its queue through an `AsyncLocalStorage` store rather
than an argument, because a usecase cannot know whether it is the outermost
transaction — `runInTenantContext` *is* a `$transaction`, usecases call
usecases, and a helper that moved its own notify one level out would still be
inside somebody else's. The OUTERMOST frame owns the drain; a nested frame just
runs its body.

ALS and not the module-level stack in `audit-context.ts`: that file documents its
own reason (Prisma query extensions run in a detached context), and nothing here
runs inside an extension. A shared stack would be actively wrong — under
concurrent requests its top is whichever request pushed last, so effects would
drain against another request's transaction.

Prisma does not nest transactions, so an inner `$transaction` commits
independently while the outer one may still roll back. The collector resolves
that asymmetry conservatively: the inner frame's WRITES survive, its
ANNOUNCEMENTS do not. Skipping a notification is recoverable; sending one about
work that was undone is not.

## What was actually wrong in the Exchange

`sendExchangeMessageImpl` called `await notifyOtherParty(...)` **inside** its
`runInTenantContext`, under a comment that claimed the opposite ("Persist, THEN
notify"). `notifyOtherParty` opens `withTenantDb` for the RECIPIENT — it has to,
their memberships are RLS-forced — and that inner transaction is INDEPENDENT. So
the bell rows, the SSE publishes and the outbox rows all committed while the
sender's transaction was still open.

Measured, by restoring the old line and running
`tests/integration/exchange-notify-after-commit.test.ts`: a send that rolls back
at COMMIT leaves **2 Notification rows** where it must leave 0. The publish is
the unrecoverable half — a row can be reconciled, an SSE push cannot be
recalled.

## The pool measurement, and why the hardening test says 11 and not 20

The roadmap asked for "20 concurrent sends produce 0 P2028". **20 is not
reachable on this stack, and the reason is not the Exchange notify.** Swept
2026-10-01 against the local test database at `max = 12`, one `withTenantDb` per
task:

| transaction body | c=11 | c=12 | c=20 | c=40 |
|---|---|---|---|---|
| raw `SELECT 1` on the tx | ok | ok | ok | — |
| model read, COLD tenant | ok | **12 fail** | **20 fail** | — |
| model read, WARM tenant | ok | ok | ok | ok |
| model write, WARM tenant | ok | ok | **8 fail** | — |

Failures are P2028 after ~5.2s (Prisma's interactive-transaction timeout) or
"unable to start a transaction in the given time" (its 2s `maxWait`). A
`pg_stat_activity` sample 1.5s into the stall showed **12 backends, all `idle in
transaction`, last statement `SELECT set_config('app.tenant_id', $1, true)`** —
i.e. twelve transactions open and none of them able to run its next query.

The mechanism is one thing with two instances: **a transaction that holds one of
`max` connections and then needs a second cannot make progress once every slot
is held.** The two second-connection users are:

* `withEncryptionExtension`'s `resolveTenantDekPair`, awaited on EVERY model read
  and write, which reads the `Tenant` row through the GLOBAL client. Cached per
  tenant per process, so it costs the extra connection ONCE per tenant — which
  is why the cold row fails at exactly `max` and the warm row clears 40.
* `appendAuditEntry`, which opens its own `$transaction` on the global client for
  every audited write and is NOT cached. That is the write row's ceiling.

Neither is the Exchange notify and neither is fixed here (see Findings). The
hardening test therefore runs `PG_POOL_MAX - 1` sends, from DISTINCT sender
tenants (because `appendAuditEntry` takes
`pg_advisory_xact_lock(hashtext(tenantId))`, so same-tenant sends serialise their
audit appends inside transactions bounded at 5s — a flake, not a property), after
a warm-up read per tenant. What it proves is the part P0.8 owns: a send no longer
needs a connection for its notify while its own transaction is open. Before the
un-nesting a send needed three at once (its own, the audit's, the notify's).

## The pool `max`

`PG_POOL_MAX = floor((25 − 1) / 2) = 12`, derived in `src/lib/db/pool-config.ts`
from pgbouncer's `DEFAULT_POOL_SIZE: "25"`, two pooled containers (`app` +
`worker`), and one slot reserved for an operator session. It was previously
`pg`'s default of 10 — a ceiling nobody chose and no file recorded.
`connection_limit` in the URL would not have done it: with a driver adapter the
pool is `pg`'s and that parameter is read by nobody.

`connectionTimeoutMillis` is deliberately NOT set — `pg` waits indefinitely, so
exhaustion presents as a hang rather than an error. Capping the wait converts a
transient burst into 500s; that is a different change with its own measurement.

## Files

| file | role |
|---|---|
| `src/lib/db/after-commit.ts` | the collector: `afterCommit`, `runWithAfterCommit`, the drain, the rollback discard |
| `src/lib/db/pool-config.ts` | `PG_POOL_MAX` and the three constants it is derived from |
| `src/lib/db-context.ts` | both transaction helpers now own an after-commit scope, placed OUTSIDE `$transaction` |
| `src/lib/prisma.ts` | passes `max: PG_POOL_MAX` to `PrismaPg` |
| `src/app-layer/usecases/exchange-messaging.ts` | the notify is queued with `afterCommit` instead of awaited inline |
| `tests/unit/after-commit-collector.test.ts` | the collector's contract, no database |
| `tests/unit/db-context-after-commit.test.ts` | the WIRING, via an injected fake client |
| `tests/guards/pg-pool-size-fits-pgbouncer.test.ts` | re-derives `PG_POOL_MAX` from the compose file |
| `tests/integration/exchange-notify-after-commit.test.ts` | positive control, forced rollback at COMMIT, concurrency |

## Decisions

* **`afterCommit` runs the effect immediately when no transaction is open**
  rather than throwing. It is called from usecase code that may or may not have
  been entered through a transaction helper, and a helper that crashed on the
  non-transactional path would push callers back to calling the side effect
  inline — which is the defect. Either way `runEffect` never rejects.
* **The drain is sequential and awaited by the caller.** Ordering is observable
  (the bell row before the email that references it), and a `Promise.all` would
  open one pool client per effect — multiplying the cost this change removes.
  Awaiting it keeps the response latency what it was and lets a test assert
  without polling.
* **A failed effect is contained.** The transaction has committed; letting the
  error propagate would turn a delivered write into a 500 and skip every effect
  queued behind it.
* **Notification content and recipients are untouched.** `notifyOtherParty`
  still resolves the recipient tenant's OWNER/ADMIN members and fans out to
  several mailboxes, in the recipient's language, with the same per-day outbox
  dedupe.
* **The rollback test keys its trigger on `threadId`, not on the message body.**
  `ExchangeMessage.body` is stored ENCRYPTED (see Findings), so a trigger
  comparing plaintext never matches — the first version of the test sent its
  message and failed its own assertion, which is how the encryption was found.
* **Two ADMINs and no OWNER in the fixture.** The fan-out resolves
  `role: { in: ['OWNER','ADMIN'] }`, and `tenant_membership_last_owner_guard`
  makes an ACTIVE OWNER membership undeletable — which would leak fixture rows
  into the shared test database on every run.

## Findings this PR does NOT fix

Both were measured while building the hardening tests. Neither is in P0.8's
scope; both are filed.

1. **#1222 — the recipient of an Exchange message reads ciphertext, not the
   message.**
   `ExchangeMessage` is not in `ENCRYPTED_FIELDS`, but
   `encryption-middleware`'s `'*'` fan-out encrypts any field NAMED `body`
   (because `TaskComment: ['body']` is in the manifest) under the WRITER
   tenant's DEK. A thread has two parties with different DEKs, so the other side
   cannot decrypt. Measured: the same row read in the sender's context returns
   `"__p08_probe_body__"`, and in the recipient's context returns
   `"v2:arifZrA3GVhFxUEnFcEGuIe/..."`. The file's own docblock warns about
   exactly this fan-out class for `message`; `body` is the live instance.
2. **#1223 — a cold tenant's first in-transaction model operation needs two
   connections**, so a burst of first-requests at concurrency ≥ `max`
   deadlocks the pool. The fix shape is to resolve the DEK BEFORE opening the
   transaction (or on the transaction's own client); both touch the encryption
   key path and want their own test population.

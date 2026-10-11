# 2026-10-11 — P5.6b: erasure by pseudonymisation

**Commit:** `<pending>` P5.6b: delete my account, and say honestly what survives

## Design

```
POST /api/account/deletion          DELETE /api/account/deletion
  └─ requestAccountDeletion           └─ cancelAccountDeletion
       ├─ deletionRequestedAt = now        └─ deletionRequestedAt = null
       ├─ sessionVersion++                    (sessions NOT restored)
       └─ UserSession.revokedAt

account-erasure-sweep  (daily 04:15 UTC)
  └─ findAccountsDueForErasure()   WHERE deletionRequestedAt < now-30d
  │                                  AND pseudonymisedAt IS NULL
  └─ eraseAccount(userId)   ── ONE transaction ──┐
       ├─ per PERSONAL_DATA_REGISTRY entry:      │
       │    DELETE_ROW          → deleteMany     │
       │    PSEUDONYMISE_COLUMN → updateMany     │  ← random per-user pseudonym,
       │    (RETAIN → untouched)                 │     stored nowhere
       └─ User: email=tombstone, name=null,      │
                pseudonymisedAt=now              │
                                                 ┘ aborts whole on any error
```

## Decisions

- **The row survives.** Art 17(3)(b), owner ruling. `ContentReport` keeps
  pointing at it, so the DSA trail stays answerable — and erasure is therefore
  incomplete, which the notice states.

- **Two erasure actions, because NULL is unavailable.** Every erasable person
  column is `String` with no `?`. `DELETE_ROW` where the row has no meaning
  without the person; `PSEUDONYMISE_COLUMN` where it is also a farm's or a
  counterparty's record.

- **A random per-user pseudonym.** `ExchangeThread`'s
  `@@unique([listingId, inquirerUserId])` makes a shared sentinel collide. The
  mapping is stored nowhere, so those rows are anonymised.

- **Around the chains, never through them.** The exit criterion is that the
  chain still verifies afterwards, so the test runs the verifier — and writes an
  entry first, because an empty chain verifies trivially.

- **A blocked erasure rolls back whole and retries tomorrow.** No savepoints
  here, and a half-erased account is worse than a loudly repeated one.

- **Frozen, with explicit cancellation.** Sessions are revoked so the person
  must sign in again; signing in does not silently cancel, because a background
  refresh would undo a deliberate request.

## Three things measurement corrected

- **A DMMF probe said every erasable column was nullable.** It was reading
  `isRequired`, which Prisma 7 no longer emits — so the property was `undefined`
  for every field and the probe returned the same answer whatever it was asked.
  The schema text says `String`. A uniform answer across every input is the
  tell, and it changed the whole erasure design.

- **`emailHash: null` was dead code.** `pii-middleware` re-derives it from
  `email` on write, so the explicit null was overridden. The outcome I wanted —
  the original address freed — happens anyway, by a mechanism I had wrong. The
  test that caught it is the one asserting the hash was gone.

- **`PlatformChainVerdict` is `{ intact, entries, brokenAt }`**, not
  `{ valid, entriesChecked }`. Guessed, then read.

## And one self-inflicted false alarm

A backgrounded integration run reported **56 failed suites / 297 failed tests**.
All of it was mine: I ran a 733-suite guard sweep and `npm run lint`
concurrently, and both executions' `globalSetup` prepare the same test
database. 536 of the 610 failure lines were
`Can't reach database server at 127.0.0.1:5436` — there is no local pgbouncer at
all, so anything falling back to `DATABASE_URL` cannot connect. Re-run alone on
the identical tree: **178 suites / 1401 tests green, zero connection errors.**

My first instinct was that the diff had broken 56 suites, and I nearly started
bisecting a change that was fine. A failure count that large with uniform errors
is a signal about the observer.

## Not in here

- **Blocking mutations during the freeze.** The freeze's teeth today are the
  session revocation, so a frozen person is signed out and cannot post. If they
  sign in again they can, until they cancel or the sweep runs. Narrow, and it
  wants the `withApiErrorHandling` choke point the way slow mode did.
- **"No new messages received."** The owner's freeze description includes it;
  it needs the person-block predicate extended to a deletion-pending account,
  which is a change to the exchange messaging path rather than to this one.
- **The iOS half**, same release per #1598 — a delete button AND a recovery
  screen, since the grace period is recoverable.

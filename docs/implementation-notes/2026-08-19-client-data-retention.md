# 2026-08-19 — Bounding how long a phone keeps a farm

**Commit:** `<pending> feat(offline): bound client data retention without touching the outbox`

## What was unbounded

Epic B encrypts business content at rest **in the database**. That boundary
stops at the Postgres row — anything a client persists is outside the KEK/DEK
hierarchy entirely, in plaintext, on a device that gets lost, sold, or handed
to another worker.

Three stores had no bound at all:

| store | what it holds | exit before this |
|---|---|---|
| `agri.offline.fieldop.v1.<taskId>` | the whole `FieldOpView` — parcel names and geometry, prescription lines, doses, location | none. `clearFieldSnapshot` had **zero callers** |
| `agrent-swr:v*:*` | list responses | a 24h TTL that only fires when that namespace is **hydrated** |
| `agrent-v1-fielddata`, `agrent-v1-pages` | field-op and location API responses; every server-rendered tenant document | a `CACHE_VERSION` bump **plus activation** |

The field snapshots are the sharpest: one key per task, forever, across
sign-out and tenant switch, rewritten on every optimistic mark. The SWR TTL is
the subtlest: a bucket for a tenant the operator has stopped visiting is never
looked at, so it is never expired.

`DATA_CACHE` deserves a specific note — `getFieldOperation` does a `findFirst`
with no `select`, so `Task.description` and `Task.resolution`, which are Epic B
encrypted at rest, are cached here **decrypted**.

## The design decision that makes this safe

An earlier version of this work purged everything, the outbox included. Review
found three ways that goes wrong, and **all three are properties of touching
the outbox**, not of purging:

1. `useOfflineSync.flush()` ends in `refreshOutboxState()`, which rewrites the
   manifest from the live queue. Landing between a manifest clear and a queue
   clear leaves the manifest full and the queue empty — precisely the shape the
   loss detector reads as *"this phone deleted your work"*. A sticky, false,
   operator-acknowledgement-only banner.
2. `flushOutbox` snapshots its items, and `store.update()` is an upsert, so a
   flush in flight across a purge writes the departing operator's mutations
   back into the cleared store.
3. Queued work is the one thing on the device that exists nowhere else.
   Deleting it is unrecoverable by definition.

So the sweep is scoped to **caches only** — data that can be refetched. It
cannot lose work, cannot race the flush loop, and cannot trip the loss
detector, because it never writes to any store the outbox owns. `NEVER_SWEPT`
names them as a contract.

The single outbox read is READ-only and protective: a snapshot whose task still
has queued work is never evicted, because `/api` is network-only for
field-operations and that snapshot is the render source for a cold offline
reload of a job the operator is still marking. If the queue cannot be read at
all, **everything** is protected — failing closed costs disk, failing open
costs an operator their work-in-progress.

## Files

| file | role |
|---|---|
| `src/lib/offline/client-data-retention.ts` | NEW — `sweepClientStores({ maxAgeMs })` |
| `src/lib/offline/field-snapshot.ts` | `{t, data}` wrapper + back-compat read |
| `src/components/offline/ClientDataRetentionSweep.tsx` | NEW — runs it once per launch |
| `src/app/layout.tsx` | mounts it beside the other global side-effect components |
| `public/sw.js` | byte caps on `DATA_CACHE` / `PAGE_CACHE`; evictor generalised |
| `tests/unit/offline/client-data-retention.test.ts` | executing — 16 assertions |

## Decisions

- **Snapshots gained a timestamp, and legacy entries still read.** They were
  stored as the bare payload, so they could not be aged. The wrapper is
  detected by shape rather than a version marker, because the legacy form has
  no marker to read. A legacy entry is treated as **expired** on the first
  sweep: it predates this release by definition, and the panel rewrites on
  every mark, so an actively-worked job gets a fresh timestamp immediately.

- **Collect-then-delete, never delete-during-walk.** Removing a key inside an
  index walk over `localStorage` shifts every later key and silently skips
  half the store. There is a test for exactly that.

- **Byte caps in the service worker, ageing in the window.** A cap bounds size,
  not age — a capped cache still holds a farm indefinitely. Ageing is done from
  the window via `caches.delete`, deliberately kept OUT of `public/sw.js`,
  which is the hardest file here to roll back: install skips `skipWaiting`, so
  a broken worker sits on operators' phones until they consent to an update.
  The cap reuses `selectBasemapEvictions`, already proven in that file, and
  `evictBasemapOverBudget` survives as a named wrapper because the lockstep
  guardrail pins that symbol.

- **Once per launch, not on an interval.** The exposure being bounded is
  measured in days. A sweep firing while an operator works offline would be
  pure risk for no gain.

- **Purge-on-sign-out is NOT here, and is deliberately last.** Against the
  realistic exposure cases it covers only "device handed over after an explicit
  sign-out" — a lost or stolen phone is never signed out, and a shared device
  where the next operator simply signs in does not wait for it. Once this sweep
  exists, that purge is `sweepClientStores({ maxAgeMs: 0 })` wired to the three
  sign-out sites: one line of reuse, already scoped so it cannot eat the queue.
  The executing tests already cover the `maxAgeMs: 0` path, including that it
  still protects a snapshot with queued work.

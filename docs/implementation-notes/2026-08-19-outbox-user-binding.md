# 2026-08-19 — Queued work belongs to whoever queued it

**Commit:** `<pending> fix(offline): bind queued work to the operator who queued it`

## What was wrong

An outbox item carried no user identity — `id`, `url`, `method`, `label`,
`createdAt`, `attempts`, and optionally `ifMatch` / `conflict`. And
`fetchSender` replays with plain `fetch`, which sends whatever session cookie
is **current**, not the one that queued the item.

On a shared farm device that produces two outcomes:

**Same tenant, different operator.** A's queued journal entry is created and
hash-chain-audited as **B**. The audit trail is wrong, and nothing indicates it.

**Different tenant.** The URL carries A's slug, the Edge tenant gate answers
403, `flushOutbox` classifies a terminal 4xx as undeliverable and calls
`store.remove`. The work is **destroyed silently** — and invisibly to the loss
detector added by the outbox-durability work, because that detector only fires
on an *unexplained* disappearance, and this removal is deliberate: the manifest
is re-mirrored from the queue immediately after. The one mechanism built to
notice vanished field work cannot see this particular way of vanishing it.

## Design

`enqueue` / `enqueuePhoto` stamp `queuedByUserId` from a module-scoped current
user. `flushOutbox` takes the user it is draining as and **skips** items
belonging to someone else — never sends, never drops.

**Module scope, not React context.** The outbox is not a React thing: `enqueue`
runs from a hook, `flushOutbox` is a pure function in `sync.ts`, and
`public/sw.js` replays from IndexedDB with no React at all. One value set at
launch is readable from all three. It is set from the same server-resolved id
that already namespaces the SWR cache, during render rather than in an effect,
so an enqueue on the very first interaction is already attributed.

**Held work is surfaced.** `snapshot.foreign` and a line in the sync bar. Work
that is held but invisible is the same class of bug as work that is lost but
invisible — the operator has to be able to see that something is waiting for
someone else to sign in.

## Decisions

- **Skip, don't refuse the whole flush.** A mixed queue is the realistic case,
  and a coarse "refuse to drain while foreign items exist" would strand the
  current operator's own work behind someone else's.

- **Legacy items still flush.** Anything queued before this shipped has nothing
  to attribute it to. Holding those forever would be a silent regression that
  strands real work — the opposite of the point.

- **`ownerUserId = null` drains everything.** That is the service worker's
  case: it replays from IndexedDB with no session context, so passing null
  preserves exactly the prior behaviour rather than inventing a new one for a
  caller that cannot supply the argument.

- **The field is omitted, not set to `undefined`.** The service worker reads
  these records raw out of IndexedDB; a clean record shape matters more than a
  uniform one.

- **Attribution only.** `queuedByUserId` is never sent anywhere, is not a
  credential, and grants nothing. The server still authorises the replay by the
  session cookie exactly as before.

## Not in this PR

Purge-on-sign-out. It rides on `sweepClientStores` (client-data-retention),
which is not merged yet; once it is, the purge is one line at the three
sign-out sites. Note this change makes that purge *less* urgent for the
handover case, since another operator's queued work is now held rather than
misattributed or destroyed.

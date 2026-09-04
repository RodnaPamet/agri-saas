# 2026-09-04 — #744 has no fix, so the lever moved from detection to prevention

**Commit:** `<pending> fix(offline): carry the install remedy app-wide; pin the #744 read set`

## Design

#744 records that a **class-wide** storage sweep is invisible to the loss detector: the
queue lives in IndexedDB, the manifest and lost-record in localStorage, and reconciling one
against the other is what makes loss visible. A cap that clears script-writable storage as
a *class* takes both, and then neither detector fires.

The obvious response is a better detector. There isn't one, and the reason is narrow enough
to state exactly.

**Work is enqueued while OFFLINE.** That is why it is queued at all. So at the only moment a
durable signal could be written, the sole writable stores are localStorage, IndexedDB,
Cache Storage and `document.cookie` — the same script-writable class. The two signals that
*would* survive a sweep are an HttpOnly cookie and a server-side row, and both need a
network at the exact moment there is none.

Measured this session: `refreshOutboxState`'s complete cold-launch input surface is

```
localStorage : agri.offline.durability.v1
               agri.offline.lostwork.v1
               agri.offline.outbox.manifest.v1
IndexedDB    : store.all()  store.takeDelivered()  store.wasRecreated()
```

Six inputs, all inside the swept class.

**Not claimed:** that WebKit's cap is exhaustive over that class in every iOS version.
ITP's 7-day script-writable cap is documented; it has not been measured on a device here.
That measurement belongs to #648.

## Files

| file | role |
|---|---|
| `tests/unit/offline/outbox-eviction.test.ts` | one new `it` pinning the read set as an enumerable fact |
| `src/components/offline/UnsyncedWorkBanner.tsx` | the pending pill carries the install remedy |
| `messages/{en,bg}.json` | `offline.installToKeep` |
| `tests/rendered/offline-install-hint.test.tsx` | six cases for the pill's gate |
| `CLAUDE.md` | replaces "known, not fixed" with why it is not fixable |

## Decisions

- **The test pins the READ SET, not the absence.** Asserting `lost === null` after a
  class-wide wipe is vacuous — it is equally true of a brand-new phone that has never
  queued anything, which is the issue's own thesis. An adversarial pass proved this by
  writing the "paired" version, installing an always-firing detector, and watching it pass
  anyway: both legs were built from byte-identical inputs, so `toEqual` reduced to
  `f() === f()`. Enumerating the inputs is falsifiable where enumerating the output is not.

- **That test is designed to fail one day, and the failure is good news.** A new key or
  store method appearing in the read set means someone gave the detector another input. Its
  comment says so: check whether the new input survives a class-wide sweep; if it does,
  #744 became fixable. Mutation-proved — adding a fourth `getItem` reddens it.

- **The remedy moved to the app-wide pill.** `OfflineSyncBar` already carried the
  Add-to-Home-Screen hint, but it mounts on five surfaces: queue a journal entry, walk to
  the map, and the advice leaves the screen while the work stays queued. The lost-work
  banner is too late by construction — by the time it renders, the thing the install would
  have protected is gone. `UnsyncedWorkBanner` mounts once in `ClientProviders` and shows
  exactly while work is still savable, which is the only window in which installing changes
  the outcome.

- **Three independent gates, each mutation-proved separately:** work pending, verdict
  `persisted === false`, and un-installed iOS. `null` is deliberately not `false` — advising
  an install on a device whose verdict was never measured would be advice with no evidence
  behind it.

- **#744 stays OPEN.** This does not fix it; nothing can. It documents the impossibility at
  the decision point and moves the mitigation somewhere it is reachable. Closing it would
  erase a real, live defect from the tracker.

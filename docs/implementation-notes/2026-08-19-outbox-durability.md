# 2026-08-19 — Offline outbox durability

**Commit:** `<pending> fix(offline): make outbox loss visible, and stop losing it silently`

## MEASURED — 2026-08-23, mobile Safari on a physical iPhone

**`persist()` was REFUSED.** The device showed the offline bar's refusal line
(`offline-storage-unprotected`):

> Този телефон не се съгласи да пази неизпратената работа. Синхронизирайте
> веднага щом имате сигнал.

which renders on `pending > 0 && storagePersisted === false` — so the stored
verdict carried `persisted: false`. The instrument this note describes was used
exactly as intended: an operator queued one journal entry offline and read the
answer off the phone.

Ambiguity worth recording rather than glossing: that render condition cannot
separate `persist()` returning `false` from `navigator.storage` being absent
altogether, because both write `persisted: false`. On a current iPhone the
former is overwhelmingly likely, and operationally the two are the same fact —
unsent work is not protected.

**Home Screen (installed PWA) is STILL UNMEASURED.** iOS has historically given
an installed web app its own storage jar, so it can answer differently, and this
reading does not carry over.

### What the answer changes

Nothing in the code, which was the point of taking both STEP 2 branches. What it
changes is confidence:

- The behavioural mitigations — sticky loss record, three-state UI — are not
  belt-and-braces. On this device they are the **only** defence.
- Eviction is reachable, which is what the static-cache bound (#739/#742) was
  argued on. That bound is reducing real risk, not tidying.
- It exposes a blind spot the grant would have masked: see below.

### The blind spot this measurement makes reachable

The queue lives in **IndexedDB**; the manifest and lost-work record live in
**localStorage** (`writeJson` → `globalThis.localStorage`). The detector works by
reconciling one against the other, which is sound when eviction is *selective*.

iOS ITP's cap on script-writable storage for an unengaged origin is **not**
selective — it clears the class. If IndexedDB and localStorage go together while
the app is closed, neither detector fires:

- **in-session** (`wasRecreated`) needs `wasOpenedBefore` — true only if *this*
  session already opened the database. An eviction while closed never has that.
- **cross-session** (`reconcileManifest`) opens with
  `if (manifest.length === 0) return []` — no manifest, nothing to reconcile.

So the operator is told nothing, which is the precise failure this whole
mechanism exists to prevent. Tracked separately; not fixed here.

## STEP 1 has now been half-run — the note below predates it

The prompt asked for `navigator.storage.persisted()` / `persist()` / `estimate()`
read off a **physical iPhone**, in both mobile Safari and Home Screen mode,
before anything was built. **At the time of writing that measurement had not
been taken** — the Safari half landed on 2026-08-23 and is recorded above; the
Home Screen half is still outstanding. Every claim below about what iOS does is
either a claim about code in this repo or is labelled as an assumption, and is
left as written so the reasoning that shipped without evidence stays legible.

So the measurement was turned into a shipped instrument instead of a guess.
`requestPersistence()` calls the API, stores the verdict under
`agri.offline.durability.v1`, and the offline surfaces read it back. The first
operator to open the app on a real device answers STEP 1 by using it, and
support can read the answer off the phone:

```json
{"supported":true,"persisted":false,"requested":true,"quota":…,"usage":…,"at":"…"}
```

**Which STEP 2 branch was taken: both, deliberately.** The two branches differ
in exactly one thing — whether `persist()` is called. Every other mitigation in
the "IF IT DOES NOT" branch is correct under either answer, because a GRANT
lowers the probability of eviction without removing it: the user can still clear
website data, and a browser that granted persistence can still revoke it. An app
that goes quiet about the queue on the strength of a `true` would be trusting a
promise no browser actually makes. So the request ships **and** the behavioural
mitigations ship, and the note records that the branch was not chosen on
evidence because the evidence does not exist yet.

## What was actually wrong

Three defects, all found by reading the code rather than by inference.

**1. `persist()` was never called — anywhere.** Grep across `src/` and `tests/`
returned nothing. The outbox has always been in best-effort storage on every
platform.

**2. An evicted queue and a delivered queue rendered identically.** This is the
real bug. An evicted IndexedDB does not error: `indexedDB.open` cheerfully
rebuilds the database, the object store comes back empty, `all()` resolves `[]`,
`pending` becomes `0`, and `OfflineSyncBar` renders exactly what it renders
after a clean sync. There was **no state in the product** meaning "work was here
and is gone". An operator who lost a morning of marks saw the same screen as one
whose work had landed.

**3. There was no foreground flush, and on iOS nothing else covers it.** The
flush triggers were: mount, the `online` event, a manual "Sync now", and
Background Sync — which **iOS does not implement** (`use-offline-sync.ts` says so
in its own comment). iOS suspends a backgrounded PWA rather than unloading it, so
the canonical field pattern — queue work in a dead-signal field, pocket the
phone, drive back into coverage, take the phone out — fires no `online` event
(the transition happened while the page was frozen) and causes no remount. The
queue sat until the operator happened to navigate to one of the five surfaces
that mount the hook. Every hour it sat there was another hour of eviction
exposure, which makes this a *durability* bug and not just a latency one.

A fourth, smaller: the pending count was per-hook-instance, so it vanished on
navigation, and the "already flushing" lock was per-instance too — two mounted
surfaces could drain the same items concurrently.

## Design

```
                    ┌──────────────────────────────┐
  five surfaces ───▶│  useOfflineSync (thin)       │
  + ClientProviders └──────────────┬───────────────┘
                                   │ useSyncExternalStore
                    ┌──────────────▼───────────────┐
                    │  outbox-state.ts             │  ONE truth, module scope:
                    │   pending / lost / conflicts │  survives navigation
                    │   shared flush lock          │
                    └───┬──────────────────────┬───┘
                        │                      │
        ┌───────────────▼──────┐   ┌───────────▼─────────────┐
        │ idb-outbox.ts        │   │ durability.ts           │
        │  wasRecreated()      │   │  persist() + verdict    │
        │  ← in-session evict  │   │  manifest + loss record │
        └──────────────────────┘   └─────────────────────────┘
```

**Three states, where there used to be two.** `pending > 0` → *saved on this
phone, not on the server*. `pending === 0` → *everything is on the server*.
`lost !== null` → *work was queued and is gone*. The silent state is gone: the
bar now always makes a claim, and always one the app can support.

**Two loss detectors, because they see different things.**

- *In-session* (`IndexedDbOutboxStore.wasRecreated()`) — the database was
  destroyed while the app was open. Exact, and reported on every platform:
  `onupgradeneeded` firing on a session that has **already** opened the database
  means the database was genuinely absent, which no code path in this app can
  cause. A service-worker drain — the one other writer — removes records and
  leaves the database alone, so it can never trip this.
- *Cross-session* (`reconcileManifest`) — a `localStorage` manifest mirrors the
  queue, so an item removed on purpose leaves it in the same pass and only an
  unexplained disappearance is left behind at startup.

## Files

| file | role |
|---|---|
| `src/lib/offline/durability.ts` | NEW. `persist()` + the recorded verdict, the manifest, the lost-work record |
| `src/lib/offline/outbox-state.ts` | NEW. One app-wide snapshot, the shared flush lock, both loss detectors |
| `src/lib/offline/idb-outbox.ts` | in-session eviction signal; closes on `versionchange` |
| `src/lib/offline/outbox.ts` | optional `wasRecreated()` on the store interface |
| `src/lib/offline/use-offline-sync.ts` | delegates to the shared state; foreground flush; asks for persistence at first enqueue |
| `src/components/offline/OfflineSyncBar.tsx` | says WHERE the work is, in both directions |
| `src/components/offline/UnsyncedWorkBanner.tsx` | NEW. App-wide pending pill + sticky lost-work alert |
| `src/components/layout/ClientProviders.tsx` | mounts the banner for every tenant page |
| `tests/unit/offline/durability.test.ts` | executing — persistence verdicts, manifest, loss record |
| `tests/unit/offline/outbox-eviction.test.ts` | executing — the policy, incl. no-false-positive cases |
| `tests/e2e/mobile/offline-eviction.spec.ts` | executing — a REAL IndexedDB deleted under a live page |
| `tests/guardrails/offline-pwa-coverage.test.ts` | the concurrency guard now pins the stronger invariant |

## Decisions

- **`persist()` is asked for at the first enqueue, not on first paint.** Firefox
  shows a permission prompt; on first paint that is an unexplained
  interruption, and at the moment an operator has just saved field work with no
  signal "keep this on the device" is self-evidently the right answer. Chromium
  grants on an engagement heuristic, so asking before the user has done anything
  is also the case most likely to be *refused*. If `persisted()` already returns
  true, `persist()` is not called at all — re-prompting a user who has already
  agreed is a bug.

- **The cross-session detector stays SILENT where Background Sync exists.** "In
  the manifest but not in the queue" has two explanations — the service worker
  delivered it while the app was closed, or the phone evicted it — and the page
  cannot tell them apart, because the SW cannot write `localStorage` and leaves
  no receipt. It does not have to: Background Sync **does not exist on iOS**,
  the platform this investigation is about, so where the API is absent a gap is
  unambiguously loss. The honest cost: on Android, an eviction while the app is
  closed goes unreported by this path (the in-session detector still covers it
  while the app is open). That asymmetry is deliberate — a false "your work was
  deleted" on a platform that had in fact delivered it would teach operators to
  dismiss the real one, and then the feature is worse than nothing.

- **The lost-work record is never cleared by a successful sync.** Only an
  explicit acknowledgement removes it, and `durability.ts` says so at the call
  site. Clearing on success is precisely the "resurrect a partial queue as if
  complete" failure: the items in the record are not in that sync and never will
  be. It is additive across detections and de-duplicated by id, so a reload
  before acknowledgement neither inflates the count nor erases an earlier loss.

- **A store that cannot be read is not a store that is empty.** `refreshOutboxState`
  holds the previous snapshot when `all()` throws, rather than publishing a
  reassuring zero.

- **The pending indicator is app-wide, not another per-page strip.** "Not behind
  a menu" has to mean not behind a *route* either. Mounting the hook in
  `ClientProviders` also puts the foreground flush on every tenant page rather
  than only the five that render a sync bar — on iOS that is the difference
  between a queue that drains when the phone comes out of a pocket and one that
  waits for the operator to navigate somewhere specific.

- **The eviction test had to be an E2E.** The unit tests drive a fake store, so
  they prove the policy and nothing about the detector — which is entirely a
  claim about IndexedDB's own behaviour (that deleting a database under a live
  connection fires `versionchange`, that closing on it unblocks the delete, that
  the next open reports the store as newly created). A mocked IndexedDB cannot
  report that IndexedDB changed. The spec deletes the real database under a real
  page; the `blocked` assertion is what proves the `versionchange` handler
  actually closes the connection.

- **The queue-growth warning is advisory, not a cap.** Refusing to queue work in
  a field with no signal would destroy the thing the outbox exists to protect.

## Raised, not solved: the outbox holds plaintext on a phone that can be lost

The server encrypts business content at rest with per-tenant DEKs (Epic B). The
outbox holds that same content — journal bodies, task resolutions, and the photo
**bytes** — as plaintext IndexedDB records on a device that gets left in a field,
sold, or stolen. Two properties make it worse than it first looks:

- **Photos are the bulk of it.** A queued `PhotoOutboxItem` carries the actual
  image Blob, capped at 8 MB each, and a queue can hold many.
- **The work sits there longest exactly when it is least protected** — an
  operator out of signal for a day is the case with both the fullest queue and
  the highest chance of the phone being somewhere it should not be.

This PR makes the exposure *more* visible rather than less: the queue now
survives longer by design (persistence requested) and the operator is told it is
there. That is the right trade for data loss and it does not address
confidentiality at all.

It needs a decision, not a discovery. The shape of the options, briefly: encrypt
outbox records under a key held in the session (loses the offline cold-reload the
outbox exists for, since the key dies with the session); encrypt under a
device-held key in WebCrypto with `extractable: false` (protects against casual
file-system access, not against someone with the unlocked phone); or accept it
and rely on device-level encryption plus the OS passcode, which is what the
current design implicitly does without anyone having said so. **The last one may
well be the right answer** — but it should be chosen.

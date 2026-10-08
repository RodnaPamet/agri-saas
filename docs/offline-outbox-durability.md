# Offline outbox durability

**Read this before touching anything under `src/lib/offline/`, `public/sw.js`,
or any surface that enqueues field work.**

The outbox holds unsynced field work in IndexedDB, which the phone is free to
evict. Every rule below cost something to learn, and several were defects that
shipped and looked like success — a destroyed compliance write leaving the same
trace as a delivered one, a sticky "your work was deleted" banner for work that
was safely on the server, a photo replayed under whoever happened to be signed
in.

CLAUDE.md carries the RULES as imperatives. This document carries the reasoning,
the incident history and the mechanism detail — which is what you need before
changing any of it, and what you do not need loaded on every request.

The design note is
[`docs/implementation-notes/2026-08-19-outbox-durability.md`](implementation-notes/2026-08-19-outbox-durability.md).

---

The outbox holds unsynced field work in IndexedDB, which the phone is free
to evict. Three rules, all load-bearing — see
`docs/implementation-notes/2026-08-19-outbox-durability.md`.

**Not every write belongs here.** The insurance quote request (#1120) is
deliberately NOT an outbox surface: the calculator works offline, but SENDING
needs a connection and a failed send is not queued. A queued lead would email
the operator hours later carrying figures the farmer may have corrected since —
and an insurance enquiry priced against a stale area is worse than one the
farmer knows did not go. The wizard disables Send while offline and says so.

- **One queue truth: `src/lib/offline/outbox-state.ts`.** Module-scoped, so
  it survives client-side navigation, and it owns the counts, the loss
  record and the SHARED flush lock. `useOfflineSync` is a thin subscriber.
  Never reintroduce a per-instance `flushing` ref — five surfaces mount the
  hook, and a per-instance lock lets two of them drain the same items at
  once.
- **Never claim "synced" without evidence.** An evicted IndexedDB does not
  error: it rebuilds empty, `all()` resolves `[]`, and that is
  indistinguishable from a clean drain. So the UI carries three BASE states —
  `pending > 0` ("saved on this phone"), `pending === 0` ("everything is on
  the server"), and `lost !== null` ("work was queued and is gone"). The
  lost record is sticky and clears ONLY on an explicit operator
  acknowledgement; a successful later sync must never wipe it.
- **`pending` alone reassures falsely too, so `blocked` splits it.** Since
  #763 `OutboxSnapshot` also carries `blocked` and `blockedAuth`, and
  `blocked` is deliberately a strict SUBSET of `pending` rather than a
  sibling: `pending` is computed over `live`, which filters conflicts and
  foreign items and nothing else, so a stalled item was always counted
  INSIDE it. That is not a false zero — it is a TRUE number meaning two
  different things, "3 waiting" reading as "will go when I get signal" when
  for some of them it never will. The UI reads "N waiting, of which M cannot
  move" instead of two numbers an operator reconciles in their head in a
  field. `blockedAuth` is split out because only it has an action attached;
  the other kind resolves itself when the server recovers.
- **A poison item is PARKED, never deleted, and since #923 that includes a
  REFUSAL.** Past `MAX_ATTEMPTS` a transient failure writes
  `blocked: 'exhausted'` (`sync.ts`); a terminal 4xx about the payload writes
  `blocked: 'refused'` + `refusedStatus`. That arm used to call
  `noteDelivered()` then `store.remove()` — byte for byte the SUCCESS arm — so
  a destroyed compliance write and a delivered one left an identical trace,
  and the receipt is precisely what suppressed the loss detector for it. Only
  a `dropped` counter differed, and nothing in `src/` reads it. `flushOutbox`
  now has ONE removal (success); every other outcome parks. Two things ride
  with that: a park is written through `parkIfStillQueued`, because
  `store.update` is an upsert and the page and service worker drain the same
  queue, so an unguarded park RESURRECTS a row the other drain already
  delivered; and a refusal is surfaced by `UnsyncedWorkBanner` with a per-item
  discard, because parking an invisible row only trades a silent loss for a
  silent stall. A terminal 4xx is only honest as "not on the server" because
  `setTaskStatus` gained an already-applied arm in the same change — its
  commonest 400 was a replay whose write had ALREADY landed.

  The escape from a poison item is that it stops being RETRIED, not that the
  work is destroyed. Nothing in the codebase clears a `blocked` flag on its
  own, so every kind of park is permanent until something explicitly unblocks
  it — signing in again for `auth`, and for `refused` an operator tapping
  discard, the one path that removes it. That is a deliberate trade of a stuck
  row against a silently deleted one, and it is the same principle as the
  sticky lost record above. The cost is real and worth stating: a parked photo
  holds up to `MAX_QUEUED_PHOTO_BYTES` (8 MiB) of Blob until someone acts, so
  on a device without granted persistence a hoard of refusals raises the
  eviction risk for writes that are still deliverable.
- **`navigator.storage.persist()` is requested at the FIRST ENQUEUE**, not
  on first paint (Firefox prompts; Chromium grants on engagement). The
  verdict is recorded under `agri.offline.durability.v1`, and that CACHED
  verdict — never a fresh measurement — is how the answer gets read back off
  a real device. The instrument is `/t/<slug>/diagnostics/offline`
  (`src/app/t/[tenantSlug]/(app)/diagnostics/offline/page.tsx`, #760): a
  URL-addressable route, reachable from ONE affordance — the user menu's
  "Offline diagnostics" row, whose href `TopChrome` supplies and passes as
  `null` only on org chrome, where the route does not exist. It IS shown to
  the MECHANISATOR since #812: `isOperatorAllowedPath` allows
  `/diagnostics/offline` by EXACT match (not a `/diagnostics/` prefix — that
  namespace's future siblings inherit nothing from the decision), because the
  operator's phone is the one the page measures. Its breadcrumb root is
  persona-aware for the same reason — the dashboard is denied to them, and
  this page has no nav entry, so a bouncing trail would strand them. That
  route renders
  the stored verdict in EVERY state INCLUDING ABSENT — the pre-existing
  signals are negative-only (`OfflineSyncBar` renders only when `pending > 0
  && storagePersisted === false`), so on screen "granted", "never measured"
  and "nothing queued yet" were indistinguishable — alongside display mode,
  the four `public/sw.js` caches BY NAME, service-worker control state and
  the outbox snapshot, with a Copy-as-text button for pasting into an issue.
  It does NOT call `persist()` itself: measuring there would produce a
  second, different answer and muddy the one the app stored. Operator steps:
  `docs/runbooks/offline-device-probes.md`. **Measured on a
  physical iPhone (2026-08-23/24), and the two contexts DISAGREE: mobile
  Safari REFUSES (`persisted: false`), the installed Home Screen PWA GRANTS
  (`persisted: true`).** So installing the app is a real durability
  mitigation on iOS, not a packaging preference — in Safari the behavioural
  mitigations above are the ONLY defence and eviction is live; installed,
  the origin is one the UA has agreed to keep. `InstallPrompt` already
  carries the iOS Add-to-Home-Screen hint (Safari fires no
  `beforeinstallprompt`), so the path exists; whether it is prominent enough
  for a field operator is an open question. Note the request is armed once
  per PAGE LOAD (a module-scoped flag), so a reload re-measures; an app
  opened with work already queued and nothing new enqueued shows the CACHED
  verdict.
- **The detector assumes eviction is SELECTIVE, and iOS's is not.** The queue
  is in IndexedDB while the manifest and lost record are in localStorage, and
  reconciling one against the other is what makes loss visible. A cap that
  clears script-writable storage as a CLASS takes both, and then neither
  detector fires: `wasRecreated` needs a prior open in the same session, which
  an eviction-while-closed never has, and `reconcileManifest` returns `[]` the
  moment the manifest is empty. Reachable in SAFARI, where persistence is
  refused; the installed PWA's grant is what keeps it off the table there.
  See the durability note and #744 — known and UNFIXED, but not unfixable.
  This paragraph used to say work is only ever enqueued while OFFLINE, so no
  durable signal could ever be written. That is wrong: `submit` tries the
  network FIRST when online and enqueues after a COMPLETED server round-trip
  on a 409 (`use-offline-sync.ts:224`) or a transient 5xx/408/429 (`:238`),
  and `sync.ts:125-144` parks conflicted, auth-blocked, exhausted and
  foreign-owner items in IndexedDB for days while the device is online. Those
  are networked moments with a non-empty queue — write points for a
  server-side high-water marker, which is the signal that would separate a
  clean drain from a class-wide sweep.
  `refreshOutboxState`'s complete cold-launch read set is three localStorage
  keys (`agri.offline.durability.v1`, `.lostwork.v1`,
  `.outbox.manifest.v1`) plus three outbox-store methods (`all`,
  `takeDelivered`, `wasRecreated`) — all inside that class, and PINNED as an
  enumerable fact by `tests/unit/offline/outbox-eviction.test.ts`. The two
  signals that would survive (an HttpOnly cookie; a server row) both need a
  network at the exact moment there is none. So the lever is PREVENTION, not
  detection: `UnsyncedWorkBanner`'s pending pill carries the Add-to-Home-Screen
  remedy app-wide, because installing is the measured mitigation on iOS and the
  five-surface `OfflineSyncBar` loses the advice the moment the operator
  navigates. If that read-set test ever fails because a NEW input appeared,
  read it as news — check whether the new input survives a class-wide sweep.
- **A deliberate removal leaves a RECEIPT, and that is what tells a drain
  from an eviction.** The manifest alone cannot: an id the manifest lists but
  the queue no longer holds is either delivered or destroyed, and a removal
  looks identical either way. Re-mirroring the manifest in the same pass
  covers only removals the PAGE made and then refreshed; the SERVICE WORKER
  drains the same queue and cannot write localStorage, so its drains read as
  eviction on the next cross-session reconcile — a sticky, FALSE "your work
  was deleted" for work already on the server. So the removal in
  `flushOutbox` writes a receipt FIRST (`noteDelivered` from
  `src/lib/offline/delivery-receipts.ts`, then `store.remove`), into a SECOND
  IndexedDB object store beside the queue — `RECEIPT_STORE_NAME =
  'delivered'`, added at `OUTBOX_DB_VERSION = 2` in `idb-outbox.ts` and
  mirrored in `public/sw.js`, which writes its own on every worker drain.
  `refreshOutboxState` consumes them (`takeDeliveryReceipts` →
  `forgetManifestEntries`) BEFORE either detector runs; that is what let
  `noteOutboxDrainedElsewhere` drop its `!reconciled` early return. Receipts
  live in IndexedDB rather than localStorage for two reasons: the worker can
  reach them, and they share the QUEUE's fate — a class-wide eviction takes
  both, so a stale receipt can never excuse a genuine loss. They age out
  after `RECEIPT_TTL_MS` (7 days), and `noteDelivered` never throws: a
  missing receipt costs a false loss report, a receipt write that breaks the
  flush costs the delivery itself. **A removal path not immediately followed
  by a page-side refresh MUST write a receipt** — `resolveConflict` is the
  exception that proves the rule, removing and `refresh()`ing in the same
  call so it re-mirrors the manifest itself. Two version rules ride along:
  `onCreated` fires only when the QUEUE store was absent, which is what made
  adding a store at v2 safe instead of an eviction report on every existing
  device; and `OUTBOX_DB_VERSION` is a ONE-WAY DOOR — IndexedDB refuses to
  open at a LOWER version, so reverting it deletes nothing but freezes sync
  on every upgraded device. Roll the client forward, not back.

- **Queued work is bound to the operator who queued it — mutations and
  photos alike.** A replay uses `fetch`, which sends whatever session
  cookie is CURRENT — not the one that queued the item. On a shared device
  that means A's work lands attributed to B in a hash-chained audit trail,
  or (different tenant) earns a 403. So `enqueue` stamps `queuedByUserId`
  from `current-user.ts`, and `flushOutbox` skips a foreign item: never
  sent, never dropped, and SURFACED (`snapshot.foreign`) so held work is not
  invisible. Since #761 a 403 no longer destroys anything either — the
  401/403 arm in `sync.ts` (mirrored in `public/sw.js`) RETAINS the item,
  marks `blocked: 'auth'` and BREAKS the pass, because the server refused the
  SESSION, not the work. That is also why the skip still earns its keep: an
  unskipped foreign item would park as auth-blocked and stop the drain for
  the operator who IS signed in, and nothing in the codebase ever clears a
  `blocked` flag, so the park is permanent rather than a deferral.
  **BOTH enqueue paths stamp it, from the ONE `attribution()` helper in
  `outbox.ts`** — and that helper exists because #786 was precisely those two
  paths drifting. `enqueue` and `enqueuePhoto` build two item literals over
  the same `OutboxItemBase`, and only the first ever stamped; both read sites
  gate on the field being PRESENT, so every photo queued since the kind
  shipped was neither skipped nor counted as foreign and replayed under
  whoever was signed in at flush time. The carve-out below read as a
  shrinking set of legacy rows and was in fact every photo, permanently. **A
  third enqueue path uses `attribution()` or it is the same bug again** — and
  a test that exercises one path cannot catch it, which is why
  `tests/unit/offline/outbox-user-binding.test.ts` drives the enqueue cases
  from one table. Legacy items with no attribution still flush, and a drain
  with no known user still drains everything. **The service worker is a
  separate case and `public/sw.js` cannot import from `src/`**, so its
  Background Sync drain is a parallel REIMPLEMENTATION of the flush
  (`public/sw.js`'s own `flushOutbox`, not the one in `sync.ts`). Two
  implementations drifting is the same shape as #786, one level up, which is
  why `attribution()` lives in `src/` and why the worker's copy has to be
  checked against it rather than assumed.
  **It DOES enforce the binding now** (#956): `public/sw.js` resolves identity
  from the SERVER via its own `swResolveWhoami`, skips an item whose
  `queuedByUserId` is not the signed-in operator's, and posts `foreignHeld` so
  held work is visible rather than silent. Its three-way outcome — `user` /
  `signed-out` / `unknown` — never collapses unknown into signed-out, so a
  captive portal's 200-with-HTML reschedules instead of sending. This
  paragraph said the opposite until #1005; if you are here to "add" worker
  attribution, read `public/sw.js:919` and `:1009` first.
  **The PAGE is now the weaker half**, which is the inversion #1005 fixes:
  `getCurrentUserId()` is fed from the server-rendered layout — the document
  the worker replays from cache — and it still feeds the drain owner
  (`use-offline-sync.ts`), the enqueue stamp and the snapshot. `enqueue`
  CANNOT use a network probe (queueing happens precisely when offline), so
  those are not one fix; what #1005 closed is the deletion guard in
  `supersedeQueuedWrites`, which failed OPEN on an unknown owner.

- **The idempotency handle is minted BEFORE the first attempt, and every
  outbox-bound request builds its headers through `outboxHeaders()`.** Until
  #924 `fetchSender` sent `Idempotency-Key` on every REPLAY while `submit`'s
  first attempt sent none and `submitPhoto`'s sent no headers at all — so the
  one request that actually reaches the server FIRST was the one the server
  could not dedupe. A response lost after the server committed then re-queued
  under an id minted at enqueue time, which the server had never seen, and the
  write landed TWICE (traced: two rows, every time, on all three CREATE routes
  — `createLogEntryImpl` has no natural-key fallback and its only pre-check is
  gated on `if (idempotencyKey)`). `submit`/`submitPhoto` now mint an
  `OutboxId` up front and pass it to `enqueue`, so the attempt and its replays
  share one key. **A new sender uses `outboxHeaders()` or it is the same bug
  again** — the same shape as the `attribution()` rule above, and the reason
  the guard failed to see it is that every existing check pointed at the replay
  path. The id parameter is BRANDED (`OutboxId`) because `store.add` is an
  upsert: a caller passing `task.id` would silently overwrite queued work.
  Note this binds the SENDERS, not the routes — `PlantingBoard.tsx` still
  creates journal entries through a keyless `apiPost` (#924 names it).

New offline surfaces subscribe to the shared state; they do not add another
`useState` count or another flush loop.

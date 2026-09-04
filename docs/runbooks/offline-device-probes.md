# Runbook — the six offline device probes (issue #648)

> **Instrument:** `/t/<tenantSlug>/diagnostics/offline`
> (`src/app/t/[tenantSlug]/(app)/diagnostics/offline/page.tsx`, shipped in #760).
> Not linked from navigation — reach it by URL.
>
> **Production:** `https://35-187-80-26.sslip.io/t/<tenantSlug>/diagnostics/offline`

---

## What this measures, and what it does not

#648 words its probes as *"inside WKWebView in `server.url` mode"* — a
Capacitor shell. **There is no Capacitor project in this repo** (no `ios/`,
no `capacitor.config.*`, no `@capacitor/*` dependency), so that framing has
nothing to run against and #649 is the issue that would build it.

The runnable substitute is the axis that actually decides the answer, and it
is the one the diagnostics page puts first:

| context | how to get there | what is known |
|---|---|---|
| **mobile Safari** | open the URL in Safari | `persist()` **refused** (`persisted: false`) — measured 2026-08-23/24, #650 |
| **installed PWA** | Share → Add to Home Screen, launch from the icon | `persist()` **granted** (`persisted: true`) — same session |

A `server.url` WKWebView changes the container, not the storage semantics.
So **if the PWA fails in Safari, the wrapper cannot fix it** — which is why
#648 is a FAIL ⇒ NO-GO gate sitting ahead of #649.

**Run every probe in BOTH contexts.** The comparison is the evidence; either
run alone is not.

---

## Order

**Start probe 6 first.** It needs a night of real wall-clock and nothing else
can compress it. Everything else takes about twenty minutes once it is
running.

---

## Three traps that silently corrupt the measurement

Read these before starting. Each one produces a plausible-looking wrong
answer rather than an obvious failure.

### 1. An ONLINE morning relaunch destroys two of the four caches before you can read them

`sweepCaches()` deletes every `*-pages` and `*-fielddata` bucket **whole, on
every launch**, with no age filter — that is `PAGE_CACHE` and `DATA_CACHE`,
two of the four names probe 2 asks for and the one (`PAGE_CACHE`) that probe
3 depends on. It returns early **only** when `navigator.onLine === false`
(`src/lib/offline/client-data-retention.ts:218`).

> **So the morning read for probe 6 must happen in AIRPLANE MODE.** Turn the
> radio off *before* launching. An online relaunch sweeps, and the resulting
> `entries=0` is our own code, not eviction — indistinguishable from the
> finding you are trying to make.

### 2. The durability verdict is CACHED, not measured on the page

`persist()` is armed once per **page load**, at the **first enqueue**
(`outbox-state.ts:231`), and the verdict is stored under
`agri.offline.durability.v1`. The diagnostics page **reads** that key; it
never calls `persist()` itself, and it says so on screen.

> So a launch with work already queued and nothing new enqueued shows the
> **previous** verdict. To take a fresh reading: load the app, then queue
> something new.

### 3. Probe 3's failure has a specific look

When `PAGE_CACHE` cannot serve a navigation the service worker falls back to
a hardcoded inline **green "Offline" page** (`public/sw.js:334-357`).

> Green Offline screen = `PAGE_CACHE` did **not** serve → probe 3 is **NO**.
> The real page = it did → **YES**. You do not need devtools for this one.

---

## Probe 6 — storage eviction (start this first)

**Evening**

1. Install to the Home Screen (Share → Add to Home Screen). Launch from the icon.
2. Open the diagnostics page: **avatar (top right) → Offline diagnostics**.
   Confirm `displayMode: standalone (installed PWA)`.
   > The installed app is `display: standalone` — **there is no address bar**,
   > so the menu row is the only way in. Before #648's reachability fix nothing
   > in the app linked this page, which made this step impossible as written.
   > **Run probe 6 as an OWNER/ADMIN, not as a MECHANISATOR.** Since #812 the
   > operator persona can *reach* this page — the row is shown to them — but it
   > cannot complete the probe: step 4 needs a journal entry with a photo, and
   > `/t/<slug>/journal` is denied by `isOperatorAllowedPath`. Without that
   > enqueue, `persist()` is never armed and the page reports "never measured"
   > — a true reading of an unrun protocol, not a finding about the device.
   > Tracked as #819.
3. **Airplane mode on.**
4. Create one journal entry **with a photo** — this is what arms `persist()` and puts work in the outbox.
5. Back to the diagnostics page (avatar → Offline diagnostics) → **Re-collect** → **Copy as text**. Paste it somewhere you will still have in the morning. This is the "before".
6. Close the app. Leave the phone overnight, untouched. Radio state does not matter overnight.

**Morning**

7. **Airplane mode ON before launching** (trap 1).
8. Launch from the Home Screen icon → avatar → **Offline diagnostics** → **Copy as text**. This is the "after".

**Reading it — two observations, not one**

This is the part worth getting right, because the interesting outcome looks
like a null result.

The queue lives in **IndexedDB**; the manifest and the lost-work record live
in **localStorage**. Loss is made visible by reconciling one against the
other, so **whether localStorage survived is a separate question from whether
IndexedDB did**, and the answer decides whether a silent morning means
"nothing happened" or "the detector cannot see this".

Record both. You can read them straight off the page:

- **Did localStorage survive?** The `probe 6 · storage` section shows the
  durability verdict, which is *read* from `agri.offline.durability.v1` in
  localStorage. A verdict present in the morning means localStorage survived.
  **`NONE STORED` means it did not.** `manifest entries` is the same signal.
- **Did IndexedDB survive?** The outbox counts under `probes 4 · 6`.

| IndexedDB | localStorage | reading |
|---|---|---|
| kept | kept | no eviction — probe 6 is **inconclusive**, not negative. Try a longer idle. |
| **gone** | kept | **selective** eviction. The detector fires: expect `lost work` non-empty and the sticky banner. |
| **gone** | **gone** | the **class-wide** sweep — expect **silence**, and *the silence is the finding* (#744). |

> **A silent morning is only meaningful once you know which of the last two
> rows you are in.** If the durability verdict is absent *and* the queue is
> empty, that is the class-wide case, and the absence of a banner is the
> result — not a failed measurement.

**Why the manifest, and not `wasRecreated`.** CLAUDE.md and #744 both describe
the blind spot as `wasRecreated()` being unable to arm. That is imprecise, and
it points at the wrong fix. In `refreshOutboxState`
(`outbox-state.ts:189-196`) **both** branches call `reconcileManifest` and
**both** gate on `missing.length > 0`; `wasRecreated` only selects the reason
*label* (`storage-evicted` vs `queue-vanished-while-closed`). What actually
defeats detection is `reconcileManifest` returning `[]` the moment the
manifest is empty (`durability.ts:257`) — which is a **localStorage**
dependency, not an IndexedDB one. There is even a second arming path for
`wasRecreated` already (`markRecreated()` at `idb-outbox.ts:186-188`, via the
SW's `OUTBOX_RECREATED` message), and it does not help, which is the clearest
evidence the framing is off.

> One nuance that does **not** apply on an iPhone but would elsewhere: the
> cross-session branch passes `backgroundSyncPossible()`, and
> `reconcileManifest` also returns `[]` when that is true. iOS Safari does not
> implement Background Sync, so it is `false` on your device and the two
> branches converge. On Android the distinction is live.

Repeat the whole sequence in **mobile Safari, not installed**. That comparison
is what actually answers #744.

---

## Probes 1, 2, 4 — read straight off the page

These need no devtools; the instrument reports them.

**Probe 1 — service worker.** The `probe 1` section: `supported`,
`controlled`, `scope`, `active.state`, `waiting`. **`controlled: true` is the
one that matters** — it means a service worker is actually *serving* this
page, not merely registered. #648 asks for positive evidence rather than an
absence of errors; this is it.

**Probe 2 — all four caches by name.** The `probe 2` section lists
`STATIC_CACHE`, `PAGE_CACHE`, `DATA_CACHE`, `BASEMAP_CACHE` with their
runtime names (`agrent-v1-*`) and entry counts. A cache that is absent shows
**`MISSING`** rather than being silently omitted — that is the finding, not a
gap in the list. (Remember trap 1 before concluding anything about
`PAGE_CACHE` / `DATA_CACHE`.)

**Probe 4 — airplane warm.** With the radio off, record a field operation
with a photo. On the diagnostics page:

- `pending` / `pendingPhotos` rise → it reached the outbox.
- Restore the network, wait for the sync, Re-collect → `pending` returns to 0.
- **Check `blocked` too.** Post-#761 nothing leaves the queue on a refused
  session or exhausted retries — it is *retained and marked*. So `pending: 3`
  alone does not mean "will send when I get signal"; `blocked` is what
  separates held work from waiting work. `blocked · auth` means the session
  was refused and the operator must sign in again.
- The **not duplicated** half is the only part the page cannot answer — check
  the server-side list shows exactly one row.

---

## Probe 3 — airplane-mode cold launch

The sharpest question, and it takes two minutes.

1. Use the app online briefly so `PAGE_CACHE` is populated (confirm on the diagnostics page).
2. **Force-quit** the app — swipe it away, do not just background it.
3. **Airplane mode on.**
4. Launch.

Real page → **YES**. Green Offline screen → **NO** (trap 3).

Do this in both contexts. Note that in Safari, an online launch between steps
1 and 4 will have swept `PAGE_CACHE` (trap 1) — so do not put one there.

---

## Probe 5 — offline basemap, recorded as TWO variables

#648 is explicit that map behaviour and cache behaviour are separate
variables and must not be collapsed into one verdict.

1. With signal: download tiles via `DownloadBasemapButton`. Confirm
   `BASEMAP_CACHE` entry count rises on the diagnostics page. ← *cache*
2. Airplane mode on. Pan and zoom the map. ← *map*

Record them separately: **tiles cached / not cached**, and **MapLibre GL +
WebGL renders in this context / does not**. A blank map with a populated
`BASEMAP_CACHE` is a WebGL finding, not a caching one.

> `BASEMAP_CACHE` is not swept by `sweepCaches()`, so trap 1 does not apply here.

---

## Recording the result

**Copy as text** on the diagnostics page emits the whole set — context,
durability verdict, service worker, all four caches, and the outbox counts
including `blocked` / `blockedAuth` — as pasteable plain text. Paste each run
into #648 with a one-line label (`installed PWA, before overnight`, etc.).

#648's "done" bar is **a recorded YES/NO per probe, with evidence**, and any
failure carries a stated fix-cost — so the verdict is a comparison rather
than a shrug.

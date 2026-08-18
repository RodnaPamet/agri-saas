# P3 — the six offline tests, on device

Run **in this order**: cheapest kill first. A failure at 3.1 makes the rest moot.

Read `../../docs/spikes/2026-08-18-capacitor-spike.md` §5.5 **F4–F8** first —
the desk analysis already ranks these by risk and tells you where we expect this
to die (3.3 and 3.6). Aim the session; don't explore.

**How to inspect anything:** Safari on the Mac → Develop → \<your iPhone\> →
the Capacitor webview. That gives a real Web Inspector console against the
WKWebView. Everything below is run there unless stated.

---

## 3.1 Does the service worker REGISTER?

Confirm from the SW's own state or cache contents — **not** from an absence of
errors in the console.

```js
navigator.serviceWorker.getRegistration().then(r => console.log({
  scope: r?.scope, active: !!r?.active, state: r?.active?.state,
}));
```

- [ ] **YES / NO:** ______  (paste the object)

Desk view: LOW risk. `ServiceWorkerRegistrar.tsx` registers `/sw.js` at the site
origin and `server.url` keeps that origin, so this should behave as Safari does.

---

## 3.2 Do all four caches populate? Check BY NAME.

```js
caches.keys().then(async keys => {
  console.log('cache keys:', keys);
  for (const k of keys) console.log(k, (await (await caches.open(k)).keys()).length, 'entries');
});
```

Expect names containing `agrent-v1`: `STATIC_CACHE`, `PAGE_CACHE`, `DATA_CACHE`,
`BASEMAP_CACHE`.

- [ ] STATIC ____ entries  [ ] PAGE ____  [ ] DATA ____  [ ] BASEMAP ____
- [ ] **YES / NO (all four present and non-empty):** ______

A cache that exists with 0 entries is a NO for that cache — say which.

---

## 3.3 AIRPLANE MODE, COLD LAUNCH  ← the sharpest question in the spike

Nothing is bundled in `server.url` mode. This survives only if an
already-activated SW intercepts the navigation in a fresh webview process.

1. With signal: open the app, visit the field screens so `PAGE_CACHE` fills.
2. Confirm 3.2 shows a non-empty `PAGE_CACHE`.
3. **Force-quit** the app (swipe up; not just background).
4. Enable Airplane Mode. Confirm no Wi-Fi.
5. Launch the app. Wait 30s.

- [ ] What appeared, verbatim: ______________________________
      (the app shell / a blank white view / a WKWebView error page / a Capacitor
      error / an infinite splash)
- [ ] **YES (shell) / NO (failure screen):** ______
- [ ] Screenshot attached: ______

**This is kill criterion K2's third clause.** If it is a failure screen, write
what fixing it would cost before moving on — the honest options are (a) a
Capacitor local fallback page, which means the app is partly bundled after all,
or (b) accepting that a cold launch needs signal, which for a field product may
itself be disqualifying. Price both.

---

## 3.4 Airplane mode, WARM: write → outbox → sync, exactly once

Mirrors what `tests/e2e/mobile/offline-photo.spec.ts` asserts in the browser.

1. With the app open, enable Airplane Mode.
2. Record a field operation. Attach a photo.
3. Confirm it queued:

```js
indexedDB.databases().then(console.log);   // find the outbox db name
// then, against that db, count entries in the outbox store
```

- [ ] Outbox entry present, with the photo Blob: ______
4. Disable Airplane Mode. Do **not** reload the page.
5. Watch for the flush (the page nudges the SW on `online`).

- [ ] Did it sync without a manual reload? ______
- [ ] **Exactly one** record server-side — check the journal/operation list: ______
- [ ] **YES / NO:** ______

Desk view: duplication is architecturally prevented (F5 — `Idempotency-Key` is
the stable outbox id and rides every retry, and the server honours it). If you
DO see a duplicate, that is a bigger finding than the spike: it means the
idempotency path is broken in the web app too.

---

## 3.5 Offline basemap, and WebGL — record these SEPARATELY

`MapCanvas` is MapLibre GL. Cache behaviour and WebGL behaviour are two
variables and conflating them makes the result unusable.

1. With signal, on a location's Map tab, use `DownloadBasemapButton`.
2. Confirm `BASEMAP_CACHE` grew (3.2's snippet). Note the byte budget is 24 MB —
   `BASEMAP_CACHE_BUDGET_BYTES` — so a large area may evict its own earlier tiles.
3. Airplane Mode. Pan and zoom.

- [ ] **CACHE:** do tiles come from cache (map renders imagery)? ______
- [ ] **WEBGL:** does the GL canvas render at all — labels, vectors, parcel
      polygons — independent of whether tiles are present? ______
- [ ] Any `WebGL context lost` in the console? ______
- [ ] **YES / NO (each, separately):** cache ____ / webgl ____

---

## 3.6 STORAGE EVICTION  ← start this on DAY 1; it cannot be compressed

The desk analysis (F4) found **no `navigator.storage.persist()` call anywhere**
in the app. Without it this storage is best-effort, and iOS deletes
script-writable storage after ~7 days without site interaction — with quota
pressure from photo Blobs and a 24 MB basemap budget on the same origin.

1. Queue at least one outbox item (a field op + photo) and leave it **unsent**
   (stay in Airplane Mode, or stop the server reaching the API).
2. Record the outbox count and the four cache counts. Write them here: ______
3. Background the app. **Do not open it.** Leave overnight (≥12h; longer if the
   time box allows).
4. Reopen. Re-run 3.2's snippet and the outbox count.

- [ ] Outbox entries before ____ → after ____
- [ ] Cache entries before ____ → after ____
- [ ] **Did any queued item vanish WITHOUT being delivered? YES / NO:** ______

**A YES is kill criterion K4 and it kills the spike on its own** — that is data
loss, not a performance regression.

**Run the same test on the PWA in Safari, same device, same window.** F4 notes
this is a PWA problem too. If both lose data, it is not a shell finding and the
verdict must not report it as one — it becomes a product bug worth its own fix
(`persist()`), which is far cheaper than any rewrite.

- [ ] PWA-in-Safari comparison result: ______

---

## Recording

Write each YES/NO with its evidence into §6 of the spike document, in the
criteria's original wording. If a criterion said "cold launch offline shows the
shell" and you saw a failure screen, that is a **NO**.

Where a test fails, record **what fixing it would cost**, so the verdict is a
comparison and not a shrug.

/*
 * Agrent service worker — operator PWA.
 *
 * Responsibilities:
 *   - Installable, fast app SHELL (static-asset + navigation caching).
 *   - OFFLINE-FIRST field data: the last-viewed location / parcels /
 *     field-operation GETs are network-first with a cache fallback, so the
 *     Map / my-Tasks / Field-execute routes open with no signal.
 *   - BACKGROUND SYNC: on a 'flush-outbox' sync event, replay the
 *     IndexedDB outbox (queued field mutations) so they deliver after the
 *     app is closed, when connectivity returns. Mirrors the client policy
 *     in src/lib/offline/sync.ts.
 *   - WEB PUSH: show task-assignment / spray-window notifications and focus
 *     the right route on click.
 *
 * Still conservative: non-GET requests are NEVER touched (writes are the
 * client outbox's job), and only the narrow field-data GETs are cached —
 * not arbitrary tenant data.
 *
 * Bump CACHE_VERSION to invalidate old caches on the next activate.
 */
// Bumped for the Agrent rebrand — invalidates the old `agri-v2` caches so
// installed clients re-precache the new seedling icon.svg + manifest. The
// `activate` handler below deletes every cache not prefixed with this value.
const CACHE_VERSION = 'agrent-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGE_CACHE = `${CACHE_VERSION}-pages`;
const DATA_CACHE = `${CACHE_VERSION}-fielddata`;
// Dedicated, SEPARATE cache for the offline basemap pack (Roadmap-6 P1b).
// Kept apart from DATA_CACHE so the two eviction policies never interfere:
// field data is network-first + unbounded (last-viewed fields), the basemap
// is cache-first + LRU-with-a-byte-budget (bounded natural-earth tiles). The
// basemap is public-domain geometry, NOT tenant data.
const BASEMAP_CACHE = `${CACHE_VERSION}-basemap`;
// Byte budget for BASEMAP_CACHE. Mirrors BASEMAP_CACHE_BUDGET_BYTES in
// src/lib/offline/basemap-pack.ts (the SW can't import from src/ — kept in
// lockstep by tests/guardrails/offline-pwa-coverage.test.ts).
const BASEMAP_CACHE_BUDGET_BYTES = 24 * 1024 * 1024;
// Byte budgets for the two TENANT caches. Unlike the basemap (immutable
// public geometry), these hold the operator's own farm: DATA_CACHE keeps
// field-operation and location API responses — including Task.description
// and Task.resolution, which are Epic B encrypted at rest and cached here
// DECRYPTED — and PAGE_CACHE keeps every server-rendered tenant document
// with its rows inline. Both were UNBOUNDED: the only exit was a
// CACHE_VERSION bump plus activation, and install deliberately skips
// skipWaiting, so even that waits on operator consent.
//
// A byte cap is not a retention policy — it bounds size, not age. Ageing
// them out is the window's job (src/lib/offline/client-data-retention.ts
// deletes both buckets wholesale via caches.delete), deliberately kept OUT
// of this file: a bug here ships to phones that will not take an update
// until the operator agrees.
// Entry cap for STATIC_CACHE. A COUNT, not a byte budget, and the distinction
// is measured rather than stylistic: `basemapEntrySize` sizes an entry from
// `Content-Length`, and `deploy/Caddyfile` serves `encode gzip zstd`, which
// makes Caddy DROP that header on a compressed response. 28 of the 30 assets
// on the live login page carry no `Content-Length` at all, so they would each
// fall to that function's 8KB fallback — one real 641,667-byte chunk counts as
// 8,192. A "24MB" byte budget would therefore have been an entry cap of ~3,072
// in disguise, firing at roughly 176MB of real bytes. A worker cannot ask for
// an identity encoding either: `Accept-Encoding` is a forbidden header name.
//
// So this bounds what it can actually count. 750 entries is generous against a
// full build of 569 JS+CSS files, of which a real client only caches the routes
// it visits — several builds' worth of realistic use, and a bound where there
// was none. It exists because nothing else reclaims this cache: `activate`
// keeps any name starting with CACHE_VERSION (a hardcoded literal no build
// varies), and the window's retention sweep skips it since it holds no tenant
// data. Unbounded, every deploy's chunks accumulate forever — and storage
// pressure is what makes a phone evict the origin, which takes the outbox with
// it. See #739.
const STATIC_CACHE_MAX_ENTRIES = 750;
const DATA_CACHE_BUDGET_BYTES = 8 * 1024 * 1024;
const PAGE_CACHE_BUDGET_BYTES = 4 * 1024 * 1024;
const PRECACHE = ['/icon.svg', '/manifest.webmanifest'];

// ── Outbox IndexedDB contract (shared with src/lib/offline/idb-outbox.ts) ──
// One object store, keyPath 'id', holds two item kinds: `mutation` (JSON
// body, default when `kind` is absent) and `photo` (a `blob` Blob stored
// natively + `fileName`/`fileType`, replayed as multipart). flushOutbox below
// branches on `item.kind` — kept in lockstep with fetchSender in
// src/lib/offline/sync.ts.
const OUTBOX_DB = 'agri-offline';
const OUTBOX_DB_VERSION = 1;
const OUTBOX_STORE = 'outbox';
const OUTBOX_MAX_ATTEMPTS = 8; // mirrors MAX_ATTEMPTS in sync.ts
const FLUSH_OUTBOX_TAG = 'flush-outbox';
/** Posted to clients when the worker finds the outbox database rebuilt. */
const OUTBOX_RECREATED_MSG = 'outbox-db-recreated';

self.addEventListener('install', (event) => {
    // Precache the shell, but do NOT skipWaiting — a deploy mid-field-session
    // must not hot-swap the SW under an operator who's mid-queue on flaky
    // signal. The new worker parks in the "waiting" state; ServiceWorkerRegistrar
    // surfaces an "Update ready — refresh" prompt and only sends SKIP_WAITING
    // (below) on the operator's consent. Otherwise the update applies on the
    // next natural launch.
    event.waitUntil(
        caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)),
                ),
            )
            .then(() => self.clients.claim()),
    );
});

function isStaticAsset(url) {
    return (
        url.pathname.startsWith('/_next/static/') ||
        /\.(?:css|js|woff2?|ttf|svg|png|jpg|jpeg|gif|webp|ico)$/.test(url.pathname)
    );
}

// Narrow allowlist of field GET endpoints worth caching for offline open.
// Scoped on purpose — NOT a blanket /api cache (avoids stale/leaky tenant
// data). Covers: a location, its parcels, a field-operation, the operator's
// farm-task queue, and the same-origin parcel MVT tiles for a location.
function isFieldDataRequest(url) {
    if (!url.pathname.startsWith('/api/')) return false;
    return (
        /\/locations\/[^/]+(?:\/parcels)?$/.test(url.pathname) ||
        // Parcel vector tiles: /api/t/<slug>/locations/<id>/tiles/<z>/<x>/<y>.pbf
        // Same-origin geometry — cache so a previously-viewed field keeps its
        // parcel outlines offline. Bounded: only tenant parcel tiles, never
        // arbitrary /api. (Roadmap-6 P1 — scoped addition, see
        // offline-pwa-coverage guardrail.)
        /\/locations\/[^/]+\/tiles\/\d+\/\d+\/\d+(?:\.pbf)?$/.test(url.pathname) ||
        /\/field-operations\/[^/]+$/.test(url.pathname) ||
        /\/farm-tasks(?:$|\?)/.test(url.pathname) ||
        url.pathname.endsWith('/farm-tasks')
    );
}

// Network-first with a cache fallback: fresh when online, last-viewed when
// offline. Only successful responses are cached.
async function networkFirstData(request) {
    const cache = await caches.open(DATA_CACHE);
    try {
        const res = await fetch(request);
        if (res.ok) {
            await cache.put(request, res.clone());
            await evictCacheOverBudget(cache, DATA_CACHE_BUDGET_BYTES);
        }
        return res;
    } catch (err) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw err;
    }
}

// ── Offline basemap pack (dedicated BASEMAP_CACHE, LRU + byte budget) ───
//
// The bounded, user-initiated per-location basemap pack (Roadmap-6 P1b).
// STRICTLY the same-origin basemap tile route — NOT arbitrary /api, and
// deliberately separate from the parcel field-data path (isFieldDataRequest /
// DATA_CACHE), which is owned by its own PR. Shape:
//   /api/t/<slug>/locations/<id>/basemap/<z>/<x>/<y>[.pbf]
function isBasemapRequest(url) {
    if (!url.pathname.startsWith('/api/')) return false;
    return /\/locations\/[^/]+\/basemap\/\d+\/\d+\/\d+(?:\.pbf)?$/.test(url.pathname);
}

// Size of a cached basemap response, from Content-Length (tiles are tiny +
// carry it). Falls back to a small constant so an absent header can't make a
// tile look free and defeat the budget.
function basemapEntrySize(response) {
    const len = response && response.headers ? response.headers.get('Content-Length') : null;
    const n = len ? parseInt(len, 10) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 8 * 1024;
}

// Pure LRU eviction predicate — MIRRORS selectBasemapEvictions in
// src/lib/offline/basemap-pack.ts (unit-tested there; the SW can't import from
// src/, so the logic is duplicated and kept in lockstep by the
// offline-pwa-coverage guardrail). `entries` are ordered oldest-first; returns
// the prefix of keys to evict so the remaining total sits at/under budget.
function selectBasemapEvictions(entries, budgetBytes) {
    let total = entries.reduce((sum, e) => sum + Math.max(0, e.size), 0);
    const evict = [];
    for (let i = 0; i < entries.length && total > budgetBytes; i++) {
        evict.push(entries[i].key);
        total -= Math.max(0, entries[i].size);
    }
    return evict;
}

// Evict least-recently-used entries until a cache is within budget.
// Cache Storage preserves insertion order, so `cache.keys()` order is
// oldest-first. For BASEMAP_CACHE, cacheFirstBasemap additionally moves a
// touched tile to the newest end (delete-then-put) on every hit, making
// that order a true LRU; the tenant caches are network-first and rewrite
// on each fetch, so for them it is insertion order, which is the right
// approximation and never evicts something just written.
async function evictCacheOverBudget(cache, budgetBytes) {
    const keys = await cache.keys();
    const entries = [];
    for (const req of keys) {
        const res = await cache.match(req);
        entries.push({ key: req.url, request: req, size: basemapEntrySize(res) });
    }
    const evictUrls = new Set(selectBasemapEvictions(entries, budgetBytes));
    await Promise.all(
        entries.filter((e) => evictUrls.has(e.key)).map((e) => cache.delete(e.request)),
    );
}

// Trim STATIC_CACHE to its entry cap, oldest first.
//
// `cache.keys()` is last-successful-`put` order — a put on an existing key
// removes the old record and appends a new one — and the stale-while-revalidate
// branch re-puts every asset the CURRENT build requests on each online load. So
// live chunks ride at the newest end and the leading entries are the ones no
// page references any more.
//
// Deliberately does NOT reuse `evictCacheOverBudget`: that walks the cache with
// a sequential `await cache.match` PER ENTRY to size it, which on this cache
// means hundreds of disk-backed Response opens per sweep on a low-end phone,
// and every one of those awaits widens the window in which a concurrently
// re-put hot asset can be deleted by a stale victim list. One `keys()` and the
// deletes is all a count needs.
let staticEvictionInFlight = null;
async function trimStaticCache(cache) {
    const keys = await cache.keys();
    const over = keys.length - STATIC_CACHE_MAX_ENTRIES;
    if (over <= 0) return;
    await Promise.all(keys.slice(0, over).map((req) => cache.delete(req)));
}

// One sweep at a time: a page load puts dozens of assets, and running a sweep
// per put would repeat the same walk dozens of times. Only ever reached from
// the network-success path below, so it cannot run while offline — an offline
// cold launch reads this cache and must never prune it.
function enforceStaticBudget(cache) {
    if (staticEvictionInFlight) return staticEvictionInFlight;
    staticEvictionInFlight = trimStaticCache(cache)
        .catch(() => {})
        .then(() => {
            staticEvictionInFlight = null;
        });
    return staticEvictionInFlight;
}

// Kept as a named wrapper: the offline-pwa-coverage guardrail pins this
// symbol, and the basemap budget is the one that mirrors a constant in
// src/lib/offline/basemap-pack.ts.
async function evictBasemapOverBudget(cache) {
    return evictCacheOverBudget(cache, BASEMAP_CACHE_BUDGET_BYTES);
}

// Cache-FIRST for basemap tiles: they're immutable natural-earth geometry, so
// a cached tile is served instantly (and works offline). On a hit we bump
// recency (delete-then-put) so the LRU order stays honest; on a miss we fetch,
// store, and enforce the byte budget.
async function cacheFirstBasemap(request) {
    const cache = await caches.open(BASEMAP_CACHE);
    const cached = await cache.match(request);
    if (cached) {
        // Bump recency: move this tile to the newest end of the insertion order.
        cache
            .delete(request)
            .then(() => cache.put(request, cached.clone()))
            .catch(() => {});
        return cached;
    }
    const res = await fetch(request);
    // 204/304 carry no body — don't cache an empty tile as if it were data.
    if (res && res.ok && res.status === 200) {
        await cache.put(request, res.clone());
        await evictBasemapOverBudget(cache);
    }
    return res;
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return; // writes never touched by the SW
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return; // third-party → passthrough

    if (url.pathname.startsWith('/api/')) {
        // Offline-first for the narrow field-data GETs; the bounded basemap
        // pack is cache-first in its OWN dedicated cache; everything else
        // under /api stays network-only (the app + SWR own freshness).
        if (isBasemapRequest(url)) event.respondWith(cacheFirstBasemap(request));
        else if (isFieldDataRequest(url)) event.respondWith(networkFirstData(request));
        return;
    }

    // Static assets: stale-while-revalidate.
    if (isStaticAsset(url)) {
        event.respondWith(
            caches.open(STATIC_CACHE).then(async (cache) => {
                const cached = await cache.match(request);
                const network = fetch(request)
                    .then((res) => {
                        if (res.ok) {
                            // Bound the cache after the write lands. Eviction is
                            // oldest-first by last successful put, and this
                            // branch re-puts every asset the CURRENT build
                            // requests on each online load — so live chunks ride
                            // at the newest end and only ones no page references
                            // any more age out.
                            cache
                                .put(request, res.clone())
                                .then(() => enforceStaticBudget(cache))
                                .catch(() => {});
                        }
                        return res;
                    })
                    .catch(() => cached);
                return cached || network;
            }),
        );
        return;
    }

    // Navigations: network-first with a cached-document fallback so a
    // previously-opened field route still opens offline.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((res) => {
                    if (res.ok) {
                        const copy = res.clone();
                        caches.open(PAGE_CACHE).then(async (cache) => {
                            await cache.put(request, copy);
                            await evictCacheOverBudget(cache, PAGE_CACHE_BUDGET_BYTES);
                        });
                    }
                    return res;
                })
                .catch(async () => {
                    const cached = await caches.match(request);
                    return (
                        cached ||
                        new Response(
                            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><body style="font-family:system-ui;background:#0b1220;color:#e5e7eb;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#86efac">Offline</h1><p>You’re offline. Marked jobs are queued and will sync when you reconnect.</p></div></body>',
                            { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
                        )
                    );
                }),
        );
    }
});

// ── Background Sync: replay the IndexedDB outbox ───────────────────────

/**
 * Does the outbox database exist RIGHT NOW?
 *
 * `indexedDB.open` has no read-only mode: opening an absent database CREATES
 * it. That is why this check exists — see `openOutboxDb` below for why the
 * worker must never be the one to create it. Returns `null` where the browser
 * has no `databases()` (pre-14 WebKit), meaning "cannot tell".
 */
async function outboxDbExists() {
    if (typeof indexedDB.databases !== 'function') return null;
    try {
        return (await indexedDB.databases()).some((d) => d.name === OUTBOX_DB);
    } catch {
        return null;
    }
}

/**
 * Open the outbox, reporting whether THIS open had to create the store.
 *
 * Creating it is never routine here: the worker only ever READS a queue the
 * page wrote, so an absent store means the database was destroyed — an
 * eviction. That event is the app's only exact eviction signal
 * (`IndexedDbOutboxStore.wasRecreated`), it is delivered once, to whoever
 * opens first, and only the PAGE can act on it. A worker that quietly
 * recreated the store consumed the signal and the operator was never told
 * their queued work had been deleted. See `flushOutbox`.
 */
function openOutboxDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(OUTBOX_DB, OUTBOX_DB_VERSION);
        let created = false;
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
                created = true;
                db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve({ db: req.result, created });
        req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
    });
}

/** Tell every open client the queue's database was rebuilt underneath it. */
async function reportOutboxRecreated() {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    clients.forEach((c) => c.postMessage({ type: OUTBOX_RECREATED_MSG }));
}
function idbGetAll(db) {
    return new Promise((resolve, reject) => {
        const rq = db.transaction(OUTBOX_STORE, 'readonly').objectStore(OUTBOX_STORE).getAll();
        rq.onsuccess = () => resolve(rq.result || []);
        rq.onerror = () => reject(rq.error);
    });
}
function idbWrite(db, op, arg) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OUTBOX_STORE, 'readwrite');
        const store = tx.objectStore(OUTBOX_STORE);
        op === 'put' ? store.put(arg) : store.delete(arg);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
function isTransient(status) {
    // status 0 = network throw. 408 + 5xx are retryable-with-attempt-bump.
    // 429 is handled separately (retain, no bump, stop the burst) — see below.
    return status === 0 || status === 408 || status >= 500;
}

// Replays every queued mutation once, applying the same policy as
// src/lib/offline/sync.ts (kept in lockstep). Rejects if work remains so the
// browser reschedules the sync (exponential backoff) until the queue drains.
//
// 429 is special: a reconnect burst can outrun the mutation rate limit. A 429
// is NOT the item's fault and WILL succeed later, so it must never bump the
// attempts counter (or a long burst would DROP a farmer's queued edits) and
// must stop the pass (no point replaying the rest into a closed window). We
// retain everything, surface the server's Retry-After to open clients, and
// throw so the browser reschedules the drain after backing off.
async function flushOutbox() {
    // An absent database has no queue to replay, so there is nothing to gain
    // by opening it — and everything to lose, because opening CREATES it and
    // destroys the page's eviction signal. Skip without touching it.
    if ((await outboxDbExists()) === false) return;

    let db;
    let created;
    try { ({ db, created } = await openOutboxDb()); } catch { return; }
    // `databases()` was unavailable and the store turned out to be absent, so
    // this open created it and consumed the signal. Hand it to the clients
    // rather than swallowing it; the queue is empty by definition.
    if (created) {
        try { db.close(); } catch { /* already closed */ }
        await reportOutboxRecreated();
        return;
    }
    let items;
    try { items = await idbGetAll(db); } catch { return; }
    items.sort((a, b) => a.createdAt - b.createdAt);

    let transientRemains = false;
    let rateLimited = false;
    let retryAfterSeconds;
    for (const item of items) {
        // A parked 409 conflict awaits operator resolution in an open client —
        // never re-send it (would 409 again, or clobber once versions align).
        if (item.conflict) continue;

        let status = 0;
        let ok = false;
        let retryAfterHeader = null;
        let conflictBody;
        try {
            let res;
            if (item.kind === 'photo') {
                // Binary path — reconstruct the multipart upload from the Blob
                // stored natively in IndexedDB (mirrors fetchSender in
                // src/lib/offline/sync.ts). The item id rides as
                // Idempotency-Key so a replay dedupes to exactly-once (a photo
                // can't attach twice). No Content-Type — the runtime sets the
                // multipart boundary.
                const fd = new FormData();
                fd.append('file', new File([item.blob], item.fileName, { type: item.fileType }));
                res = await fetch(item.url, {
                    method: item.method,
                    headers: { 'Idempotency-Key': item.id },
                    body: fd,
                    credentials: 'same-origin',
                });
            } else {
                res = await fetch(item.url, {
                    method: item.method,
                    // Idempotency-Key: the outbox id is the exactly-once handle
                    // (dedupe a replay). If-Match: the optimistic-lock version the
                    // client saw, so the server 409s a stale write, not a clobber.
                    headers: {
                        'Content-Type': 'application/json',
                        'Idempotency-Key': item.id,
                        ...(item.ifMatch !== undefined ? { 'If-Match': String(item.ifMatch) } : {}),
                    },
                    body: item.body !== undefined ? JSON.stringify(item.body) : undefined,
                    credentials: 'same-origin',
                });
            }
            status = res.status;
            ok = res.ok;
            if (status === 429) retryAfterHeader = res.headers.get('Retry-After');
            if (status === 409) conflictBody = await res.json().catch(() => undefined);
        } catch {
            status = 0;
        }

        if (ok) {
            await idbWrite(db, 'delete', item.id);
        } else if (status === 409) {
            // Optimistic-lock conflict — the row moved on while this edit sat
            // queued. Retain it (NON-transient: never dropped, never clobbered)
            // for the operator to resolve; stash the server state for the UI.
            // Guard against resurrection: a late 409 must not re-add an item the
            // operator already resolved (take-server removed it).
            const current = await idbGetAll(db);
            if (current.some((i) => i.id === item.id)) {
                await idbWrite(db, 'put', { ...item, conflict: { status: 409, server: conflictBody } });
            }
        } else if (status === 429) {
            // Rate limited — retain untouched (no attempts bump, never
            // dropped) and stop draining into the closed window.
            rateLimited = true;
            const parsed = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
            if (Number.isFinite(parsed) && parsed >= 0) retryAfterSeconds = parsed;
            break;
        } else if (isTransient(status)) {
            const next = { ...item, attempts: (item.attempts || 0) + 1 };
            if (next.attempts >= OUTBOX_MAX_ATTEMPTS) await idbWrite(db, 'delete', item.id);
            else { await idbWrite(db, 'put', next); transientRemains = true; }
        } else {
            // Terminal client error — drop so the queue keeps moving.
            await idbWrite(db, 'delete', item.id);
        }
    }
    // Notify any open clients so their pending-count refreshes.
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    clients.forEach((c) => c.postMessage({ type: 'outbox-flushed', rateLimited, retryAfterSeconds }));
    if (rateLimited) throw new Error('outbox: rate limited — reschedule sync after backoff');
    if (transientRemains) throw new Error('outbox: transient failures remain — reschedule sync');
}

self.addEventListener('sync', (event) => {
    if (event.tag === FLUSH_OUTBOX_TAG) event.waitUntil(flushOutbox());
});

// Fallback trigger for browsers without Background Sync (iOS Safari): the
// page can postMessage a flush request (e.g. on regained connectivity).
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === FLUSH_OUTBOX_TAG) {
        event.waitUntil ? event.waitUntil(flushOutbox()) : flushOutbox();
    }
    // Operator tapped "Update ready — refresh": activate the waiting worker
    // now. It then claims clients (activate handler) and the page reloads on
    // controllerchange. Only ever sent on explicit consent, so a deploy never
    // interrupts an in-flight outbox flush on its own.
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// ── Web Push ───────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        payload = { title: 'Agrent', body: event.data ? event.data.text() : '' };
    }
    const title = payload.title || 'Agrent';
    const options = {
        body: payload.body || payload.message || '',
        icon: '/icon.svg',
        badge: '/icon.svg',
        tag: payload.tag || undefined,
        data: { url: payload.url || payload.linkUrl || '/' },
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            for (const client of clients) {
                if ('focus' in client) {
                    if ('navigate' in client) client.navigate(target);
                    return client.focus();
                }
            }
            return self.clients.openWindow(target);
        }),
    );
});

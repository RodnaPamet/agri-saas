/**
 * Guardrail: offline operator PWA wiring + invariants.
 *
 * Locks the load-bearing pieces of the queue-and-sync PWA:
 *   1. A valid, installable web app manifest exists and is linked.
 *   2. The service worker NEVER caches the API and NEVER touches non-GET
 *      requests — offline writes are the outbox's job, not the SW's. A SW
 *      that cached /api or swallowed a PATCH would serve stale tenant data
 *      or silently drop a mutation.
 *   3. The outbox store is a single seam: UI goes through `useOfflineSync`,
 *      not `getOutboxStore()` directly (mirrors the terra-draw / react-
 *      window single-seam discipline).
 *   4. The SW registrar is mounted in the root layout.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(REPO_ROOT, rel));

// ─── 1 — manifest ──────────────────────────────────────────────────

describe('PWA manifest', () => {
    it('exists and is valid installable JSON', () => {
        expect(exists('public/manifest.webmanifest')).toBe(true);
        const m = JSON.parse(read('public/manifest.webmanifest'));
        expect(m.name).toBeTruthy();
        expect(m.display).toBe('standalone');
        expect(Array.isArray(m.icons)).toBe(true);
        expect(m.icons.length).toBeGreaterThan(0);
        expect(m.start_url).toBeTruthy();
    });

    it('is linked + the SW registrar is mounted in the root layout', () => {
        const layout = read('src/app/layout.tsx');
        expect(layout).toMatch(/manifest:\s*['"]\/manifest\.webmanifest['"]/);
        expect(layout).toMatch(/ServiceWorkerRegistrar/);
    });
});

// ─── 2 — service worker safety ─────────────────────────────────────

describe('service worker safety', () => {
    const sw = () => read('public/sw.js');

    it('exists', () => {
        expect(exists('public/sw.js')).toBe(true);
    });

    it('never caches the API + bails on non-GET', () => {
        const src = sw();
        // Explicit guards present.
        expect(src).toMatch(/method\s*!==\s*['"]GET['"]/);
        expect(src).toMatch(/\/api\//);
        // No cache write keyed on an /api/ request anywhere.
        expect(/cache\.put\([^)]*\/api\//.test(src)).toBe(false);
    });

    it('does NOT skipWaiting on install — the new SW waits for consent', () => {
        // A deploy mid-field-session must not hot-swap the SW under an operator
        // who's mid-queue. The install handler precaches but never auto-activates.
        const src = sw();
        const install = src.slice(
            src.indexOf("addEventListener('install'"),
            src.indexOf("addEventListener('activate'"),
        );
        // No CALL to skipWaiting() in the install handler (a mention in a
        // comment is fine).
        expect(install).not.toMatch(/skipWaiting\s*\(/);
    });

    it('activates the waiting worker only on a SKIP_WAITING message', () => {
        // The takeover is consent-gated: ServiceWorkerRegistrar posts
        // SKIP_WAITING when the operator taps "Update ready — refresh".
        const src = sw();
        expect(src).toMatch(/['"]SKIP_WAITING['"]/);
        expect(src).toMatch(/self\.skipWaiting\(\)/);
    });

    // Roadmap-6 P1 — scoped addition. The parcel MVT tile route joins the
    // field-data allowlist so a previously-viewed field keeps its parcel
    // geometry offline. This behaviourally pins BOTH halves of the contract:
    // the tile route IS cached, and the "never cache arbitrary /api"
    // invariant still holds. Evaluate the real predicate from sw.js so a
    // future edit that widens it to a blanket /api cache fails here.
    it('field-data allowlist caches parcel MVT tiles but never arbitrary /api', () => {
        const src = sw();
        const m = src.match(/function isFieldDataRequest\(url\)\s*\{[\s\S]*?\n\}/);
        expect(m).toBeTruthy();
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const isFieldDataRequest = new Function(
            'url',
            `${m![0]}\nreturn isFieldDataRequest(url);`,
        ) as (url: { pathname: string }) => boolean;
        const u = (pathname: string) => ({ pathname });

        // Scoped addition — parcel vector tiles (with + without .pbf).
        expect(isFieldDataRequest(u('/api/t/acme/locations/loc1/tiles/12/2345/1234.pbf'))).toBe(true);
        expect(isFieldDataRequest(u('/api/t/acme/locations/loc1/tiles/12/2345/1234'))).toBe(true);
        // Existing field data still cached.
        expect(isFieldDataRequest(u('/api/t/acme/locations/loc1'))).toBe(true);
        expect(isFieldDataRequest(u('/api/t/acme/locations/loc1/parcels'))).toBe(true);
        expect(isFieldDataRequest(u('/api/t/acme/farm-tasks'))).toBe(true);
        // Invariant — arbitrary /api is NEVER cached.
        expect(isFieldDataRequest(u('/api/t/acme/admin/members'))).toBe(false);
        expect(isFieldDataRequest(u('/api/t/acme/risks'))).toBe(false);
        // An incomplete tile path (no y) must not match.
        expect(isFieldDataRequest(u('/api/t/acme/locations/loc1/tiles/12/2345'))).toBe(false);
    });
});

// ─── 2c — offline basemap pack: dedicated cache + LRU (Roadmap-6 P1b) ──
//
// The bounded, user-initiated per-location basemap pack lives in its OWN
// cache with a byte budget + LRU eviction — deliberately SEPARATE from the
// field-data DATA_CACHE (owned by another PR). These assertions pin that
// separation and the bounded matcher WITHOUT weakening "never caches
// arbitrary /api": the basemap matcher is a narrow same-origin tile pattern,
// and the API-safety test above still holds (the SW's basemap `cache.put`
// keys on the request object, not a literal `/api/` string).
describe('offline basemap pack (dedicated cache + LRU eviction)', () => {
    const sw = () => read('public/sw.js');

    it('uses a dedicated basemap cache SEPARATE from the field-data cache', () => {
        const src = sw();
        expect(src).toMatch(/BASEMAP_CACHE\s*=\s*`\$\{CACHE_VERSION\}-basemap`/);
        // Both caches are versioned so the activate handler prunes stale ones.
        expect(src).toMatch(/DATA_CACHE\s*=\s*`\$\{CACHE_VERSION\}-fielddata`/);
        // The basemap path is routed to its own handler, not the field-data one.
        expect(src).toMatch(/isBasemapRequest\(url\)\)\s*event\.respondWith\(cacheFirstBasemap/);
    });

    it('bounds the basemap matcher to the same-origin per-location tile path', () => {
        const src = sw();
        // Must be gated on /api/ AND the narrow locations/<id>/basemap/z/x/y
        // shape — never an open /api cache.
        expect(src).toMatch(/function isBasemapRequest\(url\)/);
        // The narrow per-location basemap tile shape: .../locations/<id>/basemap/z/x/y
        expect(src).toMatch(/locations/);
        expect(src).toMatch(/basemap\\\/\\d\+\\\/\\d\+\\\/\\d\+/);
        expect(src).toMatch(/if \(!url\.pathname\.startsWith\('\/api\/'\)\) return false/);
    });

    it('bounds the TENANT caches too, not just the basemap', () => {
        // DATA_CACHE and PAGE_CACHE were unbounded. Unlike the basemap
        // (immutable public geometry) they hold the operator's own farm:
        // field-operation API responses — with Task.description and
        // Task.resolution, Epic B encrypted at rest, cached here DECRYPTED —
        // and every server-rendered tenant document with its rows inline.
        // The only exit was a CACHE_VERSION bump plus activation, and install
        // deliberately skips skipWaiting, so even that waits on operator
        // consent.
        const src = read('public/sw.js');
        expect(src).toMatch(/DATA_CACHE_BUDGET_BYTES\s*=/);
        expect(src).toMatch(/PAGE_CACHE_BUDGET_BYTES\s*=/);
        // Both write sites must enforce, not merely define, a budget.
        expect(src).toMatch(/evictCacheOverBudget\(cache, DATA_CACHE_BUDGET_BYTES\)/);
        expect(src).toMatch(/evictCacheOverBudget\(cache, PAGE_CACHE_BUDGET_BYTES\)/);
    });

    it('leaves AGEING those caches to the window, not the service worker', () => {
        // A byte cap bounds size, not age — a capped cache still holds a
        // farm indefinitely. Ageing is deliberately done from the window
        // (client-data-retention.ts deletes both buckets via caches.delete)
        // because a bug in sw.js ships to phones that will not take an
        // update until the operator agrees.
        const retention = read('src/lib/offline/client-data-retention.ts');
        expect(retention).toMatch(/caches\.delete\(/);
        // And it must never reach into the outbox: clearing the manifest
        // without the queue is exactly what the loss detector reads as
        // "this phone deleted your work".
        expect(retention).toMatch(/NEVER_SWEPT/);
        expect(retention).toContain("'agri-offline'");
    });

    it('enforces a byte budget with an LRU eviction helper', () => {
        const src = sw();
        expect(src).toMatch(/BASEMAP_CACHE_BUDGET_BYTES\s*=/);
        expect(src).toMatch(/function selectBasemapEvictions\(entries, budgetBytes\)/);
        expect(src).toMatch(/function evictBasemapOverBudget\(cache\)/);
        // Eviction is actually invoked after a basemap write.
        expect(src).toMatch(/await evictBasemapOverBudget\(cache\)/);
    });

    it('keeps the SW eviction predicate in lockstep with the unit-tested source', () => {
        // The pure predicate lives in src/lib/offline/basemap-pack.ts (unit
        // tested) and is MIRRORED inline in the SW. Assert both spell the same
        // budget so a drift in one is caught.
        const swSrc = sw();
        const libSrc = read('src/lib/offline/basemap-pack.ts');
        expect(libSrc).toMatch(/BASEMAP_CACHE_BUDGET_BYTES\s*=\s*24 \* 1024 \* 1024/);
        expect(swSrc).toMatch(/BASEMAP_CACHE_BUDGET_BYTES\s*=\s*24 \* 1024 \* 1024/);
        expect(libSrc).toMatch(/export function selectBasemapEvictions/);
    });

    it('serves basemap tiles cache-FIRST (offline-capable) but never caches empty tiles', () => {
        const src = sw();
        expect(src).toMatch(/function cacheFirstBasemap\(request\)/);
        // Only a 200 with a body is stored — a 204/empty tile is not cached.
        expect(src).toMatch(/res\.ok && res\.status === 200/);
    });
});

// ─── 2b — offline exactly-once (idempotency handle) ────────────────

describe('outbox replay carries the idempotency handle', () => {
    // A queued write re-sent over a flaky link must transmit the outbox-item
    // id as `Idempotency-Key` so the server dedupes the replay instead of
    // minting a duplicate row. BOTH senders (the in-page fetch sender AND the
    // service-worker background flush) must set it — they drain the SAME
    // outbox, so a gap in either reopens the double-write path.
    it('the in-page fetch sender sets Idempotency-Key from the item id', () => {
        const src = read('src/lib/offline/sync.ts');
        expect(src).toMatch(/['"]Idempotency-Key['"]\s*:\s*item\.id/);
    });

    it('the service-worker flush sets Idempotency-Key from the item id', () => {
        const src = read('public/sw.js');
        expect(src).toMatch(/['"]Idempotency-Key['"]\s*:\s*item\.id/);
    });
});

// ─── 2d — binary (photo) outbox path (Roadmap-6 P2) ────────────────
//
// The outbox carries a SECOND item kind: `photo`, whose downscaled BYTES ride
// as a `Blob` stored natively in IndexedDB. On replay BOTH senders — the
// in-page fetch sender AND the service-worker background flush — must
// reconstruct multipart FormData from the Blob and POST it, in lockstep. A
// gap in either drains the shared outbox incorrectly (a JSON body with no
// bytes) and reopens the failed-upload path P2 set out to close. The
// compressed size is capped at ENQUEUE so a huge blob can't wedge the queue.

describe('binary photo outbox path (client + SW lockstep)', () => {
    it('the in-page sender reconstructs multipart FormData from the stored Blob', () => {
        const src = read('src/lib/offline/sync.ts');
        // Branches on the photo kind and builds FormData from the item blob.
        expect(src).toMatch(/isPhotoItem\(item\)/);
        expect(src).toMatch(/new FormData\(\)/);
        expect(src).toMatch(/new File\(\[item\.blob\], item\.fileName/);
        // Multipart replay still carries the idempotency handle (header only).
        expect(src).toMatch(/['"]Idempotency-Key['"]\s*:\s*item\.id/);
    });

    it('the service-worker flush reconstructs multipart FormData from the stored Blob', () => {
        const src = read('public/sw.js');
        expect(src).toMatch(/item\.kind === ['"]photo['"]/);
        expect(src).toMatch(/new FormData\(\)/);
        expect(src).toMatch(/new File\(\[item\.blob\], item\.fileName/);
        // The photo branch also carries the idempotency handle.
        expect(src).toMatch(/['"]Idempotency-Key['"]\s*:\s*item\.id/);
    });

    it('enforces a compressed-size cap at ENQUEUE so a huge blob cannot wedge the queue', () => {
        const src = read('src/lib/offline/outbox.ts');
        expect(src).toMatch(/MAX_QUEUED_PHOTO_BYTES\s*=/);
        // enqueuePhoto rejects an oversized blob before it enters the store.
        expect(src).toMatch(/export async function enqueuePhoto/);
        expect(src).toMatch(/blob\.size\s*>\s*MAX_QUEUED_PHOTO_BYTES/);
        expect(src).toMatch(/throw new PhotoTooLargeError/);
    });
});

// ─── 2b — the worker's eviction signal reaches the page ────────────

describe('the SW recreation signal is wired end to end', () => {
    // The WORKER half is executed in `tests/unit/offline/sw-outbox-recreation.test.ts`
    // — that drives the real `flushOutbox` against a fake IndexedDB. What is
    // structural here is the PAGE half: a listener inside a `useEffect` whose
    // absence is silent, and whose failure mode is an operator never being told
    // their queued work was deleted. Both ends must name the same message.
    it('the worker reports a recreation rather than swallowing it', () => {
        const sw = read('public/sw.js');
        expect(sw).toContain("const OUTBOX_RECREATED_MSG = 'outbox-db-recreated'");
        // The primary fix: never open a database that is not there.
        expect(sw).toMatch(/if \(\(await outboxDbExists\(\)\) === false\) return;/);
    });

    it('the page listens for it and routes it through the offline seam', () => {
        const reg = read('src/components/pwa/ServiceWorkerRegistrar.tsx');
        expect(reg).toContain("'outbox-db-recreated'");
        expect(reg).toContain('noteOutboxRecreatedElsewhere(');
        expect(reg).toContain("navigator.serviceWorker.addEventListener('message'");
        // Removed on unmount — a listener that outlives its effect fires
        // against a stale closure on every later navigation.
        expect(reg).toContain("navigator.serviceWorker.removeEventListener('message'");
    });
});

// ─── 3 — outbox single seam ────────────────────────────────────────

function walk(dir: string): string[] {
    const out: string[] = [];
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) return out;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(rel));
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
    }
    return out;
}

describe('outbox single seam', () => {
    it('only the offline lib references the raw outbox store', () => {
        const offenders = walk('src')
            .filter((rel) => !rel.startsWith(path.join('src', 'lib', 'offline')))
            .filter((rel) => /getOutboxStore|new LocalStorageOutboxStore|new InMemoryOutboxStore/.test(read(rel)));
        expect(offenders).toEqual([]);
    });

    it('the operator panel goes through useOfflineSync', () => {
        const panel = read('src/components/offline/OfflineFieldPanel.tsx');
        expect(panel).toMatch(/useOfflineSync/);
        expect(/getOutboxStore/.test(panel)).toBe(false);
    });

    it('the flush lock is MODULE-scoped, not per hook instance', () => {
        // Originally a `flushing` useRef inside the hook. That guarded one
        // instance against itself, which was the wrong scope: five surfaces
        // mount this hook, and two mounted at once held a lock EACH, so both
        // could drain the same items concurrently. The lock now lives in
        // `outbox-state.ts` at module scope, shared by every instance —
        // strictly stronger, and the behaviour is executed (not just
        // asserted about) in tests/unit/offline/outbox-eviction.test.ts.
        const hook = read('src/lib/offline/use-offline-sync.ts');
        expect(hook).toMatch(/runExclusiveFlush/);
        // A per-instance ref must not come back: it would silently re-open
        // the double-drain window while still looking like a guard.
        expect(/flushing\s*=\s*useRef/.test(hook)).toBe(false);

        const state = read('src/lib/offline/outbox-state.ts');
        expect(state).toMatch(/let flushing = false/);
        expect(state).toMatch(/if \(flushing\) return null/);
    });

    it('the outbox asks for persistent storage, and records what it was told', () => {
        // The queue lives in storage the phone may evict. Calling persist()
        // is half of it; keeping the ANSWER is the other half — without a
        // recorded verdict nobody can tell whether an operator's lost work
        // was on a device that had refused persistence.
        const durability = read('src/lib/offline/durability.ts');
        expect(durability).toMatch(/storage\.persist\(\)/);
        expect(durability).toMatch(/DURABILITY_STORAGE_KEY/);
        // Asked at the engagement moment, not on first paint.
        const state = read('src/lib/offline/outbox-state.ts');
        expect(state).toMatch(/noteWorkQueued/);
        expect(read('src/lib/offline/use-offline-sync.ts')).toMatch(/noteWorkQueued\(\)/);
    });

    it('a foreground return re-drains the queue', () => {
        // iOS SUSPENDS a backgrounded PWA and has no Background Sync, so an
        // operator who regains signal with the phone in a pocket gets no
        // `online` event and no remount. Without this the queue sits until
        // they happen to open a surface that mounts the hook.
        const hook = read('src/lib/offline/use-offline-sync.ts');
        expect(hook).toMatch(/visibilitychange/);
        expect(hook).toMatch(/pageshow/);
    });
});

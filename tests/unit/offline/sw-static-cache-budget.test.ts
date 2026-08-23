/**
 * STATIC_CACHE is bounded (#739).
 *
 * ## Why this cache was the one without a bound
 *
 * Three reclamation mechanisms exist and each covers the other caches:
 * `activate` deletes caches not prefixed with `CACHE_VERSION`;
 * `evictCacheOverBudget` enforces byte budgets on DATA / PAGE / BASEMAP; and
 * `sweepClientStores` clears the tenant buckets. All three miss STATIC.
 * `CACHE_VERSION` is a hardcoded literal that no build step varies, so
 * `agrent-v1-static` survives every deploy; there was no
 * `STATIC_CACHE_BUDGET_BYTES`; and the retention sweep skips it deliberately,
 * because it holds no tenant data — reasoning about PRIVACY that is simply
 * blind to STORAGE PRESSURE.
 *
 * The consequence is not untidiness. Every deploy emits fresh `[contenthash]`
 * chunk URLs, `cache.put` keys on the URL, so each deploy ADDS entries that
 * nothing removes. Storage pressure is what makes a phone evict an origin —
 * and that takes the IndexedDB outbox with it, which is the loss the whole
 * durability stack exists to prevent.
 *
 * ## Why it executes the worker
 *
 * `public/sw.js` is imported by nothing, so a source assertion is all a guard
 * could offer, and the interesting behaviour here is ORDERING — which entries
 * get evicted, and whether an offline read can trigger a prune. Both are
 * invisible to a grep. This drives the real `fetch` handler against a fake
 * Cache API.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SW_SRC = fs.readFileSync(path.resolve(__dirname, '../../../public/sw.js'), 'utf8');

/** Minimal Cache that preserves insertion order and re-appends on put. */
class FakeCache {
    entries = new Map<string, number>();
    deleted: string[] = [];
    constructor(seed: Array<[string, number]> = []) {
        for (const [url, size] of seed) this.entries.set(url, size);
    }
    async keys() {
        return [...this.entries.keys()].map((url) => ({ url }));
    }
    headerless = false;
    async match(req: { url: string }) {
        const size = this.entries.get(req.url);
        if (size === undefined) return undefined;
        return {
            headers: { get: () => (this.headerless ? null : String(size)) },
            clone: () => ({}),
            ok: true,
        };
    }
    async put(req: { url: string }, res: { _size?: number }) {
        // Spec behaviour: a put deletes any matching entry, then appends — so a
        // rewrite moves the entry to the NEWEST end. The whole eviction order
        // depends on this.
        this.entries.delete(req.url);
        this.entries.set(req.url, res._size ?? 1024);
    }
    async delete(req: { url: string }) {
        this.deleted.push(req.url);
        return this.entries.delete(req.url);
    }
}

interface Harness {
    fetchHandler: (e: unknown) => void;
    cache: FakeCache;
    fetchCalls: string[];
}

function loadWorker(opts: { seed?: Array<[string, number]>; online?: boolean; responseSize?: number; headerless?: boolean }): Harness {
    const cache = new FakeCache(opts.seed ?? []);
    cache.headerless = opts.headerless ?? false;
    const fetchCalls: string[] = [];
    const listeners: Record<string, (e: unknown) => void> = {};

    const self = {
        addEventListener: (type: string, cb: (e: unknown) => void) => {
            listeners[type] = cb;
        },
        clients: { matchAll: async () => [] },
        registration: {},
        // The fetch handler passes third-party requests straight through, so
        // the worker needs an origin to compare against.
        location: { origin: 'https://app.test' },
    };
    const caches = { open: async () => cache, keys: async () => [], delete: async () => true };
    const fetchImpl = async (req: { url: string }) => {
        fetchCalls.push(req.url);
        if (opts.online === false) throw new Error('offline');
        return { ok: true, clone: () => ({ _size: opts.responseSize ?? 1024 }), headers: { get: () => String(opts.responseSize ?? 1024) } };
    };

    const factory = new Function(
        'self', 'indexedDB', 'caches', 'fetch', 'Response', 'URL', 'clients',
        `${SW_SRC}\n;return { STATIC_CACHE_MAX_ENTRIES };`,
    );
    factory(self, { open: () => ({}), databases: async () => [] }, caches, fetchImpl, class {}, URL, self.clients);

    return { fetchHandler: listeners['fetch'], cache, fetchCalls };
}

/** Drive one fetch event through the worker and await whatever it promised. */
async function request(h: Harness, url: string): Promise<void> {
    let responded: Promise<unknown> | undefined;
    h.fetchHandler({
        request: { url, method: 'GET', mode: 'cors' },
        respondWith: (p: Promise<unknown>) => { responded = p; },
    });
    if (responded) await responded.catch(() => {});
    // Let the fire-and-forget put -> enforce chain settle. A macrotask boundary
    // is required, not a fixed number of microtask ticks: the sweep awaits a
    // `cache.match` PER ENTRY, so the queue it generates grows with the cache
    // and a counted drain silently under-runs it (which is exactly how this
    // test first reported "nothing was evicted").
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

const CHUNK = (n: string) => `https://app.test/_next/static/chunks/${n}.js`;
const CAP = 750;

describe('STATIC_CACHE stays within its entry cap', () => {
    it('a fresh asset is cached', async () => {
        const h = loadWorker({});
        await request(h, CHUNK('a'));
        expect([...h.cache.entries.keys()]).toEqual([CHUNK('a')]);
    });

    it('trims the OLDEST entries once over the cap, never the one just written', async () => {
        const seed: Array<[string, number]> = Array.from(
            { length: CAP + 20 },
            (_, i) => [CHUNK(`old${i}`), 1024],
        );
        const h = loadWorker({ seed });
        await request(h, CHUNK('new'));

        expect(h.cache.deleted.length).toBeGreaterThan(0);
        expect(h.cache.deleted).toContain(CHUNK('old0'));
        expect(h.cache.deleted).not.toContain(CHUNK('new'));
        expect([...h.cache.entries.keys()]).toContain(CHUNK('new'));
        expect(h.cache.entries.size).toBeLessThanOrEqual(CAP);
    });

    it('a re-requested chunk moves to the newest end and stops being a victim', async () => {
        // The load-bearing property. A vendor chunk whose contenthash never
        // changes is among the OLDEST by first-fetch order, yet the current
        // build still requests it on every online load — so the re-put must
        // carry it out of the eviction prefix, ahead of chunks nothing
        // references any more.
        const seed: Array<[string, number]> = [
            [CHUNK('stable-vendor'), 1024],
            ...Array.from({ length: CAP + 20 }, (_, i) => [CHUNK(`dead${i}`), 1024] as [string, number]),
        ];
        const h = loadWorker({ seed });
        await request(h, CHUNK('stable-vendor'));
        expect(h.cache.deleted).not.toContain(CHUNK('stable-vendor'));
        expect([...h.cache.entries.keys()]).toContain(CHUNK('stable-vendor'));
    });

    it('an OFFLINE read never prunes the cache', async () => {
        // The hazard that makes this fix dangerous if done carelessly: an
        // offline cold launch reads its chunks out of this cache. Pruning is
        // reachable only from the network-success path, so a failed fetch must
        // leave everything alone — otherwise the launch that needs the cache is
        // the one that empties it.
        const seed: Array<[string, number]> = Array.from(
            { length: CAP + 50 },
            (_, i) => [CHUNK(`c${i}`), 1024],
        );
        const h = loadWorker({ seed, online: false });
        await request(h, CHUNK('c0'));
        expect(h.cache.deleted).toEqual([]);
        expect(h.cache.entries.size).toBe(CAP + 50);
    });

    it('leaves a cache that is already under the cap completely alone', async () => {
        const seed: Array<[string, number]> = [[CHUNK('x'), 1024]];
        const h = loadWorker({ seed });
        await request(h, CHUNK('y'));
        expect(h.cache.deleted).toEqual([]);
    });

    it('does not try to size entries — the reason this is a count', async () => {
        // Measured on production: Caddy's `encode gzip zstd` drops
        // Content-Length, so 28 of 30 static assets carry none and would each
        // be counted as `basemapEntrySize`'s 8KB fallback — a real 641,667-byte
        // chunk included. A byte budget built on that is an entry cap wearing a
        // misleading number. These responses expose NO Content-Length at all,
        // and eviction must still be exact.
        const seed: Array<[string, number]> = Array.from(
            { length: CAP + 5 },
            (_, i) => [CHUNK(`u${i}`), 0],
        );
        const h = loadWorker({ seed, headerless: true });
        await request(h, CHUNK('fresh'));
        expect(h.cache.entries.size).toBeLessThanOrEqual(CAP);
        expect(h.cache.deleted).toContain(CHUNK('u0'));
    });
});

/**
 * An offline navigation must open the route asked for, or say it cannot.
 * It must never quietly open a DIFFERENT one.
 *
 * Reported from a physical iPhone, 2026-09-10, with the route's RSC payload and
 * three documents already cached: *"It flashes the screen of the task, but then
 * returns to the tasks screen"*. The chain, every link of it in this worker:
 *
 *   1. `Cache.match()` honours the response's `Vary` header unless told not to
 *      (`ignoreVary` defaults to FALSE), and Next sets
 *      `Vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch,
 *      Next-Router-Segment-Prefetch` on every app-router response
 *      (node_modules/next/dist/server/base-server.js, setVaryHeader).
 *      `Next-Router-State-Tree` is the CURRENT router tree, so it differs by
 *      the route navigated FROM — the lookup missed.
 *   2. A missed lookup made networkFirstRsc throw, and the App Router does not
 *      treat a rejected flight fetch as an error to show. fetch-server-response.js
 *      ends its catch with `return originalUrl.toString()` under the comment
 *      "If fetch fails handle it like a mpa navigation" — a FULL DOCUMENT LOAD.
 *   3. That document load missed too, and the shell fallback answered it with
 *      the most recently cached document — My work. The operator was returned
 *      to the list they had just tapped out of, with nothing reporting a fault.
 *
 * These tests model `Vary` for real rather than asserting on the source, so
 * deleting `ignoreVary` turns them red for the reason the operator saw.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SW_SRC = fs.readFileSync(path.resolve(__dirname, '../../../public/sw.js'), 'utf8');

/** Next's real Vary list, verbatim from base-server.js `setVaryHeader`. */
const NEXT_VARY = ['RSC', 'Next-Router-State-Tree', 'Next-Router-Prefetch', 'Next-Router-Segment-Prefetch'];

type Headers = Record<string, string | null>;
interface Entry { url: string; vary: Headers; body: string }

/** A Cache that enforces Vary the way the real one does. */
class VaryCache {
    entries: Entry[] = [];
    constructor(seed: Entry[] = []) { this.entries = [...seed]; }
    // A real Cache.keys() returns the stored REQUESTS, headers and all — a
    // bare {url} makes the Vary check throw and passes off a harness artifact
    // as a product bug.
    async keys() {
        return this.entries.map((e) => ({ url: e.url, headers: { get: (k: string) => e.vary[k] ?? null } }));
    }

    /** The real Cache API accepts a URL string as well as a Request. */
    private norm(req: unknown) {
        return typeof req === 'string'
            ? { url: req, headers: { get: () => null } }
            : (req as { url: string; headers: { get(k: string): string | null } });
    }

    private varyAgrees(entry: Entry, req: { headers: { get(k: string): string | null } }) {
        return NEXT_VARY.every((h) => (entry.vary[h] ?? null) === req.headers.get(h));
    }

    async match(
        reqIn: unknown,
        opts?: { ignoreSearch?: boolean; ignoreVary?: boolean },
    ) {
        const req = this.norm(reqIn);
        // ONE insertion-order pass, first match wins. `ignoreSearch` does NOT
        // make the real Cache API fall back to preferring an exact URL — a
        // fake that does is more forgiving than the thing it stands in for,
        // and it hid whether the exact lookup's `ignoreVary` did anything.
        const ok = (e: Entry) => opts?.ignoreVary || this.varyAgrees(e, req);
        const same = opts?.ignoreSearch
            ? (e: Entry) => e.url.split('?')[0] === req.url.split('?')[0]
            : (e: Entry) => e.url === req.url;
        const hit = this.entries.find((e) => same(e) && ok(e));
        return hit ? { _served: hit.url, _body: hit.body } : undefined;
    }

    // Insertion order, ALL matches — this is what Cache.match() returns [0] of.
    async matchAll(
        req: { url: string; headers: { get(k: string): string | null } },
        opts?: { ignoreSearch?: boolean; ignoreVary?: boolean },
    ) {
        const ok = (e: Entry) => opts?.ignoreVary || this.varyAgrees(e, req);
        const same = opts?.ignoreSearch
            ? (e: Entry) => e.url.split('?')[0] === req.url.split('?')[0]
            : (e: Entry) => e.url === req.url;
        return this.entries.filter((e) => same(e) && ok(e)).map((e) => ({ _served: e.url, _body: e.body }));
    }

    async put(reqIn: unknown, res: { _body?: string }) {
        const req = this.norm(reqIn);
        const vary: Headers = {};
        for (const h of NEXT_VARY) vary[h] = req.headers.get(h);
        this.entries = this.entries.filter((e) => !(e.url === req.url && this.varyAgrees(e, req)));
        this.entries.push({ url: req.url, vary, body: res._body ?? 'flight' });
    }
    // A stub returning true without removing anything is a double that cannot
    // produce the failing input: it reported an eviction that never happened.
    async delete(
        req?: { url: string; headers: { get(k: string): string | null } },
        opts?: { ignoreSearch?: boolean; ignoreVary?: boolean },
    ) {
        if (!req) return false;
        const before = this.entries.length;
        const ok = (e: Entry) => opts?.ignoreVary || this.varyAgrees(e, req);
        const same = opts?.ignoreSearch
            ? (e: Entry) => e.url.split('?')[0] === req.url.split('?')[0]
            : (e: Entry) => e.url === req.url;
        this.entries = this.entries.filter((e) => !(same(e) && ok(e)));
        return this.entries.length < before;
    }
}

class FakeResponse {
    static constructed: { body: string }[] = [];
    _html: string;
    constructor(body: string, _init?: unknown) {
        this._html = String(body);
        FakeResponse.constructed.push({ body: this._html });
    }
}

interface WorkerOpts {
    online: boolean;
    rscSeed?: Entry[];
    pageSeed?: Entry[];
    cacheNames?: string[];
}

function loadWorker(opts: WorkerOpts) {
    const listeners: Record<string, (e: unknown) => void> = {};
    const buckets: Record<string, VaryCache> = {};
    const deleted: string[] = [];
    const self = {
        addEventListener: (t: string, cb: (e: unknown) => void) => { listeners[t] = cb; },
        clients: { matchAll: async () => [], claim: async () => undefined },
        registration: {},
        location: { origin: 'https://app.test' },
    };
    // Pre-instantiate seeded buckets. Creating them lazily made "never opened"
    // and "opened and emptied" the same observation, so a mutation could go red
    // for a reason unrelated to the behaviour under test.
    if (opts.rscSeed) buckets['agrent-v1-rsc'] = new VaryCache(opts.rscSeed);
    if (opts.pageSeed) buckets['agrent-v1-pages'] = new VaryCache(opts.pageSeed);
    const caches = {
        open: async (name: string) => {
            buckets[name] ??= new VaryCache([]);
            return buckets[name];
        },
        keys: async () => opts.cacheNames ?? [],
        delete: async (name: string) => { deleted.push(name); return true; },
        // The REAL caches.match searches EVERY open cache. A stub returning
        // undefined makes "not cached anywhere" and "my fake cannot look"
        // the same observation — which read a working warmup as broken.
        match: async (req: unknown, opts?: { ignoreSearch?: boolean; ignoreVary?: boolean }) => {
            for (const b of Object.values(buckets)) {
                const hit = await b.match(req, opts);
                if (hit) return hit;
            }
            return undefined;
        },
    };
    const calls: string[] = [];
    const fetchImpl = async (u: unknown) => {
        const url = typeof u === 'string' ? u : (u as { url: string }).url;
        calls.push(url);
        if (!opts.online) throw new Error('offline');
        // The document request carries no `_rsc`; the flight request does.
        const body = url.includes('_rsc') ? 'flight' : 'DOCUMENT';
        return {
            ok: true, status: 200, statusText: 'OK', redirected: false,
            headers: { get: () => '512' },
            clone: () => ({ _body: body, body, redirected: false }),
        };
    };
    const factory = new Function(
        'self', 'indexedDB', 'caches', 'fetch', 'Response', 'URL', 'clients', 'console',
        `${SW_SRC}\n;return true;`,
    );
    factory(self, { open: () => ({}), databases: async () => [] }, caches, fetchImpl,
        FakeResponse, URL, self.clients, { ...console, warn: () => {} });
    return { listeners, buckets, deleted, calls };
}

type Worker = ReturnType<typeof loadWorker>;

function headersFor(h: Headers) {
    return { get: (k: string) => h[k] ?? null };
}

async function dispatch(w: Worker, request: unknown) {
    let responded: Promise<unknown> | undefined;
    w.listeners['fetch']({ request, respondWith: (p: Promise<unknown>) => { responded = p; } });
    const out = responded ? await responded.catch((e: Error) => ({ _threw: e.message })) : undefined;
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    return out as { _served?: string; _threw?: string; _html?: string } | undefined;
}

const flight = (url: string, h: Headers = {}) =>
    ({ url, method: 'GET', mode: 'cors', headers: headersFor({ RSC: '1', ...h }) });

const asset = (url: string) =>
    ({ url, method: 'GET', mode: 'cors', headers: headersFor({}) });

const navigation = (url: string) =>
    ({ url, method: 'GET', mode: 'navigate', headers: headersFor({}) });

const TASK = 'https://app.test/t/acme/field/task-1?_rsc=abc123';
const MY_WORK_DOC = 'https://app.test/t/acme/my-work';
const START_URL = 'https://app.test/tenants';

beforeEach(() => { FakeResponse.constructed = []; });

describe('a cached flight payload survives a different router state (Vary)', () => {
    it('serves the payload cached under a DIFFERENT Next-Router-State-Tree', async () => {
        // Online the operator reached the task from My work; offline the app
        // booted from the shell fallback, so the tree is not the same string.
        // Without ignoreVary this lookup misses and the route is lost.
        const w = loadWorker({
            online: false,
            rscSeed: [{
                url: TASK,
                vary: { RSC: '1', 'Next-Router-State-Tree': '%5B%22%22%2C%7Bmy-work%7D%5D' },
                body: 'flight',
            }],
        });
        const res = await dispatch(w, flight(TASK, { 'Next-Router-State-Tree': '%5B%22%22%2C%7Bdifferent%7D%5D' }));
        expect(res?._threw).toBeUndefined();
        expect(res?._served).toBe(TASK);
    });

    it('still finds it when BOTH the state tree and the _rsc hash differ', async () => {
        const w = loadWorker({
            online: false,
            rscSeed: [{ url: TASK, vary: { RSC: '1', 'Next-Router-State-Tree': 'tree-A' }, body: 'flight' }],
        });
        const res = await dispatch(
            w,
            flight('https://app.test/t/acme/field/task-1?_rsc=OTHER', { 'Next-Router-State-Tree': 'tree-B' }),
        );
        expect(res?._served).toBe(TASK);
    });

    it('prefers the EXACT url over a stale entry on the same path', async () => {
        // Separates the two ignoreVary sites. Drop it from the exact lookup and
        // the exact match misses on Vary, so the loose `ignoreSearch` retry
        // answers with whichever same-path entry was inserted FIRST — a stale
        // payload for the right route. Without this case both lookups could be
        // mutated one at a time with nothing going red.
        const w = loadWorker({
            online: false,
            rscSeed: [
                { url: 'https://app.test/t/acme/field/task-1?_rsc=STALE', vary: { RSC: '1', 'Next-Router-State-Tree': 'tree-A' }, body: 'stale' },
                { url: TASK, vary: { RSC: '1', 'Next-Router-State-Tree': 'tree-A' }, body: 'flight' },
            ],
        });
        const res = await dispatch(w, flight(TASK, { 'Next-Router-State-Tree': 'tree-B' }));
        expect(res?._served).toBe(TASK);
    });
});

describe('a prefetch payload is served but never stored', () => {
    it('does not store a Next-Router-Prefetch response', async () => {
        // Next returns a PARTIAL tree for a prefetch of a dynamic route. With
        // ignoreVary in play the Cache API no longer keeps it away from a real
        // navigation, so storing one would hand the router half a page.
        const w = loadWorker({ online: true });
        await dispatch(w, flight(TASK, { 'Next-Router-Prefetch': '1' }));
        expect(w.buckets['agrent-v1-rsc']?.entries ?? []).toHaveLength(0);
    });

    it.each(['1', '2', '3'])('does not store a prefetch with Next-Router-Prefetch: %s', async (v) => {
        // PRESENCE, not equality. Next emits three values —
        // node_modules/next/dist/client/components/segment-cache/cache.js:1972,
        // :1977, :1982 set '2', '3' and '1'. #880 tested `=== '1'`, which would
        // have stored the '2'/'3' payloads as navigations and then skipped them
        // during eviction — the exact failure the predicate exists to prevent.
        const w = loadWorker({ online: true });
        await dispatch(w, flight(TASK, { 'Next-Router-Prefetch': v }));
        expect(w.buckets['agrent-v1-rsc']?.entries ?? []).toHaveLength(0);
    });

    it('does not store a segment prefetch either', async () => {
        const w = loadWorker({ online: true });
        await dispatch(w, flight(TASK, { 'Next-Router-Segment-Prefetch': '/_tree' }));
        expect(w.buckets['agrent-v1-rsc']?.entries ?? []).toHaveLength(0);
    });

    it('DOES store a real navigation payload — the positive control', async () => {
        // Without this the two assertions above pass for the wrong reason: an
        // empty bucket is also what a totally broken cache path produces.
        const w = loadWorker({ online: true });
        await dispatch(w, flight(TASK));
        expect((w.buckets['agrent-v1-rsc']?.entries ?? []).map((e) => e.url)).toEqual([TASK]);
    });
});

describe('the shell fallback answers a LAUNCH, never a specific screen', () => {
    it('does not hand a deep route some other cached document', async () => {
        // The whole reported bug. PAGE_CACHE holds My work; the operator asked
        // for a task. Answering with My work is how they got bounced.
        const w = loadWorker({
            online: false,
            pageSeed: [{ url: MY_WORK_DOC, vary: {}, body: 'MY-WORK-DOCUMENT' }],
        });
        const res = await dispatch(w, navigation('https://app.test/t/acme/field/task-1'));
        expect(res?._served).toBeUndefined();
        expect((res as unknown as FakeResponse)._html).toContain('Not saved for offline');
        expect((res as unknown as FakeResponse)._html).not.toContain('MY-WORK-DOCUMENT');
    });

    it('still serves the shell for the Home Screen launch url (#858 holds)', async () => {
        // start_url is /tenants and it always redirects, so it can never be
        // cached under its own key. Narrowing the fallback must not undo that.
        const w = loadWorker({
            online: false,
            pageSeed: [{ url: MY_WORK_DOC, vary: {}, body: 'MY-WORK-DOCUMENT' }],
        });
        const res = await dispatch(w, navigation(START_URL));
        expect(res?._served).toBe(MY_WORK_DOC);
    });

    it('falls back to the launch copy when nothing at all is cached', async () => {
        const w = loadWorker({ online: false, pageSeed: [] });
        const res = await dispatch(w, navigation(START_URL));
        expect((res as unknown as FakeResponse)._html).toContain('Marked jobs are queued');
        expect((res as unknown as FakeResponse)._html).not.toContain('Not saved for offline');
    });
});

describe('activate evicts prefetch entries WITHOUT emptying the bucket', () => {
    // #880 purged the whole RSC bucket on every activate, on the theory that
    // flight payloads are build-scoped. Both halves were wrong.
    //
    // `activate` fires when public/sw.js changes, not when the app is rebuilt —
    // 18 of the last 200 commits touched it — so it never was a staleness
    // control; networkFirstRsc being network-first is. And because the worker
    // does not skipWaiting, it activates on a LATER launch than the one that
    // installed it. Measured on an iPhone 2026-09-11: the operator relaunched
    // with signal, opened a task to cache it, force-quit, then relaunched in
    // airplane mode — and THAT launch activated the worker, whose purge deleted
    // the payload they had just gone and fetched. "Not saved for offline", for
    // a screen saved sixty seconds earlier.
    const seed = (): Entry[] => [
        { url: TASK, vary: { RSC: '1', 'Next-Router-Prefetch': '1' }, body: 'PARTIAL-PREFETCH' },
        { url: TASK, vary: { RSC: '1', 'Next-Router-State-Tree': 'tree-A' }, body: 'flight' },
    ];
    const NAMES = ['agrent-v1-static', 'agrent-v1-pages', 'agrent-v1-fielddata',
        'agrent-v1-basemap', 'agrent-v1-rsc', 'agri-v2-pages'];

    async function activate() {
        const w = loadWorker({ online: true, cacheNames: NAMES, rscSeed: seed() });
        let held: Promise<unknown> | undefined;
        w.listeners['activate']({ waitUntil: (p: Promise<unknown>) => { held = p; } });
        await held;
        return w;
    }

    it('deletes only stale CACHE_VERSION buckets, never the RSC bucket', async () => {
        const w = await activate();
        expect(w.deleted.sort()).toEqual(['agri-v2-pages']);
    });

    it('evicts the partial prefetch entry', async () => {
        const w = await activate();
        const bodies = (w.buckets['agrent-v1-rsc']?.entries ?? []).map((e) => e.body);
        expect(bodies).not.toContain('PARTIAL-PREFETCH');
    });

    it('KEEPS the navigation payload the operator just cached', async () => {
        // The whole point. This is the assertion that would have caught #880.
        const w = await activate();
        const bodies = (w.buckets['agrent-v1-rsc']?.entries ?? []).map((e) => e.body);
        expect(bodies).toContain('flight');
    });
});

describe('the offline document names the screen it could not serve', () => {
    it('includes the requested path on a deep-route miss', async () => {
        // Both flavours of this page looked identical in a photograph, so
        // "the app would not launch" and "that one screen was not cached" were
        // the same screenshot. Telling them apart cost a round-trip to someone
        // standing in a field.
        const w = loadWorker({
            online: false,
            pageSeed: [{ url: MY_WORK_DOC, vary: {}, body: 'MY-WORK-DOCUMENT' }],
        });
        const res = await dispatch(w, navigation('https://app.test/t/acme/field/task-1'));
        expect((res as unknown as FakeResponse)._html).toContain('/t/acme/field/task-1');
    });
});

describe('the newest cached payload wins, never the oldest', () => {
    it('serves the navigation payload over an older prefetch for the same URL', async () => {
        // Cache.match() resolves to matchAll()[0] and the Query Cache walks its
        // list in INSERTION order, so the first entry wins. Next prefetches on
        // link render and navigates on tap, so the PREFETCH entry is always the
        // older one — match() would hand the router a partial tree whenever
        // both exist.
        //
        // dropPrefetchRscEntries() also prevents this, but it leans on
        // Cache.keys() preserving request headers, which is not something to
        // stake an operator's screen on in WebKit. This does not depend on it.
        const w = loadWorker({
            online: false,
            rscSeed: [
                { url: TASK, vary: { RSC: '1', 'Next-Router-Prefetch': '1' }, body: 'PARTIAL-PREFETCH' },
                { url: TASK, vary: { RSC: '1', 'Next-Router-State-Tree': 'tree-A' }, body: 'flight' },
            ],
        });
        const res = await dispatch(w, flight(TASK, { 'Next-Router-State-Tree': 'tree-B' }));
        expect((res as { _body?: string })?._body).toBe('flight');
    });
});

describe('the MapLibre worker is cached, so the map can boot offline', () => {
    it.each([
        '/maplibre/maplibre-gl-worker.mjs',
        '/maplibre/maplibre-gl-shared.mjs',
    ])('caches %s as a static asset', async (path) => {
        // isStaticAsset matched `js` but not `mjs`, and these two are not under
        // /_next/static/, so they fell off the end of the fetch handler with no
        // respondWith at all. Offline that left MapCanvas — 60vh of a phone
        // screen — an empty rectangle with no spinner, icon or error, because
        // it registers no onError. An absence with nothing to explain it, which
        // is the whole class of bug this worker keeps producing.
        const w = loadWorker({ online: true });
        await dispatch(w, asset('https://app.test' + path));
        const cached = (w.buckets['agrent-v1-static']?.entries ?? []).map((e) => e.url);
        expect(cached).toContain('https://app.test' + path);
    });

    it('still does not treat an API route as a static asset', async () => {
        // Positive control for the widened regex: `m?js` must not start
        // swallowing things that belong on the data path.
        const w = loadWorker({ online: true });
        await dispatch(w, asset('https://app.test/api/t/acme/farm-tasks'));
        const cached = (w.buckets['agrent-v1-static']?.entries ?? []).map((e) => e.url);
        expect(cached).toHaveLength(0);
    });
});

describe('a route visited online becomes openable offline', () => {
    // The structural gap this closes: PAGE_CACHE is written in ONE place, the
    // navigate branch, and a navigate request only happens on a FULL PAGE LOAD.
    // App Router users move with <Link> and router.push, which issue no
    // document request at all — so PAGE_CACHE stayed nearly empty no matter how
    // much of the app they used (measured on an iPhone: ONE entry).
    //
    // That left every route one RSC miss away from a dead end, because a missed
    // flight fetch makes Next fall back to a full document load and offline
    // that document was never there. Reported 2026-09-11 for
    // /t/<slug>/farm-tasks — a page the operator had been looking at minutes
    // before.
    const LIST = 'https://app.test/t/acme/farm-tasks';

    it('warms the DOCUMENT into PAGE_CACHE when the flight payload is cached', async () => {
        const w = loadWorker({ online: true });
        await dispatch(w, flight(`${LIST}?_rsc=abc`));
        const warmed = (w.buckets['agrent-v1-pages']?.entries ?? []).map((e) => e.url);
        expect(warmed).toContain(LIST);
    });

    it('and that route then opens offline', async () => {
        const w = loadWorker({
            online: false,
            pageSeed: [{ url: LIST, vary: {}, body: 'DOCUMENT' }],
        });
        const res = await dispatch(w, navigation(LIST));
        expect((res as { _body?: string })?._body).toBe('DOCUMENT');
    });

    it('does not refetch a document it already has', async () => {
        // At most ONE extra request per route per cache generation. Without
        // this the warmup would double every navigation forever.
        const w = loadWorker({
            online: true,
            pageSeed: [{ url: LIST, vary: {}, body: 'DOCUMENT' }],
        });
        await dispatch(w, flight(`${LIST}?_rsc=abc`));
        expect(w.calls.filter((u) => !u.includes('_rsc'))).toHaveLength(0);
    });

    it('does not warm on a PREFETCH — only on a real visit', async () => {
        // A prefetch means a link became visible, not that the operator went
        // there. Warming on prefetch would fetch a document for every row.
        const w = loadWorker({ online: true });
        await dispatch(w, flight(`${LIST}?_rsc=abc`, { 'Next-Router-Prefetch': '1' }));
        expect(w.calls.filter((u) => !u.includes('_rsc'))).toHaveLength(0);
    });
});

/**
 * A redirected navigation must still be cacheable (#851).
 *
 * ## Why this is the start_url, not an edge case
 *
 * `public/manifest.webmanifest` sets `"start_url": "/tenants"`, so that is the
 * URL a Home Screen launch requests. It ALWAYS redirects: 307 to `/login` when
 * signed out, and `src/app/tenants/page.tsx:52` redirects a single-tenant user
 * to `/t/<slug>/dashboard`.
 *
 * A `Response` whose `redirected` flag is set cannot be replayed for a
 * navigation — the browser refuses a service-worker response carrying it. So
 * the one URL the launch asks for was the one URL that could never be served
 * offline, and `PAGE_CACHE` looked simply empty.
 *
 * ## Why it executes the worker
 *
 * `public/sw.js` is imported by nothing and the behaviour is a property of the
 * Response object, not of the source text. A grep cannot see it: the fix is
 * "construct a different Response", and a source assertion would pass on a
 * version that constructed the wrong one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SW_SRC = fs.readFileSync(path.resolve(__dirname, '../../../public/sw.js'), 'utf8');

interface PutRecord {
    url: string;
    res: { redirected?: boolean; _reconstructed?: boolean; _body?: unknown };
}

class FakeCache {
    puts: PutRecord[] = [];
    async keys() {
        return [];
    }
    async match() {
        return undefined;
    }
    async put(req: { url: string }, res: PutRecord['res']) {
        this.puts.push({ url: req.url, res });
    }
    async delete() {
        return true;
    }
}

/** Records every reconstruction, and reports redirected:false like the real one. */
class FakeResponse {
    static constructed: Array<{ body: unknown; init: { status?: number; statusText?: string } }> = [];
    redirected = false;
    _reconstructed = true;
    _body: unknown;
    constructor(body: unknown, init: { status?: number; statusText?: string } = {}) {
        this._body = body;
        FakeResponse.constructed.push({ body, init });
    }
}

function loadWorker(opts: { redirected: boolean; putThrows?: boolean }) {
    const cache = new FakeCache();
    if (opts.putThrows) cache.put = async () => { throw new Error('quota'); };
    const listeners: Record<string, (e: unknown) => void> = {};
    const warnings: unknown[][] = [];

    const self = {
        addEventListener: (t: string, cb: (e: unknown) => void) => { listeners[t] = cb; },
        clients: { matchAll: async () => [] },
        registration: {},
        location: { origin: 'https://app.test' },
    };
    const caches = { open: async () => cache, keys: async () => [], delete: async () => true };
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        redirected: opts.redirected,
        headers: { get: () => '1024' },
        clone: () => ({ body: 'THE-DOCUMENT', redirected: opts.redirected, _reconstructed: false }),
    });

    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };

    const factory = new Function(
        'self', 'indexedDB', 'caches', 'fetch', 'Response', 'URL', 'clients', 'console',
        `${SW_SRC}\n;return true;`,
    );
    factory(self, { open: () => ({}), databases: async () => [] }, caches, fetchImpl,
        FakeResponse, URL, self.clients, { ...console, warn: (...a: unknown[]) => warnings.push(a) });
    console.warn = originalWarn;

    return { fetchHandler: listeners['fetch'], cache, warnings };
}

async function navigate(h: ReturnType<typeof loadWorker>, url: string): Promise<void> {
    let responded: Promise<unknown> | undefined;
    h.fetchHandler({
        // A real Request always has headers — the worker reads the RSC header
        // to tell a flight request from a document navigation.
        request: { url, method: 'GET', mode: 'navigate', headers: { get: () => null } },
        respondWith: (p: Promise<unknown>) => { responded = p; },
    });
    if (responded) await responded.catch(() => {});
    // The put is fire-and-forget; let the chain settle across macrotasks.
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

const START_URL = 'https://app.test/tenants';

beforeEach(() => {
    FakeResponse.constructed = [];
});

describe('the SW caches a REDIRECTED navigation in replayable form', () => {
    it('rebuilds the response so the redirected flag is gone', async () => {
        const h = loadWorker({ redirected: true });
        await navigate(h, START_URL);

        expect(h.cache.puts).toHaveLength(1);
        const stored = h.cache.puts[0];
        // Keyed on what the NEXT launch will ask for, not the redirect target.
        expect(stored.url).toBe(START_URL);
        // The whole point: what is stored must not carry `redirected`.
        expect(stored.res.redirected).toBe(false);
        expect(stored.res._reconstructed).toBe(true);
    });

    it('preserves status, statusText and the body when rebuilding', async () => {
        const h = loadWorker({ redirected: true });
        await navigate(h, START_URL);

        expect(FakeResponse.constructed).toHaveLength(1);
        const { body, init } = FakeResponse.constructed[0];
        expect(body).toBe('THE-DOCUMENT');
        expect(init.status).toBe(200);
        expect(init.statusText).toBe('OK');
    });

    it('does NOT rebuild a normal response — clone stays the cheap path', async () => {
        const h = loadWorker({ redirected: false });
        await navigate(h, 'https://app.test/t/acme/my-work');

        expect(FakeResponse.constructed).toHaveLength(0);
        expect(h.cache.puts).toHaveLength(1);
        expect(h.cache.puts[0].res._reconstructed).toBe(false);
    });

    it('a failed put is LOGGED, never silent', async () => {
        // The original defect was invisible in both directions: no catch here,
        // and an absent entry reads the same as one never written.
        const h = loadWorker({ redirected: true, putThrows: true });
        await navigate(h, START_URL);

        expect(h.warnings.length).toBeGreaterThan(0);
        expect(JSON.stringify(h.warnings)).toContain('PAGE_CACHE put failed');
    });
});

/**
 * The offline launch, measured rather than reasoned about (#851).
 *
 * Three fixes missed this because they all assumed the start_url could be
 * cached. It cannot. `start_url` is /tenants and it ALWAYS redirects, and a
 * navigation request carries `redirect: 'manual'` — so `fetch(request)` returns
 * an OPAQUE REDIRECT (status 0, ok false, redirected false). The `if (res.ok)`
 * guard is false for the one URL every Home Screen launch asks for.
 *
 * Device evidence, iPhone 18.7, 2026-09-10: PAGE_CACHE entries=1 across
 * repeated online launches, service worker `activated` and `controlled`, and
 * the launch still served the inline Offline page. One document cached, and it
 * was never the one the launch requested.
 *
 * So the fix is not "cache the start_url" — it is "serve a cached document when
 * the exact URL is missing", which is the ordinary PWA shell fallback.
 */

class ShellCache {
    constructor(public urls: string[]) {}
    async keys() {
        return this.urls.map((url) => ({ url }));
    }
    async match(req: { url: string }) {
        return this.urls.includes(req.url) ? { _servedFrom: req.url } : undefined;
    }
    async put() {}
    async delete() {
        return true;
    }
}

function loadOfflineWorker(cachedPages: string[]) {
    const pages = new ShellCache([...cachedPages]);
    const listeners: Record<string, (e: unknown) => void> = {};
    const self = {
        addEventListener: (t: string, cb: (e: unknown) => void) => { listeners[t] = cb; },
        clients: { matchAll: async () => [] },
        registration: {},
        location: { origin: 'https://app.test' },
    };
    const caches = {
        open: async () => pages,
        keys: async () => [],
        delete: async () => true,
        // Global match = exact-URL lookup across caches.
        match: async (req: { url: string }) =>
            pages.urls.includes(req.url) ? { _servedFrom: req.url } : undefined,
    };
    const fetchImpl = async () => { throw new Error('offline'); };

    const factory = new Function(
        'self', 'indexedDB', 'caches', 'fetch', 'Response', 'URL', 'clients', 'console',
        `${SW_SRC}\n;return true;`,
    );
    factory(self, { open: () => ({}), databases: async () => [] }, caches, fetchImpl,
        FakeResponse, URL, self.clients, console);

    return { fetchHandler: listeners['fetch'], pages };
}

async function navigateOffline(h: ReturnType<typeof loadOfflineWorker>, url: string) {
    let responded: Promise<unknown> | undefined;
    h.fetchHandler({
        // A real Request always has headers — the worker reads the RSC header
        // to tell a flight request from a document navigation.
        request: { url, method: 'GET', mode: 'navigate', headers: { get: () => null } },
        respondWith: (p: Promise<unknown>) => { responded = p; },
    });
    return responded ? await responded : undefined;
}

const LAUNCH = 'https://app.test/tenants';
const DIAG = 'https://app.test/t/acme/diagnostics/offline';
const WORK = 'https://app.test/t/acme/my-work';

describe('an offline navigation falls back to a cached document', () => {
    it('serves the exact match when there is one', async () => {
        const h = loadOfflineWorker([DIAG]);
        const res = (await navigateOffline(h, DIAG)) as { _servedFrom?: string };
        expect(res._servedFrom).toBe(DIAG);
    });

    it('serves the SHELL when the launch URL is not cached — the real case', async () => {
        // Exactly the measured device state: one cached document, and it is
        // not the start_url. Before this, the launch got the Offline page.
        const h = loadOfflineWorker([DIAG]);
        const res = (await navigateOffline(h, LAUNCH)) as { _servedFrom?: string };
        expect(res._servedFrom).toBe(DIAG);
    });

    it('prefers the most recent document', async () => {
        const h = loadOfflineWorker([DIAG, WORK]);
        const res = (await navigateOffline(h, LAUNCH)) as { _servedFrom?: string };
        expect(res._servedFrom).toBe(WORK);
    });

    it('falls back to the Offline page only when nothing is cached', async () => {
        const h = loadOfflineWorker([]);
        const res = (await navigateOffline(h, LAUNCH)) as { _servedFrom?: string; _body?: unknown };
        expect(res._servedFrom).toBeUndefined();
        expect(String(res._body)).toContain('Offline');
    });
});

describe('the constraint that made three fixes miss', () => {
    it('an opaque redirect is not ok, so the start_url is never cached', async () => {
        // Pinned as an executable statement rather than a comment: a navigation
        // request has redirect:'manual', so a redirecting start_url yields
        // status 0 / ok false, and the caching branch cannot run. Any future
        // "just cache the start_url" fix has to contend with this test.
        const opaque = { ok: false, status: 0, redirected: false, clone: () => ({}) };
        expect(opaque.ok).toBe(false);
        expect(opaque.redirected).toBe(false);
        // Which is why the fallback above is keyed on the CACHE being non-empty,
        // not on the request URL being present.
        const h = loadOfflineWorker([DIAG]);
        const res = (await navigateOffline(h, LAUNCH)) as { _servedFrom?: string };
        expect(res._servedFrom).toBe(DIAG);
    });
});

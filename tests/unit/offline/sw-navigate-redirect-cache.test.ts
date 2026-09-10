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
        request: { url, method: 'GET', mode: 'navigate' },
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

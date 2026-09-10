/**
 * Client-side route changes must work offline (#862 follow-up).
 *
 * A Next `<Link>` navigation does not issue a document request — the router
 * fetches the route's RSC payload. 41 of the 70 tenant pages are server
 * components, so offline, opening a task from My work fetched a payload that
 * was not there and Next surfaced the generic "Something went wrong" error
 * boundary. Measured on an iPhone 2026-09-10: the app opened offline, PAGE_CACHE
 * held 3 documents, and tapping a task still failed.
 *
 * The worker had ZERO knowledge of RSC (`grep -c '_rsc\|RSC'` → 0), so those
 * requests fell through to the network with no respondWith at all.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SW_SRC = fs.readFileSync(path.resolve(__dirname, '../../../public/sw.js'), 'utf8');

interface Entry { url: string; body: string }

class RscCache {
    entries: Entry[] = [];
    constructor(seed: Entry[] = []) { this.entries = [...seed]; }
    async keys() { return this.entries.map((e) => ({ url: e.url })); }
    async match(req: { url: string }, opts?: { ignoreSearch?: boolean }) {
        const exact = this.entries.find((e) => e.url === req.url);
        if (exact) return { _served: exact.url, _body: exact.body };
        if (opts?.ignoreSearch) {
            const bare = req.url.split('?')[0];
            const loose = this.entries.find((e) => e.url.split('?')[0] === bare);
            if (loose) return { _served: loose.url, _body: loose.body };
        }
        return undefined;
    }
    async put(req: { url: string }, res: { _body?: string }) {
        this.entries = this.entries.filter((e) => e.url !== req.url);
        this.entries.push({ url: req.url, body: res._body ?? 'flight' });
    }
    async delete() { return true; }
}

function loadWorker(opts: { online: boolean; seed?: Entry[] }) {
    const rsc = new RscCache(opts.seed ?? []);
    const listeners: Record<string, (e: unknown) => void> = {};
    const self = {
        addEventListener: (t: string, cb: (e: unknown) => void) => { listeners[t] = cb; },
        clients: { matchAll: async () => [] },
        registration: {},
        location: { origin: 'https://app.test' },
    };
    // Name-aware, deliberately. A single shared cache object made the
    // field-data path write into the RSC bucket, which broke the /api test in
    // a way that looked like a product bug and was not.
    const buckets: Record<string, RscCache> = {};
    const caches = {
        open: async (name: string) => {
            if (name.endsWith('-rsc')) return rsc;
            buckets[name] ??= new RscCache([]);
            return buckets[name];
        },
        keys: async () => [],
        delete: async () => true,
        match: async () => undefined,
    };
    const fetchImpl = async () => {
        if (!opts.online) throw new Error('offline');
        return { ok: true, status: 200, headers: { get: () => '512' }, clone: () => ({ _body: 'flight' }) };
    };
    const factory = new Function(
        'self', 'indexedDB', 'caches', 'fetch', 'Response', 'URL', 'clients', 'console',
        `${SW_SRC}\n;return true;`,
    );
    factory(self, { open: () => ({}), databases: async () => [] }, caches, fetchImpl,
        class {}, URL, self.clients, console);
    return { fetchHandler: listeners['fetch'], rsc };
}

async function rscFetch(h: ReturnType<typeof loadWorker>, url: string) {
    let responded: Promise<unknown> | undefined;
    h.fetchHandler({
        request: { url, method: 'GET', mode: 'cors', headers: { get: (k: string) => (k === 'RSC' ? '1' : null) } },
        respondWith: (p: Promise<unknown>) => { responded = p; },
    });
    const out = responded ? await responded.catch((e: Error) => ({ _threw: e.message })) : undefined;
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    return out as { _served?: string; _threw?: string } | undefined;
}

const TASK = 'https://app.test/t/acme/field/task-1?_rsc=abc123';

describe('RSC payloads are cached so a route opens offline', () => {
    it('caches the payload when online', async () => {
        const h = loadWorker({ online: true });
        await rscFetch(h, TASK);
        expect(h.rsc.entries.map((e) => e.url)).toEqual([TASK]);
    });

    it('serves it offline — the task opens instead of the error boundary', async () => {
        const h = loadWorker({ online: false, seed: [{ url: TASK, body: 'flight' }] });
        const res = await rscFetch(h, TASK);
        expect(res?._served).toBe(TASK);
        expect(res?._threw).toBeUndefined();
    });

    it('matches loosely when the _rsc hash differs', async () => {
        // `_rsc` encodes a build/router hash, so the visit that cached the
        // payload and the navigation that needs it can disagree on it.
        const h = loadWorker({ online: false, seed: [{ url: TASK, body: 'flight' }] });
        const res = await rscFetch(h, 'https://app.test/t/acme/field/task-1?_rsc=DIFFERENT');
        expect(res?._served).toBe(TASK);
    });

    it('still fails when nothing was ever cached for that route', async () => {
        // Honest: a route never opened online cannot be opened offline. The
        // error boundary is correct there — this fix is not a promise that
        // every route works, only the ones already visited.
        const h = loadWorker({ online: false, seed: [] });
        const res = await rscFetch(h, 'https://app.test/t/acme/never-seen?_rsc=x');
        expect(res?._threw).toBe('offline');
    });

    it('the /api branch is dispatched BEFORE the RSC branch', () => {
        // What actually keeps API requests off the RSC path is dispatch ORDER,
        // not the `startsWith('/api/')` line inside isRscRequest — an API
        // request is answered and returned before the RSC check is reached.
        //
        // Written as an ordering assertion because the behavioural version
        // could not fail: with the guard deleted the API request still never
        // reaches the RSC path, so the bucket stays empty either way. That test
        // passed under its own mutation, which is worth less than nothing. The
        // guard stays as belt-and-braces against a future reordering; THIS is
        // what detects the reordering.
        const handler = SW_SRC.slice(SW_SRC.indexOf("addEventListener('fetch'"));
        const api = handler.indexOf("startsWith('/api/')");
        const rsc = handler.indexOf('isRscRequest(request, url)');
        expect(api).toBeGreaterThan(-1);
        expect(rsc).toBeGreaterThan(-1);
        expect(api).toBeLessThan(rsc);
    });
});

/**
 * The service worker must not consume the outbox's eviction signal (#730).
 *
 * ## The defect this executes
 *
 * `IndexedDbOutboxStore.wasRecreated()` is the app's only EXACT eviction
 * signal, and it is delivered exactly once: `indexedDB.open` fires
 * `upgradeneeded` on whoever opens the destroyed database FIRST, and the flag
 * is consumed on read. The service worker opens the SAME database
 * (`agri-offline`) and its `openOutboxDb` created the object store when absent
 * — silently, because from its side that is indistinguishable from a cold
 * start.
 *
 * So an eviction followed by a race the worker won left the page opening a
 * database that already existed: no `upgradeneeded`, `recreated` stayed false,
 * `refreshOutboxState` mirrored an empty queue over the manifest, and the
 * record of what had been deleted was gone. The operator was told nothing.
 *
 * The race is not hypothetical and not test-only. `ServiceWorkerRegistrar`
 * nudges the worker to flush **on the `online` event** — the iOS fallback for
 * a platform with no Background Sync — which is exactly the moment a phone
 * that evicted storage while offline comes back. iOS is both the platform that
 * evicts and the platform that fires this path.
 *
 * ## Why this executes the worker instead of grepping it
 *
 * `public/sw.js` is not imported by anything, so nothing in the suite ran a
 * line of it. A guard asserting "the source contains a databases() check"
 * would pass against a check that is present and wrong. This loads the real
 * file and drives `flushOutbox` against a fake IndexedDB, so the assertions
 * are about what the worker DOES.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SW_SRC = fs.readFileSync(
    path.resolve(__dirname, '../../../public/sw.js'),
    'utf8',
);

interface Harness {
    flushOutbox: () => Promise<void>;
    opens: string[];
    posted: Array<{ type?: string }>;
}

/** Load the real worker with injected globals and hand back its internals. */
function loadWorker(opts: {
    /** `null` = the browser has no `indexedDB.databases()` (pre-14 WebKit). */
    existing: string[] | null;
    /** Whether an open finds the object store already present. */
    storePresent: boolean;
    items?: unknown[];
}): Harness {
    const opens: string[] = [];
    const posted: Array<{ type?: string }> = [];

    const makeDb = () => ({
        objectStoreNames: { contains: () => opts.storePresent },
        createObjectStore: () => ({}),
        close: () => {},
        transaction: () => ({
            objectStore: () => ({
                getAll: () => {
                    const rq: Record<string, unknown> = { result: opts.items ?? [] };
                    queueMicrotask(() => (rq.onsuccess as () => void)?.());
                    return rq;
                },
            }),
        }),
    });

    const indexedDB = {
        databases: opts.existing === null ? undefined : async () =>
            (opts.existing ?? []).map((name) => ({ name })),
        open: (name: string) => {
            opens.push(name);
            const req: Record<string, unknown> = { result: makeDb() };
            queueMicrotask(() => {
                if (!opts.storePresent) (req.onupgradeneeded as () => void)?.();
                (req.onsuccess as () => void)?.();
            });
            return req;
        },
    };

    const self = {
        addEventListener: () => {},
        clients: {
            matchAll: async () => [{ postMessage: (m: { type?: string }) => posted.push(m) }],
        },
        registration: {},
    };

    const factory = new Function(
        'self', 'indexedDB', 'caches', 'fetch', 'Response', 'URL', 'clients',
        `${SW_SRC}\n;return { flushOutbox };`,
    );
    const api = factory(
        self, indexedDB, { open: async () => ({}) }, async () => ({}),
        class {}, URL, self.clients,
    ) as { flushOutbox: () => Promise<void> };

    return { flushOutbox: api.flushOutbox, opens, posted };
}

describe('the worker and an evicted outbox database', () => {
    it('does NOT open a database that no longer exists', async () => {
        // The fix. Opening is what destroys the signal, and there is nothing
        // to gain: an absent database holds no queue to replay.
        const w = loadWorker({ existing: [], storePresent: false });
        await w.flushOutbox();
        expect(w.opens).toEqual([]);
    });

    it('still opens — and flushes — when the database is really there', async () => {
        // The other half. A guard that skipped every flush would satisfy the
        // assertion above and break the feature outright.
        const w = loadWorker({ existing: ['agri-offline'], storePresent: true });
        await w.flushOutbox();
        expect(w.opens).toEqual(['agri-offline']);
        expect(w.posted.map((m) => m.type)).toContain('outbox-flushed');
    });

    it('hands the signal to the page when it could not pre-check', async () => {
        // Pre-14 WebKit has no `databases()`, so the worker cannot avoid the
        // open. It must then report what it consumed rather than swallow it.
        const w = loadWorker({ existing: null, storePresent: false });
        await w.flushOutbox();
        expect(w.opens).toEqual(['agri-offline']);
        expect(w.posted.map((m) => m.type)).toEqual(['outbox-db-recreated']);
    });

    it('does not claim a recreation when it merely found an empty queue', async () => {
        // A drained queue and a destroyed one are the same observation to
        // everything except `upgradeneeded` — the distinction this whole
        // mechanism exists to preserve. Reporting loss here would produce the
        // false banner the durability notes call the worst outcome.
        const w = loadWorker({ existing: ['agri-offline'], storePresent: true, items: [] });
        await w.flushOutbox();
        expect(w.posted.map((m) => m.type)).not.toContain('outbox-db-recreated');
    });
});

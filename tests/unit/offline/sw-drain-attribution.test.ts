/**
 * The service-worker drain must respect `queuedByUserId` (#932).
 *
 * ## The defect this executes
 *
 * A replay uses `fetch`, which sends whatever session cookie is CURRENT — not
 * the one that queued the item. The PAGE drain has skipped foreign items since
 * #761 (`src/lib/offline/sync.ts`: "skip, never send, never drop. It waits for
 * its owner"). `public/sw.js` cannot import from `src/`, so its Background Sync
 * drain is a parallel reimplementation, and it had no attribution concept at
 * all — zero occurrences of `queuedByUserId`.
 *
 * So on a shared phone, operator A's queued work replayed under whoever was
 * signed in at flush time. That lands in three places, not one: the
 * hash-chained `AuditLog`, and — permanently, in a БАБХ compliance record —
 * `OperationParcel.completedByUserId`, a domain column.
 *
 * `src/lib/auth/sign-out.ts` already promises this cannot happen: "Since the
 * queue is bound to the operator who queued it, another operator signing in
 * cannot send it either — it is held, visibly, until its owner returns." The
 * page kept that promise; the worker broke it.
 *
 * ## Why this executes the worker rather than grepping it
 *
 * `public/sw.js` is imported by nothing, so a guard asserting "the source
 * mentions queuedByUserId" would pass against a mention that is present and
 * wrong — and the mirror between the two drains is maintained BY HAND, with
 * nothing enforcing it. This loads the real file and drives `flushOutbox`, so
 * every assertion is about what the worker DOES.
 *
 * ## Why identity comes from the server
 *
 * The worker cannot read the page's user id: `setCurrentUserId` is fed from the
 * server-rendered layout, so that value belongs to the DOCUMENT, and this same
 * worker replays cached documents — the shell fallback can hand operator B a
 * page rendered for A. Hence the whoami probe, and hence three outcomes rather
 * than two: a captive portal answers 200 with HTML, a proxy answers 502.
 * Neither is a 401, and treating either as verified sends under a wrong id.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SW_SRC = fs.readFileSync(path.resolve(__dirname, '../../../public/sw.js'), 'utf8');

type Whoami = { kind: 'user'; userId: string } | { kind: 'signed-out' } | { kind: 'unknown' };

interface Sent {
    url: string;
}

interface Harness {
    flushOutbox: () => Promise<void>;
    sent: Sent[];
    posted: Array<Record<string, unknown>>;
    removed: string[];
}

function loadWorker(opts: { items: Array<Record<string, unknown>>; whoami?: Whoami }): Harness {
    const sent: Sent[] = [];
    const posted: Array<Record<string, unknown>> = [];
    const removed: string[] = [];
    const who: Whoami = opts.whoami ?? { kind: 'user', userId: 'operator-b' };

    const store = {
        getAll: () => {
            const rq: Record<string, unknown> = { result: opts.items };
            queueMicrotask(() => (rq.onsuccess as () => void)?.());
            return rq;
        },
        delete: (id: string) => {
            removed.push(id);
            const rq: Record<string, unknown> = {};
            queueMicrotask(() => (rq.onsuccess as () => void)?.());
            return rq;
        },
        put: () => {
            const rq: Record<string, unknown> = {};
            queueMicrotask(() => (rq.onsuccess as () => void)?.());
            return rq;
        },
        get: (id: string) => {
            const rq: Record<string, unknown> = { result: opts.items.find((i) => i.id === id) };
            queueMicrotask(() => (rq.onsuccess as () => void)?.());
            return rq;
        },
    };

    const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        close: () => {},
        // `idbWrite` and `idbNoteDelivered` resolve on `tx.oncomplete`, which a
        // fake that never fires it turns into a hang — and a hung success path
        // makes every "does NOT send" assertion pass for the wrong reason.
        // Scheduling the callback here runs it after the caller has assigned it,
        // since assignment happens synchronously after `transaction()` returns.
        transaction: () => {
            const tx: Record<string, unknown> = { objectStore: () => store };
            queueMicrotask(() => (tx.oncomplete as (() => void) | undefined)?.());
            return tx;
        },
    };

    const indexedDB = {
        databases: async () => [{ name: 'agri-offline' }],
        open: () => {
            const req: Record<string, unknown> = { result: db };
            queueMicrotask(() => (req.onsuccess as () => void)?.());
            return req;
        },
    };

    const self = {
        addEventListener: () => {},
        clients: {
            matchAll: async () => [{ postMessage: (m: Record<string, unknown>) => posted.push(m) }],
        },
        registration: {},
    };

    const fetchImpl = async (url: string) => {
        const u = String(url);
        if (u.includes('/api/offline/whoami')) {
            if (who.kind === 'signed-out') return { status: 401, ok: false, headers: { get: () => null } };
            if (who.kind === 'unknown') return { status: 502, ok: false, headers: { get: () => null } };
            return {
                status: 200,
                ok: true,
                headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
                json: async () => ({ userId: who.userId }),
            };
        }
        sent.push({ url: u });
        return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({}) };
    };

    const factory = new Function(
        'self', 'indexedDB', 'caches', 'fetch', 'Response', 'URL', 'clients',
        `${SW_SRC}\n;return { flushOutbox };`,
    );
    const api = factory(
        self, indexedDB, { open: async () => ({}) }, fetchImpl,
        class {}, URL, self.clients,
    ) as { flushOutbox: () => Promise<void> };

    return { flushOutbox: api.flushOutbox, sent, posted, removed };
}

const itemFor = (id: string, owner?: string) => ({
    id,
    url: `/api/t/acme/farm-tasks/${id}/status`,
    method: 'POST',
    body: '{}',
    createdAt: 1,
    attempts: 0,
    ...(owner ? { queuedByUserId: owner } : {}),
});

describe('the worker drain and a shared device', () => {
    it('does NOT send an item queued by a different operator', async () => {
        // The defect. Before the fix this sent 1 and it landed as operator-b.
        const w = loadWorker({
            items: [itemFor('a1', 'operator-a')],
            whoami: { kind: 'user', userId: 'operator-b' },
        });
        await w.flushOutbox();
        expect(w.sent).toEqual([]);
        expect(w.removed).toEqual([]); // held, not dropped — it waits for its owner
    });

    it('DOES send the signed-in operator’s own item', async () => {
        // The other half. A worker that skipped everything would satisfy the
        // assertion above and break offline sync outright.
        const w = loadWorker({
            items: [itemFor('b1', 'operator-b')],
            whoami: { kind: 'user', userId: 'operator-b' },
        });
        await w.flushOutbox();
        expect(w.sent.map((s) => s.url)).toEqual(['/api/t/acme/farm-tasks/b1/status']);
    });

    it('sends only the owner’s item out of a mixed queue', async () => {
        const w = loadWorker({
            items: [itemFor('a1', 'operator-a'), itemFor('b1', 'operator-b')],
            whoami: { kind: 'user', userId: 'operator-b' },
        });
        await w.flushOutbox();
        expect(w.sent.map((s) => s.url)).toEqual(['/api/t/acme/farm-tasks/b1/status']);
    });

    it('still sends a legacy item with no attribution, exactly as the page does', async () => {
        // Items queued before attribution shipped carry no `queuedByUserId`.
        // `src/lib/offline/outbox.ts` documents that they still flush; diverging
        // from the page here would strand the oldest work in the queue.
        const w = loadWorker({
            items: [itemFor('legacy')],
            whoami: { kind: 'user', userId: 'operator-b' },
        });
        await w.flushOutbox();
        expect(w.sent.map((s) => s.url)).toEqual(['/api/t/acme/farm-tasks/legacy/status']);
    });

    it('tells open clients that work was held back', async () => {
        // Holding an item silently trades a mis-attributed write for an
        // invisible stall — the same trade #923 refused for refusals.
        const w = loadWorker({
            items: [itemFor('a1', 'operator-a')],
            whoami: { kind: 'user', userId: 'operator-b' },
        });
        await w.flushOutbox();
        const flushed = w.posted.find((m) => m.type === 'outbox-flushed');
        expect(flushed?.foreignHeld).toBe(true);
    });
});

describe('the worker drain when identity is not established', () => {
    it('sends NOTHING when whoami cannot be resolved', async () => {
        // A captive portal answers 200 with HTML; a proxy answers 502. Neither
        // is a refusal, and neither is a verified identity. Sending here would
        // attribute the write to whoever the cookie happens to belong to.
        const w = loadWorker({ items: [itemFor('b1', 'operator-b')], whoami: { kind: 'unknown' } });
        await expect(w.flushOutbox()).rejects.toThrow(/identity unverified/);
        expect(w.sent).toEqual([]);
    });

    it('sends NOTHING when the server says signed-out, and does not reschedule', async () => {
        // A definite 401 is not transient. Throwing would burn the browser's
        // sync budget re-running a pass that cannot succeed until someone signs
        // in — which is a page-side event, not a network one.
        const w = loadWorker({ items: [itemFor('b1', 'operator-b')], whoami: { kind: 'signed-out' } });
        await expect(w.flushOutbox()).resolves.toBeUndefined();
        expect(w.sent).toEqual([]);
    });

    it('tells open clients the pass was deferred, and why', async () => {
        const w = loadWorker({ items: [itemFor('b1', 'operator-b')], whoami: { kind: 'signed-out' } });
        await w.flushOutbox();
        const deferred = w.posted.find((m) => m.type === 'outbox-flush-deferred');
        expect(deferred?.reason).toBe('signed-out');
    });
});

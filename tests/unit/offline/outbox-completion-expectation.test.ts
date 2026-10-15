/**
 * A 2xx that did not finish the work keeps the item queued (#1870).
 *
 * `POST /journal/treatments` is resumable rather than atomic: the per-parcel
 * mark is what writes each ДНЕВНИК entry, so a failure part-way answers 201
 * with fewer parcels recorded than were sent. Both drains used to call that
 * delivered and drop the item, so a farmer who ticked 12 parcels and had 5
 * marked got a folded row reading 5, seven real applications missing from a
 * regulated register, and no signal anywhere.
 *
 * EXECUTING, not structural — `outbox-completion-mirrors-the-sw.test.ts` is
 * the source-level mirror check, and it cannot tell whether either drain
 * actually retains. Both drains are driven here: the page one through
 * `flushOutbox`, and the real `public/sw.js` through the worker harness, since
 * the worker is the copy whose being wrong leaves no trace but a delivery
 * receipt.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { InMemoryOutboxStore, enqueue, type CompletionExpectation } from '@/lib/offline/outbox';
import { flushOutbox, MAX_ATTEMPTS } from '@/lib/offline/sync';

const TICKED: CompletionExpectation = { field: 'parcelCount', equals: 12 };

async function seedTreatment(
    completeWhen: CompletionExpectation | undefined,
): Promise<InMemoryOutboxStore> {
    const s = new InMemoryOutboxStore();
    await enqueue(s, {
        url: '/api/t/acme/journal/treatments',
        method: 'POST',
        body: { parcelIds: Array.from({ length: 12 }, (_, i) => `p${i}`) },
        label: 'Karate Zeon',
        ...(completeWhen ? { completeWhen } : {}),
    });
    return s;
}

describe('the page drain', () => {
    it('REMOVES the item when the 2xx recorded everything', async () => {
        const s = await seedTreatment(TICKED);
        const res = await flushOutbox(s, async () => ({
            ok: true,
            status: 201,
            completionBody: { parcelCount: 12 },
        }));

        expect(res.sent).toBe(1);
        expect(await s.all()).toHaveLength(0);
    });

    it('RETAINS the item when the 2xx came back short', async () => {
        const s = await seedTreatment(TICKED);
        const res = await flushOutbox(s, async () => ({
            ok: true,
            status: 201,
            completionBody: { parcelCount: 5 },
        }));

        // Not counted as sent — the work is not done.
        expect(res.sent).toBe(0);
        const remaining = await s.all();
        expect(remaining).toHaveLength(1);
        // The attempt IS counted: this one reached the server and got a real
        // answer, so a treatment the server will never finish has to stop
        // eventually rather than re-sending for ever.
        expect(remaining[0].attempts).toBe(1);
        // And it is NOT parked as refused or blocked — it is simply still
        // queued, so the next drain re-sends it.
        expect(remaining[0].blocked).toBeUndefined();
        expect(remaining[0].conflict).toBeUndefined();
    });

    it('re-sends under the SAME id, which is what finishes the remainder', async () => {
        const s = await seedTreatment(TICKED);
        const seen: string[] = [];
        const short = async (item: { id: string }) => {
            seen.push(item.id);
            return { ok: true, status: 201, completionBody: { parcelCount: 5 } };
        };
        await flushOutbox(s, short);
        await flushOutbox(s, short);

        // The Idempotency-Key is the item id, so the second request resumes
        // the same treatment instead of minting another one.
        expect(seen).toHaveLength(2);
        expect(seen[0]).toBe(seen[1]);
    });

    it('PARKS as exhausted rather than deleting a treatment that never finishes', async () => {
        const s = await seedTreatment(TICKED);
        const short = async () => ({ ok: true, status: 201, completionBody: { parcelCount: 5 } });
        for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await flushOutbox(s, short);

        const remaining = await s.all();
        // Still there. A partly-recorded treatment is the one thing in this
        // queue that cannot be reconstructed, so exhaustion must never delete
        // it — it parks, visibly, for the operator.
        expect(remaining).toHaveLength(1);
        expect(remaining[0].blocked).toBe('exhausted');
    });

    it('an unreadable body retains, rather than reading as success', async () => {
        // The direction that matters. "Treat an unparseable body as delivered"
        // is the tidying that looks like robustness and silently drops field
        // work out of a compliance register.
        const s = await seedTreatment(TICKED);
        await flushOutbox(s, async () => ({ ok: true, status: 201, completionBody: undefined }));
        expect(await s.all()).toHaveLength(1);
    });

    it('leaves every OTHER write alone — a 2xx is still delivery', async () => {
        // The compatibility direction, and the one with the whole product
        // behind it: a journal entry, a photo, a farm task, a cost batch.
        const s = await seedTreatment(undefined);
        const res = await flushOutbox(s, async () => ({ ok: true, status: 201 }));
        expect(res.sent).toBe(1);
        expect(await s.all()).toHaveLength(0);
    });
});

// ── The service worker, running for real ──────────────────────────────
//
// Modelled on sw-drain-attribution.test.ts. `public/sw.js` is imported by
// nothing and cannot import from `src/`, so its copy of this rule is kept in
// lockstep by hand — which is why it is driven here rather than asserted
// about.

const SW_SRC = fs.readFileSync(path.resolve(__dirname, '../../../public/sw.js'), 'utf8');

interface SwHarness {
    flushOutbox: () => Promise<void>;
    removed: string[];
    put: Array<Record<string, unknown>>;
    sent: string[];
}

function loadWorker(opts: {
    items: Array<Record<string, unknown>>;
    responseBody: unknown;
}): SwHarness {
    const removed: string[] = [];
    const put: Array<Record<string, unknown>> = [];
    const sent: string[] = [];

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
        put: (row: Record<string, unknown>) => {
            put.push(row);
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
        clients: { matchAll: async () => [{ postMessage: () => {} }] },
        registration: {},
    };

    const fetchImpl = async (url: string) => {
        const u = String(url);
        if (u.includes('/api/offline/whoami')) {
            return {
                status: 200,
                ok: true,
                headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
                json: async () => ({ userId: 'operator-a' }),
            };
        }
        sent.push(u);
        return {
            status: 201,
            ok: true,
            headers: { get: () => null },
            json: async () => opts.responseBody,
        };
    };

    const factory = new Function(
        'self', 'indexedDB', 'caches', 'fetch', 'Response', 'URL', 'clients',
        `${SW_SRC}\n;return { flushOutbox };`,
    );
    const mod = factory(
        self,
        indexedDB,
        { open: async () => ({ match: async () => undefined, put: async () => {}, keys: async () => [] }) },
        fetchImpl,
        class {},
        URL,
        self.clients,
    ) as { flushOutbox: () => Promise<void> };

    return { flushOutbox: mod.flushOutbox, removed, put, sent };
}

function treatmentRow(completeWhen: CompletionExpectation | undefined) {
    return {
        id: 'ob_treatment_1',
        url: '/api/t/acme/journal/treatments',
        method: 'POST',
        body: { parcelIds: Array.from({ length: 12 }, (_, i) => `p${i}`) },
        label: 'Karate Zeon',
        createdAt: 1,
        attempts: 0,
        queuedByUserId: 'operator-a',
        ...(completeWhen ? { completeWhen } : {}),
    };
}

describe('the service-worker drain, executed', () => {
    it('REMOVES the item when the 2xx recorded everything', async () => {
        const h = loadWorker({ items: [treatmentRow(TICKED)], responseBody: { parcelCount: 12 } });
        await h.flushOutbox();
        expect(h.sent).toHaveLength(1);
        expect(h.removed).toEqual(['ob_treatment_1']);
    });

    it('RETAINS the item when the 2xx came back short', async () => {
        // The one that matters: the page can retain all it likes, and a
        // Background Sync pass that deletes the item undoes it — leaving a
        // delivery receipt, which is the trace the page reads to tell a drain
        // apart from an eviction. The register ends short and every signal
        // says it was fine.
        const h = loadWorker({ items: [treatmentRow(TICKED)], responseBody: { parcelCount: 5 } });
        // It THROWS, and that is the point rather than a wrinkle: the worker
        // signals Background Sync to reschedule by rejecting the
        // `waitUntil`-ed promise, so an unfinished treatment is retried by
        // the browser instead of waiting for the next page visit. Retaining
        // the item without asking for a retry would leave the remainder
        // unrecorded until somebody happened to open the app.
        await expect(h.flushOutbox()).rejects.toThrow(/transient failures remain/);
        expect(h.sent).toHaveLength(1);
        expect(h.removed).toEqual([]);
        // Retained with the attempt counted, matching the page drain.
        const retained = h.put.filter((r) => r.id === 'ob_treatment_1');
        expect(retained).toHaveLength(1);
        expect(retained[0].attempts).toBe(1);
        expect(retained[0].blocked).toBeUndefined();
    });

    it('leaves every OTHER write alone — a 2xx is still delivery', async () => {
        const h = loadWorker({ items: [treatmentRow(undefined)], responseBody: { parcelCount: 5 } });
        await h.flushOutbox();
        // No expectation, so the short body is nobody's business and the item
        // is delivered exactly as before this change.
        expect(h.removed).toEqual(['ob_treatment_1']);
    });
});

/**
 * Unit tests for the offline sync/replay engine
 * (`src/lib/offline/sync.ts`). The retry policy is the crux: success
 * removes, terminal-4xx drops, transient keeps + bumps, poison drops.
 */
import { InMemoryOutboxStore, enqueue, type OutboxItem } from '@/lib/offline/outbox';
import { flushOutbox, MAX_ATTEMPTS, type Sender } from '@/lib/offline/sync';

async function seed(n: number): Promise<InMemoryOutboxStore> {
    const s = new InMemoryOutboxStore();
    for (let i = 0; i < n; i++) {
        await enqueue(s, { url: `/u/${i}`, method: 'PATCH', body: { i }, label: `L${i}` });
    }
    return s;
}

const ok: Sender = async () => ({ ok: true, status: 200 });
const terminal: Sender = async () => ({ ok: false, status: 400 });
const serverErr: Sender = async () => ({ ok: false, status: 503 });
const throws: Sender = async () => {
    throw new Error('network down');
};

describe('flushOutbox', () => {
    it('removes successfully-sent items', async () => {
        const s = await seed(3);
        const res = await flushOutbox(s, ok);
        expect(res).toMatchObject({ sent: 3, failed: 0, dropped: 0, remaining: 0 });
        expect(await s.all()).toHaveLength(0);
    });

    it('drops terminal 4xx (so the queue keeps moving)', async () => {
        const s = await seed(2);
        const res = await flushOutbox(s, terminal);
        expect(res).toMatchObject({ sent: 0, dropped: 2, remaining: 0 });
    });

    it('keeps + bumps attempts on a 5xx (transient)', async () => {
        const s = await seed(1);
        const res = await flushOutbox(s, serverErr);
        expect(res).toMatchObject({ sent: 0, failed: 1, dropped: 0, remaining: 1 });
        expect((await s.all())[0].attempts).toBe(1);
    });

    it('treats a network throw as transient (status 0)', async () => {
        const s = await seed(1);
        const res = await flushOutbox(s, throws);
        expect(res.failed).toBe(1);
        expect(res.remaining).toBe(1);
    });

    it('retries on 408 (transient, bumps attempts)', async () => {
        const s = await seed(1);
        const res = await flushOutbox(s, async () => ({ ok: false, status: 408 }));
        expect(res.failed).toBe(1);
        expect(res.remaining).toBe(1);
        expect((await s.all())[0].attempts).toBe(1);
    });

    it('PARKS a poison item past MAX_ATTEMPTS — it must never be deleted', async () => {
        // Changed deliberately. The escape from an item the server keeps
        // rejecting is that it stops being RETRIED, not that the operator's
        // work is destroyed. Field marks queued in a dead-signal valley are
        // not reproducible; a queue that deletes them to keep itself moving
        // is solving the wrong problem.
        const s = new InMemoryOutboxStore();
        const it: OutboxItem = {
            id: 'poison',
            url: '/u',
            method: 'PATCH',
            body: {},
            label: 'L',
            createdAt: 1,
            attempts: MAX_ATTEMPTS - 1,
        };
        await s.add(it);
        const res = await flushOutbox(s, serverErr);

        expect(res.dropped).toBe(0);
        expect(res.blocked).toBe(1);
        const [kept] = await s.all();
        expect(kept).toBeDefined();
        expect(kept.blocked).toBe('exhausted');
    });

    it('a request that NEVER LEFT the phone does not spend an attempt', async () => {
        // status 0 means dead radio — the request reached nobody. Counting it
        // as a failure marched work toward MAX_ATTEMPTS and then deleted it,
        // so a phone retrying with no signal destroyed the work it was holding.
        const s = new InMemoryOutboxStore();
        await s.add({
            id: 'a', url: '/u', method: 'PATCH', body: {}, label: 'L',
            createdAt: 1, attempts: 3,
        } as OutboxItem);

        const res = await flushOutbox(s, async () => { throw new Error('offline'); });

        expect(res.dropped).toBe(0);
        const [kept] = await s.all();
        expect(kept.attempts).toBe(3);
        expect(kept.blocked).toBeUndefined();
    });

    it('a refused SESSION blocks the queue instead of deleting it', async () => {
        // The headline defect: 401/403 was "terminal client error — drop so the
        // queue keeps moving", so changing a password on a laptop deleted the
        // phone's queued field work on the next flush. Silently, because the
        // removal looked deliberate to the loss detector.
        const s = new InMemoryOutboxStore();
        for (const id of ['a', 'b', 'c']) {
            await s.add({ id, url: '/u', method: 'PATCH', body: {}, label: id, createdAt: 1, attempts: 0 } as OutboxItem);
        }

        const res = await flushOutbox(s, async () => ({ ok: false, status: 401 }));

        expect(res.dropped).toBe(0);
        expect(res.authBlocked).toBe(true);
        // Nothing was lost, and the pass STOPPED — the rest carry the same
        // credential and would meet the same answer.
        expect(await s.all()).toHaveLength(3);
    });

    it('flushes in FIFO order', async () => {
        const s = new InMemoryOutboxStore();
        await s.add({ id: 'second', url: '/u', method: 'PATCH', body: {}, label: 'L', createdAt: 200, attempts: 0 });
        await s.add({ id: 'first', url: '/u', method: 'PATCH', body: {}, label: 'L', createdAt: 100, attempts: 0 });
        const order: string[] = [];
        await flushOutbox(s, async (item) => {
            order.push(item.id);
            return { ok: true, status: 200 };
        });
        expect(order).toEqual(['first', 'second']);
    });

    // ── 409 optimistic-lock conflict handling ───────────────────────
    // A queued mark can replay after a supervisor changed the job. The server
    // 409s (STALE_DATA); the outbox must PARK it (never drop, never clobber)
    // for the operator to resolve — and never re-send a parked conflict.

    it('409 parks the item as a conflict — not dropped, retained with server state', async () => {
        const s = await seed(1);
        const conflict409: Sender = async () => ({
            ok: false,
            status: 409,
            conflict: { code: 'STALE_DATA', currentVersion: 3, currentStatus: 'SKIPPED' },
        });
        const res = await flushOutbox(s, conflict409);
        expect(res).toMatchObject({ sent: 0, failed: 0, dropped: 0, conflicts: 1, remaining: 1 });
        const parked = (await s.all())[0];
        expect(parked.conflict?.status).toBe(409);
        expect(parked.conflict?.server).toMatchObject({ currentVersion: 3 });
        expect(parked.attempts).toBe(0); // a conflict is not the item's fault
    });

    it('never re-sends a parked conflict on a subsequent flush', async () => {
        const s = new InMemoryOutboxStore();
        await s.add({
            id: 'stuck', url: '/u', method: 'PATCH', body: {}, label: 'L',
            createdAt: 1, attempts: 0, ifMatch: 2,
            conflict: { status: 409, server: { currentVersion: 5 } },
        });
        let calls = 0;
        const res = await flushOutbox(s, async () => { calls++; return { ok: true, status: 200 }; });
        expect(calls).toBe(0); // the parked conflict was skipped
        expect(res).toMatchObject({ sent: 0, conflicts: 0, remaining: 1 });
        expect((await s.all())[0].conflict?.status).toBe(409); // still parked
    });

    // ── 429 rate-limit handling (Roadmap-5 PR1) ──────────────────────
    // A PWA reconnect burst can outrun the mutation limiter. A 429 must
    // RETAIN queued work (never dropped, never counts toward MAX_ATTEMPTS)
    // and back off per Retry-After — a reconnect burst is a legit single-
    // user pattern, not abuse.

    it('429 retains the item WITHOUT bumping attempts', async () => {
        const s = await seed(1);
        const res = await flushOutbox(s, async () => ({ ok: false, status: 429 }));
        expect(res).toMatchObject({ sent: 0, failed: 0, dropped: 0, remaining: 1, rateLimited: true });
        // attempts untouched — a 429 is not the item's fault.
        expect((await s.all())[0].attempts).toBe(0);
    });

    it('429 never drops queued work even past MAX_ATTEMPTS', async () => {
        const s = new InMemoryOutboxStore();
        await s.add({
            id: 'hot', url: '/u', method: 'PATCH', body: {}, label: 'L',
            createdAt: 1, attempts: MAX_ATTEMPTS, // already at the cap
        });
        const res = await flushOutbox(s, async () => ({ ok: false, status: 429 }));
        expect(res.dropped).toBe(0);
        expect(res.rateLimited).toBe(true);
        expect(await s.all()).toHaveLength(1); // retained, not dropped
    });

    it('429 stops the burst — remaining items are left untouched', async () => {
        const s = await seed(3);
        let calls = 0;
        const res = await flushOutbox(s, async () => {
            calls++;
            return { ok: false, status: 429 };
        });
        expect(calls).toBe(1); // stopped after the first 429
        expect(res.remaining).toBe(3); // all three retained
        expect(res.rateLimited).toBe(true);
    });

    it('429 surfaces the server Retry-After for backoff', async () => {
        const s = await seed(1);
        const res = await flushOutbox(s, async () => ({ ok: false, status: 429, retryAfter: 42 }));
        expect(res.retryAfterSeconds).toBe(42);
    });

    it('handles a mixed batch: send ok, drop 4xx, keep 5xx', async () => {
        const s = new InMemoryOutboxStore();
        await s.add({ id: 'a', url: '/a', method: 'PATCH', body: {}, label: 'L', createdAt: 1, attempts: 0 });
        await s.add({ id: 'b', url: '/b', method: 'PATCH', body: {}, label: 'L', createdAt: 2, attempts: 0 });
        await s.add({ id: 'c', url: '/c', method: 'PATCH', body: {}, label: 'L', createdAt: 3, attempts: 0 });
        const send: Sender = async (item) =>
            item.id === 'a' ? { ok: true, status: 200 } : item.id === 'b' ? { ok: false, status: 422 } : { ok: false, status: 500 };
        const res = await flushOutbox(s, send);
        expect(res).toMatchObject({ sent: 1, dropped: 1, failed: 1, remaining: 1 });
        expect((await s.all())[0].id).toBe('c');
    });
});

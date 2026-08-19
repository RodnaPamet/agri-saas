/**
 * Client data retention — executing tests.
 *
 * The property under test is not "old things get deleted". It is that
 * the sweep CANNOT lose work. Every assertion below that looks
 * defensive is guarding a specific failure an earlier design would have
 * produced:
 *
 *  - a snapshot for a task with queued work is the render source for a
 *    cold offline reload of a job the operator is still marking;
 *  - the outbox and its bookkeeping are never touched, because clearing
 *    the manifest without the queue (or vice versa) is exactly the shape
 *    the loss detector reads as "this phone deleted your work", and
 *    would raise a sticky false banner;
 *  - an unreadable queue protects everything rather than nothing.
 */
import {
    sweepClientStores,
    CLIENT_DATA_MAX_AGE_MS,
    NEVER_SWEPT,
} from '@/lib/offline/client-data-retention';
import { saveFieldSnapshot, readFieldSnapshot } from '@/lib/offline/field-snapshot';

const NOW = 1_800_000_000_000;
const OLD = NOW - CLIENT_DATA_MAX_AGE_MS - 1;

let store: Map<string, string>;

function installLocalStorage(): Map<string, string> {
    const map = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() {
            return map.size;
        },
    } as Storage;
    return map;
}

/** Outbox items the sweep will read to decide what to protect. */
let queued: { id: string; url: string }[] = [];
jest.mock('@/lib/offline/outbox', () => ({
    ...jest.requireActual('@/lib/offline/outbox'),
    getOutboxStore: () => ({
        all: async () => queued,
        add: async () => {},
        update: async () => {},
        remove: async () => {},
    }),
}));

beforeEach(() => {
    store = installLocalStorage();
    queued = [];
});

function seedSnapshot(taskId: string, writtenAt: number) {
    store.set(
        `agri.offline.fieldop.v1.${taskId}`,
        JSON.stringify({ t: writtenAt, data: { lines: [{ parcel: 'North 40' }] } }),
    );
}

describe('field snapshots', () => {
    it('removes one older than the retention window', async () => {
        seedSnapshot('task-old', OLD);
        const res = await sweepClientStores({ now: NOW });
        expect(res.snapshotsRemoved).toBe(1);
        expect(store.has('agri.offline.fieldop.v1.task-old')).toBe(false);
    });

    it('keeps a recent one', async () => {
        seedSnapshot('task-fresh', NOW - 1000);
        const res = await sweepClientStores({ now: NOW });
        expect(res.snapshotsRemoved).toBe(0);
        expect(res.snapshotsKept).toBe(1);
    });

    it('NEVER removes a snapshot whose task still has queued work', async () => {
        // The load-bearing exclusion. /api is network-only for field-ops,
        // so this snapshot is the only thing that renders the job on a cold
        // offline reload — for a job the operator is still marking.
        seedSnapshot('task-busy', OLD);
        queued = [{ id: 'ob1', url: '/api/t/acme/field-operations/task-busy/parcels/p1' }];
        const res = await sweepClientStores({ now: NOW });
        expect(res.snapshotsRemoved).toBe(0);
        expect(store.has('agri.offline.fieldop.v1.task-busy')).toBe(true);
    });

    it('protects EVERYTHING when the queue cannot be read', async () => {
        // Failing closed costs disk. Failing open costs an operator the
        // render source for work they are in the middle of.
        seedSnapshot('task-a', OLD);
        seedSnapshot('task-b', OLD);
        const outbox = jest.requireMock('@/lib/offline/outbox') as {
            getOutboxStore: () => { all: () => Promise<unknown> };
        };
        const spy = jest
            .spyOn(outbox, 'getOutboxStore')
            .mockReturnValue({
                all: async () => {
                    throw new Error('IDB unavailable');
                },
            } as never);
        const res = await sweepClientStores({ now: NOW });
        expect(res.snapshotsRemoved).toBe(0);
        expect(res.snapshotsKept).toBe(2);
        spy.mockRestore();
    });

    it('removes a LEGACY bare-payload snapshot, which has no timestamp', async () => {
        // Pre-wrapper entries cannot be aged, and they are by definition at
        // least as old as this release. The panel rewrites on every mark, so
        // an actively-worked job gets a fresh timestamp immediately.
        store.set('agri.offline.fieldop.v1.legacy', JSON.stringify({ lines: [] }));
        const res = await sweepClientStores({ now: NOW });
        expect(res.snapshotsRemoved).toBe(1);
    });

    it('sweeps every expired key, not just the first — the index-walk trap', async () => {
        // Removing during an index walk shifts later keys and silently skips
        // half the store.
        for (let i = 0; i < 6; i++) seedSnapshot(`t${i}`, OLD);
        const res = await sweepClientStores({ now: NOW });
        expect(res.snapshotsRemoved).toBe(6);
        expect([...store.keys()].filter((k) => k.startsWith('agri.offline.fieldop'))).toEqual([]);
    });
});

describe('the SWR buckets', () => {
    it('removes a bucket past the window even if its namespace is never hydrated', async () => {
        // The cache's own TTL only fires on hydrate, so a tenant the
        // operator stopped visiting keeps its bucket forever.
        store.set('agrent-swr:v2:usr_1::old-farm', JSON.stringify({ v: 2, t: OLD, entries: [] }));
        const res = await sweepClientStores({ now: NOW });
        expect(res.swrBucketsRemoved).toBe(1);
    });

    it('keeps a fresh bucket', async () => {
        store.set('agrent-swr:v2:usr_1::acme', JSON.stringify({ v: 2, t: NOW - 5, entries: [] }));
        expect((await sweepClientStores({ now: NOW })).swrBucketsRemoved).toBe(0);
    });

    it('removes an unparseable bucket — it is unusable anyway', async () => {
        store.set('agrent-swr:v2:usr_1::acme', 'not json');
        expect((await sweepClientStores({ now: NOW })).swrBucketsRemoved).toBe(1);
    });
});

describe('what the sweep must never touch', () => {
    it('leaves the outbox bookkeeping alone, even with maxAgeMs 0', async () => {
        // maxAgeMs 0 is the strongest form — the future purge-on-sign-out.
        // Even then, nothing the outbox owns may be removed: clearing the
        // manifest without the queue is exactly what the loss detector
        // reads as "this phone deleted your work".
        store.set('agri.offline.outbox.manifest.v1', JSON.stringify([{ id: 'a', label: 'x' }]));
        store.set('agri.offline.lostwork.v1', JSON.stringify({ entries: [{ id: 'b' }] }));
        store.set('agri.offline.durability.v1', JSON.stringify({ persisted: false }));
        seedSnapshot('task-x', NOW);

        await sweepClientStores({ now: NOW, maxAgeMs: 0 });

        expect(store.has('agri.offline.outbox.manifest.v1')).toBe(true);
        expect(store.has('agri.offline.lostwork.v1')).toBe(true);
        expect(store.has('agri.offline.durability.v1')).toBe(true);
    });

    it('names those stores explicitly, so removing one is a deliberate act', () => {
        expect(NEVER_SWEPT).toContain('agri-offline');
        expect(NEVER_SWEPT).toContain('agri.offline.outbox.manifest.v1');
        expect(NEVER_SWEPT).toContain('agri.offline.lostwork.v1');
    });

    it('leaves unrelated keys alone', async () => {
        store.set('theme', 'dark');
        store.set('agri.offline.fieldop.v1.task-old', JSON.stringify({ t: OLD, data: {} }));
        await sweepClientStores({ now: NOW });
        expect(store.get('theme')).toBe('dark');
    });
});

describe('resilience', () => {
    it('never throws when localStorage is unavailable', async () => {
        delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
        await expect(sweepClientStores({ now: NOW })).resolves.toMatchObject({
            snapshotsRemoved: 0,
        });
    });

    it('maxAgeMs 0 sweeps caches but still keeps busy snapshots', async () => {
        seedSnapshot('task-busy', NOW);
        queued = [{ id: 'ob1', url: '/api/t/acme/field-operations/task-busy/parcels/p1' }];
        const res = await sweepClientStores({ now: NOW, maxAgeMs: 0 });
        expect(res.snapshotsRemoved).toBe(0);
        expect(store.has('agri.offline.fieldop.v1.task-busy')).toBe(true);
    });
});

describe('the snapshot round-trip survives the wrapper change', () => {
    it('reads back what it wrote', () => {
        saveFieldSnapshot('t1', { lines: [{ parcel: 'North 40' }] });
        expect(readFieldSnapshot<{ lines: { parcel: string }[] }>('t1')?.lines[0].parcel).toBe(
            'North 40',
        );
    });

    it('still reads a LEGACY bare payload written by an older build', () => {
        // No operator loses a snapshot on upgrade.
        store.set('agri.offline.fieldop.v1.t2', JSON.stringify({ lines: [{ parcel: 'South 8' }] }));
        expect(readFieldSnapshot<{ lines: { parcel: string }[] }>('t2')?.lines[0].parcel).toBe(
            'South 8',
        );
    });
});

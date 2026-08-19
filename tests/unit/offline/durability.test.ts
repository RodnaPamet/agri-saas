/**
 * Outbox durability primitives — EXECUTING tests.
 *
 * These run the real functions in `src/lib/offline/durability.ts` against a
 * real (in-memory) `localStorage` and an injected `StorageManager`, because
 * the whole point of the module is what it does at runtime. A structural
 * guard asserting that `persist()` appears in the source would have passed
 * just as happily against a version that called it and threw the answer away.
 */
import {
    DURABILITY_STORAGE_KEY,
    LOST_WORK_STORAGE_KEY,
    MANIFEST_STORAGE_KEY,
    acknowledgeLostWork,
    readDurabilityVerdict,
    readLostWork,
    reconcileManifest,
    recordLostWork,
    requestPersistence,
    writeManifest,
    type ManifestEntry,
    type StorageManagerLike,
} from '@/lib/offline/durability';

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

const entry = (id: string, label = `Mark ${id}`): ManifestEntry => ({
    id,
    label,
    createdAt: 1,
});

let store: Map<string, string>;
beforeEach(() => {
    store = installLocalStorage();
});

describe('requestPersistence', () => {
    it('records supported:false when the Storage API is absent', async () => {
        const verdict = await requestPersistence(undefined);
        expect(verdict).toMatchObject({ supported: false, persisted: false, requested: false });
        // The measurement is CACHED — support reads this back off a device.
        expect(readDurabilityVerdict()).toMatchObject({ supported: false });
        expect(store.has(DURABILITY_STORAGE_KEY)).toBe(true);
    });

    it('does NOT call persist() when the origin is already persisted', async () => {
        // Firefox prompts on persist(). Re-asking a user who already said yes
        // is a permission prompt they cannot explain, so it must not happen.
        const persist = jest.fn(async () => true);
        const api: StorageManagerLike = {
            persisted: async () => true,
            persist,
            estimate: async () => ({ quota: 100, usage: 10 }),
        };
        const verdict = await requestPersistence(api);
        expect(persist).not.toHaveBeenCalled();
        expect(verdict).toMatchObject({ supported: true, persisted: true, requested: false });
    });

    it('calls persist() when not yet persisted and records the GRANT', async () => {
        const persist = jest.fn(async () => true);
        const verdict = await requestPersistence({
            persisted: async () => false,
            persist,
            estimate: async () => ({ quota: 2048, usage: 512 }),
        });
        expect(persist).toHaveBeenCalledTimes(1);
        expect(verdict).toMatchObject({
            supported: true,
            persisted: true,
            requested: true,
            quota: 2048,
            usage: 512,
        });
    });

    it('records a REFUSAL as a refusal, not a crash', async () => {
        // The iOS case this whole investigation is about: persist() may
        // resolve false, or be a no-op. Either way the app keeps working and
        // the verdict says what happened.
        const verdict = await requestPersistence({
            persisted: async () => false,
            persist: async () => false,
            estimate: async () => ({ quota: 1, usage: 0 }),
        });
        expect(verdict).toMatchObject({ supported: true, persisted: false, requested: true });
    });

    it('treats a THROWN persist() as a refusal and still records a verdict', async () => {
        const verdict = await requestPersistence({
            persisted: async () => false,
            persist: async () => {
                throw new Error('SecurityError');
            },
        });
        expect(verdict).toMatchObject({ supported: true, persisted: false });
        expect(readDurabilityVerdict()?.persisted).toBe(false);
    });

    it('survives an estimate() that throws — diagnostics never fail the request', async () => {
        const verdict = await requestPersistence({
            persisted: async () => false,
            persist: async () => true,
            estimate: async () => {
                throw new Error('NotSupported');
            },
        });
        expect(verdict.persisted).toBe(true);
        expect(verdict.quota).toBeUndefined();
    });

    it('never throws when localStorage is unavailable (private mode)', async () => {
        delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
        await expect(
            requestPersistence({ persisted: async () => false, persist: async () => true }),
        ).resolves.toMatchObject({ persisted: true });
    });
});

describe('reconcileManifest', () => {
    it('reports entries the queue no longer holds when Background Sync is impossible', () => {
        writeManifest([entry('a'), entry('b'), entry('c')]);
        expect(reconcileManifest(['b'], false).map((e) => e.id)).toEqual(['a', 'c']);
    });

    it('reports NOTHING when Background Sync could have delivered them', () => {
        // The service worker cannot write localStorage, so it leaves no
        // receipt. On a platform where it might have drained the queue,
        // silence beats accusing the browser of losing delivered work.
        writeManifest([entry('a'), entry('b')]);
        expect(reconcileManifest([], true)).toEqual([]);
    });

    it('reports nothing when the manifest is empty', () => {
        expect(reconcileManifest([], false)).toEqual([]);
    });

    it('reports nothing when the queue still holds everything', () => {
        writeManifest([entry('a'), entry('b')]);
        expect(reconcileManifest(['a', 'b'], false)).toEqual([]);
    });

    it('writeManifest([]) clears the key rather than storing an empty array', () => {
        writeManifest([entry('a')]);
        writeManifest([]);
        expect(store.has(MANIFEST_STORAGE_KEY)).toBe(false);
    });
});

describe('lost-work record', () => {
    it('persists across a reload and is readable back', () => {
        recordLostWork([entry('a', 'Mark North 40 done')], 'storage-evicted');
        const read = readLostWork();
        expect(read?.entries.map((e) => e.label)).toEqual(['Mark North 40 done']);
        expect(read?.cause).toBe('storage-evicted');
    });

    it('APPENDS a second loss instead of replacing the first', () => {
        recordLostWork([entry('a')], 'storage-evicted');
        recordLostWork([entry('b')], 'queue-vanished-while-closed');
        expect(readLostWork()?.entries.map((e) => e.id)).toEqual(['a', 'b']);
    });

    it('de-duplicates a repeated detection of the same items', () => {
        // A reload before the operator acknowledges must not inflate the count.
        recordLostWork([entry('a'), entry('b')], 'storage-evicted');
        recordLostWork([entry('a'), entry('b')], 'storage-evicted');
        expect(readLostWork()?.entries).toHaveLength(2);
    });

    it('recording zero entries changes nothing', () => {
        expect(recordLostWork([], 'storage-evicted')).toBeNull();
        expect(store.has(LOST_WORK_STORAGE_KEY)).toBe(false);
    });

    it('clears ONLY on an explicit acknowledgement', () => {
        recordLostWork([entry('a')], 'storage-evicted');
        expect(readLostWork()).not.toBeNull();
        acknowledgeLostWork();
        expect(readLostWork()).toBeNull();
    });
});

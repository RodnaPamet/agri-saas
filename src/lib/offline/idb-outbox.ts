/**
 * IndexedDB-backed offline outbox.
 *
 * Why IDB and not the older `localStorage` store: the Background Sync API
 * fires its `sync` event inside the SERVICE WORKER, which cannot read
 * `localStorage` (it's a window-only API). To flush queued field mutations
 * "without reopening" the app, the queue must live somewhere both the page
 * AND the service worker can read — IndexedDB. `public/sw.js` replays from
 * this exact DB/store shape, so the constants below are a contract shared
 * with the SW (keep them in sync).
 *
 * Shape mirrors {@link OutboxItem} 1:1 (one record per queued mutation,
 * keyed by `id`), so the pure `flushOutbox` policy in `sync.ts` works
 * unchanged against this store.
 */
import type { OutboxItem, OutboxStore } from './outbox';

// Legacy localStorage key (mirrors `OUTBOX_STORAGE_KEY` in outbox.ts). Inlined
// rather than imported so this module has only a TYPE dependency on
// outbox.ts — keeping the outbox→idb-outbox import (in getOutboxStore) free
// of a runtime cycle.
const LEGACY_LOCALSTORAGE_KEY = 'agri.offline.outbox.v1';

/** Shared contract with `public/sw.js` — do not rename without updating the SW. */
export const OUTBOX_DB_NAME = 'agri-offline';
export const OUTBOX_DB_VERSION = 1;
export const OUTBOX_STORE_NAME = 'outbox';

function hasIndexedDb(): boolean {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

/**
 * Open the outbox database.
 *
 * `onCreated` fires when the browser had to CREATE the store — i.e. the
 * database did not exist at this version. On the very first open of a fresh
 * install that is normal. On a LATER open, after this page session has
 * already opened the database successfully, it means the database was
 * destroyed underneath us: the phone evicted the origin's storage, or the
 * user cleared website data. See {@link IndexedDbOutboxStore.wasRecreated}.
 */
function openOutboxDb(onCreated?: () => void): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(OUTBOX_DB_NAME, OUTBOX_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(OUTBOX_STORE_NAME)) {
                db.createObjectStore(OUTBOX_STORE_NAME, { keyPath: 'id' });
            }
            onCreated?.();
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
    });
}

function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('idb transaction failed'));
    });
}

/**
 * One-time migration: drain any items left in the legacy `localStorage`
 * outbox into IDB, then clear the legacy key. Runs lazily on first store
 * use so an operator who queued work before this upgrade doesn't lose it.
 * Fails soft — a migration error must never block queueing new work.
 */
async function migrateFromLocalStorage(db: IDBDatabase): Promise<void> {
    let legacy: OutboxItem[] = [];
    try {
        const raw = globalThis.localStorage?.getItem(LEGACY_LOCALSTORAGE_KEY);
        if (!raw) return;
        legacy = JSON.parse(raw) as OutboxItem[];
    } catch {
        return;
    }
    if (!Array.isArray(legacy) || legacy.length === 0) {
        try { globalThis.localStorage?.removeItem(LEGACY_LOCALSTORAGE_KEY); } catch { /* ignore */ }
        return;
    }
    try {
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite');
        const store = tx.objectStore(OUTBOX_STORE_NAME);
        for (const item of legacy) {
            if (item && typeof item.id === 'string') store.put(item);
        }
        await txDone(tx);
        globalThis.localStorage?.removeItem(LEGACY_LOCALSTORAGE_KEY);
    } catch {
        /* leave the legacy key in place for a future retry */
    }
}

export class IndexedDbOutboxStore implements OutboxStore {
    private dbPromise: Promise<IDBDatabase> | null = null;
    /** True once this session has held an open connection to the database. */
    private opened = false;
    /** Set when the database was created AFTER this session already had it. */
    private recreated = false;

    /**
     * Did the backing database get destroyed and rebuilt under this session?
     *
     * This is the IN-SESSION eviction signal, and it is exact: the store is
     * recreated only when the database is genuinely absent at open time, which
     * cannot happen through any code path in this app. A queue drained by the
     * service worker — the one other writer — removes records and leaves the
     * database itself alone, so it can never trip this.
     *
     * Reading CONSUMES the signal, so a single eviction is reported once.
     */
    wasRecreated(): boolean {
        const value = this.recreated;
        this.recreated = false;
        return value;
    }

    /**
     * Drop the cached connection so the next call re-opens.
     *
     * `versionchange` fires when something (a `deleteDatabase`, another tab
     * upgrading) needs our connection gone; holding it open would BLOCK that
     * request indefinitely. `close` fires when the connection was terminated
     * abnormally, which is what an eviction of live storage looks like.
     */
    private detach(db: IDBDatabase): void {
        try {
            db.close();
        } catch {
            /* already closed */
        }
        this.dbPromise = null;
    }

    private db(): Promise<IDBDatabase> {
        if (!this.dbPromise) {
            this.dbPromise = (async () => {
                const wasOpenedBefore = this.opened;
                const db = await openOutboxDb(() => {
                    // Store created. Normal on a cold start; on a session that
                    // has already opened the database, it means it was wiped.
                    if (wasOpenedBefore) this.recreated = true;
                });
                this.opened = true;
                db.onversionchange = () => this.detach(db);
                db.onclose = () => {
                    this.dbPromise = null;
                };
                await migrateFromLocalStorage(db);
                return db;
            })();
        }
        return this.dbPromise;
    }

    async add(item: OutboxItem): Promise<void> {
        const db = await this.db();
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite');
        tx.objectStore(OUTBOX_STORE_NAME).put(item);
        await txDone(tx);
    }

    async all(): Promise<OutboxItem[]> {
        const db = await this.db();
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readonly');
        const req = tx.objectStore(OUTBOX_STORE_NAME).getAll();
        const items = await new Promise<OutboxItem[]>((resolve, reject) => {
            req.onsuccess = () => resolve((req.result as OutboxItem[]) ?? []);
            req.onerror = () => reject(req.error ?? new Error('getAll failed'));
        });
        // FIFO — same ordering contract as the localStorage store.
        return items.sort((a, b) => a.createdAt - b.createdAt);
    }

    async update(item: OutboxItem): Promise<void> {
        // put() is an upsert — same as add for an existing key.
        await this.add(item);
    }

    async remove(id: string): Promise<void> {
        const db = await this.db();
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite');
        tx.objectStore(OUTBOX_STORE_NAME).delete(id);
        await txDone(tx);
    }
}

/** True when IndexedDB is usable in this context (browser, not jsdom/SSR). */
export function indexedDbAvailable(): boolean {
    return hasIndexedDb();
}

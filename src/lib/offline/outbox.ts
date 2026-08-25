/**
 * Offline outbox — the "queue" half of the operator PWA's queue-and-sync.
 *
 * When an operator marks a spray line in the field with no signal, the
 * mutation is appended here instead of being lost. On reconnect the
 * outbox is flushed (see `sync.ts`). Mutations are tiny JSON
 * (`PATCH …/parcels/:id { status }`), so a `localStorage`-backed store is
 * plenty — no IndexedDB needed until we queue photos (deferred).
 *
 * The store is an interface so the queue logic stays pure + unit-testable
 * (the in-memory store) and the browser binding is a thin adapter.
 */

import { IndexedDbOutboxStore, indexedDbAvailable } from './idb-outbox';
import { getCurrentUserId } from './current-user';

export type OutboxMethod = 'POST' | 'PATCH' | 'DELETE';

/**
 * Two item kinds share the ONE outbox store so they drain in a single FIFO
 * pass and the service worker reads a single object store:
 *   - `mutation` (default / legacy): a tiny JSON body — the original outbox.
 *   - `photo`: a multipart upload carrying the (already-downscaled) photo
 *     BYTES as a `Blob`. IndexedDB stores Blobs natively via structured
 *     clone — no base64 bloat — so the same record shape holds both. `body`
 *     is absent; the Blob is replayed as `FormData` (see `fetchSender` and
 *     the SW's `flushOutbox`, kept in lockstep).
 *
 * `kind` is OPTIONAL and absent means `mutation` — so records queued before
 * this change keep working, and the localStorage/in-memory stores (which
 * can't hold a Blob) are unaffected as long as they only ever carry
 * mutations.
 */
export type OutboxItemKind = 'mutation' | 'photo';

/**
 * Set when a replay came back 409 STALE_DATA — the row moved on while the edit
 * sat queued. The item is RETAINED in this "needs attention" state (never
 * dropped, never re-sent) until the operator resolves it (keep-mine /
 * take-server). `server` is the 409 body (the current server state).
 */
export interface OutboxConflict {
    status: number;
    server?: unknown;
}

interface OutboxItemBase {
    /** Client-generated id — also the idempotency handle on replay. */
    id: string;
    /** Tenant-scoped API path (already built via useTenantApiUrl). */
    url: string;
    method: OutboxMethod;
    /** Human label for the pending-sync UI ("Mark North 40 done"). */
    label: string;
    createdAt: number;
    attempts: number;
    /**
     * Retained but undeliverable until something outside this item changes.
     *
     * `auth` — the server refused the SESSION (401/403), not the work. A
     * revoked or expired session is a property of the session; deleting the
     * operator's marks because their password changed on another device
     * destroys field work that nothing can recover. `exhausted` — past
     * MAX_ATTEMPTS on genuine server-side transients.
     *
     * Blocked items are never sent and never dropped. They are surfaced so an
     * operator can act (sign in again), which is the only thing that can
     * unblock them.
     */
    blocked?: 'auth' | 'exhausted';
    /**
     * Optimistic-lock version the client saw when it queued this write, sent
     * back as `If-Match` on replay. The server 409s if the row moved on. Absent
     * for writes that don't participate in optimistic locking.
     */
    ifMatch?: number;
    /**
     * The user who queued this write.
     *
     * A replay uses `fetch`, which sends whatever session cookie is CURRENT —
     * not the one that queued the item. On a shared farm device that has two
     * consequences, and the second is the reason this field exists:
     *
     *   - same tenant, different operator: the write lands attributed to
     *     whoever happens to be signed in, in a hash-chained audit trail;
     *   - different tenant: the URL carries the original tenant's slug, the
     *     Edge answers 403, `flushOutbox` treats a terminal 4xx as
     *     undeliverable and REMOVES the item — silently, and invisibly to the
     *     loss detector, because the removal looks deliberate and the manifest
     *     is re-mirrored from the queue immediately after.
     *
     * Absent on items queued before this shipped; those keep their old
     * behaviour, since there is nothing to attribute them to.
     */
    queuedByUserId?: string;
    /** Present ⇒ a 409 conflict is awaiting operator resolution (not re-sent). */
    conflict?: OutboxConflict;
}

export interface MutationOutboxItem extends OutboxItemBase {
    kind?: 'mutation';
    body: unknown;
}

export interface PhotoOutboxItem extends OutboxItemBase {
    kind: 'photo';
    /** Downscaled photo bytes — stored natively in IndexedDB. */
    blob: Blob;
    /** Multipart filename for the replayed upload. */
    fileName: string;
    /** MIME type of the blob (e.g. `image/jpeg`). */
    fileType: string;
}

export type OutboxItem = MutationOutboxItem | PhotoOutboxItem;

/** Narrow to the binary photo kind. */
export function isPhotoItem(item: OutboxItem): item is PhotoOutboxItem {
    return item.kind === 'photo';
}

/**
 * Upper bound on a QUEUED photo's compressed size. Photos are downscaled to
 * a few hundred KB before enqueue (see downscale-photo.ts); this cap is a
 * safety valve so a pathological blob (a downscale that failed open on a
 * huge original) can't wedge the queue or blow the IndexedDB quota. Enforced
 * at ENQUEUE — a rejected photo never enters the outbox.
 */
export const MAX_QUEUED_PHOTO_BYTES = 8 * 1024 * 1024;

/** Thrown by `enqueuePhoto` when a blob exceeds {@link MAX_QUEUED_PHOTO_BYTES}. */
export class PhotoTooLargeError extends Error {
    constructor(readonly size: number) {
        super(`Queued photo is ${size} bytes, over the ${MAX_QUEUED_PHOTO_BYTES}-byte cap`);
        this.name = 'PhotoTooLargeError';
    }
}

export interface OutboxStore {
    add(item: OutboxItem): Promise<void>;
    all(): Promise<OutboxItem[]>;
    update(item: OutboxItem): Promise<void>;
    remove(id: string): Promise<void>;
    /**
     * Optional durability signal: true when the backing store was destroyed
     * and rebuilt under this session (an eviction). Only the IndexedDB store
     * can observe this; the localStorage and in-memory stores omit it, and a
     * caller must treat "absent" as "cannot tell" rather than "did not
     * happen". See `IndexedDbOutboxStore.wasRecreated`.
     */
    wasRecreated?(): boolean;

    /**
     * Accept a recreation signal observed elsewhere (the service worker).
     * Optional: stores with no second opener have nothing to reconcile.
     */
    markRecreated?(): void;

    /**
     * Record that an item was removed DELIBERATELY, in the same transaction as
     * the removal. See `delivery-receipts.ts` — this is what lets the page tell
     * a drain apart from an eviction, including a drain the service worker did.
     */
    noteDelivered?(id: string): Promise<void>;

    /** Read and clear the delivery receipts. */
    takeDelivered?(): Promise<Array<{ id: string; at: number }>>;
}

export const OUTBOX_STORAGE_KEY = 'agri.offline.outbox.v1';

/** Stable id without a uuid dep (crypto.randomUUID where available). */
export function newOutboxId(): string {
    try {
        if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    } catch {
        /* fall through */
    }
    return `ob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * `localStorage`-backed store. Reads/writes the whole array each call —
 * fine for the handful of items a field session accumulates. Fails soft
 * (returns empty / no-ops) if storage is unavailable (private mode).
 */
export class LocalStorageOutboxStore implements OutboxStore {
    constructor(private readonly key: string = OUTBOX_STORAGE_KEY) {}

    private read(): OutboxItem[] {
        try {
            const raw = globalThis.localStorage?.getItem(this.key);
            return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
        } catch {
            return [];
        }
    }
    private write(items: OutboxItem[]): void {
        try {
            globalThis.localStorage?.setItem(this.key, JSON.stringify(items));
        } catch {
            /* storage full / unavailable — drop silently */
        }
    }

    async add(item: OutboxItem): Promise<void> {
        const items = this.read();
        items.push(item);
        this.write(items);
    }
    async all(): Promise<OutboxItem[]> {
        return this.read().sort((a, b) => a.createdAt - b.createdAt);
    }
    async update(item: OutboxItem): Promise<void> {
        this.write(this.read().map((x) => (x.id === item.id ? item : x)));
    }
    async remove(id: string): Promise<void> {
        this.write(this.read().filter((x) => x.id !== id));
    }
}

/** In-memory store for tests (and SSR no-op safety). */
export class InMemoryOutboxStore implements OutboxStore {
    private items: OutboxItem[] = [];
    async add(item: OutboxItem): Promise<void> {
        this.items.push(item);
    }
    async all(): Promise<OutboxItem[]> {
        return [...this.items].sort((a, b) => a.createdAt - b.createdAt);
    }
    async update(item: OutboxItem): Promise<void> {
        this.items = this.items.map((x) => (x.id === item.id ? item : x));
    }
    async remove(id: string): Promise<void> {
        this.items = this.items.filter((x) => x.id !== id);
    }
}

export interface EnqueueInput {
    url: string;
    method: OutboxMethod;
    body: unknown;
    label: string;
    /** Optimistic-lock version to send as `If-Match` on replay (see OutboxItem). */
    ifMatch?: number;
}

/** Append a mutation to the outbox; returns the created item. */
export async function enqueue(store: OutboxStore, input: EnqueueInput): Promise<MutationOutboxItem> {
    const queuedByUserId = getCurrentUserId();
    const item: MutationOutboxItem = {
        id: newOutboxId(),
        url: input.url,
        method: input.method,
        body: input.body,
        label: input.label,
        createdAt: Date.now(),
        attempts: 0,
        ...(queuedByUserId ? { queuedByUserId } : {}),
        ...(input.ifMatch !== undefined ? { ifMatch: input.ifMatch } : {}),
    };
    await store.add(item);
    return item;
}

export interface EnqueuePhotoInput {
    /** Tenant-scoped multipart POST target (e.g. `/journal/:id/files`). */
    url: string;
    /** The already-downscaled photo bytes. */
    blob: Blob;
    /** Multipart filename. */
    fileName: string;
    /** MIME type of the blob. */
    fileType: string;
    label: string;
}

/**
 * Append a photo (binary) upload to the outbox; returns the created item.
 * Enforces {@link MAX_QUEUED_PHOTO_BYTES} at enqueue — a blob over the cap
 * throws {@link PhotoTooLargeError} and is NOT queued, so a huge photo can
 * never wedge the drain loop.
 */
export async function enqueuePhoto(
    store: OutboxStore,
    input: EnqueuePhotoInput,
): Promise<PhotoOutboxItem> {
    if (input.blob.size > MAX_QUEUED_PHOTO_BYTES) {
        throw new PhotoTooLargeError(input.blob.size);
    }
    const item: PhotoOutboxItem = {
        id: newOutboxId(),
        kind: 'photo',
        url: input.url,
        method: 'POST',
        blob: input.blob,
        fileName: input.fileName,
        fileType: input.fileType,
        label: input.label,
        createdAt: Date.now(),
        attempts: 0,
    };
    await store.add(item);
    return item;
}

/** The default browser store (singleton). */
let browserStore: OutboxStore | null = null;
export function getOutboxStore(): OutboxStore {
    if (!browserStore) {
        // Prefer IndexedDB: it's the only queue the service worker can read
        // for Background Sync replay (localStorage is window-only). jsdom/SSR
        // have no IndexedDB, so those fall back to localStorage / in-memory —
        // keeping the rendered-test + SSR behaviour exactly as before.
        if (indexedDbAvailable()) {
            browserStore = new IndexedDbOutboxStore();
        } else if (typeof globalThis.localStorage !== 'undefined') {
            browserStore = new LocalStorageOutboxStore();
        } else {
            browserStore = new InMemoryOutboxStore();
        }
    }
    return browserStore;
}

/**
 * Client-side data retention — bound how long this device keeps a farm.
 *
 * ## Why this exists
 *
 * Epic B encrypts business content at rest **in the database**. That
 * boundary stops at the Postgres row: anything a client persists sits
 * outside the KEK/DEK hierarchy entirely, in plaintext, on a phone that
 * gets left in a field, sold, or handed to another worker.
 *
 * Two of those stores had no bound at all:
 *
 *  - `agri.offline.fieldop.v1.<taskId>` — the whole `FieldOpView` for
 *    every task an operator has ever opened: parcel names and geometry,
 *    prescription lines, doses, location. `clearFieldSnapshot` was
 *    written with the docstring "e.g. once the job is fully synced +
 *    closed" and had **zero callers**. Monotonic growth, forever, across
 *    sign-out and tenant switch.
 *  - The persistent SWR buckets, whose 24h TTL only fires when that
 *    namespace is hydrated — so a bucket for a tenant the operator has
 *    stopped visiting is never even looked at, let alone expired.
 *
 * ## The design decision that matters: this never touches the outbox
 *
 * An earlier design purged everything including the queue. Reviewing it
 * surfaced three separate ways that goes wrong, and all three are
 * properties of touching the outbox rather than of purging in general:
 *
 *  1. `useOfflineSync.flush()` ends in `refreshOutboxState()`, which
 *     rewrites the manifest from the live queue. Landing between a
 *     manifest clear and a queue clear leaves the manifest full and the
 *     queue empty — which is *precisely* the shape the loss detector
 *     reads as "this phone deleted your work", producing a sticky,
 *     false, unacknowledgeable banner.
 *  2. `flushOutbox` snapshots its items and `store.update()` is an
 *     upsert, so a flush in flight across a purge writes the departing
 *     operator's mutations back into the cleared store.
 *  3. Queued work is the one thing on the device that exists nowhere
 *     else. Deleting it is unrecoverable by definition.
 *
 * So the sweep is scoped to **caches only** — data that can be refetched.
 * Nothing here can lose work, race the flush loop, or trip the loss
 * detector, because it never writes to any store the outbox owns.
 *
 * The one place the outbox is consulted is READ-only and protective: a
 * field snapshot whose task still has queued work is never evicted,
 * because that snapshot is the render source for a cold offline reload
 * of a job the operator is still marking.
 */
import { FIELD_SNAPSHOT_PREFIX, fieldSnapshotWrittenAt } from './field-snapshot';
import { getOutboxStore } from './outbox';

/** Default retention for cached farm data on the device. */
export const CLIENT_DATA_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Stores this sweep MUST NOT touch, and why. Read as a contract: adding
 * anything the outbox owns reintroduces the failure modes above.
 */
export const NEVER_SWEPT: readonly string[] = [
    'agri-offline', // the outbox IndexedDB — unsynced work, exists nowhere else
    'agri.offline.outbox.manifest.v1', // mirrors the queue; clearing it alone fakes a loss
    'agri.offline.lostwork.v1', // a real loss record; clears only on operator ack
    'agri.offline.durability.v1', // the persist() verdict — a measurement, not data
];

/** Cache Storage buckets the sweep may delete wholesale. */
const SWEPT_CACHES = ['fielddata', 'pages'] as const;

export interface SweepOptions {
    /** Entries older than this are removed. `0` sweeps everything. */
    maxAgeMs?: number;
    /** Injectable clock, so the behaviour is testable without waiting. */
    now?: number;
}

export interface SweepResult {
    snapshotsRemoved: number;
    snapshotsKept: number;
    swrBucketsRemoved: number;
    cachesRemoved: number;
}

function safeLocalStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null; // private mode / disabled
    }
}

/** Task ids that still have queued outbox work — never evict their snapshots. */
async function tasksWithQueuedWork(): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
        for (const item of await getOutboxStore().all()) {
            // Field-op writes are `/…/field-operations/<taskId>/…`.
            const m = /\/field-operations\/([^/?]+)/.exec(item.url);
            if (m) ids.add(m[1]);
        }
    } catch {
        // Unreadable queue → protect EVERYTHING. Failing closed here costs
        // disk; failing open costs an operator the render source for a job
        // they are still working offline.
        return new Set(['*']);
    }
    return ids;
}

function sweepFieldSnapshots(
    ls: Storage,
    cutoff: number,
    protectedTasks: Set<string>,
): { removed: number; kept: number } {
    let removed = 0;
    let kept = 0;
    const protectAll = protectedTasks.has('*');
    const doomed: string[] = [];

    for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i);
        if (!key || !key.startsWith(FIELD_SNAPSHOT_PREFIX)) continue;
        const taskId = key.slice(FIELD_SNAPSHOT_PREFIX.length);
        if (protectAll || protectedTasks.has(taskId)) {
            kept++;
            continue;
        }
        // A legacy entry has no timestamp. Treat age-unknown as expired:
        // it was written before the wrapper existed, so it is at least as
        // old as this release, and the panel rewrites a snapshot on every
        // mark — an actively-worked job gets a fresh timestamp immediately.
        const writtenAt = fieldSnapshotWrittenAt(ls.getItem(key));
        if (writtenAt !== null && writtenAt > cutoff) {
            kept++;
            continue;
        }
        doomed.push(key);
    }

    // Collect first, delete after: removing during the index walk shifts
    // every later key and silently skips half the store.
    for (const key of doomed) {
        try {
            ls.removeItem(key);
            removed++;
        } catch {
            /* ignore */
        }
    }
    return { removed, kept };
}

function sweepSwrBuckets(ls: Storage, cutoff: number): number {
    const doomed: string[] = [];
    for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i);
        if (!key || !key.startsWith('agrent-swr:')) continue;
        let writtenAt: number | null = null;
        try {
            const parsed = JSON.parse(ls.getItem(key) ?? '') as { t?: unknown };
            writtenAt = typeof parsed?.t === 'number' ? parsed.t : null;
        } catch {
            writtenAt = null; // unparseable → sweep it, it is unusable anyway
        }
        if (writtenAt === null || writtenAt <= cutoff) doomed.push(key);
    }
    for (const key of doomed) {
        try {
            ls.removeItem(key);
        } catch {
            /* ignore */
        }
    }
    return doomed.length;
}

/**
 * Delete the Cache Storage buckets holding tenant data.
 *
 * These are `PAGE_CACHE` (every server-rendered tenant document, rows
 * inline) and `DATA_CACHE` (field-op and location API responses —
 * including `Task.description` / `Task.resolution`, which are Epic B
 * encrypted at rest and cached here DECRYPTED).
 *
 * Callable straight from the window — no service-worker message
 * plumbing, which keeps the change out of `public/sw.js`, the hardest
 * file in this repo to roll back (install deliberately skips
 * `skipWaiting`, so a broken worker waits on operator consent).
 *
 * Whole-bucket delete rather than per-entry ageing: Cache Storage
 * responses carry no write timestamp we control, and the SW repopulates
 * on next use. An age-based per-entry sweep is deliberately deferred.
 */
async function sweepCaches(): Promise<number> {
    if (typeof caches === 'undefined') return 0;
    let removed = 0;
    try {
        for (const name of await caches.keys()) {
            if (SWEPT_CACHES.some((suffix) => name.endsWith(`-${suffix}`))) {
                if (await caches.delete(name)) removed++;
            }
        }
    } catch {
        /* Cache Storage unavailable — nothing to do */
    }
    return removed;
}

/**
 * Sweep expired cached farm data off this device.
 *
 * Never throws: a retention sweep must not be able to break the app it
 * is protecting.
 */
export async function sweepClientStores(options: SweepOptions = {}): Promise<SweepResult> {
    const { maxAgeMs = CLIENT_DATA_MAX_AGE_MS, now = Date.now() } = options;
    const cutoff = now - maxAgeMs;
    const result: SweepResult = {
        snapshotsRemoved: 0,
        snapshotsKept: 0,
        swrBucketsRemoved: 0,
        cachesRemoved: 0,
    };

    const ls = safeLocalStorage();
    if (ls) {
        const protectedTasks = await tasksWithQueuedWork();
        const snapshots = sweepFieldSnapshots(ls, cutoff, protectedTasks);
        result.snapshotsRemoved = snapshots.removed;
        result.snapshotsKept = snapshots.kept;
        result.swrBucketsRemoved = sweepSwrBuckets(ls, cutoff);
    }
    result.cachesRemoved = await sweepCaches();
    return result;
}

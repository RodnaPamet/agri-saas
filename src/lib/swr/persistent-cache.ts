/**
 * Roadmap-6 P3 — per-tenant persistent SWR cache provider.
 *
 * The PWA's SWR cache is memory-only by default: relaunch the app (or
 * let iOS/Android evict the tab) and the next cold start refetches the
 * WHOLE farm — every list, over rural LTE. This module gives SWR a
 * durable, self-evicting cache backing so a relaunch paints instantly
 * from disk and only revalidates (cheaply, thanks to the ETag/304 seam)
 * in the background.
 *
 * Design — two tiers, one Map:
 *
 *   • **localStorage (small / fast).** Hydrated SYNCHRONOUSLY at
 *     provider construction, so SWR renders from cache on the very
 *     first paint. This is the tier the rendered test exercises. Bodies
 *     serializing under `LS_BYTE_BUDGET` live here.
 *
 *   • **IndexedDB (large / durable).** Hydrated best-effort and
 *     ASYNCHRONOUSLY (IDB has no sync API); it backfills entries too
 *     large for localStorage. If IndexedDB is unavailable (private
 *     mode, old WebView, disabled) the whole tier silently no-ops and
 *     localStorage carries the load — never a crash.
 *
 * Isolation — the cache bucket is keyed PER TENANT (`namespace`), so a
 * shared device that signs into two tenants never lets one tenant's
 * cached rows surface under the other. The caller
 * (`SWRPersistenceProvider`) derives the namespace from the active
 * tenant slug and remounts `SWRConfig` when it changes, giving each
 * tenant its own freshly-hydrated Map.
 *
 * Self-eviction — every persisted bucket carries a schema `v` (bump
 * `SWR_CACHE_VERSION` to invalidate all buckets on a shape change) and
 * a write timestamp `t`. On hydrate, a bucket older than `maxAgeMs`
 * (default 24h) or from a stale version is dropped wholesale — stale
 * data never resurrects.
 */

/**
 * Bump on any change to the persisted entry shape (or to force-evict
 * every client's on-disk cache after a data-model change). A bucket
 * written under a different version is ignored on read.
 *
 * **2 (2026-08-19)** — the persist allowlist below. The bump is the
 * REMEDIATION, not bookkeeping: v1 buckets on real devices already hold
 * responses the allowlist now excludes, and nothing else removes them.
 * The 24h TTL only fires when that namespace is hydrated, and the
 * IndexedDB tier has no delete path at all — so a phone that never opens
 * the Rent page again keeps its lease PII indefinitely. `parseBucket`
 * rejects a wrong-version bucket wholesale, so bumping erases every
 * existing bucket, both tiers, on the next launch.
 */
export const SWR_CACHE_VERSION = 2;

/** Default max age of a persisted bucket before it self-evicts. */
export const SWR_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * The ONLY endpoints whose responses may be written to disk.
 *
 * ## Why an allowlist and not a denylist
 *
 * A denylist protects what someone remembered to list, and this repo
 * already ran that experiment. `ParcelLease.lessorName` / `lessorEik` sit
 * in the Epic B `ENCRYPTED_FIELDS` manifest *precisely because* they are
 * personal data about a third party the farm contracts with — and they
 * still reached plaintext `localStorage`, because persisting them
 * required nobody's decision. It required only that the Rent page use
 * `useTenantSWR` like every other list. Nobody connected the two facts
 * for the entire life of the feature.
 *
 * No static analysis can decide "is this response sensitive". So the
 * question is only which way the omission fails:
 *
 *   - a forgotten DENYLIST entry writes personal data to a phone;
 *   - a forgotten ALLOWLIST entry costs one cold-start refetch.
 *
 * The second is the cost this cache exists to avoid, which makes it a
 * real cost — and still the right one to pay. It also closes the CLASS:
 * an endpoint nobody has written yet is safe by default.
 *
 * ## What belongs here
 *
 * The lists the cold-start work (Roadmap-6 P3) was actually built for —
 * the same four that got `jsonWithETag` for conditional revalidation.
 * Adding an entry means deciding that this response is acceptable on a
 * phone that may be lost, sold, or handed to another worker. If it
 * carries names, contacts, identifiers, financial terms or anything from
 * `ENCRYPTED_FIELDS`, the answer is no — leave it memory-only and let it
 * refetch.
 */
const PERSISTABLE_PATHS: readonly string[] = [
    '/journal',
    '/farm-tasks',
    '/locations',
    '/exchange/listings',
];

/**
 * Normalise an SWR key to a tenant-relative path.
 *
 * Keys are resolved absolute URLs (`useTenantSWR` builds
 * `/api/t/<slug>/<path>`), so strip the query, the hash and the tenant
 * prefix. A key that does not match that shape — a non-tenant endpoint
 * like `/api/auth/me`, or a bespoke key — returns as-is and simply will
 * not match the allowlist, which is the safe outcome.
 */
export function tenantRelativePath(key: string): string {
    const withoutQuery = key.split('?')[0].split('#')[0];
    const m = /^\/api\/t\/[^/]+(\/.*)?$/.exec(withoutQuery);
    return m ? (m[1] ?? '/') : withoutQuery;
}

/**
 * May this SWR key's response be written to disk?
 *
 * Segment-aware on purpose: `startsWith('/leases')` would also match
 * `/leases-summary`, and a prefix test that leaks a neighbouring
 * endpoint is the same bug as a denylist.
 */
export function isPersistableKey(key: string): boolean {
    const path = tenantRelativePath(key);
    return PERSISTABLE_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

const LS_PREFIX = 'agrent-swr';
/**
 * Serialized-payload ceiling for the localStorage tier (~1.5 MB, safely
 * under the ~5 MB per-origin localStorage cap once other keys are
 * accounted for). Above this the bucket goes to IndexedDB instead.
 */
const LS_BYTE_BUDGET = 1_500_000;

const IDB_NAME = 'agrent-swr-cache';
const IDB_STORE = 'buckets';

/** A single SWR key → its cached `data` (transient state is dropped). */
type SerializedEntry = [key: string, data: unknown];

interface PersistedBucket {
    v: number;
    t: number;
    entries: SerializedEntry[];
}

/**
 * Minimal SWR cache-state shape we read/write. SWR stores richer state
 * per key (`isValidating`, `isLoading`, …) but only `data` is worth
 * persisting; transient flags and non-serializable `error` objects are
 * intentionally dropped. Structurally assignable to SWR's own `State`
 * so a `Map<string, SwrState>` satisfies SWR's `Cache` contract.
 */
export interface SwrState {
    data?: unknown;
    error?: unknown;
}

type CacheMap = Map<string, SwrState>;

export interface PersistentCacheOptions {
    /** Per-tenant bucket key (usually the tenant slug). */
    namespace: string;
    /** Override the default 24h eviction window (tests). */
    maxAgeMs?: number;
    /** Injectable clock (tests). */
    now?: () => number;
    /**
     * Injectable localStorage-like store (tests). Defaults to the real
     * `window.localStorage` when available.
     */
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

export function storageKey(namespace: string): string {
    return `${LS_PREFIX}:v${SWR_CACHE_VERSION}:${namespace}`;
}

function resolveLocalStorage(
    override: PersistentCacheOptions['storage'],
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
    if (override !== undefined) return override;
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            return window.localStorage;
        }
    } catch {
        // Access to localStorage can throw in sandboxed iframes / private
        // mode — treat as unavailable.
    }
    return null;
}

/** A valid, in-window bucket, or null if stale / malformed / wrong version. */
function parseBucket(
    raw: string | null,
    now: number,
    maxAgeMs: number,
): PersistedBucket | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as PersistedBucket;
        if (
            !parsed ||
            parsed.v !== SWR_CACHE_VERSION ||
            typeof parsed.t !== 'number' ||
            !Array.isArray(parsed.entries)
        ) {
            return null;
        }
        if (now - parsed.t > maxAgeMs) return null; // stale → self-evict
        return parsed;
    } catch {
        return null;
    }
}

function applyBucket(map: CacheMap, bucket: PersistedBucket): void {
    for (const [key, data] of bucket.entries) {
        if (typeof key !== 'string' || map.has(key)) continue;
        // Gate the READ too, not just the write. Without this a bucket
        // already on disk keeps rehydrating its now-disallowed entries
        // into memory, and the next flush is not guaranteed to run — so
        // the data would keep surfacing in the UI even though nothing
        // would write it again. Belt and braces alongside the version
        // bump, which is what actually erases those bytes.
        if (!isPersistableKey(key)) continue;
        // Seed as an SWR state object; SWR reads `.data`.
        map.set(key, { data });
    }
}

/** Collect the persistable subset of the live cache: keys with data, no error. */
function collectEntries(map: CacheMap): SerializedEntry[] {
    const entries: SerializedEntry[] = [];
    for (const [key, value] of map.entries()) {
        if (typeof key !== 'string' || key.startsWith('$')) continue;
        // The allowlist gate. `collectEntries` is the single write
        // funnel — `flush()` serialises ONE entries array and uses it for
        // both the localStorage write and the IndexedDB spill — so
        // gating here covers both tiers and every spill path.
        if (!isPersistableKey(key)) continue;
        const state = value as SwrState | undefined;
        if (!state || state.data === undefined || state.error !== undefined) {
            continue;
        }
        entries.push([key, state.data]);
    }
    return entries;
}

// ─── IndexedDB tier (best-effort, async, never throws) ───────────────

function idbAvailable(): boolean {
    try {
        return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch {
        return false;
    }
}

function openIdb(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        try {
            const req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

async function idbRead(key: string): Promise<string | null> {
    if (!idbAvailable()) return null;
    const db = await openIdb();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () =>
                resolve(typeof req.result === 'string' ? req.result : null);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        } finally {
            // db closes with the transaction lifecycle; no explicit close
            // to avoid racing an in-flight request.
        }
    });
}

async function idbWrite(key: string, payload: string): Promise<void> {
    if (!idbAvailable()) return;
    const db = await openIdb();
    if (!db) return;
    await new Promise<void>((resolve) => {
        try {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(payload, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        } catch {
            resolve();
        }
    });
}

/**
 * Create a Map suitable for SWR's `provider` option, hydrated from the
 * per-tenant persistent cache and wired to flush back on tab-hide.
 *
 * Safe to call on the server (returns a plain empty Map — every browser
 * API is feature-detected).
 */
export function createPersistentCacheProvider(
    opts: PersistentCacheOptions,
): CacheMap {
    const map: CacheMap = new Map<string, SwrState>();
    const key = storageKey(opts.namespace);
    const now = opts.now ?? Date.now;
    const maxAgeMs = opts.maxAgeMs ?? SWR_CACHE_MAX_AGE_MS;
    const ls = resolveLocalStorage(opts.storage);

    // 1. Synchronous hydrate from localStorage — cache is live before the
    //    first render.
    try {
        const bucket = parseBucket(ls?.getItem(key) ?? null, now(), maxAgeMs);
        if (bucket) applyBucket(map, bucket);
        else if (ls) {
            // Drop a stale/mismatched bucket so it can't be re-read.
            try {
                ls.removeItem(key);
            } catch {
                /* ignore */
            }
        }
    } catch {
        /* hydration is best-effort */
    }

    // 2. Async best-effort backfill from IndexedDB (large buckets). Only
    //    fills keys not already present from localStorage.
    void (async () => {
        try {
            const bucket = parseBucket(await idbRead(key), now(), maxAgeMs);
            if (bucket) applyBucket(map, bucket);
        } catch {
            /* ignore */
        }
    })();

    // 3. Flush on tab-hide (the last reliable moment before eviction).
    if (typeof window !== 'undefined') {
        const flush = () => {
            try {
                const entries = collectEntries(map);
                const payload = JSON.stringify({
                    v: SWR_CACHE_VERSION,
                    t: now(),
                    entries,
                } satisfies PersistedBucket);

                if (payload.length <= LS_BYTE_BUDGET) {
                    try {
                        ls?.setItem(key, payload);
                    } catch {
                        // Quota exceeded → spill the whole bucket to IDB.
                        void idbWrite(key, payload);
                    }
                } else {
                    // Too big for the small tier: clear it and use IDB.
                    try {
                        ls?.removeItem(key);
                    } catch {
                        /* ignore */
                    }
                    void idbWrite(key, payload);
                }
            } catch {
                /* flush is best-effort */
            }
        };

        window.addEventListener('pagehide', flush);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') flush();
            });
        }
    }

    return map;
}

/**
 * Outbox durability — persistence request, the queue manifest, and the
 * lost-work record.
 *
 * ## The problem this exists for
 *
 * The outbox (`idb-outbox.ts`) holds unsynced field work in IndexedDB. By
 * default that is BEST-EFFORT storage: the browser may evict it whenever it
 * likes, and iOS is the aggressive case. Until this module landed the app
 * never called `navigator.storage.persist()`, so every queued mark and every
 * queued photo sat in storage the phone was free to delete — and if it did,
 * the app could not tell, because an evicted queue and a fully-drained queue
 * both read as "0 pending".
 *
 * Three jobs, deliberately in one framework-free module so they are unit
 * testable without a browser:
 *
 *  1. **Ask for persistence, and record the answer.** `requestPersistence()`
 *     is also the INSTRUMENT for the open question — see below.
 *  2. **Keep a manifest** of what is queued, in `localStorage`, so a queue
 *     that disappears while the app is closed is still detectable on the
 *     next launch.
 *  3. **Record loss durably** once detected, so it survives the reload and
 *     the operator cannot navigate away from it by accident.
 *
 * ## WHAT persist() RETURNS ON A REAL iPHONE — MEASURED 2026-08-23/24
 *
 * The spike finding asked for `persisted()` / `persist()` / `estimate()` read
 * off a physical device in both mobile Safari and Home Screen mode. That
 * measurement HAS now been taken, on a physical iPhone, and the two contexts
 * DISAGREE: mobile Safari REFUSES (`persisted: false`); the installed Home
 * Screen PWA GRANTS (`persisted: true`). So installing the app is a real
 * durability mitigation on iOS rather than a packaging preference — in
 * Safari the behavioural mitigations are the only defence and eviction is
 * live. See `docs/implementation-notes/2026-08-19-outbox-durability.md`.
 *
 * This module is what MADE that measurement and is what keeps making it: it
 * calls the API, stores the verdict under {@link DURABILITY_STORAGE_KEY},
 * and `/t/<slug>/diagnostics/offline` renders it. Support reads the answer
 * back off the device from that cached verdict — which is also why the
 * diagnostics page must never call `persist()` itself.
 *
 * That is why the behaviour here does not branch on the expected answer:
 * everything downstream (manifest, loss detection, the "on this phone" vs
 * "the farm has it" distinction) is correct whether persistence is granted or
 * refused. A GRANT lowers the probability of eviction; it does not remove it —
 * the user can still clear website data, and Safari still evicts on its own
 * terms — so the app must be honest about the queue either way.
 */

/** Where the last durability verdict is cached for support to read back. */
export const DURABILITY_STORAGE_KEY = 'agri.offline.durability.v1';
/** Ids currently believed to be queued — see {@link reconcileManifest}. */
export const MANIFEST_STORAGE_KEY = 'agri.offline.outbox.manifest.v1';
/** Work the phone removed before it reached the server. */
export const LOST_WORK_STORAGE_KEY = 'agri.offline.lostwork.v1';

/** What `navigator.storage` said, and when. */
export interface DurabilityVerdict {
    /** False when the Storage API is absent entirely (old WebKit, insecure ctx). */
    supported: boolean;
    /** `navigator.storage.persisted()` — is this origin's storage protected? */
    persisted: boolean;
    /** True once `persist()` has been called in this browser at least once. */
    requested: boolean;
    /** `estimate().quota` in bytes, when the browser reports one. */
    quota?: number;
    /** `estimate().usage` in bytes, when the browser reports one. */
    usage?: number;
    /** ISO timestamp of this reading. */
    at: string;
}

/** One queued item, as recorded in the manifest. */
export interface ManifestEntry {
    id: string;
    /** The human label from the outbox item ("Mark North 40 done"). */
    label: string;
    createdAt: number;
}

/** Work that was queued and then vanished without being delivered. */
export interface LostWorkRecord {
    entries: ManifestEntry[];
    /** ISO timestamp of the detection. */
    detectedAt: string;
    /** How the loss became visible — useful in a support conversation. */
    cause: 'storage-evicted' | 'queue-vanished-while-closed';
}

// ── localStorage helpers (fail-soft: private mode must never throw) ──────

function readJson<T>(key: string): T | null {
    try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

function writeJson(key: string, value: unknown): void {
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
        /* quota / private mode — the feature degrades, it must not throw */
    }
}

function removeKey(key: string): void {
    try {
        globalThis.localStorage?.removeItem(key);
    } catch {
        /* no-op */
    }
}

// ── 1. Persistence request + measurement ────────────────────────────────

/**
 * The subset of `navigator.storage` this module uses. Declared structurally
 * so tests can inject a fake without `as any` (the auth-stack pinning rule
 * bans those, and there is no reason to be looser here).
 */
export interface StorageManagerLike {
    persisted?: () => Promise<boolean>;
    persist?: () => Promise<boolean>;
    estimate?: () => Promise<{ quota?: number; usage?: number }>;
}

/** Read the cached verdict without touching the browser API. */
export function readDurabilityVerdict(): DurabilityVerdict | null {
    return readJson<DurabilityVerdict>(DURABILITY_STORAGE_KEY);
}

/**
 * Ask the browser to make this origin's storage persistent, and record what
 * it said.
 *
 * WHEN TO CALL THIS: at the moment the first item is queued — not on first
 * paint. Two reasons, and both matter.
 *
 *  - Firefox shows a PERMISSION PROMPT for `persist()`. On first paint that
 *    is an unexplained interruption; at the moment an operator has just saved
 *    field work with no signal, "keep this on the device" is self-evidently
 *    the right answer.
 *  - Chromium grants on an engagement heuristic. Asking before the user has
 *    done anything is the case most likely to be refused.
 *
 * Idempotent and fail-soft. If the API is missing the verdict records
 * `supported: false`, which is itself the measurement.
 */
export async function requestPersistence(
    storage: StorageManagerLike | undefined = typeof navigator !== 'undefined'
        ? (navigator.storage as StorageManagerLike | undefined)
        : undefined,
): Promise<DurabilityVerdict> {
    const at = new Date().toISOString();
    if (!storage || typeof storage.persist !== 'function') {
        const verdict: DurabilityVerdict = { supported: false, persisted: false, requested: false, at };
        writeJson(DURABILITY_STORAGE_KEY, verdict);
        return verdict;
    }

    let persisted = false;
    let requested = false;
    try {
        // Already granted → do NOT call persist() again. On Firefox that
        // would re-prompt a user who has already said yes.
        persisted = typeof storage.persisted === 'function' ? await storage.persisted() : false;
        if (!persisted) {
            requested = true;
            persisted = await storage.persist();
        }
    } catch {
        // A rejected promise is a refusal, not a crash. Record it as one.
        persisted = false;
    }

    let quota: number | undefined;
    let usage: number | undefined;
    try {
        if (typeof storage.estimate === 'function') {
            const est = await storage.estimate();
            quota = est.quota;
            usage = est.usage;
        }
    } catch {
        /* estimate is diagnostic only — never let it fail the request */
    }

    const verdict: DurabilityVerdict = { supported: true, persisted, requested, quota, usage, at };
    writeJson(DURABILITY_STORAGE_KEY, verdict);
    return verdict;
}

// ── 2. The queue manifest ───────────────────────────────────────────────

export function readManifest(): ManifestEntry[] {
    const raw = readJson<ManifestEntry[]>(MANIFEST_STORAGE_KEY);
    return Array.isArray(raw) ? raw : [];
}

/**
 * Overwrite the manifest with the CURRENT queue. Called on every observed
 * queue change, so the manifest is a mirror rather than a log — an item the
 * page removed on purpose (delivered, dropped, conflict-resolved) leaves the
 * manifest in the same pass, and only an item that disappears WITHOUT the
 * page's knowledge is left behind for {@link reconcileManifest} to find.
 */
export function writeManifest(entries: ManifestEntry[]): void {
    if (entries.length === 0) {
        removeKey(MANIFEST_STORAGE_KEY);
        return;
    }
    writeJson(MANIFEST_STORAGE_KEY, entries);
}

/**
 * Compare the manifest against the queue as it actually is at startup, and
 * return the entries that went missing while the app was closed.
 *
 * ## Why `backgroundSyncPossible` is a required argument
 *
 * "In the manifest but not in the queue" has exactly two explanations: the
 * service worker delivered it via Background Sync while the app was closed,
 * or the phone evicted it. The page cannot tell them apart after the fact —
 * the SW cannot write `localStorage`, so it leaves no receipt.
 *
 * It does not have to. **Background Sync does not exist on iOS**, which is
 * the platform this whole investigation is about. Where the API is absent,
 * nothing but the page can remove an item, so a gap is unambiguously loss.
 * Where it IS present (Chromium), this returns nothing rather than accusing
 * the browser of losing work it actually delivered.
 *
 * The honest cost of that choice: on Android an eviction while the app is
 * closed goes unreported by THIS path. The in-session detector in
 * `idb-outbox.ts` still covers it while the app is open, and a false "your
 * work is gone" on a platform that had in fact delivered it would be worse —
 * it would teach operators to ignore the warning.
 */
/**
 * Drop entries that were removed deliberately, per their delivery receipts.
 *
 * Called before reconciliation so a drain — by this page or by the service
 * worker — never presents as a gap. Without it the manifest keeps listing work
 * that reached the server, and the next cross-session pass reads that as an
 * eviction.
 */
export function forgetManifestEntries(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    const manifest = readManifest();
    if (manifest.length === 0) return;
    writeManifest(manifest.filter((e) => !drop.has(e.id)));
}

export function reconcileManifest(
    queuedIds: readonly string[],
    backgroundSyncPossible: boolean,
): ManifestEntry[] {
    const manifest = readManifest();
    if (manifest.length === 0) return [];
    if (backgroundSyncPossible) return [];
    const present = new Set(queuedIds);
    return manifest.filter((entry) => !present.has(entry.id));
}

/** True when the SW could have drained the queue while the app was closed. */
export function backgroundSyncPossible(): boolean {
    try {
        if (typeof globalThis.ServiceWorkerRegistration === 'undefined') return false;
        return 'sync' in globalThis.ServiceWorkerRegistration.prototype;
    } catch {
        return false;
    }
}

// ── 3. The lost-work record ─────────────────────────────────────────────

export function readLostWork(): LostWorkRecord | null {
    const rec = readJson<LostWorkRecord>(LOST_WORK_STORAGE_KEY);
    if (!rec || !Array.isArray(rec.entries) || rec.entries.length === 0) return null;
    return rec;
}

/**
 * Record loss durably. ADDITIVE — a second detection appends rather than
 * replaces, because two separate losses are two separate things an operator
 * needs to know about, and the second must not quietly erase the first.
 *
 * De-duplicated by id so a repeated detection of the SAME items (a reload
 * before the operator acknowledges) does not inflate the count.
 */
export function recordLostWork(entries: readonly ManifestEntry[], cause: LostWorkRecord['cause']): LostWorkRecord | null {
    if (entries.length === 0) return readLostWork();
    const existing = readLostWork();
    const merged = [...(existing?.entries ?? [])];
    const seen = new Set(merged.map((e) => e.id));
    for (const entry of entries) {
        if (!seen.has(entry.id)) {
            merged.push(entry);
            seen.add(entry.id);
        }
    }
    const record: LostWorkRecord = {
        entries: merged,
        detectedAt: new Date().toISOString(),
        cause: existing?.cause ?? cause,
    };
    writeJson(LOST_WORK_STORAGE_KEY, record);
    return record;
}

/**
 * Clear the record — ONLY in response to an explicit operator acknowledgement.
 * Nothing in the sync path may call this: a banner that clears itself when the
 * next flush succeeds is exactly the "resurrect a partial queue as if
 * complete" failure this module exists to prevent.
 */
export function acknowledgeLostWork(): void {
    removeKey(LOST_WORK_STORAGE_KEY);
}

'use client';

/**
 * Offline field-op snapshot — lets an operator's job page open with NO
 * signal (a cold offline reload), not just stay usable once loaded.
 *
 * The service worker serves the cached page *document* offline, but
 * `/api/*` is deliberately network-only (the SW never caches authenticated
 * tenant data), so SWR's field-op fetch fails offline and the panel would
 * otherwise render "not found". `OfflineFieldPanel` writes the last-loaded
 * field-op here (keyed by taskId) and reads it back as the render source
 * when the network fetch has nothing — and it persists every optimistic
 * mark, so a cold reload reflects work already queued in the outbox.
 *
 * `localStorage`, same store family + fail-soft posture as the outbox
 * (private mode / quota → no-op, never throws).
 */

export const FIELD_SNAPSHOT_PREFIX = 'agri.offline.fieldop.v1.';
const PREFIX = FIELD_SNAPSHOT_PREFIX;

function keyFor(taskId: string): string {
    return `${PREFIX}${taskId}`;
}

/**
 * Stored shape. The `t` wrapper was added 2026-08-19 so these can be
 * aged out — before it, a snapshot was the bare payload with no
 * timestamp, `clearFieldSnapshot` had ZERO callers, and every task an
 * operator ever opened left a permanent record of the whole field-op
 * view (parcel geometry, prescription lines, location name) on the
 * device. Reads accept the legacy bare shape so no operator loses a
 * snapshot on upgrade; the retention sweep treats it as age-unknown.
 */
interface StoredSnapshot<T> {
    /** Write timestamp (ms). Absent ⇒ legacy bare payload. */
    t: number;
    data: T;
}

/** Persist the field-op view for offline cold-load. Fail-soft. */
export function saveFieldSnapshot<T>(taskId: string, data: T): void {
    try {
        const wrapped: StoredSnapshot<T> = { t: Date.now(), data };
        globalThis.localStorage?.setItem(keyFor(taskId), JSON.stringify(wrapped));
    } catch {
        /* storage full / unavailable — drop silently */
    }
}

/** Read the last-saved field-op view, or null when none / unavailable. */
export function readFieldSnapshot<T>(taskId: string): T | null {
    try {
        const raw = globalThis.localStorage?.getItem(keyFor(taskId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as StoredSnapshot<T> | T;
        // Back-compat: a legacy entry is the bare payload. Detected by the
        // wrapper's shape rather than by a version marker, because the
        // legacy form has no marker to read.
        if (
            parsed &&
            typeof parsed === 'object' &&
            typeof (parsed as StoredSnapshot<T>).t === 'number' &&
            'data' in (parsed as StoredSnapshot<T>)
        ) {
            return (parsed as StoredSnapshot<T>).data;
        }
        return parsed as T;
    } catch {
        return null;
    }
}

/** Write timestamp of a stored snapshot, or null when legacy / absent. */
export function fieldSnapshotWrittenAt(raw: string | null): number | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as { t?: unknown };
        return typeof parsed?.t === 'number' ? parsed.t : null;
    } catch {
        return null;
    }
}

/** Drop a snapshot (e.g. once the job is fully synced + closed). Fail-soft. */
export function clearFieldSnapshot(taskId: string): void {
    try {
        globalThis.localStorage?.removeItem(keyFor(taskId));
    } catch {
        /* no-op */
    }
}

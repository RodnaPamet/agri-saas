'use client';

/**
 * Smart-nav — per-tab previous-path tracker (ported from IC RQ4-3).
 *
 * Reads from `sessionStorage` (per-tab, ephemeral, cross-tenant-safe) and
 * returns the in-tenant pathname the user navigated FROM, or `null` when
 * the user arrived via a cold load / deep link / fresh tab. The
 * `<BackAffordance>` primitive falls back to the canonical parent when
 * this returns null.
 *
 * Why sessionStorage and not localStorage:
 *   - per-tab — two tabs don't fight over the same slot
 *   - ephemeral — closing the tab clears it; we never want a 2-day-old
 *     "previous path" surfacing on a fresh session
 *
 * Why scoped by tenant slug:
 *   - leaving a tenant clears it; a tenant-A page never appears as the
 *     back destination on a tenant-B view
 */
import { useCallback, useSyncExternalStore } from 'react';

export const PREV_PATH_KEY_PREFIX = 'inflect:nav:prev:';

export function prevPathStorageKey(tenantSlug: string): string {
    return `${PREV_PATH_KEY_PREFIX}${tenantSlug}`;
}

/**
 * Extract the tenant slug from a tenant-scoped pathname, or `null` if the
 * path doesn't start with `/t/<slug>/`.
 */
export function tenantSlugFromPath(pathname: string): string | null {
    const match = pathname.match(/^\/t\/([^/]+)/);
    return match ? match[1] : null;
}

/**
 * Read the previously-visited in-tenant pathname for the given tenant.
 * Returns `null` when running on the server, when no path is stored, or
 * when sessionStorage is unavailable (private mode, quota errors).
 */
export function readPreviousPath(tenantSlug: string): string | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.sessionStorage.getItem(prevPathStorageKey(tenantSlug));
    } catch {
        return null;
    }
}

/**
 * Write the current pathname into the previous-path slot for the given
 * tenant. Silent on quota or DOM errors — referrer tracking is best-effort
 * and never throws into the render path.
 */
export function writePreviousPath(tenantSlug: string, pathname: string): void {
    if (typeof window === 'undefined') return;
    try {
        window.sessionStorage.setItem(prevPathStorageKey(tenantSlug), pathname);
    } catch {
        /* best-effort */
    }
}

/**
 * Clear the previous-path slot for the given tenant. Called on cross-
 * tenant transitions to prevent tenant-A paths from leaking into
 * tenant-B's back affordance.
 */
export function clearPreviousPath(tenantSlug: string): void {
    if (typeof window === 'undefined') return;
    try {
        window.sessionStorage.removeItem(prevPathStorageKey(tenantSlug));
    } catch {
        /* best-effort */
    }
}

/**
 * Hook used by `<BackAffordance>` to read the previous in-tenant pathname.
 * Re-reads on mount and whenever `tenantSlug` changes. The
 * `<NavigationTracker>` component is responsible for KEEPING the value
 * current — this hook only reads.
 */
/**
 * `useSyncExternalStore` needs a stable subscribe function, and this store
 * has no change events to subscribe TO: `<NavigationTracker>` writes the
 * slot on navigation, and by the time a new route renders this hook has
 * already re-read it. So the subscription is a no-op that never fires —
 * which preserves the previous behaviour exactly (read on mount and on
 * `tenantSlug` change, never live-update mid-render).
 *
 * Module scope, not inline: a fresh function identity each render makes
 * React re-subscribe on every commit.
 */
const subscribeToNothing = (): (() => void) => () => {};

export function usePreviousPath(tenantSlug: string | null): string | null {
    // Read through `useSyncExternalStore` rather than `useState` + a
    // `useEffect` that calls `setPrev`. The effect form is a synchronous
    // setState inside an effect, which React flags
    // (`react-hooks/set-state-in-effect`) because it schedules a second
    // render pass on every mount purely to move a value that was already
    // available. This is the API React provides for reading an external
    // mutable source — here `sessionStorage`.
    const getSnapshot = useCallback(
        () => (tenantSlug ? readPreviousPath(tenantSlug) : null),
        [tenantSlug],
    );

    // The SERVER snapshot is `null`, matching the old `useState(null)`
    // initial value, so hydration sees what it saw before and cannot
    // mismatch. `readPreviousPath` also guards `typeof window`, so this is
    // belt and braces on purpose.
    return useSyncExternalStore(subscribeToNothing, getSnapshot, () => null);
}

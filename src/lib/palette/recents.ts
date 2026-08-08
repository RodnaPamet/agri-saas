/**
 * Bounded recent-items model for the command palette.
 *
 * Pure helpers — no React, no `localStorage` calls. The palette
 * binds these via `useLocalStorage` (the project's SSR-safe hook
 * at `src/components/ui/hooks/use-local-storage.ts`); the helpers
 * here just operate on `RecentItem[]` so the model is unit-
 * testable without a DOM.
 *
 * Design choices:
 *
 *   - **Per-tenant key**. Recents are scoped per-tenant so
 *     switching tenants doesn't leak the wrong workspace's
 *     entities into the palette. Storage key includes the slug.
 *   - **FIFO with dedupe-on-touch**. Picking the same entity
 *     again moves it to the top instead of stacking duplicates.
 *     The list stays bounded at `MAX_RECENTS` so a power user
 *     who picks 200 controls in a session doesn't bloat
 *     localStorage.
 *   - **Schema-versioned payload**. The wire shape carries a
 *     `version` field so a future migration (e.g. adding a
 *     `favourite` flag) can detect + reject older blobs without
 *     blowing up. `loadRecents` rejects unknown shapes silently.
 *   - **Type-narrow**. `RecentItem.type` mirrors the search
 *     contract's `SearchHitType` — adding a new entity kind to
 *     search auto-extends recents without a separate touch.
 */

import type { SearchHit, SearchHitType } from '@/lib/search/types';

// ─── Public types ─────────────────────────────────────────────────────

export interface RecentItem {
    type: SearchHitType;
    id: string;
    title: string;
    href: string;
    iconKey: SearchHit['iconKey'];
    /** ms since epoch — for ordering on load + display tooltips. */
    lastVisitedAt: number;
}

interface RecentsBlob {
    version: 1;
    items: RecentItem[];
}

// ─── Tunables ─────────────────────────────────────────────────────────

/** Cap on stored recents per tenant. Keeps localStorage bounded + the palette readable. */
export const MAX_RECENTS = 10;

/** Storage key prefix; the per-tenant slug is appended. */
export const RECENTS_STORAGE_PREFIX = 'inflect:palette:recents';

export function recentsStorageKey(tenantSlug: string): string {
    return `${RECENTS_STORAGE_PREFIX}:${tenantSlug}`;
}

// ─── Pure helpers ─────────────────────────────────────────────────────

/**
 * Append (or move-to-top) an item, dedupe by `(type, id)`, cap at
 * `MAX_RECENTS`. Returns a new array — never mutates the input.
 */
export function addRecent(
    list: ReadonlyArray<RecentItem>,
    item: Omit<RecentItem, 'lastVisitedAt'>,
    nowMs: number = Date.now(),
): RecentItem[] {
    const next: RecentItem = { ...item, lastVisitedAt: nowMs };
    const filtered = list.filter(
        (r) => !(r.type === item.type && r.id === item.id),
    );
    return [next, ...filtered].slice(0, MAX_RECENTS);
}

/**
 * Build a `RecentItem` from a unified-search hit. Lifts the
 * conversion out of the click handler so render-side code stays
 * narrow.
 */
export function recentFromHit(hit: SearchHit): Omit<RecentItem, 'lastVisitedAt'> {
    return {
        type: hit.type,
        id: hit.id,
        title: hit.title,
        href: hit.href,
        iconKey: hit.iconKey,
    };
}

/**
 * Defensive load — the localStorage value may be a stale blob
 * from an older schema, or a value tampered with by another tab.
 * Returns `[]` for any non-conforming input rather than throwing,
 * so a corrupted local store can never break palette open.
 */
export function loadRecents(raw: unknown): RecentItem[] {
    if (!raw || typeof raw !== 'object') return [];
    const blob = raw as Partial<RecentsBlob>;
    if (blob.version !== 1) return [];
    if (!Array.isArray(blob.items)) return [];
    const out: RecentItem[] = [];
    for (const it of blob.items) {
        if (!isValidItem(it)) continue;
        out.push(it);
        if (out.length >= MAX_RECENTS) break;
    }
    return out;
}

/**
 * Serialise to the wire shape `useLocalStorage` will JSON-encode.
 * Centralising the version bump here means the wire shape and
 * `loadRecents`'s expectations can never drift.
 */
export function serializeRecents(items: ReadonlyArray<RecentItem>): RecentsBlob {
    return { version: 1, items: items.slice(0, MAX_RECENTS) };
}

const VALID_TYPES: ReadonlySet<SearchHitType> = new Set([
    'control',
    'policy',
    'evidence',
    'framework',
    'knowledge',
]);

const VALID_ICONS: ReadonlySet<SearchHit['iconKey']> = new Set([
    'shield-check',
    'alert-triangle',
    'file-text',
    'paperclip',
    'layers',
]);

function isValidItem(value: unknown): value is RecentItem {
    if (!value || typeof value !== 'object') return false;
    const v = value as Partial<RecentItem>;
    return (
        typeof v.type === 'string' &&
        VALID_TYPES.has(v.type as SearchHitType) &&
        typeof v.id === 'string' &&
        v.id.length > 0 &&
        typeof v.title === 'string' &&
        typeof v.href === 'string' &&
        v.href.startsWith('/') &&
        typeof v.iconKey === 'string' &&
        VALID_ICONS.has(v.iconKey as SearchHit['iconKey']) &&
        typeof v.lastVisitedAt === 'number' &&
        Number.isFinite(v.lastVisitedAt)
    );
}

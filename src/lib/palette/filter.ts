/**
 * Pure filter helpers for the command-palette entity-type chips.
 *
 * The chips narrow the rendered subset of an existing
 * `SearchHit[]` payload (no refetch when chips toggle — the
 * server already returned all kinds in one call). Keeps the chip
 * interaction snappy and the request count flat.
 *
 * Helpers are GENERIC over any object that carries a kind
 * discriminator under a caller-chosen accessor, so callers using
 * either the canonical `SearchHit.type` shape OR the legacy
 * `EntitySearchResult.kind` adapter shape get the same logic.
 *
 * Active-filter semantics:
 *
 *   - `activeKinds.size === 0` (NO chips selected) → show ALL
 *     types. Equivalent to "filter is off". This avoids a
 *     "click All to see anything" footgun.
 *   - `activeKinds.size > 0` → show only those types. A chip
 *     showing 0 hits in the current result set still toggles
 *     normally (the user might be widening to include something
 *     that isn't there yet — chip count refreshes on next
 *     search).
 */

import type { SearchHitType } from '@/lib/search/types';

/**
 * Returns the subset of items whose discriminator-extractor
 * value is in the active set. Empty active set passes everything
 * through unchanged.
 */
export function filterHitsByKind<T>(
    items: ReadonlyArray<T>,
    activeKinds: ReadonlySet<SearchHitType>,
    getKind: (item: T) => SearchHitType,
): T[] {
    if (activeKinds.size === 0) return items.slice();
    return items.filter((item) => activeKinds.has(getKind(item)));
}

/**
 * Toggle a kind in/out of the active set. Pure — returns a new
 * Set, never mutates input. Lets the React reducer pass the
 * result straight to `setState`.
 */
export function toggleKind(
    active: ReadonlySet<SearchHitType>,
    kind: SearchHitType,
): Set<SearchHitType> {
    const next = new Set(active);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    return next;
}

/**
 * Per-chip count for the badge — derived from the FULL hit list
 * (not the post-filter list). Lets a user see "Policies (3)" even
 * when the Policies chip isn't currently active.
 */
export function countHitsByKind<T>(
    items: ReadonlyArray<T>,
    getKind: (item: T) => SearchHitType,
): Record<SearchHitType, number> {
    const out: Record<SearchHitType, number> = {
        control: 0,
        policy: 0,
        framework: 0,
        evidence: 0,
        asset: 0,
        task: 0,
        knowledge: 0,
    };
    for (const item of items) out[getKind(item)] += 1;
    return out;
}

/**
 * Unified tenant-scoped global search contract.
 *
 * Single typed payload consumed by every surface that wants
 * cross-entity discovery: the command palette today, the topbar
 * search field tomorrow, an SDK consumer the day after. The shape
 * is intentionally narrow — the API is responsible for ranking,
 * truncation, and href construction so every client renders the
 * same hits in the same order.
 *
 * What this contract is NOT:
 *   - a full-text engine (no Lucene-grade tokenisation, no fuzzy
 *     matching). The current implementation runs targeted
 *     `WHERE field LIKE %q%` queries against a curated set of
 *     fields per entity type. Good enough for the palette's
 *     "I'm looking for that one control / risk / policy" use
 *     case; not a substitute for Algolia / Elastic when those
 *     become necessary.
 *   - a permission-evaluation surface. We don't enrich hits with
 *     "you can/cannot edit this" — that lives on the detail page.
 *
 * Adding a new entity type:
 *   1. Add the literal to `SearchHitType`.
 *   2. Add a search query in `getUnifiedSearch` (RLS-scoped, with
 *      a per-type limit).
 *   3. Add display metadata to `SEARCH_TYPE_DEFAULTS` for the
 *     icon + category label.
 *   4. The palette auto-renders it via the existing per-kind
 *      grouping — no UI change needed.
 */

// ─── Entity types ──────────────────────────────────────────────────────

/**
 * Every entity kind that can appear in a search hit. Add a value
 * here AND a query branch in the usecase + display metadata in
 * `SEARCH_TYPE_DEFAULTS`; downstream code is type-checked.
 */
export type SearchHitType =
    | 'control'
    | 'policy'
    | 'evidence'
    | 'framework'
    | 'asset'
    | 'task'
    | 'knowledge';

// ─── Hit shape ─────────────────────────────────────────────────────────

/**
 * One row in the unified search response.
 *
 * `score` is the API's relevance ordering signal — higher is
 * better. The API also returns hits in score-DESC order, so a
 * dumb client can ignore the field entirely; it's exposed so
 * future surfaces can re-sort or threshold.
 *
 * Stable key is `${type}:${id}` — useful for React `key=` props
 * across mixed-type lists.
 */
export interface SearchHit {
    type: SearchHitType;
    /** Entity primary key (cuid) — or framework key for the framework type. */
    id: string;
    /** Main label rendered on the row. */
    title: string;
    /** Optional secondary label (status / score / version). */
    subtitle: string | null;
    /** Optional right-aligned tag (status enum). */
    badge: string | null;
    /** Tenant-scoped detail page href the row should navigate to on select. */
    href: string;
    /** Bounded relevance score. Implementation-specific magnitude; only ordering is part of the contract. */
    score: number;
    /** Stable icon key the renderer maps to a Lucide glyph (UI primitive defines the map). */
    iconKey:
        | 'shield-check'
        | 'alert-triangle'
        | 'file-text'
        | 'paperclip'
        | 'layers'
        | 'package'
        | 'check-square'
        | 'flask';
    /** Plural display name for grouping headers ("Controls", "Risks"...). */
    category: string;
}

// ─── Per-type metadata ─────────────────────────────────────────────────

/**
 * Single source of truth for icon + category label per type. Used
 * by both the API (when assembling hits) and clients that want to
 * render group headers without re-deriving the table.
 */
export const SEARCH_TYPE_DEFAULTS: Record<
    SearchHitType,
    { iconKey: SearchHit['iconKey']; category: string }
> = {
    control: { iconKey: 'shield-check', category: 'Controls' },
    policy: { iconKey: 'file-text', category: 'Policies' },
    evidence: { iconKey: 'paperclip', category: 'Evidence' },
    framework: { iconKey: 'layers', category: 'Frameworks' },
    asset: { iconKey: 'package', category: 'Assets' },
    task: { iconKey: 'check-square', category: 'Tasks' },
    // Knowledge Base articles — reuses the document glyph (the palette
    // group heading carries its own BookOpen icon).
    knowledge: { iconKey: 'file-text', category: 'Knowledge' },
};

// ─── Top-level payload ─────────────────────────────────────────────────

export interface SearchResponseMeta {
    /** Echo of the trimmed query the API actually used. */
    query: string;
    /** Per-type result count after capping. */
    perTypeCounts: Record<SearchHitType, number>;
    /** True when ANY type hit its per-type cap (so client can show "+more"). */
    truncated: boolean;
    /** Per-type cap actually applied. */
    perTypeLimit: number;
}

export interface SearchResponse {
    hits: SearchHit[];
    meta: SearchResponseMeta;
}

// ─── Tunables ──────────────────────────────────────────────────────────

/**
 * Per-type cap. Five hits per kind keeps the palette readable
 * (max 25 total across 5 types) and keeps each underlying
 * `WHERE LIKE` query fast (sub-10ms on the seeded DB). Bumping
 * this requires verifying the query plan still uses an index.
 */
export const DEFAULT_PER_TYPE_LIMIT = 5;

/**
 * Minimum query length the API accepts. Below this, we return an
 * empty result set without hitting the DB. Mirrors the
 * client-side gate so behaviour is consistent.
 *
 * Set to 1 so single-character queries (`1`, `2`, etc.) can match
 * entity codes / IDs / numeric identifiers — a user searching for
 * "risk 1" should be able to find it. Pre-2026-05-12 this was set
 * to 2 to defend the DB from over-broad queries, but with every
 * entity query already bounded by `perTypeLimit * 3` (currently 15
 * rows) and ILIKE-indexed columns, the DB cost of a 1-char query
 * is unchanged in practice.
 */
export const MIN_QUERY_LENGTH = 1;

/**
 * Maximum query length we'll accept. Defends against pathological
 * input that would still pass the trim guard (a 10MB string of
 * "a" characters). Anything longer is truncated.
 */
export const MAX_QUERY_LENGTH = 200;

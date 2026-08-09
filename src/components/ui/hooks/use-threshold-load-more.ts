'use client';

/**
 * PR-1 — Threshold-based "Load more" accumulator for tenant tables.
 *
 * The org-level tables already use `useCursorPagination` for a
 * server-cursor "Load more …" UX. Tenant tables historically render
 * the full result set in one go — fine when row counts are small,
 * but the dashboard's heaviest list pages (practices, risks,
 * evidence, tasks) can balloon past a few hundred rows on busy
 * tenants. That dragged DOM size + scroll cost the user no
 * particular discoverability win.
 *
 * This hook closes the gap WITHOUT requiring every list page to
 * migrate to a paginated API surface (most tenant pages already
 * have the full row set in memory via the existing
 * `LIST_BACKFILL_CAP` cap). It slices the input rows to a
 * threshold-sized window and exposes a `loadMore` action that
 * grows the window in fixed increments.
 *
 *   • If `rows.length <= threshold`, every row is visible from
 *     the start. `hasMore` is `false`, `loadMore` is a no-op.
 *   • If `rows.length > threshold`, only the first `threshold`
 *     rows are visible. `hasMore` is `true`. `loadMore()` adds
 *     `increment` more rows; calling it again reveals the next
 *     batch.
 *   • When the input `rows` shrinks (filters narrow the set) the
 *     visible window stays a single slice, so a narrowed result
 *     never hides the rows the user can see.
 *   • When the input `rows` grows past the current window AFTER a
 *     filter change (filter relaxes back), the window stays at
 *     the user's loaded size — no surprise re-collapse.
 *
 * The hook is purely client-side. The matching org-level cursor
 * pattern lives at `useCursorPagination`; both speak the same UX
 * vocabulary (`hasMore` + `loadMore` + `loading`/`error` on the
 * cursor variant; this variant has no async I/O so no `loading`
 * or `error` state). The shared `<TableLoadMoreFooter>` consumer
 * can render either return shape; see its props for the contract.
 */
import { useCallback, useMemo, useState } from 'react';

export interface UseThresholdLoadMoreOptions {
    /**
     * The visible-row threshold. Above this, the table starts in
     * a windowed state with a "Load more …" footer. Defaults to
     * 50 — the row count past which scanning + interaction friction
     * starts to compound on every modern list page surface.
     */
    threshold?: number;
    /**
     * How many rows each `loadMore()` call reveals. Defaults to
     * the threshold so the second slice is the same size as the
     * first — predictable rhythm.
     */
    increment?: number;
}

export interface UseThresholdLoadMoreResult<TRow> {
    /** Rows the consumer should hand to the table primitive. */
    visibleRows: TRow[];
    /** Total rows in the source array (for the "X of Y" count). */
    totalCount: number;
    /** True iff `visibleRows.length < totalCount`. */
    hasMore: boolean;
    /**
     * Reveal `increment` more rows (capped at `totalCount`).
     * No-op when there's nothing more to reveal.
     */
    loadMore: () => void;
    /** Collapse back to the initial threshold window. */
    reset: () => void;
}

export const DEFAULT_LOAD_MORE_THRESHOLD = 50;

export function useThresholdLoadMore<TRow>(
    rows: ReadonlyArray<TRow>,
    options: UseThresholdLoadMoreOptions = {},
): UseThresholdLoadMoreResult<TRow> {
    const threshold = options.threshold ?? DEFAULT_LOAD_MORE_THRESHOLD;
    const increment = options.increment ?? threshold;

    // The window size — how many rows the user has chosen to see.
    // Starts at `threshold`; grows by `increment` on each
    // `loadMore`. Stays put when `rows` shrinks (filter narrowed)
    // so a filtered subset stays fully visible, and stays put when
    // `rows` grows again (filter relaxed) so the user isn't
    // surprised by a re-collapse.
    const [windowSize, setWindowSize] = useState(threshold);

    const totalCount = rows.length;
    const visibleRows = useMemo(
        () => rows.slice(0, windowSize),
        [rows, windowSize],
    );
    const hasMore = totalCount > windowSize;

    const loadMore = useCallback(() => {
        setWindowSize((prev) => Math.min(prev + increment, Number.MAX_SAFE_INTEGER));
    }, [increment]);

    const reset = useCallback(() => {
        setWindowSize(threshold);
    }, [threshold]);

    return { visibleRows, totalCount, hasMore, loadMore, reset };
}

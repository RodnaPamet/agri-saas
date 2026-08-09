'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 53 — canonical filter toolbar for list pages.
 *
 * Composes the shared `FilterSelect` picker + `FilterList` active-pill strip
 * + a standardised free-text search input. Every migrated list page wires
 * this one component at its toolbar position; the filter definitions
 * (enum options, groups, range configs) come from that page's own
 * `filter-defs.ts`, so the toolbar stays entity-agnostic.
 *
 * Must be rendered inside a `<FilterProvider>` — it consumes state via
 * `useFilters()`. Page authors typically wrap their client component with
 * `FilterProvider` at the outer boundary (see any migrated *Client.tsx for
 * the pattern).
 *
 * Keyboard / a11y: the shared FilterSelect carries the `f` shortcut, Escape
 * cascade, and keyboard-driven option navigation. Free-text search lives
 * INSIDE the filter dropdown — there is no separate search bar. When a page
 * passes `searchPlaceholder`, the Filter popover's top input becomes a LIVE
 * content search (typing filters the table on a short debounce, no Enter)
 * and the filter categories stay listed below it. Pages without
 * `searchPlaceholder` keep the classic category-only picker.
 */

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
    Filter as FilterUI,
    filterStateToActiveFilters,
    useFilters,
    type ActiveFilter,
    type FilterType,
} from '@/components/ui/filter';

export interface FilterToolbarProps {
    /**
     * Resolved filter definitions for this page. Include any runtime-derived
     * options (owner / category lookups built from loaded rows).
     */
    filters: FilterType[];
    /**
     * DOM id of the search input. Required ONLY when the toolbar
     * renders a search input (see `searchPlaceholder`). Ignored
     * otherwise.
     */
    searchId?: string;
    /**
     * Placeholder text (usually "Search {entityPlural}…").
     *
     * **Omit to hide the search input entirely.** The toolbar's
     * other slots (filters, primary action, etc.) still render.
     * Pages should default to omitting it — the global ⌘K palette
     * is the canonical cross-page search; per-page text-search is
     * legacy. Locked by
     * `tests/guards/r14-no-page-searchbars.test.ts`.
     */
    searchPlaceholder?: string;
    /** Optional label for the FilterSelect trigger button. Defaults to "Filter". */
    triggerLabel?: ReactNode;
    /**
     * Secondary slot (right side of the toolbar, before the primary
     * cluster) — typically the DataTable's `<EditColumnsButton>` so
     * column visibility lives at the same eye-line as the filter
     * practices. Use this for icon-only ghost actions: bulk edit,
     * export, column visibility, settings.
     *
     * v2-PR-7 — was the only right-edge slot. The new `primary` slot
     * sits to the right of this one for the single primary action
     * (the "Create X" button). Existing call sites keep working
     * unchanged; new code reaching for a primary action should use
     * `primary` instead of crowding it into `actions`.
     */
    actions?: ReactNode;
    /**
     * Primary slot (rightmost — anchored to the right edge of the
     * toolbar). Reserved for the SINGLE primary action of the page —
     * typically a `<Button variant="primary">{action}</Button>`. The
     * lock to one slot is deliberate: list pages should not present
     * two co-equal primary actions.
     *
     * v2-PR-7 added this slot so the canonical reading order on
     * every list page is:
     *
     *   [search + filter button] [active pills (flex-1)] [secondary] [primary]
     *
     * Header-level "Create" buttons that used to live in
     * `EntityListPage header.actions` (right of the title) should
     * migrate here over time — keeping page headers navigational and
     * the toolbar mutate-only.
     */
    primary?: ReactNode;
    /** Optional className forwarded to the outer container. */
    className?: string;
}

/**
 * Dispatch a FilterSelect `onSelect` into the shared context, picking
 * `toggle` / `set` based on the filter definition's `multiple` / `type`.
 * Extracted here so every page calls the same branching logic.
 */
function dispatchOnSelect(
    filters: FilterType[],
    ctx: ReturnType<typeof useFilters>,
    key: string,
    value: string | string[],
): void {
    if (Array.isArray(value)) {
        for (const v of value) ctx.toggle(key, String(v));
        return;
    }
    const def = filters.find((f) => f.key === key);
    if (def?.type === 'range') {
        ctx.set(key, String(value));
    } else if (def?.multiple) {
        ctx.toggle(key, String(value));
    } else {
        ctx.set(key, String(value));
    }
}

export function FilterToolbar({
    filters,
    searchId,
    searchPlaceholder,
    triggerLabel,
    actions,
    primary,
    className,
}: FilterToolbarProps) {
    const t = useTranslations('filtersChrome');
    const ctx = useFilters();
    const { remove, removeAll, clearAll, search, setSearch, state } = ctx;

    // Live content search lives INSIDE the filter dropdown — typing in the
    // Filter popover's top input filters the table on a ~250ms debounce
    // (no Enter, no separate search bar). Only wired when the page opts in
    // via `searchPlaceholder`.
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const handleSearchChange = useCallback(
        (value: string) => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => setSearch(value), 250);
        },
        [setSearch],
    );
    useEffect(
        () => () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        },
        [],
    );

    const searchEnabled = Boolean(searchPlaceholder);

    const activeFilters: ActiveFilter[] = useMemo(
        () => filterStateToActiveFilters(state),
        [state],
    );

    return (
        <div className={`flex flex-wrap items-start gap-compact${className ? ` ${className}` : ''}`}>
            <div className="flex flex-wrap items-center gap-tight">
                <FilterUI.Select
                    filters={filters}
                    activeFilters={activeFilters}
                    onSelect={(key, value) => dispatchOnSelect(filters, ctx, String(key), value as string | string[])}
                    onRemove={(key, value) => remove(String(key), String(value))}
                    onRemoveFilter={(key) => removeAll(String(key))}
                    searchId={searchEnabled ? searchId : undefined}
                    searchPlaceholder={searchEnabled ? searchPlaceholder : undefined}
                    searchValue={searchEnabled ? search : undefined}
                    onSearchChange={searchEnabled ? handleSearchChange : undefined}
                    className="h-9"
                >
                    {triggerLabel ?? t('filter')}
                </FilterUI.Select>
            </div>
            <div className="flex-1 min-w-0">
                <FilterUI.List
                    filters={filters}
                    activeFilters={activeFilters}
                    // Without onSelect, the active-pill value dropdown
                    // could only REMOVE values — picking a different
                    // value did nothing (single-select filters like
                    // applicability could never be switched from the
                    // pill). Wire the same dispatcher the Select uses so
                    // the pill can change/add values too.
                    onSelect={(key, value) =>
                        dispatchOnSelect(filters, ctx, String(key), value as string | string[])
                    }
                    onRemove={(key, value) => remove(String(key), String(value))}
                    onRemoveFilter={(key) => removeAll(String(key))}
                    onRemoveAll={clearAll}
                />
            </div>
            {actions ? (
                <div
                    className="flex items-center gap-tight"
                    data-testid="filter-toolbar-secondary"
                >
                    {actions}
                </div>
            ) : null}
            {primary ? (
                <div
                    className="flex items-center gap-tight"
                    data-testid="filter-toolbar-primary"
                >
                    {primary}
                </div>
            ) : null}
        </div>
    );
}

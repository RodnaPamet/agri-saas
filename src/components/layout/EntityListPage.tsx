"use client";

/**
 * `EntityListPage` — composition shell for entity list pages.
 *
 * Wraps the standard `<ListPageShell>` (Epic 52) +
 * `<FilterToolbar>` (Epic 53) + `<DataTable>` (Epic 52) arrangement
 * every list page uses, so consumers stop hand-writing the same
 * 30-line `<ListPageShell.Header>...<ListPageShell.Body>` block.
 *
 * Inspiration: CISO-Assistant's `ModelTable.svelte` shows the value
 * of one shell across every entity list. Inflect already has the
 * underlying primitives (DataTable + ListPageShell + FilterToolbar);
 * what was missing was the higher-level composition that bundles
 * them. This file is that bundle.
 *
 * What stays in the page:
 *
 *   - Column definitions (typed via `createColumns<TRow>()` so the
 *     row shape isn't erased)
 *   - Filter definitions (`buildXFilters` from each page's
 *     `filter-defs.ts`)
 *   - Data fetching, mutations, optimistic updates
 *   - Detail / create modals + sheets (rendered as children — they
 *     live next to the page state that drives them)
 *   - Permission gates on header actions
 *   - URL sync (handled by `<FilterProvider>` from the page)
 *
 * What the shell carries:
 *
 *   - The 3-slot ListPageShell layout (header + filters + body)
 *   - Header chrome: title + count line + right-aligned actions
 *   - FilterToolbar wiring (defs + searchId + searchPlaceholder
 *     + the right-side actions slot for the ColumnsDropdown)
 *   - DataTable wiring (every prop the consumer cares about
 *     surfaces; nothing forced)
 *   - Children passthrough so modals/sheets sit at the page-state
 *     level, not nested in the shell's tree
 *
 * What this is NOT:
 *
 *   - A JSON-driven generic table. Columns are typed React nodes
 *     the page builds with full TanStack power.
 *   - A data fetcher. Pages run their queries — see
 *     `ControlsClient` for the canonical React Query shape.
 *   - A wrapper that hides DataTable's prop surface. Most table
 *     props pass through directly so a feature added to DataTable
 *     (sorting, batch actions, column visibility) is reachable
 *     without a shell change.
 */

import { type ReactNode } from 'react';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { DataTable, type DataTableProps } from '@/components/ui/table';
import type { FilterType } from '@/components/ui/filter';
import { type BreadcrumbItem } from '@/components/ui/breadcrumbs';

// ─── Header ────────────────────────────────────────────────────────

export interface EntityListPageHeader {
    /**
     * Optional breadcrumb trail rendered ABOVE the title. Pass an array
     * of `{ label, href? }` items; the last item is automatically
     * marked as the current page. See `<Breadcrumbs>` for the full
     * shape (truncation, separators, custom current).
     */
    breadcrumbs?: ReadonlyArray<BreadcrumbItem>;
    /**
     * Optional uppercase eyebrow rendered above the title (v2-PR-12).
     * Conventionally the resource name in screaming-quiet caps —
     * e.g. "Controls" above a "Compliance register" title. The trio
     * (eyebrow + title + description) gives every list page the same
     * 3-line composition signature.
     */
    eyebrow?: ReactNode;
    /** Title rendered in the page header (string or ReactNode). */
    title: ReactNode;
    /**
     * Optional count / subtitle line beneath the title. Threaded
     * through to the PageHeader's `description` slot — the v2 polish
     * convention is one sentence ≤ 80 chars, ending with an action
     * prompt or a count summary.
     */
    count?: ReactNode;
    /**
     * Optional descriptive sentence below the title (v2-PR-12).
     * Distinct from `count` — `description` carries narrative
     * context ("Track and treat enterprise risk in one register"),
     * `count` is the rolling tally. When both are passed,
     * `description` wins; when neither is, the line is omitted.
     */
    description?: ReactNode;
    /** Right-side action area (create button, dashboard nav, etc.). */
    actions?: ReactNode;
}

// ─── Filters ──────────────────────────────────────────────────────

export interface EntityListPageFilters {
    /** Filter definitions (typically resolved via `useFilters` + buildXFilters). */
    defs: FilterType[];
    /**
     * Stable id for the search input. Required ONLY when
     * `searchPlaceholder` is also provided.
     */
    searchId?: string;
    /**
     * Search placeholder copy. **Omit to hide the search input.**
     * The global ⌘K palette is the canonical cross-page search;
     * per-page text-search is legacy. Locked by
     * `tests/guards/r14-no-page-searchbars.test.ts`.
     */
    searchPlaceholder?: string;
    /** Optional override for the FilterSelect trigger label. */
    triggerLabel?: ReactNode;
    /**
     * Secondary cluster inside the toolbar — typically a
     * `<ColumnsDropdown>`, bulk-edit / export icons. Same shape as
     * `<FilterToolbar actions>`.
     */
    toolbarActions?: ReactNode;
    /**
     * Primary action inside the toolbar (right edge — v2-PR-7).
     * Reserved for the SINGLE primary action of the page (the
     * "Create X" button). Pages should prefer this over
     * `header.actions` so headers stay navigational and the toolbar
     * is the only place that mutates the list.
     */
    toolbarPrimary?: ReactNode;
}

// ─── Public props ────────────────────────────────────────────────

/**
 * Table props mirror `<DataTable>`'s public surface (see
 * `data-table.tsx`). `data + columns` are required; everything
 * else is optional and threads through. Adding a new DataTable
 * prop doesn't require a shell change — it surfaces here via the
 * `Pick` type below.
 */
export type EntityListPageTable<TRow> = Pick<
    DataTableProps<TRow>,
    | 'data'
    | 'columns'
    | 'loading'
    | 'error'
    | 'emptyState'
    | 'resourceName'
    | 'sortableColumns'
    | 'sortBy'
    | 'sortOrder'
    | 'onSortChange'
    | 'onRowClick'
    | 'onRowPrefetch'
    | 'getRowId'
    // Selection defaults ON in DataTable, and when it is on the row's SINGLE
    // click toggles selection while the row ACTION moves to double-click. A
    // list with no batch actions therefore charges the user a click and gives
    // nothing back — and the row still renders `cursor-pointer`, so it looks
    // like a single click should open it. Pages without batch actions can now
    // turn it off (the precedent is EvidenceSubTable, which does exactly this
    // and calls it load-bearing).
    | 'selectionEnabled'
    | 'onRowSelectionChange'
    | 'selectedRows'
    | 'selectionControls'
    | 'batchActions'
    | 'columnVisibility'
    | 'onColumnVisibilityChange'
    | 'pagination'
    | 'onPaginationChange'
    | 'rowCount'
    | 'className'
    | 'scrollWrapperClassName'
    | 'mobileFallback'
    | 'virtualize'
    | 'virtualRowHeight'
    | 'virtualHeight'
> & {
    /** Test id forwarded to the DataTable. */
    'data-testid'?: string;
    /**
     * Default true. Override to opt out of viewport-fitting (rare —
     * the shell is built for the standard list-page layout).
     */
    fillBody?: boolean;
};

export interface EntityListPageProps<TRow> {
    header: EntityListPageHeader;
    /** Omit when the page doesn't have any filter UI. */
    filters?: EntityListPageFilters;
    table: EntityListPageTable<TRow>;
    /**
     * PR-5 — optional render slot above the table, below the filters.
     * Used by the SWR-backed pages to surface
     * `<TruncationBanner truncated={...} />` when the backfill cap
     * fired. Renders nothing when omitted.
     */
    banner?: ReactNode;
    /**
     * R23-PR-D — optional KPI strip rendered ABOVE the filter
     * toolbar (inside the same `<Filters>` slot, so spacing and
     * scroll behaviour stay consistent with the Risks-page reference
     * layout). Pass a row of `<KpiFilterCard>`s wrapped in the
     * standard `grid grid-cols-2 md:grid-cols-4 gap-default`. Omit
     * for pages that don't need a KPI strip.
     */
    kpis?: ReactNode;
    /**
     * Children render below the body inside the same `<ListPageShell>`
     * — typically modals / sheets that sit at the page-state level.
     * They're a render-time concern of the page, not the shell, so
     * they pass through verbatim.
     */
    children?: ReactNode;
    /**
     * Right-rail roadmap Phase 2 — optional aside slot. Threaded to
     * `<ListPageShell.Body aside>`: docks as a third column at `xl`+,
     * stacks below the table under `xl`. The canonical use is the
     * multi-select selection summary — pass an `<AsidePanel>` wrapping
     * a `<SelectionSummaryPanel>`, conditionally (only when rows are
     * selected). Omit it and the page is single-column as before.
     */
    aside?: ReactNode;
    /**
     * B7 — optional left orientation rail. Pass a
     * `<LeftAccordionRail>` (or anything that fits a docked
     * left-column shape). The shell renders it OUTSIDE the table
     * card's natural border with a `gap-section` separation —
     * the rail reads as a sibling, not embedded chrome. Below
     * `xl` it stacks above the table.
     */
    leftRail?: ReactNode;
    /**
     * PR-1 — rendered inside `<ListPageShell.Body>` AFTER the
     * `<DataTable>`. Canonical use: the shared
     * `<TableLoadMoreFooter>` driven by `useThresholdLoadMore`, so
     * tenant list pages can match the org-level "Load more …"
     * pattern without dropping into bespoke layout. Pure passthrough
     * — the shell doesn't reach inside.
     */
    tableFooter?: ReactNode;
    /** Forwarded to the outer ListPageShell. */
    className?: string;
}

// ─── Component ──────────────────────────────────────────────────

export function EntityListPage<TRow>(props: EntityListPageProps<TRow>) {
    const {
        header,
        filters,
        table,
        banner,
        kpis,
        aside,
        leftRail,
        tableFooter,
        children,
        className,
    } = props;

    return (
        <ListPageShell
            className={className}
            data-entity-list-page
        >
            <ListPageShell.Header>
                <PageHeader
                    breadcrumbs={header.breadcrumbs}
                    eyebrow={header.eyebrow}
                    title={header.title}
                    // v2-PR-12 — `description` wins over `count` so
                    // pages migrating to the new trio (eyebrow +
                    // title + description) drop into the slot
                    // cleanly. Pages that still pass only `count`
                    // keep their current rendering until they
                    // migrate.
                    description={header.description ?? header.count}
                    actions={header.actions}
                    data-testid="entity-list-header"
                />
            </ListPageShell.Header>

            {(filters || kpis) && (
                <ListPageShell.Filters className="space-y-section">
                    {kpis}
                    {filters && (
                        <FilterToolbar
                            filters={filters.defs}
                            searchId={filters.searchId}
                            searchPlaceholder={filters.searchPlaceholder}
                            triggerLabel={filters.triggerLabel}
                            actions={filters.toolbarActions}
                            primary={filters.toolbarPrimary}
                        />
                    )}
                </ListPageShell.Filters>
            )}

            <ListPageShell.Body aside={aside} leftRail={leftRail}>
                {banner}
                <DataTable<TRow>
                    fillBody={table.fillBody ?? true}
                    {...table}
                />
                {/* PR-1 — Load-more footer slot. Pass a
                    `<TableLoadMoreFooter>` driven by either
                    `useThresholdLoadMore` (tenant in-memory) or
                    `useCursorPagination` (org server cursor) and the
                    footer matches the org table experience. */}
                {tableFooter}
            </ListPageShell.Body>

            {children}
        </ListPageShell>
    );
}

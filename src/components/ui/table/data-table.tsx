"use client";

/**
 * DataTable — the canonical reusable table component for all entity list pages.
 *
 * Built on top of the TanStack React Table `useTable` + `Table` foundation,
 * this wrapper provides a simpler, ergonomic API for the most common pattern:
 *
 *   <DataTable
 *     data={practices}
 *     columns={practiceColumns}
 *     loading={isLoading}
 *     onRowClick={(row) => router.push(`/practices/${row.original.id}`)}
 *   />
 *
 * For advanced features (column resizing, pinning, edit-columns), use the
 * lower-level `useTable` + `Table` directly.
 */
import {
  ColumnDef,
  PaginationState,
  Row,
  RowSelectionState,
  Table as TableType,
  VisibilityState,
} from "@tanstack/react-table";
import { Dispatch, MouseEvent, ReactNode, SetStateAction, useRef, useState } from "react";
import { type BatchAction, renderBatchActions } from "./selection-toolbar";
import { Table, useTable } from "./table";
import { cn } from "./table-utils";
import type { UseTableProps } from "./types";
import { VirtualTable } from "./virtual-table-body";
import { MobileCardList } from "./mobile-card-list";
import { useMediaQuery } from "../hooks";

// ── Public Column Helper ────────────────────────────────────────────

/**
 * Typed column definition for DataTable.
 * Re-exports TanStack ColumnDef for convenience so consumers don't need
 * to import from @tanstack/react-table directly.
 */
export type { ColumnDef };

/**
 * Helper to create a typed column array with proper inference.
 *
 * Usage:
 *   const columns = createColumns<Practice>([
 *     { accessorKey: "code", header: "Code" },
 *     { accessorKey: "name", header: "Name" },
 *     { id: "actions", header: "", cell: ({ row }) => <ActionsMenu row={row} /> },
 *   ]);
 */
export function createColumns<T>(
  columns: ColumnDef<T, any>[], // eslint-disable-line @typescript-eslint/no-explicit-any
): ColumnDef<T, any>[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  return columns;
}

// ── DataTable Props ─────────────────────────────────────────────────

export interface DataTableProps<T> {
  /** The data array to render. */
  data: T[];

  /** TanStack column definitions. Use `createColumns<T>()` for type safety. */
  columns: ColumnDef<T, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any

  /** Show a loading overlay. */
  loading?: boolean;

  /** Error message to display instead of the table. */
  error?: string;

  /** Custom empty state content. */
  emptyState?: ReactNode;

  /** Human-readable resource name for empty/pagination text. */
  resourceName?: (plural: boolean) => string;

  // ── Sorting ──

  /** Column IDs that support sorting. */
  sortableColumns?: string[];

  /** Currently sorted column ID. */
  sortBy?: string;

  /** Current sort direction. */
  sortOrder?: "asc" | "desc";

  /** Callback when sort changes. */
  onSortChange?: (props: { sortBy?: string; sortOrder?: "asc" | "desc" }) => void;

  // ── Row interaction ──

  /** Callback when a row is clicked. */
  onRowClick?: (row: Row<T>, e: MouseEvent) => void;

  /**
   * Fired once per row on the first pointer-enter (hover). Use it to warm the
   * row's detail route + SWR cache (`router.prefetch` + `usePrefetchTenant`)
   * so the click renders instantly from cache. The callback lives in the
   * consumer (which holds the router), so the table primitive stays free of a
   * `useRouter` dependency. Complements `onRowClick`.
   */
  onRowPrefetch?: (row: Row<T>) => void;

  /** Unique row ID extractor (required for selection). */
  getRowId?: (row: T) => string;

  // ── Selection ──

  /** Callback when selected rows change. Enables selection checkboxes. */
  onRowSelectionChange?: (rows: Row<T>[]) => void;

  /** Externally controlled selection state. */
  selectedRows?: RowSelectionState;

  /** Custom toolbar rendered when rows are selected. */
  selectionControls?: (table: TableType<T>) => ReactNode;

  /**
   * R12-PR1 — opt out of the default-on select column. Pass `false`
   * for read-only tables that don't surface selection (sub-component
   * sub-tables that the parent doesn't bulk-select, dashboard
   * digests, etc.). Default is `true`.
   */
  selectionEnabled?: boolean;

  /**
   * Declarative batch actions — a simpler alternative to `selectionControls`.
   * When provided, automatically enables selection and renders a batch action bar.
   *
   * Usage:
   *   <DataTable
   *     batchActions={[
   *       { label: "Export", icon: <Download />, onClick: (rows) => exportRows(rows) },
   *       { label: "Delete", variant: "danger", onClick: (rows) => deleteRows(rows) },
   *     ]}
   *   />
   */
  batchActions?: BatchAction<T>[];

  // ── Column visibility ──

  /** Column visibility state. */
  columnVisibility?: VisibilityState;

  /** Callback when column visibility changes. */
  onColumnVisibilityChange?: (visibility: VisibilityState) => void;

  // ── Pagination ──

  /** Pagination state. Enables paginated mode. */
  pagination?: PaginationState;

  /** Pagination change handler. */
  onPaginationChange?: Dispatch<SetStateAction<PaginationState>>;

  /** Total row count (required for pagination). */
  rowCount?: number;

  // ── Column resizing (B2) ──

  /**
   * User-controlled column resizing. **On by default** for the
   * non-virtualized table: every column carries a drag handle on its
   * right edge and the user can adjust widths with the mouse.
   *
   * Widths are NOT uniform — on mount the table renders one
   * auto-layout frame, measures each column's content width, seeds
   * those widths, then switches to `table-layout: fixed` (see the
   * measure-then-fix block in `table.tsx`). The result is visually
   * identical to the old auto-sized table plus drag handles.
   *
   * Resizing is force-disabled for virtualized tables (the grid
   * renderer reads `getSize()` directly with no measure step, so it
   * would collapse to a uniform width).
   *
   * Default OFF as of 2026-06-04 (shelved — the fixed layout it
   * requires caused a horizontal scrollbar on some tables). Pass
   * `enableColumnResizing` to opt a specific table back in.
   */
  enableColumnResizing?: boolean;

  // ── Styling ──

  /** Additional class for the outer container. */
  className?: string;

  /** Additional class for the scroll wrapper. */
  scrollWrapperClassName?: string;

  /**
   * Make the table fill its parent's flex space and provide its own
   * internal vertical scroll instead of growing arbitrarily.
   *
   * Use inside `<ListPageShell.Body>` (or any flex column with
   * `min-h-0` set) to keep the page header / filter toolbar /
   * pagination footer anchored while only the table body scrolls.
   *
   * On mobile (<md) this is a no-op — the table grows naturally and
   * the document scrolls.
   *
   * Default: `false` (legacy behaviour).
   */
  fillBody?: boolean;

  /**
   * Phone (<sm) rendering strategy. A horizontally-scrolling table is
   * unusable on a 390px phone.
   *
   *   - `'scroll'` (default) — keep the table; it scrolls horizontally.
   *     Correct for dense / financial tables where the columns ARE the
   *     point (cost rollups, ledgers).
   *   - `'card'` — below `sm`, render each row as a full-width tappable
   *     CARD instead (title + optional subtitle + status pill + a few
   *     key/value rows), tapping through to detail via `onRowClick`. The
   *     card fields are driven by `column.meta.mobileCard` — see
   *     `mobile-card-list.tsx`. At `sm`+ the normal table renders.
   */
  mobileFallback?: "card" | "scroll";

  /** Test ID for automated testing. */
  "data-testid"?: string;

  // ── Virtualization (Epic 68) ──

  /**
   * Enable react-window-backed row virtualization for large data.
   *
   * Behaviour:
   *   - `undefined` (default) — auto: virtualize when `data.length`
   *     exceeds the default threshold (`VIRTUALIZE_DEFAULT_THRESHOLD`,
   *     currently 100). Pages opt in by doing nothing.
   *   - `true`               — force virtualization on regardless of
   *                            row count.
   *   - `false`              — force virtualization OFF. Use this on
   *                            pages where the existing
   *                            non-virtualized layout is intentionally
   *                            preserved (e.g. the Practices page,
   *                            where bespoke row affordances rely on
   *                            the standard `<table>` layout).
   *   - `{ threshold: N }`   — auto with a custom threshold.
   *
   * When virtualization is on, the table renders via `<VirtualTable>`
   * which uses `display: grid` for headers + rows (column alignment
   * is enforced by a single `gridTemplateColumns` value). Column
   * resizing, column pinning, and the standard pagination footer are
   * not supported in virtualized mode — DataTable falls back to the
   * non-virtualized `<Table>` automatically when those features are
   * requested.
   */
  virtualize?: boolean | { threshold: number };

  /**
   * Pixel height of each row when virtualization is on. Default 44
   * matches the standard table's row geometry. Override only when
   * row content is intentionally taller (multi-line cells).
   */
  virtualRowHeight?: number;

  /**
   * Explicit body height (px) when virtualization is on. When
   * omitted, the body fills its parent and react-window v2's `List`
   * self-measures via a ResizeObserver — which is the production
   * default (use inside `<ListPageShell.Body>` or any sized flex
   * parent). Set this only when the List can't reach a sized ancestor
   * (e.g. test harnesses, or ad-hoc layouts); it is forwarded as
   * react-window's `defaultHeight`.
   */
  virtualHeight?: number;
}

/**
 * Default row count above which DataTable auto-virtualizes. Exported
 * so structural ratchets and rollout tests can assert against the
 * same value the runtime uses.
 *
 * History — Epic 68 originally shipped with threshold 100 but the
 * auto-virtualize kicked in too aggressively for medium-sized tables
 * (100-1000 rows). Two concrete fallouts:
 *   - E2E tests that accumulate rows from prior tests crossed 100
 *     and then failed Playwright clicks because the virtualized div
 *     wrapper intercepted pointer events on row interactions.
 *   - The virtualized branch's keyboard / focus contract for table
 *     bodies (vs. the standard <table>) needs more bake time before
 *     it's right for medium-traffic tables.
 *
 * Threshold raised to 1000 to scope auto-virtualization to genuinely
 * large unpaginated tables. Pages that legitimately need it for
 * smaller datasets can opt in with `virtualize={true}` or
 * `virtualize={{ threshold: N }}`. The Practices opt-out
 * (`virtualize={false}`) stays as documented.
 */
export const VIRTUALIZE_DEFAULT_THRESHOLD = 1000;

// ── DataTable Component ─────────────────────────────────────────────

export function DataTable<T>({
  data,
  columns,
  loading,
  error,
  emptyState,
  resourceName,
  sortableColumns,
  sortBy,
  sortOrder,
  onSortChange,
  onRowClick,
  onRowPrefetch,
  getRowId,
  onRowSelectionChange,
  selectedRows,
  selectionControls,
  selectionEnabled,
  batchActions,
  columnVisibility,
  onColumnVisibilityChange,
  pagination,
  onPaginationChange,
  rowCount,
  className,
  scrollWrapperClassName,
  fillBody,
  mobileFallback,
  "data-testid": dataTestId,
  virtualize,
  virtualRowHeight,
  virtualHeight,
  // Default OFF (2026-06-04). Column resizing switched the table to a
  // fixed layout seeded from measured widths, which on some tables
  // summed wider than the card and left a horizontal scrollbar. The
  // feature is shelved (default-off) until that's reworked; pass
  // `enableColumnResizing` to opt a specific table back in. With it
  // off the table is plain auto-layout (width 100%, cells truncate) —
  // no fixed layout, no measure-freeze, no horizontal scroll.
  enableColumnResizing = false,
}: DataTableProps<T>) {
  // Compose the viewport-fill classes onto the existing className /
  // scrollWrapperClassName slots. Tailwind's `md:` prefixes mean
  // mobile keeps natural document scroll; desktop gets the flex
  // chain that lets the table body scroll within its parent.
  const filledContainerClassName = fillBody
    ? cn(
        // Container is a flex column that sizes to its content
        // (= the scroll wrapper inside) but is capped by the parent
        // (ListPageShell.Body). `max-h-full` is the cap;
        // `min-h-0` allows shrinking. NO `flex-1` — that would
        // force the card to fill the parent even when the scroll
        // wrapper inside is short (Evidence with 1 row, empty
        // state, etc.). Result: card grows with content up to
        // viewport, then stops; smaller content = smaller card.
        "md:flex md:flex-col md:max-h-full md:min-h-0 md:overflow-hidden",
        className,
      )
    : className;
  const filledScrollWrapperClassName = fillBody
    ? cn(
        // Wrapper sizes to content, capped at parent (the card).
        // The JS whole-row clip in table.tsx adds an inline
        // max-height when content exceeds the viewport allocation,
        // overriding this max-h-full to a row-aligned value.
        "md:max-h-full md:min-h-0 md:overflow-y-auto",
        scrollWrapperClassName,
      )
    : scrollWrapperClassName;
  // Auto-manage selection state when batchActions are provided
  // without explicit selection handlers. The setter is unwired —
  // batch-mode without explicit selection is currently a
  // visual-affordance-only path; selection mutation flows through
  // the explicit `onRowSelectionChange` prop when wired.
  const [internalSelection] = useState<RowSelectionState>({});
  // Drives the `mobileFallback="card"` swap. Read unconditionally (rules of
  // hooks); only consulted in the card branch below. `isMobile` is <sm,
  // matching the card breakpoint. SSR/first render = false (desktop) so the
  // table is the SSR markup; the swap to cards happens post-hydration.
  const { isMobile } = useMediaQuery();
  const hasExplicitSelection = !!onRowSelectionChange || !!selectionControls;
  const hasBatchActions = batchActions && batchActions.length > 0;

  // Determine effective selection props
  const effectiveOnRowSelectionChange = onRowSelectionChange ?? (hasBatchActions ? (() => {}) : undefined);
  const effectiveSelectedRows = selectedRows ?? (hasBatchActions && !hasExplicitSelection ? internalSelection : undefined);
  const effectiveSelectionPractices = selectionControls ?? (hasBatchActions ? renderBatchActions(batchActions!) : undefined);
  // Column resizing lives on the non-virtualized <Table> only — its
  // measure-then-fix step seeds each column's content width before
  // switching to fixed layout. VirtualTable reads getSize() straight
  // into its grid template with no measure step, so handing it the
  // resizing defaults would collapse every column to the uniform
  // default width. Compute the virtualization decision up-front (the
  // resolver is a pure, hoisted function) and gate resizing on it.
  const willVirtualizeEarly =
    decideVirtualization(virtualize, data.length) &&
    data.length > 0 &&
    !error &&
    !loading &&
    !(!!pagination && !!onPaginationChange && rowCount !== undefined);
  const resizingEnabled = enableColumnResizing && !willVirtualizeEarly;

  // Build the useTable props, handling the pagination discriminated union
  const tableProps = pagination && onPaginationChange && rowCount !== undefined
    ? {
        data,
        columns,
        loading,
        error,
        emptyState,
        resourceName,
        sortableColumns,
        sortBy,
        sortOrder,
        onSortChange,
        onRowClick,
        getRowId,
        onRowSelectionChange: effectiveOnRowSelectionChange,
        selectedRows: effectiveSelectedRows,
        selectionControls: effectiveSelectionPractices,
        selectionEnabled,
        columnVisibility,
        onColumnVisibilityChange,
        pagination,
        onPaginationChange,
        rowCount,
        enableColumnResizing: resizingEnabled,
        containerClassName: filledContainerClassName,
        scrollWrapperClassName: filledScrollWrapperClassName,
      }
    : {
        data,
        columns,
        loading,
        error,
        emptyState,
        resourceName,
        sortableColumns,
        sortBy,
        sortOrder,
        onSortChange,
        onRowClick,
        getRowId,
        onRowSelectionChange: effectiveOnRowSelectionChange,
        selectedRows: effectiveSelectedRows,
        selectionControls: effectiveSelectionPractices,
        selectionEnabled,
        columnVisibility,
        onColumnVisibilityChange,
        enableColumnResizing: resizingEnabled,
        containerClassName: filledContainerClassName,
        scrollWrapperClassName: filledScrollWrapperClassName,
      };

  // `tableProps` is one branch of a discriminated union (paginated vs. not);
  // TypeScript can't unify the branches through the spread, so we narrow to
  // the exact target type. `UseTableProps<T>` is the correct shape here —
  // this is NOT a loose cast.
  const { table, ...rest } = useTable(tableProps as unknown as UseTableProps<T>);

  // Hover-prefetch — fire the consumer's `onRowPrefetch` once per row on the
  // first pointer-enter so it can warm that row's detail route + SWR cache
  // before the click. Attaches via the standard <Table>'s per-row `rowProps`
  // hook; deduped by row id via a ref. Entity lists render under the
  // virtualization threshold, so they take the standard <Table> path below.
  const prefetchedRows = useRef<Set<string>>(new Set());
  const prefetchRowProps = onRowPrefetch
    ? (row: Row<T>) => ({
        onMouseEnter: () => {
          if (!prefetchedRows.current.has(row.id)) {
            prefetchedRows.current.add(row.id);
            onRowPrefetch(row);
          }
        },
      })
    : undefined;

  // The outermost wrapper exists for the dataTestId / id hooks the
  // E2E suite uses. When fillBody is on it participates in the
  // flex chain (max-h-full + flex flex-col + overflow-hidden) so
  // the inner card's max-h-full can resolve to a finite parent
  // height. NO flex-1 — see filledContainerClassName comment.
  const wrapperClassName = fillBody
    ? "md:flex md:flex-col md:max-h-full md:min-h-0 md:overflow-hidden"
    : undefined;

  // Epic 68 — auto-virtualize above the threshold unless the caller
  // overrides. Virtualization is force-disabled when features
  // unsupported by the virtualized renderer are requested:
  //   - server-side pagination (the footer + page buttons live on
  //     <Table> only; virtualization replaces pagination by rendering
  //     the full row set with a windowed viewport)
  //   - error / empty / loading rendering paths still need <Table>
  //     today — when no rows exist there's nothing to virtualize, so
  //     <Table>'s richer empty/error chrome is the correct surface.
  const useVirtual = willVirtualizeEarly;

  const tableEl = useVirtual ? (
    <VirtualTable<T>
      table={table}
      rowHeight={virtualRowHeight}
      height={virtualHeight}
      onRowClick={onRowClick}
      selectionEnabled={selectionEnabled}
      sortableColumns={sortableColumns}
      sortBy={sortBy}
      sortOrder={sortOrder}
      onSortChange={onSortChange}
      containerClassName={filledContainerClassName}
      scrollWrapperClassName={filledScrollWrapperClassName}
    />
  ) : (
    <Table {...rest} table={table} data={data} rowProps={prefetchRowProps} />
  );

  // Card fallback (<sm): render ONLY ONE of the card list / table — never
  // both behind CSS. A hidden card copy would still live in the DOM and
  // duplicate every row's text, making `getByText(rowText)` match twice
  // (strict-mode break) and `.first()` resolve to the hidden copy — which
  // broke existing desktop assertions. Branching on `isMobile` keeps a
  // single copy in the DOM; the table branch is identical to scroll mode so
  // its `fillBody` flex chain is untouched. SSR/first paint renders the
  // table (isMobile=false) and swaps to cards post-hydration on phones.
  if (mobileFallback === "card") {
    return (
      <div id={dataTestId} data-testid={dataTestId} className={wrapperClassName}>
        {isMobile ? (
          <MobileCardList<T>
            table={table}
            onRowClick={onRowClick}
            loading={loading}
            error={error}
            emptyState={emptyState}
          />
        ) : (
          tableEl
        )}
      </div>
    );
  }

  return (
    <div id={dataTestId} data-testid={dataTestId} className={wrapperClassName}>
      {tableEl}
    </div>
  );
}

/**
 * Resolve the `virtualize` prop into a boolean. Pure function, also
 * exported for direct test coverage of the threshold contract.
 */
export function decideVirtualization(
  virtualize: DataTableProps<unknown>["virtualize"],
  rowCount: number,
): boolean {
  if (virtualize === false) return false;
  if (virtualize === true) return true;
  const threshold =
    typeof virtualize === "object" && virtualize !== null
      ? virtualize.threshold
      : VIRTUALIZE_DEFAULT_THRESHOLD;
  return rowCount > threshold;
}

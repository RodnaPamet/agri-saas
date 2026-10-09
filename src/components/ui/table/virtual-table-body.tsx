"use client";

/**
 * Epic 68 — `<VirtualTable>` (filename: `virtual-table-body.tsx`).
 *
 * Replacement for the standard `<Table>` component when row counts
 * are large enough to benefit from windowed rendering. DataTable
 * routes here when `virtualize` is enabled (see DataTable's
 * threshold logic) and falls back to the standard `<Table>`
 * otherwise.
 *
 * Built on react-window v2's single `List` component (the v1
 * `FixedSizeList` / `VariableSizeList` split is gone). The sticky
 * header is injected via the `List`'s `children` slot (rendered inside
 * the same scroll container as the rows), replacing v1's
 * `outerElementType`. Per-render row data flows through `rowProps`,
 * replacing v1's `itemData`. The `List` self-measures its parent via a
 * ResizeObserver and fills the height defined by its style, so
 * `react-virtualized-auto-sizer` is no longer needed — an explicit
 * `height` prop (or `defaultHeight` for the auto-fill / SSR path) is
 * all that's required.
 *
 * Why a sibling component instead of in-place virtualization:
 *   - The standard `<Table>` uses real `<table>` / `<thead>` /
 *     `<tbody>` with sticky-header logic that's tightly coupled to
 *     the whole-row clip ResizeObserver. Bolting react-window into
 *     a `<tbody>` requires `display: block` on table elements + a
 *     full rewrite of the column-width inference. The risk of
 *     subtly breaking the existing 80+ tables is too high.
 *   - This component uses `display: grid` for headers + rows. Same
 *     visual contract (sticky header, hover, selection background,
 *     sort buttons, click handlers, selection-column checkboxes)
 *     reproduced via div semantics.
 *   - Column alignment is enforced via a single `gridTemplateColumns`
 *     value derived from `column.getSize()` — both the header and
 *     every body row use the same template so they cannot drift.
 *
 * Limitations vs `<Table>` (DataTable falls back to non-virtual when
 * any of these are needed):
 *   - column resizing
 *   - column pinning
 *   - server-side pagination footer (virtualization is the replacement)
 *
 * Preserved from `<Table>`:
 *   - sticky header at the top of the scroll container
 *   - sortable columns with sort indicator
 *   - selection (checkbox column flows through `getVisibleLeafColumns`)
 *   - hover + selected backgrounds
 *   - row click + middle-click handlers, with interactive-child guard
 *   - keyboard reachability (scroll container is `tabIndex=0` +
 *     `role=region` with an aria-label)
 */
import * as React from "react";
import {
    flexRender,
    type Row,
    type Table as TableType,
} from "@tanstack/react-table";
import { List, type RowComponentProps } from "react-window";
import { useTranslations } from "next-intl";

import { SortOrder } from "../icons";
import { Tooltip } from "../tooltip";
import {
    cn,
    isClickOnInteractiveChild,
    hasActivated,
    isGestureCompletingClick,
    markActivated,
    NO_ROW_ACTIVATION,
    resetActivation,
} from "./table-utils";

export const DEFAULT_VIRTUAL_ROW_HEIGHT = 44;

export interface VirtualTableProps<T> {
    /** TanStack table instance from `useTable`. */
    table: TableType<T>;
    /**
     * Explicit body height in pixels. When omitted the component
     * fills its parent and react-window v2's `List` self-measures via
     * a ResizeObserver — the parent MUST have a determinate height
     * (e.g. ListPageShell.Body's flex chain).
     */
    height?: number;
    /**
     * Pixel height of each row. Default 44 matches the standard
     * Table's `py-2.5` row geometry. Override when row content is
     * taller (e.g. multi-line cells).
     */
    rowHeight?: number;
    /**
     * Extra rows rendered above/below the visible window. Default 5
     * is generous enough that fast keyboard scroll keeps content
     * smooth; bump higher for very dense lists.
     */
    overscanCount?: number;
    /** Row click handler. Mirrors the standard `<Table>` semantics. */
    onRowClick?: (row: Row<T>, e: React.MouseEvent) => void;
    /** Middle-click / aux-click handler. */
    onRowAuxClick?: (row: Row<T>, e: React.MouseEvent) => void;
    /**
     * Whether the select column is mounted (R12-PR1 default-on). When
     * true, single click on the row body toggles selection; mirrors
     * the standard `<Table>` semantics added in R13-PR14.
     */
    selectionEnabled?: boolean;
    /** Sortable column ids (mirrors `<Table>`). */
    sortableColumns?: string[];
    /** Currently-sorted column id. */
    sortBy?: string;
    /** Currently-sorted direction. */
    sortOrder?: "asc" | "desc";
    /** Sort change callback. */
    onSortChange?: (props: {
        sortBy?: string;
        sortOrder?: "asc" | "desc";
    }) => void;
    /** Class on the outer container (mirrors `Table`'s `containerClassName`). */
    containerClassName?: string;
    /** Class on the inner scroll container. */
    scrollWrapperClassName?: string;
    /** Accessible label on the scroll container. */
    "aria-label"?: string;
    /** Test id forwarded to the outer wrapper. */
    "data-testid"?: string;
}

const SELECT_COLUMN_WIDTH = 48;
const MENU_COLUMN_WIDTH = 40;

const headerCellClassName = (columnId: string, hasSelectBefore: boolean) =>
    cn(
        "border-l border-b border-border-subtle text-left text-xs font-semibold",
        "uppercase tracking-wider whitespace-nowrap text-content-muted",
        "bg-bg-muted select-none",
        columnId === "select" && "px-0",
        columnId === "menu" && "px-1",
        !["select", "menu"].includes(columnId) &&
            (hasSelectBefore ? "pl-1 pr-4 py-2.5" : "px-4 py-2.5"),
    );

const bodyCellClassName = (
    columnId: string,
    clickable: boolean,
    hasSelectBefore: boolean,
    isFirstContent: boolean,
) =>
    cn(
        "border-l border-b border-border-subtle text-sm leading-6 whitespace-nowrap text-content-default",
        columnId === "select" && "px-0 py-0",
        columnId === "menu" && "px-1 bg-bg-page border-l-transparent py-0",
        !["select", "menu"].includes(columnId) &&
            (hasSelectBefore ? "pl-1 pr-4 py-2.5" : "px-4 py-2.5"),
        clickable && "group-hover/row:bg-bg-subtle transition-colors duration-75",
        // R13-PR15 — brand-coloured 2-px left-edge accent on hover,
        // gated on `isFirstContent` (computed at render time as the
        // first non-utility column id) instead of `:first-of-type`.
        // Mirrors the table.tsx recipe — `:first-of-type` silently
        // broke once R12-PR1 made the select column default-on and
        // it became the first `<td>`/`<div role="cell">`.
        isFirstContent &&
            clickable &&
            "group-hover/row:shadow-[inset_2px_0_0_var(--brand-default)]",
        "group-data-[selected=true]/row:bg-[var(--brand-subtle)]",
    );

function buildGridTemplate<T>(table: TableType<T>): string {
    return table
        .getVisibleLeafColumns()
        .map((col) => {
            // Utility columns get their fixed pixel widths; matches the
            // standard Table's `getUtilityColumnWidth` behaviour so the
            // checkbox/menu columns line up with the rest of the cell
            // content above and below.
            if (col.id === "select") return `${SELECT_COLUMN_WIDTH}px`;
            if (col.id === "menu") return `${MENU_COLUMN_WIDTH}px`;
            const explicit = col.columnDef.size;
            if (typeof explicit === "number" && explicit > 0) {
                return `${explicit}px`;
            }
            return "minmax(0, 1fr)";
        })
        .join(" ");
}

/**
 * Per-render row data. In react-window v2 this object is passed to the
 * `List`'s `rowProps` prop and spread onto each row component alongside
 * `index` + `style` (replacing v1's `itemData` + `data` prop).
 */
interface RowItemData<T> {
    rows: ReadonlyArray<Row<T>>;
    gridTemplate: string;
    onRowClick?: (row: Row<T>, e: React.MouseEvent) => void;
    onRowAuxClick?: (row: Row<T>, e: React.MouseEvent) => void;
    selectionEnabled: boolean;
    columnsAfterSelect: ReadonlySet<string>;
    /** Column id that carries the brand-edge accent (first non-utility column). */
    firstContentColumnId: string | undefined;
}

function VirtualRow<T>({
    index,
    style,
    rows,
    gridTemplate,
    onRowClick,
    onRowAuxClick,
    selectionEnabled,
    columnsAfterSelect,
    firstContentColumnId,
}: RowComponentProps<RowItemData<T>>) {
    // BEFORE the early return — hook order must not depend on `row`, or an
    // instance that flips between present and absent changes its hook count.
    const activatedAt = React.useRef(NO_ROW_ACTIVATION);
    const row = rows[index];
    if (!row) return null;

    return (
        <div
            role="row"
            data-selected={row.getIsSelected()}
            data-virtual-row-index={index}
            className={cn(
                "group/row grid",
                // R13-PR13 — the 2-px brand-coloured left edge moved
                // to the first non-utility cell in `bodyCellClassName`
                // so all three row paths (resizable, non-resizable,
                // virtualized) carry the accent identically and paint
                // on the cell's own paint context. Row keeps cursor +
                // colour transition only.
                //
                // R13-PR14 — selection-enabled rows also get cursor-
                // pointer because click toggles selection (onClick
                // below). Mirrors the standard `<Table>` behaviour.
                (onRowClick || selectionEnabled) &&
                    "cursor-pointer select-none transition-colors duration-150 ease-out",
                "data-[selected=true]:bg-[var(--brand-subtle)]",
            )}
            style={{
                ...style,
                display: "grid",
                gridTemplateColumns: gridTemplate,
            }}
            // R13-PR14 — single click toggles selection. See
            // `ResizableTableRow` in `table.tsx` for the full
            // single-vs-double-click semantics rationale.
            onClick={
                selectionEnabled
                    ? (e) => {
                          if (isClickOnInteractiveChild(e)) return;
                          // The second click of a gesture IS the row
                          // action, read from the click's own count rather
                          // than from a `dblclick` a re-render can lose
                          // (#1076). Toggle back first so selection ends
                          // where it started. Mirrors ResizableTableRow.
                          if (onRowClick && isGestureCompletingClick(e)) {
                              row.toggleSelected();
                              if (!hasActivated(activatedAt, row.id)) {
                                  markActivated(activatedAt, row.id);
                                  onRowClick(row, e);
                              }
                              return;
                          }
                          if (e.detail <= 1) {
                              resetActivation(activatedAt, row.id);
                          }
                          row.toggleSelected();
                      }
                    : // Selection off → single click runs the row action
                      // (mirrors ResizableTableRow in table.tsx).
                      onRowClick
                      ? (e) => {
                            if (isClickOnInteractiveChild(e)) return;
                            onRowClick(row, e);
                        }
                      : undefined
            }
            onDoubleClick={
                // A second, deduped route to the same action — see
                // `activateRowOnce`. Kept because a bare
                // `fireEvent.doubleClick` dispatches no clicks at all.
                selectionEnabled && onRowClick
                    ? (e) => {
                          if (isClickOnInteractiveChild(e)) return;
                          if (!hasActivated(activatedAt, row.id)) {
                              onRowClick(row, e);
                          }
                          resetActivation(activatedAt, row.id);
                      }
                    : undefined
            }
            onAuxClick={
                onRowAuxClick
                    ? (e) => {
                          if (isClickOnInteractiveChild(e)) return;
                          onRowAuxClick(row, e);
                      }
                    : undefined
            }
        >
            {row.getVisibleCells().map((cell) => {
                const isUtility = ["select", "menu"].includes(cell.column.id);
                const isSelect = cell.column.id === "select";
                const hasSelectBefore = columnsAfterSelect.has(cell.column.id);
                const isFirstContent = cell.column.id === firstContentColumnId;
                return (
                    <div
                        key={cell.id}
                        role="cell"
                        className={bodyCellClassName(
                            cell.column.id,
                            !!onRowClick,
                            hasSelectBefore,
                            isFirstContent,
                        )}
                    >
                        {isSelect ? (
                            <div className="flex size-full items-center justify-center">
                                {flexRender(
                                    cell.column.columnDef.cell,
                                    cell.getContext(),
                                )}
                            </div>
                        ) : (
                            <div
                                className={cn(
                                    "flex items-center",
                                    isUtility ? "justify-center" : "w-full",
                                    !isUtility && "min-w-0 truncate",
                                )}
                            >
                                {flexRender(
                                    cell.column.columnDef.cell,
                                    cell.getContext(),
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

export function VirtualTable<T>({
    table,
    height,
    rowHeight = DEFAULT_VIRTUAL_ROW_HEIGHT,
    overscanCount = 5,
    onRowClick,
    onRowAuxClick,
    selectionEnabled = true,
    sortableColumns = [],
    sortBy,
    sortOrder,
    onSortChange,
    containerClassName,
    scrollWrapperClassName,
    "aria-label": ariaLabelProp,
    "data-testid": testId,
}: VirtualTableProps<T>) {
    const t = useTranslations("ui.table");
    const ariaLabel = ariaLabelProp ?? t("scrollableRegion");
    const rows = table.getRowModel().rows;
    const visibleColumns = table.getVisibleLeafColumns();

    // Set of columns that follow the select column — used to drop the
    // double-padding between the checkbox cell and the next column.
    const columnsAfterSelect = React.useMemo(() => {
        const set = new Set<string>();
        for (let i = 1; i < visibleColumns.length; i++) {
            if (visibleColumns[i - 1].id === "select") {
                set.add(visibleColumns[i].id);
            }
        }
        return set;
    }, [visibleColumns]);

    // R13-PR15 — id of the first non-utility column. Carries the
    // brand-edge hover/selected accent.
    const firstContentColumnId = React.useMemo(
        () =>
            visibleColumns.find(
                (c) => !["select", "menu"].includes(c.id),
            )?.id,
        [visibleColumns],
    );

    // visibleColumns identity changes when columns add/remove or
    // visibility flips — those are the inputs the template depends on.
    // `table` is stable across renders. Extract the column-id key into
    // a const so the deps array is "simple expressions" only.
    const visibleColumnsKey = visibleColumns.map((c) => c.id).join(",");
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const gridTemplate = React.useMemo(() => buildGridTemplate(table), [visibleColumnsKey, table]);

    // `rowProps` carries per-render row data to every VirtualRow,
    // replacing v1's `itemData`. Memoising it keeps react-window from
    // re-rendering rows when the click handlers are referentially
    // stable between renders.
    const rowProps = React.useMemo<RowItemData<T>>(
        () => ({
            rows,
            gridTemplate,
            onRowClick,
            onRowAuxClick,
            selectionEnabled,
            columnsAfterSelect,
            firstContentColumnId,
        }),
        [rows, gridTemplate, onRowClick, onRowAuxClick, selectionEnabled, columnsAfterSelect, firstContentColumnId],
    );

    // Sticky header rendered inside the List's `children` slot, which
    // v2 mounts inside the same scroll container as the rows — so
    // `position: sticky; top: 0` pins it to the top of the scroll
    // viewport, exactly as v1's `outerElementType` header did.
    const header = (
        <VirtualTableHeader
            table={table}
            gridTemplate={gridTemplate}
            sortableColumns={sortableColumns}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSortChange={onSortChange}
            columnsAfterSelect={columnsAfterSelect}
        />
    );

    // The List root IS the scroll container in v2; the region role +
    // tabIndex + aria-label + focus ring (v1 carried on the
    // `outerElementType` wrapper) move directly onto it.
    const scrollContainerClassName = cn(
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)]/40",
        scrollWrapperClassName,
    );

    const renderList = (h: number | undefined) => (
        <List<RowItemData<T>>
            role="region"
            aria-label={ariaLabel}
            tabIndex={0}
            className={scrollContainerClassName}
            rowComponent={VirtualRow}
            rowCount={rows.length}
            rowHeight={rowHeight}
            rowProps={rowProps}
            overscanCount={overscanCount}
            defaultHeight={h}
            style={{ height: "100%" }}
        >
            {header}
        </List>
    );

    if (typeof height === "number") {
        return (
            <div
                data-virtual-table=""
                data-testid={testId}
                className={cn(
                    "border-border-subtle bg-bg-default relative z-0 rounded-lg border overflow-hidden",
                    containerClassName,
                )}
                style={{ height }}
            >
                {renderList(height)}
            </div>
        );
    }

    // Auto-fill path — no explicit height. The List self-measures its
    // parent via ResizeObserver and fills `height: 100%`. The parent
    // MUST be sized (the ListPageShell.Body flex chain provides this).
    // `react-virtualized-auto-sizer` is no longer needed.
    return (
        <div
            data-virtual-table=""
            data-testid={testId}
            className={cn(
                "border-border-subtle bg-bg-default relative z-0 rounded-lg border overflow-hidden",
                "h-full w-full",
                containerClassName,
            )}
            style={{ minHeight: 0 }}
        >
            {renderList(undefined)}
        </div>
    );
}

function HeaderContent({
    children,
    tooltip,
}: {
    children: React.ReactNode;
    tooltip?: string;
}) {
    if (!tooltip) return <>{children}</>;
    return (
        <Tooltip content={tooltip}>
            <span className="cursor-help underline decoration-dotted underline-offset-2">
                {children}
            </span>
        </Tooltip>
    );
}

interface VirtualTableHeaderProps<T> {
    table: TableType<T>;
    gridTemplate: string;
    sortableColumns: string[];
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    onSortChange?: (props: {
        sortBy?: string;
        sortOrder?: "asc" | "desc";
    }) => void;
    columnsAfterSelect: ReadonlySet<string>;
}

function VirtualTableHeader<T>({
    table,
    gridTemplate,
    sortableColumns,
    sortBy,
    sortOrder,
    onSortChange,
    columnsAfterSelect,
}: VirtualTableHeaderProps<T>) {
    const t = useTranslations("ui.table");
    return (
        <div
            role="rowgroup"
            data-virtual-table-header=""
            className="sticky top-0 z-20 bg-bg-muted"
            style={{ display: "grid", gridTemplateColumns: gridTemplate }}
        >
            {table.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => {
                    const isSortable = sortableColumns.includes(header.column.id);
                    const isSelect = header.column.id === "select";
                    const hasSelectBefore = columnsAfterSelect.has(header.column.id);
                    const headerTooltip = (header.column.columnDef.meta as
                        | { headerTooltip?: string }
                        | undefined)?.headerTooltip;

                    const labelContent = header.isPlaceholder
                        ? null
                        : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                          );

                    return (
                        <div
                            key={header.id}
                            role="columnheader"
                            className={headerCellClassName(
                                header.column.id,
                                hasSelectBefore,
                            )}
                        >
                            {isSelect ? (
                                <div className="flex size-full items-center justify-center">
                                    {labelContent}
                                </div>
                            ) : (
                                <div className="flex items-center justify-between gap-tight">
                                    {isSortable ? (
                                        <button
                                            type="button"
                                            aria-label={t("sortByColumn")}
                                            className="flex items-center gap-tight"
                                            onClick={() =>
                                                onSortChange?.({
                                                    sortBy: header.column.id,
                                                    sortOrder:
                                                        sortBy !== header.column.id
                                                            ? "desc"
                                                            : sortOrder === "asc"
                                                              ? "desc"
                                                              : "asc",
                                                })
                                            }
                                        >
                                            <HeaderContent tooltip={headerTooltip}>
                                                {labelContent}
                                            </HeaderContent>
                                            {sortBy === header.column.id && (
                                                <SortOrder
                                                    className="h-3 w-3 shrink-0"
                                                    order={sortOrder ?? "desc"}
                                                />
                                            )}
                                        </button>
                                    ) : (
                                        <HeaderContent tooltip={headerTooltip}>
                                            {labelContent}
                                        </HeaderContent>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                }),
            )}
        </div>
    );
}

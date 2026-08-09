'use client';

/* eslint-disable react-hooks/exhaustive-deps -- Various useEffect/useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers recreated each render) or use selector functions whose change-detection happens elsewhere. Adding the deps would either trigger unnecessary re-runs OR cause infinite render loops; the proper structural fix is to wrap parent-level callbacks in useCallback. Tracked as follow-up. */
/* eslint-disable @typescript-eslint/no-explicit-any --
 * Tanstack-react-table primitive wrapper. Remaining `any` usages are
 * structural — `getValue<T>()`, generic `T extends any` bounds, and the
 * heterogeneous `column: any` param in sort helpers. The `ColumnMeta`
 * fields (disableTruncate / headerTooltip) are now typed via the module
 * augmentation in `./tanstack-table.d.ts` and no longer require casts.
 */
import { cn, deepEqual, isClickOnInteractiveChild } from "./table-utils";
import {
  Column,
  ColumnDef,
  flexRender,
  getCoreRowModel,
  Row,
  RowSelectionState,
  Table as TableType,
  useReactTable,
  VisibilityState,
} from "@tanstack/react-table";
import { AnimatePresence, motion } from "motion/react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  CSSProperties,
  HTMLAttributes,
  memo,
  MouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { Button } from "../button";
import { Checkbox } from "../checkbox";
import { ErrorState } from "../error-state";
import { LoadingSpinner, SortOrder } from "../icons";
import { ChevronRight } from "../icons/nucleo/chevron-right";
import { Tooltip } from "../tooltip";
import { SelectionToolbar } from "./selection-toolbar";
import { TableProps, UseTableProps } from "./types";

const SELECT_COLUMN_WIDTH = 48;
const MENU_COLUMN_WIDTH = 40;
// v2-PR-12 follow-through (2026-05-13) — the trailing chevron-right
// affordance for clickable rows. Renders only when the consumer
// passes `onRowClick`; the column is invisible by default and the
// chevron fades in on `group-hover/row`. 32 px keeps the column
// narrow enough that it reads as decoration, not a data cell. The
// header cell stays empty — adding "→" or similar would make the
// column read as semantic which it is not.
const CHEVRON_COLUMN_WIDTH = 32;
const FIXED_UTILITY_COLUMN_IDS = new Set(["select", "menu"]);

// WCAG 2.1 (axe `empty-table-header`) — utility columns whose visible
// header is intentionally empty (a decorative chevron, a row kebab, a
// per-row action cluster) still need an accessible name on the <th> so
// screen-reader users hear what the column does instead of an empty
// header. Visually nothing changes: the label lands on `aria-label`,
// not in the DOM text. Keyed by column id; `actions` is the conventional
// id pages give their trailing icon-button column.
const UTILITY_HEADER_LABELS: Record<string, string> = {
  "__row-chevron": "Open row",
  menu: "Row actions",
  actions: "Row actions",
};

const tableCellClassName = (
  columnId: string,
  clickable?: boolean,
  hasSelectBefore?: boolean,
  isFirstContent?: boolean,
) =>
  cn([
    "py-2.5 text-left text-sm leading-6 whitespace-nowrap border-border-subtle relative",
    "border-l border-b",
    columnId === "select" && "w-12 min-w-12 max-w-12 px-0 py-0",
    columnId === "menu" && "bg-bg-page border-l-transparent py-0 px-1",
    !["select", "menu"].includes(columnId) &&
      (hasSelectBefore ? "pl-1 pr-4" : "px-4"),
    // PR-7 row hover — bg-bg-muted is the solid hover surface (was
    // bg-bg-subtle, ~7% alpha which read as nearly invisible on dark
    // theme). Pairs with `cursor-pointer` on the row itself to make
    // clickability unambiguous.
    clickable && "group-hover/row:bg-bg-muted transition-colors duration-75",
    // Brand-coloured 2-px left-edge accent on hover + selected.
    //
    // History:
    //   - Originally lived on the `<tr>` as `hover:shadow-...`.
    //     CSS table painting paints cell backgrounds on top of
    //     row-level shadows → flicker (R13-PR13 diagnosis).
    //   - R13-PR13 moved it to cells via `first-of-type:`. That
    //     selector matches the first `<td>` in each row — which
    //     became the SELECT column once R12-PR1 made selection
    //     default-on. The rule excluded the select column, so it
    //     never fired anywhere → no hover edge at all.
    //   - R13-PR15 gated the shadow on an explicit
    //     `isFirstContent` boolean — first non-utility column id.
    //     The accent then sat at the left of the second column
    //     (the data column) with the select circle in column 1
    //     to its left.
    //   - 2026-05-19 — moved to the row's TRUE leftmost cell so
    //     the accent reads as "this row" rather than "the data
    //     starts here". When the select column is mounted, the
    //     select cell carries the accent (`columnId === "select"`).
    //     When it's not (selectionEnabled={false} on a list page),
    //     the first content cell carries it (`isFirstContent &&
    //     !hasSelectBefore`).
    (columnId === "select" || (isFirstContent && !hasSelectBefore)) &&
      clickable &&
      "group-hover/row:shadow-[inset_2px_0_0_var(--brand-default)]",
    // PR-7 selected-row signal — left-edge brand accent via inset
    // box-shadow. Same leftmost-cell rule as the hover accent
    // above so hover + selected speak in one voice. Was
    // `isFirstContent` before; moved 2026-05-19 alongside hover.
    "group-data-[selected=true]/row:bg-[var(--brand-subtle)]",
    (columnId === "select" || (isFirstContent && !hasSelectBefore)) &&
      "group-data-[selected=true]/row:shadow-[inset_2px_0_0_var(--brand-default)]",
  ]);

const resizingClassName = cn([
  "absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none",
  "bg-border-emphasis/50",
  "opacity-0 group-hover/resize:opacity-100 hover:opacity-100",
  "group-hover/resize:bg-border-emphasis hover:bg-content-muted",
  "transition-all duration-200",
  "-mr-px",
  "after:absolute after:right-0 after:top-0 after:h-full after:w-4 after:translate-x-1/2",
]);

export function useTable<T extends any>(
  props: UseTableProps<T>,
): TableProps<T> & { table: TableType<T> } {
  const {
    data,
    rowCount,
    columns,
    defaultColumn,
    columnPinning,
    pagination,
    onPaginationChange,
    getRowId,
    enableColumnResizing = false,
    columnResizeMode = "onChange",
  } = props;

  const t = useTranslations("ui.table");

  // R12-PR1 — select column is default-on. Pages opt out via
  // `selectionEnabled={false}`. The previous gating (require either
  // `onRowSelectionChange` or `selectionControls`) made the select
  // column appear on exactly one page (Practices) and absent
  // everywhere else — the structural inconsistency the round closes.
  const selectionEnabled = props.selectionEnabled ?? true;

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    props.columnVisibility ?? {},
  );

  const [rowSelection, setRowSelection] = useState<RowSelectionState>(
    props.selectedRows ?? {},
  );

  const lastSelectedRowId = useRef<string | null>(null);

  // Manually unset row selection if the row is no longer in the data
  // There doesn't seem to be a proper solution for this: https://github.com/TanStack/table/issues/4498
  useEffect(() => {
    if (!getRowId || !data) return;

    const entries = Object.entries(rowSelection);
    if (entries.length > 0) {
      const newEntries = entries.filter(([key]) =>
        data.find((row) => getRowId?.(row) === key),
      );

      if (newEntries.length !== entries.length)
        setRowSelection(Object.fromEntries(newEntries));
    }
  }, [data, rowSelection, getRowId]);

  useEffect(() => {
    if (props.selectedRows && !deepEqual(props.selectedRows, rowSelection)) {
      setRowSelection(props.selectedRows ?? {});
    }
  }, [props.selectedRows]);

  useEffect(() => {
    props.onRowSelectionChange?.(table.getSelectedRowModel().rows);
  }, [rowSelection]);

  // Update internal columnVisibility when prop value changes
  useEffect(() => {
    if (
      props.columnVisibility &&
      !deepEqual(props.columnVisibility, columnVisibility)
    )
      setColumnVisibility(props.columnVisibility ?? {});
  }, [props.columnVisibility]);

  // Call onColumnVisibilityChange when internal columnVisibility changes
  useEffect(() => {
    props.onColumnVisibilityChange?.(columnVisibility);
  }, [columnVisibility]);

  const normalizedColumns = useMemo(
    () =>
      columns.map((column: any) =>
        column?.id === "menu"
          ? {
              ...column,
              minSize: MENU_COLUMN_WIDTH,
              size: MENU_COLUMN_WIDTH,
              maxSize: MENU_COLUMN_WIDTH,
            }
          : column,
      ),
    [columns],
  );

  const tableColumns = useMemo(
    () => [
      ...(selectionEnabled
        ? [
            {
              id: "select",
              enableHiding: false,
              minSize: SELECT_COLUMN_WIDTH,
              size: SELECT_COLUMN_WIDTH,
              maxSize: SELECT_COLUMN_WIDTH,
              // NB: outer wrapper is a <div>, not a <button>. Radix
              // `Checkbox` renders an internal <button>, so nesting it
              // inside <button> triggers a hydration mismatch
              // ("<button> cannot be a descendant of <button>"). The
              // inner Checkbox already owns keyboard focus; this
              // wrapper exists only to widen the click target.
              header: ({ table }: { table: TableType<T> }) => (
                <div
                  // GAP-CI-77: presentation role on the wrapping click
                  // area — the actual focusable+labelled control is the
                  // inner <Checkbox>. role="button" here was creating a
                  // button-name violation because axe inspected both the
                  // outer wrapper (had aria-label but no real button
                  // semantics) and the inner Radix button (now correctly
                  // labelled).
                  role="presentation"
                  tabIndex={-1}
                  className="flex size-full cursor-pointer items-center justify-center"
                  onClick={(e) => {
                    e.stopPropagation();
                    table.toggleAllRowsSelected();
                  }}
                  title={t("selectAll")}
                >
                  <Checkbox
                    aria-label={t("selectAllRows")}
                    className="border-border-emphasis pointer-events-none size-4 rounded-full data-[state=checked]:bg-[var(--brand-emphasis)] data-[state=indeterminate]:bg-[var(--brand-emphasis)]"
                    checked={
                      table.getIsAllRowsSelected()
                        ? true
                        : table.getIsSomeRowsSelected()
                          ? "indeterminate"
                          : false
                    }
                  />
                </div>
              ),
              cell: ({ row, table }: { row: Row<T>; table: TableType<T> }) => {
                const onSelectRow = (e: MouseEvent<HTMLDivElement>) => {
                  e.stopPropagation();
                  const currentId = getRowId?.(row.original);
                  const rows = table.getRowModel().rows;
                  const lastSelectedIndex =
                    lastSelectedRowId.current !== null
                      ? rows.findIndex(
                          (row) =>
                            getRowId?.(row.original) ===
                            lastSelectedRowId.current,
                        )
                      : -1;

                  if (
                    e.shiftKey &&
                    lastSelectedRowId.current !== null &&
                    lastSelectedIndex !== -1
                  ) {
                    // Multi-select w/ shift key
                    const currentIndex =
                      currentId !== undefined
                        ? rows.findIndex(
                            (row) => getRowId?.(row.original) === currentId,
                          )
                        : -1;
                    if (currentIndex === -1) {
                      row.toggleSelected();
                      lastSelectedRowId.current = currentId ?? null;
                      return;
                    }

                    const start = Math.min(lastSelectedIndex, currentIndex);
                    const end = Math.max(lastSelectedIndex, currentIndex);
                    const rangeIds = rows
                      .slice(start, end + 1)
                      .map((row) => getRowId?.(row.original))
                      .filter((id): id is string => id !== undefined);

                    table.setRowSelection((rowSelection) => {
                      const validRangeIds = rangeIds.filter(
                        (id): id is string => id !== undefined,
                      );
                      const alreadySelected =
                        currentId !== undefined &&
                        (rowSelection?.[currentId] ?? false);

                      return {
                        ...rowSelection,
                        ...Object.fromEntries(
                          validRangeIds.map((id) => [id, !alreadySelected]),
                        ),
                      };
                    });

                    lastSelectedRowId.current = currentId ?? null;
                  } else {
                    row.toggleSelected();
                    lastSelectedRowId.current = currentId ?? null;
                  }
                };

                return (
                  <div
                    // GAP-CI-77: see select-all wrapper above for the same
                    // role="presentation" rationale.
                    role="presentation"
                    tabIndex={-1}
                    className="flex size-full cursor-pointer items-center justify-center"
                    onClick={onSelectRow}
                    title={t("select")}
                  >
                    <Checkbox
                      aria-label={t("selectRow")}
                      className="border-border-emphasis pointer-events-none size-4 rounded-full data-[state=checked]:bg-[var(--brand-emphasis)] data-[state=indeterminate]:bg-[var(--brand-emphasis)]"
                      checked={row.getIsSelected()}
                    />
                  </div>
                );
              },
            },
          ]
        : []),
      ...normalizedColumns,
      // v2-PR-12 follow-through (2026-05-13) — render the trailing
      // chevron affordance ONLY when the consumer wired
      // `onRowClick`. Symmetric with the leading selection column:
      // selection on left, navigate-affordance on right. The cell
      // contents are decoration only — `aria-hidden`, no role.
      // The chevron itself starts at opacity-0 and fades to
      // opacity-60 on the row's `group-hover/row` (defined in the
      // `<tr>` className). Transitions through `transition-opacity`
      // — no compositor work, no layout shift. Disabled with
      // pointer-events-none so the chevron can't intercept the
      // row-click handler.
      ...(props.onRowClick
        ? [
            {
              id: "__row-chevron",
              enableHiding: false,
              enableSorting: false,
              minSize: CHEVRON_COLUMN_WIDTH,
              size: CHEVRON_COLUMN_WIDTH,
              maxSize: CHEVRON_COLUMN_WIDTH,
              header: () => null,
              cell: () => (
                <div
                  aria-hidden="true"
                  className="pointer-events-none flex size-full items-center justify-center text-content-muted opacity-0 transition-opacity duration-150 ease-out group-hover/row:opacity-60"
                >
                  <ChevronRight width={16} height={16} />
                </div>
              ),
            } satisfies ColumnDef<T>,
          ]
        : []),
    ],
    [selectionEnabled, normalizedColumns, props.onRowClick],
  );

  // TanStack Table's options object isn't designed for the React
  // Compiler's reactivity model — it expects a fresh object per render
  // (the library does its own internal stability tracking). The rule's
  // "incompatible-library" warning is correct: TanStack predates the
  // Compiler. Working as intended in production.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    rowCount,
    columns: tableColumns,
    defaultColumn: {
      // When resizing is on, the <Table> render seeds every column's
      // measured content width into the sizing state on mount
      // (measure-then-fix), so this `size` is only a transient
      // placeholder for the one pre-measure frame. `minSize` is the
      // floor a user can drag a column down to; no `maxSize` cap so
      // the seed never clips a genuinely wide column and drags stay
      // unconstrained.
      minSize: enableColumnResizing ? 64 : 0,
      size: enableColumnResizing ? 150 : 0,
      maxSize: undefined,
      enableResizing: enableColumnResizing,
      ...defaultColumn,
    },
    getCoreRowModel: getCoreRowModel(),
    onPaginationChange,
    onColumnVisibilityChange: (visibility) => setColumnVisibility(visibility),
    onRowSelectionChange: setRowSelection,
    state: {
      pagination,
      columnVisibility,
      columnPinning: { left: [], right: [], ...columnPinning },
      rowSelection,
    },
    manualPagination: true,
    autoResetPageIndex: false,
    manualSorting: true,
    getRowId,
    enableColumnResizing,
    columnResizeMode,
  });

  return {
    ...props,
    columnVisibility,
    table,
    enableColumnResizing,
  };
}

type ResizableTableRowProps<T> = {
  row: Row<T>;
  rowProps?: HTMLAttributes<HTMLTableRowElement>;
  table: TableType<T>;
  selectionEnabled: boolean;
  // Selection state captured at PARENT render time. The memo
  // comparator below MUST compare this snapshot, not call
  // `row.getIsSelected()` on both row objects — those read the LIVE
  // table state, so post-toggle they're always equal and the row
  // would never re-render (stale `data-selected` + unchecked box).
  isSelected: boolean;
} & Pick<
  TableProps<T>,
  "cellRight" | "tdClassName" | "onRowClick" | "onRowAuxClick"
>;

// Memoized row component to prevent re-renders during column resizing
const ResizableTableRow = memo(
  function ResizableTableRow<T>({
    row,
    onRowClick,
    onRowAuxClick,
    rowProps,
    cellRight,
    tdClassName,
    table,
    selectionEnabled,
    isSelected,
  }: ResizableTableRowProps<T>) {
    const { className, ...rest } = rowProps || {};

    return (
      <tr
        key={row.id}
        className={cn(
          "group/row",
          // v2-PR-12 — hover affordance for clickable rows. The
          // `group/row` class above lets the chevron-cell rendering
          // toggle on group hover. The brand-coloured 2-px left
          // edge is rendered by the FIRST non-utility cell in
          // `tableCellClassName` (R13-PR13) so it survives the
          // cell's own bg-bg-muted hover paint — see the comment
          // there. Row-level treatment here keeps just the
          // cursor + colour-transition affordance.
          //
          // R13-PR14 — selection-enabled rows also get the
          // cursor-pointer affordance even without onRowClick (the
          // click toggles selection now, see onClick below).
          (onRowClick || selectionEnabled) &&
            "cursor-pointer select-none transition-colors duration-150 ease-out",
          // hacky fix: if there are more than 8 rows, remove the bottom border from the last row
          table.getRowModel().rows.length > 8 &&
            row.index === table.getRowModel().rows.length - 1 &&
            "[&_td]:border-b-0",
          className,
        )}
        // R13-PR14 — single click on the row toggles selection
        // (filled radio fills/empties in the leftmost cell). The
        // existing select-column `onSelectRow` handler calls
        // `e.stopPropagation()` so a click on the checkbox itself
        // does not double-fire here. A real double-click fires
        // onClick twice (toggle + toggle back to start) and then
        // onDoubleClick once (navigate) — selection ends where it
        // started while navigation still happens.
        onClick={
          selectionEnabled
            ? (e) => {
                if (isClickOnInteractiveChild(e)) return;
                row.toggleSelected();
              }
            : // No selection to compete with → a single click runs the
              // row action directly (e.g. the Tasks tab opens the task
              // edit Sheet on click). When selection IS on, the row
              // action stays on double-click (handler below) so single-
              // click can own selection.
              onRowClick
              ? (e) => {
                  if (isClickOnInteractiveChild(e)) return;
                  onRowClick(row, e);
                }
              : undefined
        }
        // ── Keyboard ──────────────────────────────────────────────
        //
        // A clickable row was reachable by mouse only. `onClick` on a `<tr>`
        // gives no focus and no key handling, so every list page that opens a
        // detail sheet or navigates on row click was unusable without a
        // pointer — and on the evidence page that meant the whole review
        // workflow, since the row is how you open a record.
        //
        // `tabIndex` + Enter/Space is the data-grid convention. Deliberately
        // NO `role="button"`: that would replace the row's table semantics,
        // and a screen-reader user would lose the column associations that
        // make the row readable at all. The row stays a row; it just gains a
        // focus stop and a key that activates it.
        //
        // Space is prevented BEFORE activating — the default would scroll the
        // page out from under whatever the activation opens.
        tabIndex={onRowClick ? 0 : undefined}
        onKeyDown={
          onRowClick
            ? (e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                // A key pressed inside a nested button/link belongs to that
                // practice, not to the row.
                if (e.target !== e.currentTarget) return;
                e.preventDefault();
                onRowClick(row, e as unknown as MouseEvent<HTMLTableRowElement>);
              }
            : undefined
        }
        onDoubleClick={
          // Only when selection owns the single click does the row
          // action need a double-click. With selection off it already
          // fires on single click above.
          selectionEnabled && onRowClick
            ? (e) => {
                if (isClickOnInteractiveChild(e)) return;
                onRowClick(row, e);
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
        data-selected={isSelected}
        {...rest}
      >
        {row.getVisibleCells().map((cell, index, cells) => {
          const isUtilityColumn = ["select", "menu"].includes(cell.column.id);
          const isSelectColumn = cell.column.id === "select";
          const isColumnAfterSelect = cells[index - 1]?.column.id === "select";
          // R13-PR15 — the first NON-utility cell carries the brand-
          // edge accent. CSS `:first-of-type` was the previous lever
          // but it pointed at the select column once that became
          // default-on; this boolean is unambiguous.
          const firstContentId = cells.find(
            (c) => !["select", "menu"].includes(c.column.id),
          )?.column.id;
          const isFirstContent = cell.column.id === firstContentId;
          const disableTruncate = !!cell.column.columnDef.meta?.disableTruncate;

          return (
            <td
              key={cell.id}
              className={cn(
                tableCellClassName(
                  cell.column.id,
                  !!onRowClick,
                  isColumnAfterSelect,
                  isFirstContent,
                ),
                "text-content-default group",
                getCommonPinningClassNames(
                  cell.column,
                  row.index === table.getRowModel().rows.length - 1,
                ),
                typeof tdClassName === "function"
                  ? tdClassName(cell.column.id, row)
                  : tdClassName,
              )}
              style={{
                width: cell.column.getSize(),
                ...getCommonPinningStyles(cell.column),
              }}
            >
              {isSelectColumn ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </div>
              ) : (
                <div
                  className={cn(
                    "flex items-center",
                    isUtilityColumn
                      ? "justify-center"
                      : "w-full justify-between",
                    !isUtilityColumn &&
                      (disableTruncate
                        ? "overflow-visible"
                        : "overflow-hidden truncate"),
                  )}
                >
                  <div
                    className={cn(
                      disableTruncate ? "whitespace-nowrap" : "truncate",
                      isUtilityColumn ? "shrink-0" : "min-w-0 shrink grow",
                      disableTruncate &&
                        !isUtilityColumn &&
                        "min-w-max shrink-0",
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                  {!isUtilityColumn && cellRight?.(cell)}
                </div>
              )}
            </td>
          );
        })}
      </tr>
    );
  },
  (prevProps, nextProps) => {
    // Only re-render if row data or selection state changes. Compare
    // the `isSelected` SNAPSHOT prop (captured at parent render time),
    // NOT `row.getIsSelected()` on each row — those read the live
    // table state and are always equal right after a toggle, which
    // would skip the re-render and leave `data-selected` + the
    // checkbox stale (the row-highlight-on-select bug).
    return (
      prevProps.row.original === nextProps.row.original &&
      prevProps.isSelected === nextProps.isSelected
    );
  },
) as <T>(props: ResizableTableRowProps<T>) => JSX.Element;

export function Table<T>({
  data,
  loading,
  error,
  emptyState,
  cellRight,
  sortBy,
  sortOrder,
  onSortChange,
  sortableColumns = [],
  className,
  containerClassName,
  scrollWrapperClassName,
  emptyWrapperClassName,
  thClassName,
  tdClassName,
  table,
  pagination,
  paginationAllRowsHref, // to show all rows link in the pagination
  resourceName,
  onRowClick,
  onRowAuxClick,
  onRowSelectionChange,
  selectionControls,
  selectionEnabled: selectionEnabledProp,
  rowProps,
  rowCount,
  children,
  enableColumnResizing = false,
}: TableProps<T>) {
  const t = useTranslations("ui.table");
  const selectionEnabled = selectionEnabledProp ?? true;
  const visibleColumns = table.getVisibleLeafColumns();
  const columnsAfterSelect = new Set<string>();
  for (let i = 1; i < visibleColumns.length; i++) {
    if (visibleColumns[i - 1].id === "select") {
      columnsAfterSelect.add(visibleColumns[i].id);
    }
  }
  // R13-PR15 — id of the first NON-utility (non-select / non-menu)
  // column. Carries the brand-edge hover/selected accent on its
  // cells (CSS `:first-of-type` was the previous lever but it
  // pointed at the select column once that became default-on).
  const firstContentColumnId = visibleColumns.find(
    (c) => !["select", "menu"].includes(c.id),
  )?.id;
  const scrollWrapperRef = useRef<HTMLDivElement>(null);

  // ── Column resizing: measure-then-fix ──
  //
  // `table-layout: fixed` (required for precise drag-resize) needs an
  // explicit width per column, but a uniform default width would
  // squish every table. So on mount we render ONE auto-layout frame
  // (no per-column widths → the browser sizes each column to its
  // content), measure the laid-out header widths, seed them into
  // TanStack's column-sizing state, then flip to fixed layout. The
  // result is visually identical to the non-resizable table, but
  // every column now carries a drag handle and a concrete width the
  // user can adjust.
  //
  // `sizingFrozen` gates the layout mode. `measuredColumnKey` tracks
  // which visible-column set we last measured — when columns are
  // shown/hidden the set changes and we re-measure (dropping back to
  // auto for one frame first). A user drag updates TanStack's sizing
  // state directly and leaves the key untouched, so resizes persist.
  const tableElRef = useRef<HTMLTableElement>(null);
  const [sizingFrozen, setSizingFrozen] = useState(false);
  const measuredColumnKey = useRef<string | null>(null);
  const visibleColumnKey = visibleColumns.map((c) => c.id).join("|");
  const applyFixedLayout = enableColumnResizing && sizingFrozen;

  useLayoutEffect(() => {
    if (!enableColumnResizing) return;
    if (measuredColumnKey.current === visibleColumnKey) return;
    const tableEl = tableElRef.current;
    if (!tableEl) return;
    // Column set changed while frozen — drop to auto layout for one
    // frame so the next pass measures true content widths, not the
    // currently-pinned fixed widths.
    if (sizingFrozen) {
      setSizingFrozen(false);
      return;
    }
    const headerCells = tableEl.querySelectorAll<HTMLTableCellElement>(
      "thead th[data-column-id]",
    );
    if (!headerCells.length) return;
    const sizing: Record<string, number> = {};
    headerCells.forEach((th) => {
      const id = th.dataset.columnId;
      // Utility columns (select / row-menu / chevron) keep their
      // explicit column-def widths — skip them so the measured value
      // doesn't override the fixed affordance width.
      if (!id || FIXED_UTILITY_COLUMN_IDS.has(id)) return;
      sizing[id] = Math.round(th.getBoundingClientRect().width);
    });
    measuredColumnKey.current = visibleColumnKey;
    table.setColumnSizing((prev) => ({ ...prev, ...sizing }));
    setSizingFrozen(true);
  }, [enableColumnResizing, visibleColumnKey, sizingFrozen, table]);

  // Whole-row clip — clamp the scroll wrapper to a multiple of the
  // row height so the bottom of the card never cuts a row in half.
  // Without this, the card height is whatever the flex chain
  // allocates (= viewport - chrome), which rarely divides evenly by
  // row height and leaves the last visible row half-shown.
  //
  // Strategy: measure the outer card's height (= wrapper's intended
  // height, set by flex-1 in the chain) and the first row's height,
  // then set the wrapper's max-height to floor(avail / rowH) * rowH.
  // ResizeObserver watches the OUTER CARD (not the wrapper) so my
  // max-height update doesn't loop — the card's size is determined
  // by flex-1 above, independent of my max-height below.
  const numRows = table.getRowModel().rows.length;
  const [maxScrollHeight, setMaxScrollHeight] = useState<number | undefined>();
  // useLayoutEffect runs synchronously after DOM commit and BEFORE
  // the browser paints — eliminates the "first paint shows clipped
  // wrong, then re-renders correctly" flicker. Also more reliable
  // under Next.js fast-refresh than plain useEffect.
  useLayoutEffect(() => {
    const wrapper = scrollWrapperRef.current;
    const card = wrapper?.parentElement;
    if (!wrapper || !card) return;

    const compute = () => {
      const tbody = wrapper.querySelector("tbody");
      const firstRow = tbody?.querySelector("tr") as HTMLElement | null;
      if (!firstRow) {
        // Empty state: no rows to clip against. Let CSS take over
        // (min-h-96 floor on the empty-state container).
        setMaxScrollHeight(undefined);
        return;
      }
      const rowH = firstRow.offsetHeight;
      if (rowH <= 0) return; // not yet laid out — wait for next RO tick

      // The viewport allocation lives on an ancestor up the chain
      // (ListPageShell.Body, which is flex-1 of ListPageShell). Since
      // the card has no flex-1 anymore, card.clientHeight = card's
      // natural size (= content). Walk up to the ListPageShell.Body
      // (the closest ancestor with the data-list-page-shell-body
      // marker — fall back to the second ancestor if the marker is
      // absent on a non-shell page).
      const allocAncestor =
        (wrapper.closest("[data-list-page-body]") as HTMLElement | null) ??
        card.parentElement;
      const availH = allocAncestor?.clientHeight ?? card.clientHeight;

      // tbody.scrollHeight is the actual content height (sum of all
      // rows + any borders/padding). If it fits within the
      // allocation, no clip — CSS max-h-full naturally caps to
      // parent and content is shorter than that.
      const contentH = tbody?.scrollHeight ?? 0;
      if (contentH <= availH) {
        setMaxScrollHeight((prev) => (prev === undefined ? prev : undefined));
        return;
      }

      // Content overflows. Clip to whole rows.
      const wholeRows = Math.max(Math.floor(availH / rowH), 1);
      const newMax = wholeRows * rowH;
      setMaxScrollHeight((prev) => (prev === newMax ? prev : newMax));
    };

    compute();
    // Observe BOTH the card (its height changes when the viewport
    // resizes or the chrome above it changes) AND the first row
    // (its height changes when content reflows, e.g. font load).
    const ro = new ResizeObserver(compute);
    ro.observe(card);
    const tbody = wrapper.querySelector("tbody");
    const firstRow = tbody?.querySelector("tr");
    if (firstRow) ro.observe(firstRow);
    return () => ro.disconnect();
  }, [numRows]);

  const utilityColumnWidths = new Map(
    visibleColumns.map((column) => [column.id, column.getSize()]),
  );
  const getUtilityColumnWidth = (columnId: string, fallback: number) =>
    utilityColumnWidths.get(columnId) ?? fallback;

  const As = paginationAllRowsHref ? Link : "span";

  return (
    <div
      className={cn(
        "border-border-subtle bg-bg-default relative z-0 rounded-lg border",
        containerClassName,
      )}
    >
      {(!error && !!data?.length) || loading ? (
        <>
          {/* Selection Toolbar Overlay.
              z-30 (was z-10) so it sits ABOVE the sticky thead
              (z-20). When rows are selected the toolbar covers the
              top of the card; the sticky thead would otherwise
              render on top of it because of source order + the
              earlier z-20 bump. */}
          {selectionEnabled && (
            <SelectionToolbar
              table={table}
              practices={selectionControls}
              className="absolute left-0 top-0 z-30 rounded-t-[inherit]"
            />
          )}
          <div
            ref={scrollWrapperRef}
            // axe AA — `scrollable-region-focusable`: scrollable
            // regions (containers with `overflow: auto/scroll` and
            // content that exceeds the viewport) MUST be reachable
            // by keyboard. `tabIndex=0` makes the wrapper part of
            // the tab order so a keyboard-only user can focus it
            // and use ↑↓ / PgUp/PgDn to scroll. The complementary
            // `role="region"` + `aria-label` give assistive tech a
            // meaningful announce-name for the table viewport.
            tabIndex={0}
            role="region"
            aria-label={t("scrollableRegion")}
            className={cn(
              "relative overflow-x-auto rounded-[inherit]",
              // B6 (2026-06-07): the 400px floor is for the EMPTY state only
              // (room for the "no rows" message). A POPULATED non-fillBody
              // sub-table — e.g. a detail-page Tasks tab with a single task —
              // sizes to content; the floor was leaving ~320px of empty,
              // grid-less space below the row(s). fillBody list tables clamp
              // to the viewport via their own md:min-h-0 / max-h-full and are
              // unaffected (their rows are > 0 anyway when populated).
              numRows === 0 && "min-h-[400px]",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)]/40",
              // Scroll-snap so rows align cleanly with the sticky
              // header instead of stopping mid-row. `snap-proximity`
              // only snaps when you stop near a snap point, so free
              // scrolling still feels natural — half-row positions
              // get a gentle nudge to align. `scroll-pt-[37px]`
              // matches the sticky header height so a row's "start"
              // snap point lands BELOW the header, not under it.
              "snap-y snap-proximity scroll-pt-[37px]",
              scrollWrapperClassName,
            )}
            // maxHeight clamps the wrapper to a whole number of rows
            // (see whole-row-clip useEffect above). Inline style so
            // it overrides Tailwind's md:flex-1 from fillBody.
            style={
              maxScrollHeight !== undefined
                ? { maxHeight: maxScrollHeight }
                : undefined
            }
          >
            <table
              ref={tableElRef}
              className={cn(
                [
                  "group/table w-full border-separate border-spacing-0 transition-[border-spacing,margin-top]",
                  "[&_tr>*:first-child]:border-l-transparent",
                  "[&_tr>*:last-child]:border-r-transparent",
                  "[&_tr>*:last-child]:border-r-transparent",
                  // Header cells are `sticky top-0` for the
                  // viewport-clamped scroll layout. A blanket
                  // `[&_th]:relative` here would beat the per-th
                  // `sticky` class via selector specificity (the
                  // descendant selector outweighs the bare class
                  // selector). Use select-none only.
                  "[&_th]:select-none",
                  enableColumnResizing && "[&_th]:group/resize",
                ],
                className,
              )}
              style={{
                width: "100%",
                tableLayout: applyFixedLayout ? "fixed" : "auto",
                // Always clamp the table to its container width. Fixed
                // layout previously set `minWidth = Σ column sizes`,
                // which on a table whose seeded/resized column widths
                // summed wider than the viewport forced a horizontal
                // scrollbar on the wrapper — visible on most tables.
                // Pinning minWidth to 100% keeps the table inside the
                // card: columns redistribute within the visible width
                // (fixed layout still honours each column's relative
                // width, and the resize handles still work — dragging
                // re-proportions columns instead of growing the table
                // off-screen). Cell content truncates per the
                // per-cell `truncate`, so nothing overflows sideways.
                minWidth: "100%",
              }}
            >
              <thead className="relative">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => {
                      const isSortableColumn = sortableColumns.includes(
                        header.column.id,
                      );
                      const ButtonOrDiv = isSortableColumn ? "button" : "div";
                      const isColumnAfterSelect = columnsAfterSelect.has(
                        header.column.id,
                      );

                      return (
                        <th
                          key={header.id}
                          colSpan={header.colSpan}
                          data-column-id={header.column.id}
                          className={cn(
                            tableCellClassName(
                              header.column.id,
                              false,
                              isColumnAfterSelect,
                            ),
                            // Sticky header — keeps the column titles
                            // visible while rows scroll inside the
                            // card. Use `bg-bg-muted` (solid) not
                            // `bg-bg-subtle` (rgba 7% alpha) so
                            // scrolling rows don't bleed through.
                            // z-20 sits above row cells (z-10 below
                            // for the first-row sticky) and above
                            // the pinned-column z-index.
                            "sticky top-0 z-20 group/th",
                            "text-xs font-semibold text-content-muted uppercase tracking-wider bg-bg-muted select-none",
                            getCommonPinningClassNames(
                              header.column,
                              !table.getRowModel().rows.length,
                            ),
                            typeof thClassName === "function"
                              ? thClassName(header.column.id)
                              : thClassName,
                            enableColumnResizing && "relative",
                          )}
                          style={{
                            width: FIXED_UTILITY_COLUMN_IDS.has(
                              header.column.id,
                            )
                              ? getUtilityColumnWidth(
                                  header.column.id,
                                  header.getSize(),
                                )
                              : applyFixedLayout
                                ? header.getSize()
                                : undefined,
                            ...getCommonPinningStyles(header.column),
                          }}
                        >
                          <div
                            className={cn(
                              header.column.id === "select"
                                ? "absolute inset-0 flex items-center justify-center"
                                : "flex items-center justify-between gap-section !pr-0",
                            )}
                          >
                            <ButtonOrDiv
                              className={cn(
                                header.column.id === "select"
                                  ? "flex size-full items-center justify-center"
                                  : "flex items-center gap-tight",
                                // PR-7 — keyboard-focus ring on
                                // sortable column headers. Without
                                // this, Tab through the table header
                                // produced no visible focus state;
                                // sort columns were dead-zones for
                                // keyboard users.
                                isSortableColumn &&
                                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:rounded-sm",
                              )}
                              {...(isSortableColumn && {
                                type: "button",
                                disabled: !isSortableColumn,
                                "aria-label": t("sortByColumn"),
                                onClick: () =>
                                  onSortChange?.({
                                    sortBy: header.column.id,
                                    sortOrder:
                                      sortBy !== header.column.id
                                        ? "desc"
                                        : sortOrder === "asc"
                                          ? "desc"
                                          : "asc",
                                  }),
                              })}
                            >
                              {header.isPlaceholder
                                ? null
                                : (() => {
                                    const headerContent = flexRender(
                                      header.column.columnDef.header,
                                      header.getContext(),
                                    );
                                    const headerTooltip =
                                      header.column.columnDef.meta?.headerTooltip;
                                    // WCAG `empty-table-header`: utility
                                    // columns (chevron / kebab / action
                                    // cluster) render no visible header.
                                    // axe wants screen-reader-visible text
                                    // in the <th>, which `aria-label` on
                                    // the cell alone doesn't satisfy — emit
                                    // an `sr-only` label so the column has
                                    // an accessible name with zero visual
                                    // change. Keyed on the column id (the
                                    // rendered header for these is an empty
                                    // node, so content-sniffing is unreliable
                                    // — `flexRender` of a `() => null` header
                                    // still returns a React element).
                                    const utilityLabel =
                                      UTILITY_HEADER_LABELS[header.column.id];

                                    return (
                                      <HeaderWithTooltip
                                        tooltip={headerTooltip}
                                      >
                                        {headerContent}
                                        {utilityLabel && (
                                          <span className="sr-only">
                                            {utilityLabel}
                                          </span>
                                        )}
                                      </HeaderWithTooltip>
                                    );
                                  })()}
                              {isSortableColumn && (
                                <SortOrder
                                  className={cn(
                                    "h-3 w-3 shrink-0 transition-opacity",
                                    sortBy === header.column.id
                                      ? "opacity-100"
                                      : "opacity-30 group-hover/th:opacity-60",
                                  )}
                                  order={
                                    sortBy === header.column.id
                                      ? sortOrder || "desc"
                                      : null
                                  }
                                />
                              )}
                            </ButtonOrDiv>
                          </div>
                          {enableColumnResizing &&
                            header.column.getCanResize() &&
                            !["select", "menu"].includes(header.column.id) && (
                              <div
                                onMouseDown={header.getResizeHandler()}
                                onTouchStart={header.getResizeHandler()}
                                onClick={(e) => e.stopPropagation()}
                                className={resizingClassName}
                              />
                            )}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => {
                  const props =
                    typeof rowProps === "function" ? rowProps(row) : rowProps;
                  const { className, ...rest } = props || {};

                  return applyFixedLayout ? (
                    <ResizableTableRow
                      key={`${row.id}-${table
                        .getVisibleLeafColumns()
                        .map((col) => col.id)
                        .join(",")}`}
                      row={row}
                      onRowClick={onRowClick}
                      onRowAuxClick={onRowAuxClick}
                      rowProps={props}
                      cellRight={cellRight}
                      tdClassName={tdClassName}
                      table={table}
                      selectionEnabled={selectionEnabled}
                      isSelected={row.getIsSelected()}
                    />
                  ) : (
                    <tr
                      key={row.id}
                      className={cn(
                        "group/row",
                        // Each row is a snap point — combined with
                        // the scroll wrapper's `snap-y
                        // snap-proximity scroll-pt-[37px]`, this
                        // makes rows align cleanly with the bottom
                        // edge of the sticky header instead of
                        // stopping half-row up or down.
                        "snap-start",
                        // R13-PR13 — the brand-coloured 2-px left
                        // edge moved from row-level to the FIRST
                        // non-utility cell in `tableCellClassName`
                        // so it survives the cell's bg-bg-muted
                        // hover paint. Row keeps cursor + colour
                        // transition only.
                        //
                        // R13-PR14 — selection-enabled rows also
                        // get cursor-pointer because click toggles
                        // selection (see onClick below).
                        (onRowClick || selectionEnabled) &&
                          "cursor-pointer select-none transition-colors duration-150 ease-out",
                        table.getRowModel().rows.length > 8 &&
                          row.index === table.getRowModel().rows.length - 1 &&
                          "[&_td]:border-b-0",
                        className,
                      )}
                      // R13-PR14 — single click toggles selection.
                      // See ResizableTableRow above for the full
                      // single-vs-double-click semantics comment.
                      onClick={
                        selectionEnabled
                          ? (e) => {
                              if (isClickOnInteractiveChild(e)) return;
                              row.toggleSelected();
                            }
                          : // Selection off → single click runs the row
                            // action (mirrors ResizableTableRow above).
                            onRowClick
                            ? (e) => {
                                if (isClickOnInteractiveChild(e)) return;
                                onRowClick(row, e);
                              }
                            : undefined
                      }
                      // Keyboard — same contract as ResizableTableRow above.
                      // BOTH row renderers need it: `applyFixedLayout` picks
                      // between them, and this non-resizable branch is the one
                      // most list pages actually take, so wiring only the
                      // other would have left the fix invisible everywhere it
                      // mattered. (It did — the rendered test caught it.)
                      tabIndex={onRowClick ? 0 : undefined}
                      onKeyDown={
                        onRowClick
                          ? (e) => {
                              if (e.key !== "Enter" && e.key !== " ") return;
                              if (e.target !== e.currentTarget) return;
                              e.preventDefault();
                              onRowClick(
                                row,
                                e as unknown as MouseEvent<HTMLTableRowElement>,
                              );
                            }
                          : undefined
                      }
                      onDoubleClick={
                        selectionEnabled && onRowClick
                          ? (e) => {
                              if (isClickOnInteractiveChild(e)) return;
                              onRowClick(row, e);
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
                      data-selected={row.getIsSelected()}
                      {...rest}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const isUtilityColumn = ["select", "menu"].includes(
                          cell.column.id,
                        );
                        const isSelectColumn = cell.column.id === "select";
                        const isColumnAfterSelect = columnsAfterSelect.has(
                          cell.column.id,
                        );
                        const disableTruncate =
                          !!cell.column.columnDef.meta?.disableTruncate;

                        return (
                          <td
                            key={cell.id}
                            className={cn(
                              tableCellClassName(
                                cell.column.id,
                                !!onRowClick,
                                isColumnAfterSelect,
                                cell.column.id === firstContentColumnId,
                              ),
                              "text-content-default group",
                              getCommonPinningClassNames(
                                cell.column,
                                row.index ===
                                  table.getRowModel().rows.length - 1,
                              ),
                              typeof tdClassName === "function"
                                ? tdClassName(cell.column.id, row)
                                : tdClassName,
                            )}
                            style={{
                              minWidth: cell.column.columnDef.minSize,
                              maxWidth: cell.column.columnDef.maxSize,
                              width: FIXED_UTILITY_COLUMN_IDS.has(
                                cell.column.id,
                              )
                                ? getUtilityColumnWidth(
                                    cell.column.id,
                                    cell.column.getSize(),
                                  )
                                : enableColumnResizing
                                  ? cell.column.columnDef.size
                                  : "auto",
                              ...getCommonPinningStyles(cell.column),
                            }}
                          >
                            {isSelectColumn ? (
                              <div className="absolute inset-0 flex items-center justify-center">
                                {flexRender(
                                  cell.column.columnDef.cell,
                                  cell.getContext(),
                                )}
                              </div>
                            ) : (
                              <div
                                className={cn(
                                  "flex items-center",
                                  isUtilityColumn
                                    ? "justify-center"
                                    : "w-full justify-between",
                                  !isUtilityColumn &&
                                    (disableTruncate
                                      ? "overflow-visible"
                                      : "overflow-hidden truncate"),
                                )}
                              >
                                <div
                                  className={cn(
                                    disableTruncate
                                      ? "whitespace-nowrap"
                                      : "truncate",
                                    isUtilityColumn
                                      ? "shrink-0"
                                      : "min-w-0 shrink grow",
                                    disableTruncate &&
                                      !isUtilityColumn &&
                                      "min-w-max shrink-0",
                                  )}
                                >
                                  {flexRender(
                                    cell.column.columnDef.cell,
                                    cell.getContext(),
                                  )}
                                </div>
                                {!isUtilityColumn && cellRight?.(cell)}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {children}
          </div>
        </>
      ) : (
        <div
          className={cn(
            // flex-1 + min-h-96: fills the card when the parent is
            // a flex column (fillBody mode) so the message is in
            // the vertical centre of the WHOLE card, not stuck in
            // the upper 384px. min-h-96 keeps the legacy
            // empty-state height as a floor in non-fillBody mode.
            // text-center handles multi-line empty messages.
            "text-content-muted flex flex-1 min-h-96 w-full items-center justify-center text-center text-sm",
            emptyWrapperClassName,
          )}
        >
          {/* PR-8 — error fallback now renders as <ErrorState> when no
              custom empty/error JSX is supplied. The previous plain-
              text rendering meant a failed fetch surfaced as a tiny
              muted line; users had to guess that the page was broken
              vs. genuinely empty. With <ErrorState> the failure has
              an alert role + icon + clear messaging. emptyState (if
              passed) still wins so consumers can render their own
              shape. */}
          {error ? (
            typeof error === "string" ? (
              <ErrorState description={error} />
            ) : (
              error
            )
          ) : (
            emptyState ||
            t("emptyItems", { resource: resourceName?.(true) ?? t("items") })
          )}
        </div>
      )}
      {pagination && !error && !!data?.length && !!rowCount && (
        <div className="border-border-subtle bg-bg-default text-content-default sticky bottom-0 z-10 mx-auto -mt-px flex w-full max-w-full items-center justify-between rounded-b-[inherit] border-t px-4 py-3.5 text-sm leading-6 before:pointer-events-none before:absolute before:bottom-full before:left-0 before:right-0 before:h-6 before:bg-gradient-to-t before:from-bg-default before:to-transparent">
          <div>
            <span className="hidden sm:inline-block">{t("pagination.viewing")}</span>{" "}
            <span className="font-medium">
              {(
                (pagination.pageIndex - 1) * pagination.pageSize +
                1
              ).toLocaleString()}
              -
              {Math.min(
                (pagination.pageIndex - 1) * pagination.pageSize +
                  pagination.pageSize,
                table.getRowCount(),
              ).toLocaleString()}
            </span>{" "}
            {t("pagination.of")}{" "}
            <As href={paginationAllRowsHref ?? "#"} className="font-medium">
              {table.getRowCount().toLocaleString()}{" "}
              {resourceName?.(table.getRowCount() !== 1) || t("pagination.items")}
            </As>
          </div>
          <div className="flex items-center gap-tight">
            <Button
              variant="secondary"
              text={t("pagination.previous")}
              className="h-7 px-2"
              onClick={() => table.previousPage()}
              // disabled={!table.getCanPreviousPage()}
              disabled={pagination.pageIndex === 1}
            />
            <Button
              variant="secondary"
              text={t("pagination.next")}
              className="h-7 px-2"
              onClick={() => table.nextPage()}
              // disabled={!table.getCanNextPage()}
              disabled={pagination.pageIndex === table.getPageCount()}
            />
          </div>
        </div>
      )}

      {/* Loading overlay */}
      <AnimatePresence>
        {loading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-bg-page/70 absolute inset-0 h-full rounded-lg"
          >
            {/* here we're using min(75%,75vh) to ensure proper placement on full height vs partial height tables */}
            <div className="flex h-[min(75%,75vh)] w-full items-center justify-center">
              <LoadingSpinner />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const getCommonPinningClassNames = (
  column: Column<any>,
  isLastRow: boolean,
): string => {
  const isPinned = column.getIsPinned();
  return cn(
    isPinned && "bg-bg-default py-0",
    isPinned &&
      !isLastRow &&
      "animate-table-pinned-shadow [animation-timeline:scroll(inline)]",
  );
};

const getCommonPinningStyles = (column: Column<any>): CSSProperties => {
  const isPinned = column.getIsPinned();

  return {
    left: isPinned === "left" ? `${column.getStart("left")}px` : undefined,
    right: isPinned === "right" ? `${column.getAfter("right")}px` : undefined,
    // Pinned columns need `position: sticky` for horizontal pinning.
    // Non-pinned cells: omit the inline position so the className
    // wins — `sticky top-0` on thead cells stays effective. Setting
    // `position: relative` here would override the className and
    // break the sticky table header.
    position: isPinned ? "sticky" : undefined,
  };
};

// Component to wrap header content with optional tooltip
function HeaderWithTooltip({
  children,
  tooltip,
}: {
  children: ReactNode;
  tooltip?: string;
}) {
  if (!tooltip) {
    return <>{children}</>;
  }

  return (
    <Tooltip content={tooltip}>
      <span className="cursor-help underline decoration-dotted underline-offset-2">
        {children}
      </span>
    </Tooltip>
  );
}
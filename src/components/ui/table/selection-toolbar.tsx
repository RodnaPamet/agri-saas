"use client";

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { cn } from "./table-utils";
import { Table } from "@tanstack/react-table";
import { useTranslations } from "next-intl";
import {
  ButtonHTMLAttributes,
  forwardRef,
  ReactNode,
  useEffect,
  useState,
} from "react";
import { Checkbox } from "../checkbox";
import { useKeyboardShortcut } from "../hooks/use-keyboard-shortcut";
import { DynamicTooltipWrapper, Tooltip } from "../tooltip";

// ── Batch Action Types ──────────────────────────────────────────────

/**
 * Describes a single batch action that can be plugged into the SelectionToolbar.
 *
 * Usage:
 *   const actions: BatchAction<Practice>[] = [
 *     {
 *       label: "Export",
 *       icon: <Download className="size-3.5" />,
 *       onClick: (rows) => exportPractices(rows.map(r => r.original)),
 *     },
 *     {
 *       label: "Archive",
 *       icon: <Archive className="size-3.5" />,
 *       onClick: (rows) => archivePractices(rows.map(r => r.original.id)),
 *       variant: "danger",
 *     },
 *   ];
 */
export interface BatchAction<T> {
  /** Human-readable label for the button. */
  label: string;

  /** Optional icon rendered before the label. */
  icon?: ReactNode;

  /** Callback receiving the currently selected rows. */
  onClick: (selectedRows: import("@tanstack/react-table").Row<T>[]) => void;

  /** Visual variant — danger adds a red/destructive style. */
  variant?: "default" | "danger";

  /** Whether this action is currently disabled. */
  disabled?: boolean;

  /** Optional tooltip text shown when hovering the button. */
  title?: string;
}

// ── BatchActionButton ───────────────────────────────────────────────

/**
 * Styled button for use inside the SelectionToolbar.
 * Matches Inflect's dark-theme design tokens and provides default + danger variants.
 *
 * Can be used standalone or generated from BatchAction[] via renderBatchActions.
 */
export interface BatchActionButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "danger";
  icon?: ReactNode;
}

export const BatchActionButton = forwardRef<
  HTMLButtonElement,
  BatchActionButtonProps
>(({ variant = "default", icon, className, children, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:pointer-events-none disabled:opacity-50",
      variant === "default" &&
        "bg-bg-elevated text-content-emphasis hover:bg-bg-muted active:bg-bg-subtle border border-border-subtle",
      variant === "danger" &&
        "bg-bg-error text-content-error hover:bg-bg-error/80 active:bg-bg-error/60",
      className,
    )}
    {...props}
  >
    {icon && <span className="shrink-0">{icon}</span>}
    {children}
  </button>
));

BatchActionButton.displayName = "BatchActionButton";

// ── renderBatchActions helper ───────────────────────────────────────

/**
 * Converts a BatchAction[] into a (table) => ReactNode callback
 * suitable for the `selectionControls` prop of DataTable.
 *
 * Usage:
 *   <DataTable
 *     selectionControls={renderBatchActions(myActions)}
 *     ...
 *   />
 */
export function renderBatchActions<T>(
  actions: BatchAction<T>[],
): (table: Table<T>) => ReactNode {
  // This returns a render function for DataTable's `batchActions` slot,
  // not a React component — ESLint's display-name heuristic misfires on
  // factories that return JSX-producing functions.
  // eslint-disable-next-line react/display-name
  return (table: Table<T>) => {
    const selectedRows = table.getSelectedRowModel().rows;
    return (
      <>
        {actions.map((action) => (
          <DynamicTooltipWrapper
            key={action.label}
            tooltipProps={action.title ? { content: action.title } : undefined}
          >
            <BatchActionButton
              variant={action.variant}
              icon={action.icon}
              disabled={action.disabled}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick(selectedRows);
              }}
            >
              {action.label}
            </BatchActionButton>
          </DynamicTooltipWrapper>
        ))}
      </>
    );
  };
}

// ── SelectionToolbar ────────────────────────────────────────────────

export function SelectionToolbar<T>({
  table,
  practices,
  className,
}: {
  table: Table<T>;
  practices?: (table: Table<T>) => ReactNode;
  className?: string;
}) {
  const t = useTranslations("ui.table");
  const selectedCount = table.getSelectedRowModel().rows.length;
  const totalCount = table.getRowModel().rows.length;
  const [lastSelectedCount, setLastSelectedCount] = useState(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selectedCount !== 0) setLastSelectedCount(selectedCount);
  }, [selectedCount]);

  // Epic 57 — Escape clears the current row selection. Priority 2 so
  // this beats the filter-list clear (priority 1) when both are
  // active; both remain below any open overlay's native Escape (our
  // global-scope hook is skipped while a modal/sheet is mounted).
  useKeyboardShortcut("Escape", () => table.resetRowSelection(), {
    enabled: selectedCount > 0,
    priority: 2,
    scope: "global",
    description: "Clear selection",
  });

  return (
    <div
      className={cn(
        // UI-23: a thin brand-coloured lower border marks the active action
        // row — `--brand-default` resolves to orange (light) / yellow (dark)
        // per theme. 1px (`border-b`) keeps it a hairline accent.
        "w-full border-b border-[var(--brand-default)] bg-bg-elevated",
        "transition-opacity duration-100",
        selectedCount > 0
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0",
        className,
      )}
      // React 18 doesn't recognise `inert` as a known boolean attribute,
      // so passing a JSX boolean triggers the "non-boolean attribute"
      // warning. Conditionally spread the attribute: present (empty
      // string) when active, omitted otherwise. HTML treats any present
      // `inert` attribute as truthy.
      {...(selectedCount === 0
          ? ({ inert: "" } as Record<string, string>)
          : {})}
      role="toolbar"
      aria-label={t("batchActions")}
      data-testid="selection-toolbar"
    >
      {/* B1 (2026-06-07): the bar matches the column-header row height
          (~37px) so it pops over it cleanly — was h-11 (45px incl. border),
          which overhung the header by ~8px. */}
      <div className="flex h-9 items-center pr-2">
        {/* Select-all / indeterminate checkbox */}
        <div className="relative flex h-full w-12 shrink-0 items-center justify-center">
          <Tooltip
            content={
              table.getIsAllRowsSelected()
                ? t("deselectAll")
                : t("selectAllCount", { count: totalCount })
            }
          >
            {/* NB: <div>, not <button>. Radix Checkbox inside renders
                its own <button>, so a <button> wrapper causes the
                "<button> cannot be a descendant of <button>" hydration
                mismatch.
                GAP-CI-77: role="presentation" so the labelled inner
                Checkbox is the canonical button. role="button" here
                created a button-name violation because axe inspected
                both layers. */}
            <div
              role="presentation"
              tabIndex={-1}
              className="absolute inset-0 flex cursor-pointer items-center justify-center"
              onClick={(e) => {
                e.stopPropagation();
                table.toggleAllRowsSelected();
              }}
            >
              <Checkbox
                aria-label={
                  table.getIsAllRowsSelected()
                    ? t("deselectAllRows")
                    : t("selectAllRows")
                }
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
          </Tooltip>
        </div>

        {/* Count + actions */}
        <div className="flex min-w-0 items-center gap-2.5 pl-1">
          <span
            className={cn(
              "text-content-emphasis text-sm font-medium tabular-nums transition-transform duration-150",
              selectedCount > 0 ? "translate-x-0" : "-translate-x-1",
            )}
          >
            {t("selectedCount", { count: lastSelectedCount })}
          </span>

          {/* Separator between count and actions */}
          <div
            className={cn(
              "bg-border-emphasis h-4 w-px transition-opacity duration-150",
              selectedCount > 0 ? "opacity-100" : "opacity-0",
            )}
          />

          {/* Clear selection button */}
          <Tooltip content={t("clearSelection")} shortcut="Esc">
          <button
            type="button"
            className={cn(
              "text-content-muted hover:text-content-emphasis text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded px-1",
            )}
            onClick={(e) => {
              e.stopPropagation();
              table.resetRowSelection();
            }}
            aria-label={t("clearSelection")}
          >
            {t("clear")}
          </button>
          </Tooltip>

          {/* Pluggable batch action buttons */}
          <div
            className={cn(
              "flex items-center gap-1.5 transition-transform duration-150",
              selectedCount > 0 ? "translate-x-0" : "-translate-x-1",
            )}
          >
            {practices?.(table)}
          </div>
        </div>
      </div>
    </div>
  );
}

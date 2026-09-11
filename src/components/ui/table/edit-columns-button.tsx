"use client";

/**
 * EditColumnsButton — popover UI for toggling column visibility.
 *
 * Features:
 * - Lists all hideable columns with toggle checkboxes
 * - "Reset to defaults" action
 * - Keyboard-navigable via cmdk
 * - Respects `enableHiding: false` on columns
 * - Shows column header text or falls back to column ID
 *
 * Usage:
 *   <EditColumnsButton table={table} />
 *   <EditColumnsButton table={table} onReset={() => setVisibility(defaults)} />
 */

import { cn } from "./table-utils";
import { Table } from "@tanstack/react-table";
import { useTranslations } from "next-intl";
import { Command } from "cmdk";
import { RotateCcw, Settings } from "lucide-react";
import { useState } from "react";
import { Button } from "../button";
import { Popover } from "../popover";
import { ScrollContainer } from "../scroll-container";

// ── Types ───────────────────────────────────────────────────────────

export interface EditColumnsButtonProps<T> {
  /** The TanStack table instance. */
  table: Table<T>;

  /** Callback to reset column visibility to defaults. */
  onReset?: () => void;

  /** Optional className for the trigger button. */
  className?: string;

  /** Optional tooltip text for the trigger. */
  title?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract a human-readable label from a column definition.
 * Prefers the `header` property if it's a string, falls back to the column ID.
 */
function getColumnLabel(column: { id: string; columnDef: { header?: unknown } }): string {
  const header = column.columnDef.header;
  if (typeof header === "string" && header.length > 0) return header;
  // Capitalize & humanize the column ID as fallback
  return column.id
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

// ── Component ───────────────────────────────────────────────────────

export function EditColumnsButton<T>({
  table,
  onReset,
  className,
  title: titleProp,
}: EditColumnsButtonProps<T>) {
  const t = useTranslations("ui.table");
  const title = titleProp ?? t("editColumns");
  const [isOpen, setIsOpen] = useState(false);

  const hideableColumns = table.getAllColumns().filter((c) => c.getCanHide());
  const someHidden = hideableColumns.some((c) => !c.getIsVisible());

  return (
    <Popover
      openPopover={isOpen}
      setOpenPopover={setIsOpen}
      content={
        <ScrollContainer className="max-h-[50svh]">
          <Command tabIndex={0} loop>
            <Command.List className="flex w-screen flex-col gap-0.5 p-1 text-sm focus-visible:outline-none sm:w-auto sm:min-w-[180px]">
              {hideableColumns.map((column) => (
                <Command.Item
                  key={column.id}
                  className={cn(
                    "flex cursor-pointer select-none items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-1.5",
                    "text-content-default hover:text-content-emphasis",
                    "data-[selected=true]:bg-bg-muted",
                  )}
                  onSelect={() => column.toggleVisibility()}
                  data-testid={`column-toggle-${column.id}`}
                >
                  <div
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                      column.getIsVisible()
                        ? "border-[var(--brand-default)] bg-[var(--brand-emphasis)] text-content-inverted"
                        : "border-border-emphasis bg-transparent",
                    )}
                  >
                    {column.getIsVisible() && (
                      <svg
                        className="h-3 w-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </div>
                  <span className="truncate">{getColumnLabel(column)}</span>
                </Command.Item>
              ))}

              {/* Reset to defaults */}
              {onReset && someHidden && (
                <>
                  <div className="bg-border-subtle my-1 h-px" />
                  <Command.Item
                    className={cn(
                      "flex cursor-pointer select-none items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-1.5",
                      "text-content-muted hover:text-content-emphasis",
                      "data-[selected=true]:bg-bg-muted",
                    )}
                    onSelect={() => {
                      onReset();
                      setIsOpen(false);
                    }}
                    data-testid="column-reset"
                  >
                    <RotateCcw className="h-3.5 w-3.5 shrink-0" />
                    <span>{t("resetToDefaults")}</span>
                  </Command.Item>
                </>
              )}
            </Command.List>
          </Command>
        </ScrollContainer>
      }
      align="end"
      triggerTooltip={title}
    >
      {/* Edit columns trigger. The canonical hover hint is the Popover's
          `triggerTooltip` — it composes <Tooltip> + Popover.Trigger on this
          one Button (Radix Slot merges the open click with the hover), so the
          tooltip no longer swallows the trigger's injected props. `aria-label`
          provides the screen-reader name. */}
      <Button
        type="button"
        className={cn(
          "size-8 shrink-0 whitespace-nowrap rounded-[8px] p-0",
          someHidden && "ring-[var(--brand-default)]/30 ring-1",
          className,
        )}
        variant="secondary"
        icon={<Settings className="h-4 w-4 shrink-0" />}
        aria-label={title}
        data-testid="edit-columns-button"
      />
    </Popover>
  );
}

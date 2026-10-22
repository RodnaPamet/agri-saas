"use client";

/**
 * MobileCardList — the phone (<sm) fallback for <DataTable mobileFallback="card">.
 *
 * A horizontally-scrolling table is unusable on a 390px phone. This
 * renders each row as a full-width, tappable CARD instead: a title, an
 * optional subtitle, an optional status pill (top-right), and a few
 * key/value "meta" rows — then the whole card taps through to the row's
 * detail via the table's existing `onRowClick`.
 *
 * The card is NOT a second column config. It reuses the SAME TanStack
 * column cell renderers (so status pills, formatted dates, etc. carry
 * over verbatim) and is driven entirely by `column.meta.mobileCard`:
 *
 *   meta: { mobileCard: { slot: 'title' } }                 // heading
 *   meta: { mobileCard: { slot: 'status' } }                // pill, top-right
 *   meta: { mobileCard: { slot: 'subtitle' } }              // secondary line
 *   meta: { mobileCard: { slot: 'meta', label: 'Due' } }    // key/value row
 *
 * Columns with no `mobileCard` meta (select, actions, dense numeric
 * columns) are simply omitted from the card — keep the card to the 3–4
 * fields that matter in the field.
 *
 * Cells tagged for the card MUST render display-only content (text,
 * status pill, formatted value) — the whole card is the tap target, so a
 * nested link/button would be an interactive-in-interactive a11y trap.
 */
import {
  flexRender,
  type Cell,
  type Row,
  type RowData,
  type Table as TableType,
} from "@tanstack/react-table";
import type { MouseEvent, ReactNode } from "react";
import { ChevronRight } from "@/components/ui/icons/nucleo/chevron-right";
import { useTranslations } from "next-intl";
import { cn } from "./table-utils";
import { SwipeRow } from "../swipe-row";

// ── Column-meta augmentation ────────────────────────────────────────
// Adds the `mobileCard` slot descriptor to every TanStack column's
// `meta`. Global augmentation — importing this module (DataTable does)
// makes the typed `meta.mobileCard` available everywhere.
declare module "@tanstack/react-table" {
  // The generic signature must match TanStack's own `ColumnMeta<TData, TValue>`
  // for the augmentation to merge; the params are unused by this member.
  interface ColumnMeta<TData extends RowData, TValue> {
    /**
     * Placement of this column inside the mobile (<sm) fallback card.
     * Absent ⇒ the column is omitted from the card.
     */
    mobileCard?: {
      /**
       * - `title`    — the card heading (first match wins).
       * - `subtitle` — a secondary line under the title.
       * - `status`   — a status pill anchored top-right (first match wins).
       * - `meta`     — a key/value detail row (any number, in column order).
       * - `actions`  — a row-action affordance (e.g. a kebab menu),
       *                rendered as a right-aligned footer (first match wins).
       */
      slot: "title" | "subtitle" | "status" | "meta" | "actions";
      /** Label for a `meta` row's key. Falls back to the column's string header. */
      label?: string;
      /**
       * `meta` slot only: skip the whole key/value row (label included) when the
       * column's value is empty (null / undefined / ""), so an unset optional
       * field doesn't render an orphaned label. Requires the column to expose a
       * value (accessorKey / accessorFn).
       */
      hideWhenEmpty?: boolean;
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function cardSlot<T>(cell: Cell<T, unknown>) {
  return cell.column.columnDef.meta?.mobileCard?.slot;
}

/** Best-effort label for a `meta` row: explicit meta label → string header → "". */
function metaLabel<T>(cell: Cell<T, unknown>): string {
  const explicit = cell.column.columnDef.meta?.mobileCard?.label;
  if (explicit) return explicit;
  const header = cell.column.columnDef.header;
  return typeof header === "string" ? header : "";
}

// ── Component ───────────────────────────────────────────────────────

export interface MobileCardListProps<T> {
  table: TableType<T>;
  onRowClick?: (row: Row<T>, e: MouseEvent) => void;
  loading?: boolean;
  error?: string;
  emptyState?: ReactNode;
  /** Extra classes on the outer <ul>/state wrapper (e.g. `sm:hidden`). */
  className?: string;
  /**
   * Per-row swipe-to-act, opt-in (#2175). Return `null` for a row that must
   * not be swipeable — the card then renders exactly as before, with no
   * wrapper and no hidden button.
   *
   * A FUNCTION of the row rather than a flag, because eligibility is per row
   * and not per table: on the journal a treatment the caller did not record
   * carries `mayDelete: false`, and offering a control that 403s is worse than
   * an absent one.
   *
   * The returned `onAction` owns the undo window and the write —
   * `<SwipeRow>` commits nothing. See Epic 67.
   */
  swipeAction?: (row: Row<T>) => { label: string; icon?: ReactNode; onAction: () => void } | null;
}

export function MobileCardList<T>({
  table,
  onRowClick,
  loading,
  error,
  emptyState,
  className,
  swipeAction,
}: MobileCardListProps<T>) {
  const t = useTranslations("ui.table");
  const rows = table.getRowModel().rows;

  if (error) {
    return (
      <div
        role="alert"
        className={cn(
          "rounded-lg border border-border-error bg-bg-error px-4 py-3 text-sm text-content-error",
          className,
        )}
      >
        {error}
      </div>
    );
  }

  if (loading && rows.length === 0) {
    return (
      <ul className={cn("space-y-default", className)} aria-busy="true">
        {Array.from({ length: 3 }).map((_, i) => (
          <li
            key={i}
            className="h-20 animate-pulse rounded-lg border border-border-subtle bg-bg-subtle"
          />
        ))}
      </ul>
    );
  }

  if (rows.length === 0) {
    return (
      <div className={className}>
        {emptyState ?? (
          <p className="px-4 py-8 text-center text-sm text-content-muted">
            {t("emptyResults")}
          </p>
        )}
      </div>
    );
  }

  return (
    <ul
      className={cn("space-y-default", className)}
      id="mobile-card-list"
    >
      {rows.map((row) => {
        const cells = row.getVisibleCells();
        const titleCell = cells.find((c) => cardSlot(c) === "title");
        const statusCell = cells.find((c) => cardSlot(c) === "status");
        const subtitleCell = cells.find((c) => cardSlot(c) === "subtitle");
        const metaCells = cells.filter((c) => {
          if (cardSlot(c) !== "meta") return false;
          // Drop an optional field's row (label + value) when it's empty.
          if (c.column.columnDef.meta?.mobileCard?.hideWhenEmpty) {
            const v = c.getValue();
            if (v === null || v === undefined || v === "") return false;
          }
          return true;
        });
        const actionsCell = cells.find((c) => cardSlot(c) === "actions");
        const clickable = !!onRowClick;

        const swipe = swipeAction?.(row) ?? null;

        return (
          <li key={row.id}>
            {swipe ? (
              <SwipeRow
                actionLabel={swipe.label}
                actionIcon={swipe.icon}
                onAction={swipe.onAction}
              >
                {renderCard()}
              </SwipeRow>
            ) : (
              renderCard()
            )}
          </li>
        );

        // Extracted so the card markup is written ONCE and rendered either
        // bare or inside <SwipeRow>. A conditional wrapper around a duplicated
        // body is how the two copies drift.
        function renderCard() {
          /* Card a11y mirrors the desktop DataTable row: the card's
                onClick is a MOUSE convenience only, and the nested
                title <Link> (Tasks/Journal/Locations embed a
                same-destination <Link>) is the keyboard + assistive-tech
                affordance. The card is deliberately NOT role="button":
                a role="button" wrapping a nested <a> is a WCAG
                nested-interactive violation (axe 4.1.2) and would also
                duplicate the link's action for AT users. Rows whose
                title carries no <Link> match the desktop table's own
                mouse-only row-click model. Non-clickable rows (no detail
                route) render a plain, non-interactive card. */

          return (
            <div
              onClick={clickable ? (e) => onRowClick!(row, e) : undefined}
              className={cn(
                "flex w-full flex-col gap-tight rounded-lg border border-border-default bg-bg-default p-4 text-left",
                clickable
                  ? "min-h-[44px] cursor-pointer transition-colors hover:bg-bg-muted active:bg-bg-muted"
                  : "",
              )}
            >
              <div className="flex items-start justify-between gap-default">
                <div className="min-w-0 break-words font-medium text-content-emphasis">
                  {titleCell
                    ? flexRender(
                        titleCell.column.columnDef.cell,
                        titleCell.getContext(),
                      )
                    : null}
                </div>
                {/* Right rail: status pill + (for rows that navigate) a
                    chevron that signals "this card taps through to detail".
                    The chevron only renders on clickable cards so a
                    non-navigating card (e.g. the farm-tasks field queue)
                    doesn't imply a destination it doesn't have. */}
                {statusCell || clickable ? (
                  <div className="flex shrink-0 items-center gap-tight">
                    {statusCell ? (
                      <div className="shrink-0">
                        {flexRender(
                          statusCell.column.columnDef.cell,
                          statusCell.getContext(),
                        )}
                      </div>
                    ) : null}
                    {clickable ? (
                      <ChevronRight
                        className="h-4 w-4 shrink-0 text-content-subtle"
                        aria-hidden="true"
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>

              {subtitleCell ? (
                <div className="min-w-0 break-words text-sm text-content-muted">
                  {flexRender(
                    subtitleCell.column.columnDef.cell,
                    subtitleCell.getContext(),
                  )}
                </div>
              ) : null}

              {metaCells.length > 0 ? (
                <dl className="mt-tight space-y-tight">
                  {metaCells.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-baseline justify-between gap-default text-sm"
                    >
                      <dt className="shrink-0 text-content-subtle">
                        {metaLabel(c)}
                      </dt>
                      <dd className="min-w-0 break-words text-right text-content-default">
                        {flexRender(c.column.columnDef.cell, c.getContext())}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {/* Row actions (e.g. a kebab menu) — a right-aligned footer.
                  The card itself may be clickable (onRowClick); the action
                  affordance stops propagation so a tap on it never triggers
                  the row navigation. */}
              {actionsCell ? (
                <div
                  className="mt-tight flex justify-end"
                  onClick={(e) => e.stopPropagation()}
                >
                  {flexRender(
                    actionsCell.column.columnDef.cell,
                    actionsCell.getContext(),
                  )}
                </div>
              ) : null}
            </div>
          );
        }
      })}
    </ul>
  );
}

export default MobileCardList;

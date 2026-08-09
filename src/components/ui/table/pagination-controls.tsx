"use client";

/**
 * PaginationControls — reusable footer pagination for all entity list pages.
 *
 * Renders a "Viewing X–Y of Z items" label with Previous/Next buttons.
 * Can be used standalone or automatically rendered by the DataTable.
 *
 * Usage (standalone):
 *   <PaginationControls
 *     page={page}
 *     pageSize={25}
 *     totalCount={243}
 *     onPageChange={(p) => setPage(p)}
 *     resourceName={(p) => p ? "practices" : "practice"}
 *   />
 *
 * Usage (within DataTable):
 *   <DataTable pagination={pagination} rowCount={243} ... />
 *   // PaginationControls is rendered automatically in the table footer.
 */

import { cn } from "./table-utils";
import { Button } from "../button";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  getPageRange,
  getPaginationState,
  type PaginationMeta,
} from "./pagination-utils";

// ── Props ───────────────────────────────────────────────────────────

export interface PaginationControlsProps {
  /** Current page (1-based). */
  page: number;

  /** Items per page. */
  pageSize: number;

  /** Total item count across all pages. */
  totalCount: number;

  /** Callback when the page changes. */
  onPageChange: (page: number) => void;

  /** Human-readable resource name (e.g., "practices"). */
  resourceName?: (plural: boolean) => string;

  /** Optional URL to link the total count to (e.g., "view all"). */
  allRowsHref?: string;

  /** Additional className for the outer container. */
  className?: string;
}

// ── Component ───────────────────────────────────────────────────────

export function PaginationControls({
  page,
  pageSize,
  totalCount,
  onPageChange,
  resourceName,
  allRowsHref,
  className,
}: PaginationControlsProps) {
  const t = useTranslations("ui.table.pagination");
  const meta: PaginationMeta = { page, pageSize, totalCount };
  const state = getPaginationState(meta);

  // Don't render pagination for empty or single-page results
  if (state.isEmpty || state.isSinglePage) return null;

  const range = getPageRange(meta);
  const As = allRowsHref ? Link : "span";

  return (
    <div
      className={cn(
        "border-border-subtle bg-bg-default text-content-default",
        "sticky bottom-0 z-10 mx-auto -mt-px flex w-full max-w-full",
        // PR-7 — `before:` pseudo-element renders a 24-px gradient
        // fade ABOVE the sticky footer so the last visible row never
        // butts directly against the footer's top edge during a
        // scroll. The gradient goes from transparent to bg-default
        // so it visually merges into the footer's solid background
        // and gives the row underneath a soft scroll-fade indicator.
        "before:pointer-events-none before:absolute before:bottom-full before:left-0 before:right-0 before:h-6 before:bg-gradient-to-t before:from-bg-default before:to-transparent",
        "items-center justify-between rounded-b-[inherit] border-t",
        "px-4 py-3.5 text-sm leading-6",
        className,
      )}
      role="navigation"
      aria-label={t("label")}
      data-testid="pagination-controls"
    >
      {/* Range info: "Viewing 1–25 of 243 practices" */}
      <div>
        <span className="hidden sm:inline-block">{t("viewing")}</span>{" "}
        <span className="font-medium">
          {range.from.toLocaleString()}–{range.to.toLocaleString()}
        </span>{" "}
        {t("of")}{" "}
        <As
          href={allRowsHref ?? "#"}
          className={cn("font-medium", allRowsHref && "hover:underline")}
        >
          {range.total.toLocaleString()}{" "}
          {resourceName?.(range.total !== 1) ?? t("items")}
        </As>
      </div>

      {/* Navigation buttons */}
      <div className="flex items-center gap-tight">
        <Button
          variant="secondary"
          text={t("previous")}
          className="h-7 px-2"
          onClick={() => onPageChange(page - 1)}
          disabled={!state.canPreviousPage}
          aria-label={t("previousPage")}
        />
        <Button
          variant="secondary"
          text={t("next")}
          className="h-7 px-2"
          onClick={() => onPageChange(page + 1)}
          disabled={!state.canNextPage}
          aria-label={t("nextPage")}
        />
      </div>
    </div>
  );
}

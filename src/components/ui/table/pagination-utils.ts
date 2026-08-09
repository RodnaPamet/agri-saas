/**
 * Pagination utilities — pure functions for computing pagination state.
 *
 * These are framework-agnostic and can be used by both the pagination hook
 * and the PaginationControls component. They are also fully testable without
 * any React or DOM dependency.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface PaginationMeta {
  /** Current page index (1-based). */
  page: number;

  /** Number of items per page. */
  pageSize: number;

  /** Total number of items across all pages. */
  totalCount: number;
}

export interface PaginationRange {
  /** First item shown on the current page (1-based, inclusive). */
  from: number;

  /** Last item shown on the current page (1-based, inclusive). */
  to: number;

  /** Total number of items. */
  total: number;
}

export interface PaginationState {
  /** Total number of pages. */
  pageCount: number;

  /** Whether there is a previous page. */
  canPreviousPage: boolean;

  /** Whether there is a next page. */
  canNextPage: boolean;

  /** The range of items shown on the current page. */
  range: PaginationRange;

  /** Whether this is the first page. */
  isFirstPage: boolean;

  /** Whether this is the last page. */
  isLastPage: boolean;

  /** Whether there is only one page total. */
  isSinglePage: boolean;

  /** Whether there are zero items total. */
  isEmpty: boolean;
}

// ── Constants ───────────────────────────────────────────────────────

/** Default page sizes available in the page-size selector. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

/** Default page size used when none is specified. */
export const DEFAULT_PAGE_SIZE = 25;

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Compute the total number of pages given item count and page size.
 */
export function getPageCount(totalCount: number, pageSize: number): number {
  if (totalCount <= 0 || pageSize <= 0) return 0;
  return Math.ceil(totalCount / pageSize);
}

/**
 * Compute the range of items shown on a given page (1-indexed).
 *
 * Example: page=2, pageSize=25, totalCount=60
 *   → { from: 26, to: 50, total: 60 }
 */
export function getPageRange(meta: PaginationMeta): PaginationRange {
  const { page, pageSize, totalCount } = meta;
  if (totalCount <= 0 || pageSize <= 0) {
    return { from: 0, to: 0, total: 0 };
  }

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);

  return { from, to, total: totalCount };
}

/**
 * Compute the full pagination state from pagination metadata.
 * This is the primary function used by PaginationControls.
 */
export function getPaginationState(meta: PaginationMeta): PaginationState {
  const pageCount = getPageCount(meta.totalCount, meta.pageSize);
  const range = getPageRange(meta);
  const isEmpty = meta.totalCount <= 0;
  const isFirstPage = meta.page <= 1;
  const isLastPage = meta.page >= pageCount;

  return {
    pageCount,
    canPreviousPage: !isFirstPage,
    canNextPage: !isLastPage && !isEmpty,
    range,
    isFirstPage,
    isLastPage,
    isSinglePage: pageCount <= 1,
    isEmpty,
  };
}

/**
 * Clamp a page number to valid bounds.
 */
export function clampPage(page: number, pageCount: number): number {
  if (pageCount <= 0) return 1;
  return Math.max(1, Math.min(page, pageCount));
}

/**
 * Format the "Viewing X–Y of Z items" string.
 */
export function formatPageRange(
  range: PaginationRange,
  resourceName?: (plural: boolean) => string,
): string {
  if (range.total <= 0) return "";
  const label = resourceName?.(range.total !== 1) ?? "items";
  return `${range.from.toLocaleString()}–${range.to.toLocaleString()} of ${range.total.toLocaleString()} ${label}`;
}

/**
 * Pure decision helpers backing `FilterSelect`.
 *
 * Separated from `filter-select.tsx` so the branching logic is unit-testable
 * under the node-env jest runner (tsconfig `jsx: "preserve"` blocks requiring
 * a `.tsx` file at runtime). Keep these functions React-free and side-effect
 * free — the component composes state around them.
 *
 * Internal module: consumed by `filter-select.tsx`, not exposed from the
 * barrel. Adding these to the public API would duplicate work that
 * `useFilterContext` already performs at the page level.
 */

import { isValidElement, type ReactNode } from "react";
import type { ActiveFilterInput, Filter, FilterOption } from "./types";
import { isRangeType, normalizeActiveFilter } from "./types";

// ─── single-select decision ──────────────────────────────────────────

/**
 * A filter is single-select when either:
 *  - its definition explicitly sets `singleSelect: true`, OR
 *  - the picker isn't in advanced mode *and* the filter isn't marked
 *    `multiple: true`.
 *
 * `isAdvancedFilter` is FilterSelect's page-level toggle for expert UX — in
 * that mode every non-explicitly-single-select filter becomes multi-select so
 * power users can stack `IS`/`IS_NOT` operators.
 */
export function isSingleSelect(
  filter: Pick<Filter, "singleSelect" | "multiple"> | null | undefined,
  opts: { isAdvancedFilter?: boolean } = {},
): boolean {
  if (!filter) return false;
  if (filter.singleSelect) return true;
  return !opts.isAdvancedFilter && !filter.multiple;
}

// ─── per-filter empty-state resolution ───────────────────────────────

/**
 * Type guard: distinguishes a `Record<filterKey, ReactNode>` override map
 * from a single shared `ReactNode` empty-state. Uses React's `isValidElement`
 * so that legitimate element objects don't accidentally read as records.
 */
export function isEmptyStateObject(
  emptyState: ReactNode | Record<string, ReactNode>,
): emptyState is Record<string, ReactNode> {
  return (
    typeof emptyState === "object" &&
    emptyState !== null &&
    !isValidElement(emptyState)
  );
}

/**
 * Resolve the empty state for the currently-drilled-in filter, falling back
 * to the shared empty state when no per-key override applies. Callers
 * typically pass `selectedFilterKey ?? "default"`.
 */
export function resolveEmptyStateFor(
  emptyState: ReactNode | Record<string, ReactNode> | undefined,
  selectedFilterKey: string | null,
  fallback: ReactNode = "No matching options",
): ReactNode {
  if (!emptyState) return fallback;
  if (isEmptyStateObject(emptyState)) {
    const key = selectedFilterKey ?? "default";
    return emptyState[key] ?? fallback;
  }
  return emptyState;
}

// ─── option membership ──────────────────────────────────────────────

/**
 * Is `value` currently one of the selected values for `key` in `activeFilters`?
 * Uses `normalizeActiveFilter` so legacy `{ key, value }` / `{ key, values }`
 * shapes work without the caller converting first.
 */
export function isOptionSelectedIn(
  activeFilters: ActiveFilterInput[] | undefined,
  key: string,
  value: FilterOption["value"],
): boolean {
  if (!activeFilters) return false;
  const raw = activeFilters.find((f) => f.key === key);
  if (!raw) return false;
  return normalizeActiveFilter(raw).values.includes(value);
}

// ─── range helpers ──────────────────────────────────────────────────

/**
 * Which sides of a `"lo|hi"` token carry a value.
 *
 * Deliberately SHAPE-based rather than numeric. Both `range` and `dateRange`
 * facets store this token, and `"2026-08-01"` is not a number — running the
 * numeric parser over a date token yields `NaN` on both sides, which would
 * report a fully-applied date window as "no filter applied" and hide the
 * panel's Clear button for every date facet. The question these helpers ask
 * ("is there a bound here?") is answerable from the token's shape alone, so
 * it is asked there.
 */
function appliedRangeSides(token: string | undefined | null): {
  lo: boolean;
  hi: boolean;
} {
  if (!token) return { lo: false, hi: false };
  const [a = "", b = ""] = String(token).split("|");
  return { lo: a.trim() !== "", hi: b.trim() !== "" };
}

/**
 * Does the given range token represent at least one applied bound?
 * The sentinel `"|"` (both ends blank) returns false; `"30|"` / `"|70"` /
 * `"30|70"` / `"2026-08-01|2026-08-12"` return true.
 */
export function hasAppliedRange(token: string | undefined | null): boolean {
  const { lo, hi } = appliedRangeSides(token);
  return lo || hi;
}

/**
 * Are BOTH bounds applied? Drives the Escape-key behaviour: a complete
 * window means the user is done, so Escape closes the whole filter popover
 * rather than stepping back to the facet list.
 */
export function rangeTokenIsComplete(token: string | undefined | null): boolean {
  const { lo, hi } = appliedRangeSides(token);
  return lo && hi;
}

/**
 * Extract the currently-applied range token for a filter, if any.
 * Returns `undefined` when the filter isn't token-valued, isn't in active
 * state, or has no values. `normalizeActiveFilter` handles legacy shapes.
 *
 * Both `range` and `dateRange` store ONE `"lo|hi"` token, so the gate asks
 * `isRangeType` rather than naming either literal — a third token-shaped
 * kind would otherwise have to find and edit this line by hand.
 */
export function activeRangeTokenFor(
  filter: Pick<Filter, "type" | "key"> | null | undefined,
  activeFilters: ActiveFilterInput[] | undefined,
): string | undefined {
  if (!filter || !isRangeType(filter.type) || !activeFilters) return undefined;
  const raw = activeFilters.find((f) => f.key === filter.key);
  if (!raw) return undefined;
  const [first] = normalizeActiveFilter(raw).values;
  return typeof first === "string" ? first : undefined;
}

/**
 * Filter module — enterprise-grade, reusable filter system.
 *
 * Public API:
 *   Filter.Select  — the command-palette filter picker
 *   Filter.List    — active filter pills with remove/operator practices
 *
 * State management:
 *   useFilterContext / FilterProvider / useFilters
 *
 * Definitions:
 *   createFilterDefs / optionsFromEnum / optionsFromArray
 *
 * Pure state functions:
 *   parseUrlToFilterState / filterStateToUrlParams / etc.
 */

import { FilterList } from "./filter-list";
import { FilterSelect } from "./filter-select";

const Filter = { Select: FilterSelect, List: FilterList };

// ── Components ──
export { Filter };

// ── Types ──
export type {
  ActiveFilter,
  ActiveFilterInput,
  Filter as FilterType,
  FilterOption,
  FilterOperator,
  FilterResetBehavior,
  FilterValueCodec,
  PersistableFilterValue,
  TypedActiveFilter,
  TypedFilterOption,
} from "./types";
export { encodeRangeToken, normalizeActiveFilter, parseRangeToken } from "./types";

// ── State Management ──
export type { FilterState, FilterUrlConfig } from "./filter-state";
export {
  activeFiltersToFilterState,
  addFilterValue,
  clearAllFilters,
  countActiveFilterKeys,
  countActiveFilters,
  extractFilterOptions,
  filterStateToActiveFilters,
  filterStateToUrlParams,
  fromCompactFilterState,
  hasActiveFilters,
  isFilterActive,
  isValueSelected,
  parseUrlToFilterState,
  removeFilter,
  removeFilterValue,
  setFilterValue,
  toCompactFilterState,
  toggleFilterValue,
} from "./filter-state";

// ── Definitions ──
export type { FilterDef, FilterDefInput } from "./filter-definitions";
export {
  booleanCodec,
  codecForExampleValue,
  createFilterDefs,
  createTypedFilterDefs,
  numberCodec,
  optionsFromArray,
  optionsFromEnum,
  stringCodec,
  typedOptionsFromEnum,
} from "./filter-definitions";

// ── Context & Hooks ──
export type { FilterContextValue, UseFilterContextOptions } from "./filter-context";
export { FilterProvider, useFilterContext, useFilters } from "./filter-context";

// ── Presets (saved views) ──
export type {
  UseFilterPresetsOptions,
  UseFilterPresetsResult,
} from "./use-filter-presets";
export { useFilterPresets } from "./use-filter-presets";

// R-filter-gear (2026-06-07) — the "Edit filter cards" gear.
export { EditFiltersButton } from "./edit-filters-button";
export type { EditFiltersButtonProps } from "./edit-filters-button";
export {
  useFilterCardVisibility,
  filtersToCards,
  selectVisibleFilters,
} from "./use-filter-card-visibility";
export type {
  CardDefinition,
  CardKind,
  UseFilterCardVisibilityOptions,
  UseFilterCardVisibilityResult,
} from "./use-filter-card-visibility";

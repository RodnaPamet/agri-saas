// FilterOperator — first-party (formerly re-exported from the Dub utility shim).
type FilterOperator = 'IS' | 'IS_NOT' | 'IS_ONE_OF' | 'IS_NOT_ONE_OF';
import { LucideIcon } from "lucide-react";
import { ComponentType, ReactNode, SVGProps } from "react";

type FilterIcon =
  | LucideIcon
  | ReactNode
  | ComponentType<SVGProps<SVGSVGElement>>;

export type { FilterOperator };

/**
 * Reset behavior of a filter when the user clears all filters or returns to
 * a list page's "default" view.
 *
 * - `clearable` (default): removed on `clearAllFilters` / "Reset" — the normal case.
 * - `sticky`: survives `clearAllFilters`; used for view modes a user has opted
 *   into (e.g. "archived shown") that the product wants to keep between resets.
 * - `resetsToDefault`: removed from URL state, but the UI should re-apply a
 *   documented default value. Distinct from `clearable` so page authors can
 *   distinguish "no filter" from "default filter".
 */
export type FilterResetBehavior = "clearable" | "sticky" | "resetsToDefault";

export type Filter = {
  key: string;
  icon: FilterIcon;
  label: string;
  labelPlural?: string; // Plural form of the label (optional, defaults to pluralize(label))
  /** Optional short help text for accessible descriptions / tooltips. */
  description?: string;
  /** Optional group label for sectioning filters in dropdowns (e.g. "Attributes", "Timeline"). */
  group?: string;
  /** How `clearAllFilters` and "Reset" treat this filter. Default: `clearable`. */
  resetBehavior?: FilterResetBehavior;
  options: FilterOption[] | null;
  /** When set to `range`, `FilterSelect` renders min/max practices instead of option list. */
  type?: "default" | "range";
  /** Format a bound in storage units (e.g. cents) for display. */
  formatRangeBound?: (n: number) => string;
  /** Parse typed input into storage units. Return NaN if invalid. */
  parseRangeInput?: (raw: string) => number;
  /**
   * For `type: "range"`: divide stored values by this for the number input (e.g. `100` when storage is cents).
   * Defaults to `1` (storage shown as-is).
   */
  rangeDisplayScale?: number;
  /**
   * `step` on the min/max number inputs. Defaults to `1` when `rangeDisplayScale` is 1, else `0.01`.
   */
  rangeNumberStep?: number;
  /** Full pill label for active range token (used by `Filter.List`). */
  formatRangePillLabel?: (token: string) => string;
  hideInFilterDropdown?: boolean; // Hide in Filter.Select dropdown
  shouldFilter?: boolean; // Disable filtering for this filter
  separatorAfter?: boolean; // Add a separator after the filter in Filter.Select dropdown
  multiple?: boolean; // Allow multiple selection of values
  hideMultipleIcons?: boolean; // Hide multiple "stacked icons" view for the filter (fallback to icon display)
  singleSelect?: boolean; // Force single-select behavior even if multiSelect is enabled globally
  hideOperator?: boolean; // Hide the operator dropdown (is/is not) even when multiple is enabled
  getOptionIcon?: (
    value: FilterOption["value"],
    props: { key: Filter["key"]; option?: FilterOption },
  ) => FilterIcon | null;
  getOptionLabel?: (
    value: FilterOption["value"],
    props: { key: Filter["key"]; option?: FilterOption },
  ) => string | null;
  getOptionPermalink?: (value: FilterOption["value"]) => string | null;
};

export type FilterOption = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- filter option values are heterogeneous (string | number | object) across all filter types; `unknown` would require casts at every consumer
  value: any;
  /** The human-facing label — what users see in the dropdown/pill. */
  label: string;
  /**
   * Optional display override for the active pill. Falls back to `label` when
   * omitted. Use when the pill should read differently from the picker row
   * (e.g. picker: "ACME Inc. — admin@acme.com", pill: "ACME Inc.").
   */
  displayLabel?: string;
  right?: ReactNode;
  icon?: FilterIcon;
  hideDuringSearch?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- arbitrary per-option metadata bag; shape varies by filter type
  data?: Record<string, any>;
  permalink?: string;
};

/**
 * The set of primitive value shapes that can round-trip through a URL param.
 * Any filter value encoded to the URL must flatten to one of these — complex
 * values must provide their own `encode`/`decode` pair.
 */
export type PersistableFilterValue = string | number | boolean;

/**
 * Encode a filter value into its URL-safe string form and back.
 *
 * Scalar filters (enum/status, entity-ref ID) use the identity codec.
 * Range filters use `encodeRangeToken` / `parseRangeToken`.
 * Future boolean/date filters should export their own codec here rather than
 * each page re-implementing parse logic.
 */
export interface FilterValueCodec<V> {
  /** Persisted URL form. */
  encode: (value: V) => string;
  /** Parse URL form back into the typed value. `null` signals unparseable. */
  decode: (raw: string) => V | null;
}

/**
 * A strongly typed option, where the underlying value is narrowed to `V`
 * instead of `any`. Existing components consume the loose `FilterOption`;
 * page authors building new filters should prefer `TypedFilterOption<V>`
 * and let the adapter coerce to `FilterOption` at the component boundary.
 */
export type TypedFilterOption<V> = Omit<FilterOption, "value"> & {
  value: V;
};

export type ActiveFilter = {
  key: Filter["key"];
  values: FilterOption["value"][];
  operator: FilterOperator;
};

/**
 * Strongly typed active-filter form, parameterised by the filter key literal
 * `K` and the value type `V`. Use inside generic helpers / hooks that want to
 * statically assert which filter they're dealing with.
 */
export type TypedActiveFilter<K extends string, V> = {
  key: K;
  values: V[];
  operator: FilterOperator;
};

export type LegacyActiveFilterSingular = {
  key: Filter["key"];
  value: FilterOption["value"];
};

export type LegacyActiveFilterPlural = {
  key: Filter["key"];
  values: FilterOption["value"][];
};

export type ActiveFilterInput =
  | ActiveFilter
  | LegacyActiveFilterSingular
  | LegacyActiveFilterPlural;

/**
 * Normalize active filter to the new format with operator support
 * Handles backward compatibility with legacy formats:
 * - { key, value } → { key, values: [value], operator: 'IS' }
 * - { key, values } → { key, values, operator: 'IS' or 'IS_ONE_OF' }
 * - { key, values, operator } → unchanged (already correct)
 */
export function normalizeActiveFilter(filter: ActiveFilterInput): ActiveFilter {
  if ("operator" in filter && filter.operator && Array.isArray(filter.values)) {
    return filter as ActiveFilter;
  }

  if ("value" in filter && !("values" in filter)) {
    return {
      key: filter.key,
      operator: "IS" as FilterOperator,
      values: [filter.value],
    };
  }

  if (
    "values" in filter && Array.isArray((filter as LegacyActiveFilterPlural).values) &&
    (!("operator" in filter) || !filter.operator)
  ) {
    const values = (filter as LegacyActiveFilterPlural).values;
    return {
      key: filter.key,
      operator: values.length > 1 ? "IS_ONE_OF" : "IS",
      values: values,
    };
  }

  return {
    key: filter.key,
    operator: "IS",
    values: [],
  };
}

export function parseRangeToken(token: string | undefined | null): {
  min?: number;
  max?: number;
} {
  if (token == null || token === "|") {
    return {};
  }
  const [a, b] = token.split("|");
  const min = a === "" ? undefined : Number(a);
  const max = b === "" ? undefined : Number(b);
  return {
    ...(Number.isFinite(min) ? { min } : {}),
    ...(Number.isFinite(max) ? { max } : {}),
  };
}

export function encodeRangeToken(
  min?: number | null,
  max?: number | null,
): string {
  const l = min == null || !Number.isFinite(min) ? "" : String(Math.trunc(min));
  const r = max == null || !Number.isFinite(max) ? "" : String(Math.trunc(max));
  if (!l && !r) {
    return "|";
  }
  return `${l}|${r}`;
}

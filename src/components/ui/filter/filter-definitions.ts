/**
 * Filter Definitions — typed helpers for creating filter configurations.
 *
 * The `createFilterDef` helper provides type inference for defining
 * entity-specific filter configurations that work with both the enterprise
 * Filter.Select/Filter.List components and the URL state system.
 *
 * Usage:
 *   const practiceFilters = createFilterDefs<Practice>({
 *     status: {
 *       label: "Status",
 *       icon: CircleDot,
 *       options: [
 *         { value: "OPEN", label: "Open" },
 *         { value: "CLOSED", label: "Closed" },
 *       ],
 *     },
 *     category: {
 *       label: "Category",
 *       icon: Tag,
 *       multiple: true,
 *       options: [
 *         { value: "Technical", label: "Technical" },
 *       ],
 *     },
 *   });
 */

import { LucideIcon } from "lucide-react";
import type {
  Filter,
  FilterKind,
  FilterOption,
  FilterResetBehavior,
  FilterValueCodec,
  PersistableFilterValue,
  TypedFilterOption,
} from "./types";

// ── Types ───────────────────────────────────────────────────────────

/**
 * Simplified filter definition input. Less verbose than the full Filter type,
 * with sensible defaults for common patterns.
 */
export interface FilterDefInput {
  /** Display label. */
  label: string;
  /** Plural form (auto-derived if omitted). */
  labelPlural?: string;
  /** Optional short help text for accessible descriptions / tooltips. */
  description?: string;
  /** Optional group label for sectioning filters in the picker (e.g. "Attributes", "Timeline"). */
  group?: string;
  /** Clear/reset behavior. Default: `clearable`. */
  resetBehavior?: FilterResetBehavior;
  /** Lucide icon component. */
  icon: LucideIcon;
  /** Filter options. Pass `null` for async-loaded options. */
  options: FilterOption[] | null;
  /** Filter type. Default: "default". See `Filter["type"]`. */
  type?: FilterKind;
  /** Allow multiple selection. Default: false. */
  multiple?: boolean;
  /** Force single selection even in advanced mode. */
  singleSelect?: boolean;
  /** Hide the IS/IS_NOT operator toggle. */
  hideOperator?: boolean;
  /** Add a visual separator after this filter in the dropdown. */
  separatorAfter?: boolean;
  /** Disable cmdk's built-in filtering (for externally filtered options). */
  shouldFilter?: boolean;
  /** URL param key override (defaults to the definition key). */
  paramKey?: string;

  // Range-specific
  formatRangeBound?: (n: number) => string;
  parseRangeInput?: (raw: string) => number;
  rangeDisplayScale?: number;
  rangeNumberStep?: number;
  formatRangePillLabel?: (token: string) => string;
}

/**
 * A fully resolved filter definition, extending Filter with metadata.
 */
export interface FilterDef extends Filter {
  /** The URL parameter key for this filter. */
  paramKey: string;
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a set of typed filter definitions from a configuration object.
 *
 * @typeParam T - The entity type these filters apply to (for documentation/tooling).
 * @param defs - Object where keys are filter identifiers and values are FilterDefInput.
 * @returns An object with:
 *   - `filters`: Filter[] array for passing to Filter.Select
 *   - `filterKeys`: string[] of all URL param keys
 *   - `getFilter(key)`: lookup a single FilterDef by key
 *   - `defs`: the original keyed definitions
 */
export function createFilterDefs<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _T = any,
>(
  defs: Record<string, FilterDefInput>,
): {
  /** Filter[] for passing to Filter.Select / Filter.List. */
  filters: FilterDef[];
  /** All URL param keys managed by these filters. */
  filterKeys: string[];
  /** Lookup a FilterDef by key. */
  getFilter: (key: string) => FilterDef | undefined;
  /** The raw keyed definitions. */
  defs: Record<string, FilterDef>;
} {
  const resolved: Record<string, FilterDef> = {};

  for (const [key, input] of Object.entries(defs)) {
    resolved[key] = {
      key,
      paramKey: input.paramKey ?? key,
      label: input.label,
      labelPlural: input.labelPlural,
      description: input.description,
      group: input.group,
      resetBehavior: input.resetBehavior,
      icon: input.icon,
      options: input.options,
      type: input.type ?? "default",
      multiple: input.multiple ?? false,
      singleSelect: input.singleSelect,
      hideOperator: input.hideOperator,
      separatorAfter: input.separatorAfter,
      shouldFilter: input.shouldFilter,
      formatRangeBound: input.formatRangeBound,
      parseRangeInput: input.parseRangeInput,
      rangeDisplayScale: input.rangeDisplayScale,
      rangeNumberStep: input.rangeNumberStep,
      formatRangePillLabel: input.formatRangePillLabel,
    };
  }

  const filters = Object.values(resolved);
  const filterKeys = filters.map((f) => f.paramKey);

  return {
    filters,
    filterKeys,
    getFilter: (key: string) => resolved[key],
    defs: resolved,
  };
}

// ── Option Builders ─────────────────────────────────────────────────

/**
 * Create options from an enum-like record.
 *
 * @param enumObj - Record of value → label.
 * @param icon - Optional icon for each option.
 *
 * Usage:
 *   optionsFromEnum({ OPEN: "Open", CLOSED: "Closed" })
 */
export function optionsFromEnum(
  enumObj: Record<string, string>,
  icon?: LucideIcon,
): FilterOption[] {
  return Object.entries(enumObj).map(([value, label]) => ({
    value,
    label,
    ...(icon ? { icon } : {}),
  }));
}

/**
 * Create options from a string array.
 *
 * Usage:
 *   optionsFromArray(["Technical", "Operational", "Compliance"])
 */
export function optionsFromArray(values: string[]): FilterOption[] {
  return values.map((value) => ({ value, label: value }));
}

// ── Typed factory (literal-narrowed keys) ───────────────────────────

/**
 * Strictly typed variant of {@link createFilterDefs}. The keys of `defs` are
 * captured as a literal string union `K`, so downstream consumers
 * (`filter-state.FilterState`, page-level hooks, `useFilters()` consumers) can
 * narrow on a specific filter rather than any `string`.
 *
 * Prefer this factory for new list pages. The existing `createFilterDefs` is
 * kept for legacy call sites that rely on its loose `Record<string, …>` shape.
 *
 * Usage:
 *   const defs = createTypedFilterDefs<Practice>()({
 *     status:   { label: "Status",   icon: CircleDot, options: STATUS_OPTIONS },
 *     severity: { label: "Severity", icon: Flag,      options: SEV_OPTIONS    },
 *   });
 *   defs.getFilter("status");   // OK (typed)
 *   defs.getFilter("nonesuch"); // compile-time error
 */
export function createTypedFilterDefs<_T = unknown>(): <
  D extends Record<string, FilterDefInput>,
>(
  defs: D,
) => {
  /** Filter[] for passing to Filter.Select / Filter.List. */
  filters: FilterDef[];
  /** All URL param keys managed by these filters, narrowed to the literal union. */
  filterKeys: Array<keyof D & string>;
  /** Lookup a FilterDef by key — key is literal-narrowed. */
  getFilter: <K extends keyof D & string>(key: K) => FilterDef;
  /** The raw keyed definitions — record type preserved. */
  defs: { [P in keyof D & string]: FilterDef };
} {
  return (defs) => {
    const loose = createFilterDefs<unknown>(defs);
    return {
      filters: loose.filters,
      filterKeys: loose.filterKeys as Array<keyof typeof defs & string>,
      // Safe: `loose.getFilter` is nullable, but typed API guarantees the key
      // belongs to `defs`, so we can assert presence at runtime.
      getFilter: (key) => {
        const result = loose.getFilter(key);
        if (!result) {
          throw new Error(`createTypedFilterDefs: unknown filter key "${key}"`);
        }
        return result;
      },
      defs: loose.defs as { [P in keyof typeof defs & string]: FilterDef },
    };
  };
}

// ── Codecs for URL serialisation ────────────────────────────────────

/**
 * Identity codec for values already persistable as strings (enum values,
 * entity IDs). This is what the pure filter-state module already assumes.
 */
export const stringCodec: FilterValueCodec<string> = {
  encode: (value) => value,
  decode: (raw) => raw,
};

/**
 * Codec for numeric filter values (scores, counts). Rejects NaN.
 */
export const numberCodec: FilterValueCodec<number> = {
  encode: (value) => String(value),
  decode: (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  },
};

/**
 * Codec for boolean toggle filters (e.g. `onlyMine=true`).
 * Accepts `"1" | "0" | "true" | "false"` on decode; emits `"true" | "false"` on encode
 * so URLs stay readable.
 */
export const booleanCodec: FilterValueCodec<boolean> = {
  encode: (value) => (value ? "true" : "false"),
  decode: (raw) => {
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
    return null;
  },
};

/**
 * Return the right codec for a `PersistableFilterValue` example. Useful when
 * a helper knows the value shape at runtime but not at the type level.
 */
export function codecForExampleValue<V extends PersistableFilterValue>(
  example: V,
): FilterValueCodec<V> {
  switch (typeof example) {
    case "string":
      return stringCodec as unknown as FilterValueCodec<V>;
    case "number":
      return numberCodec as unknown as FilterValueCodec<V>;
    case "boolean":
      return booleanCodec as unknown as FilterValueCodec<V>;
    default:
      throw new Error(
        `codecForExampleValue: no built-in codec for ${typeof example}`,
      );
  }
}

// ── Typed option helpers ────────────────────────────────────────────

/**
 * Build a {@link TypedFilterOption} array from a `Record<V, label>`. Preserves
 * value narrowing so consumers get `V` back instead of `string`.
 */
export function typedOptionsFromEnum<V extends string>(
  enumObj: Record<V, string>,
  icon?: LucideIcon,
): TypedFilterOption<V>[] {
  return (Object.entries(enumObj) as [V, string][]).map(([value, label]) => ({
    value,
    label,
    ...(icon ? { icon } : {}),
  }));
}

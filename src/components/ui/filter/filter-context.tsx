"use client";

/**
 * Filter Context — React context for sharing filter state between
 * the filter bar and DataTable integration.
 *
 * This enables any component in the tree (filter pills, table headers,
 * clear buttons) to read and write filter state without prop drilling.
 *
 * Usage:
 *   // In your page component:
 *   const filterCtx = useFilterContext(practiceFilterDefs, { syncUrl: true });
 *
 *   <FilterProvider value={filterCtx}>
 *     <FilterBar />
 *     <DataTable ... />
 *   </FilterProvider>
 *
 *   // In any child:
 *   const { state, setFilter, clearAll } = useFilters();
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import type { FilterDef } from "./filter-definitions";
import {
  addFilterValue,
  clearAllFilters,
  countActiveFilterKeys,
  type FilterState,
  hasActiveFilters as checkHasActive,
  parseUrlToFilterState,
  removeFilter,
  removeFilterValue,
  setFilterValue,
  toggleFilterValue,
  type FilterUrlConfig,
} from "./filter-state";

// ── Context Value ───────────────────────────────────────────────────

export interface FilterContextValue {
  /** Current filter state. */
  state: FilterState;
  /** All filter definitions. */
  filters: FilterDef[];
  /** All managed filter keys. */
  filterKeys: string[];
  /** Set a single value for a key (replaces). */
  set: (key: string, value: string) => void;
  /** Add a value to a key (preserves existing). */
  add: (key: string, value: string | string[]) => void;
  /** Remove a specific value from a key. */
  remove: (key: string, value: string) => void;
  /** Remove all values for a key. */
  removeAll: (key: string) => void;
  /** Toggle a value (add/remove). */
  toggle: (key: string, value: string) => void;
  /** Clear all filters. */
  clearAll: () => void;
  /** Whether any filters are active. */
  hasActive: boolean;
  /** Number of active filter keys. */
  activeCount: number;
  /** The current search query (separate from filter state). */
  search: string;
  /** Update the search query. */
  setSearch: (q: string) => void;
}

const FilterCtx = createContext<FilterContextValue | null>(null);

// ── Provider ────────────────────────────────────────────────────────

export function FilterProvider({
  value,
  children,
}: {
  value: FilterContextValue;
  children: ReactNode;
}) {
  return <FilterCtx.Provider value={value}>{children}</FilterCtx.Provider>;
}

// ── Consumer Hook ───────────────────────────────────────────────────

/**
 * Access the nearest FilterProvider's value.
 * Throws if used outside a FilterProvider.
 */
export function useFilters(): FilterContextValue {
  const ctx = useContext(FilterCtx);
  if (!ctx) {
    throw new Error("useFilters must be used within a <FilterProvider>");
  }
  return ctx;
}

// ── Factory Hook ────────────────────────────────────────────────────

export interface UseFilterContextOptions {
  /** Sync filter state to URL search params. Default: true. */
  syncUrl?: boolean;
  /** URL serialization config. */
  urlConfig?: FilterUrlConfig;
  /** Initial filter state (overrides URL). */
  initialState?: FilterState;
  /** Server-provided filters for SSR hydration. */
  serverFilters?: Record<string, string>;
}

/**
 * Create a FilterContextValue from filter definitions.
 *
 * This is the primary hook for page-level filter setup. It manages state,
 * URL synchronization, and provides all mutation callbacks.
 *
 * Usage:
 *   const filterCtx = useFilterContext(myFilterDefs.filters, myFilterDefs.filterKeys);
 */
export function useFilterContext(
  filters: FilterDef[],
  filterKeys: string[],
  options: UseFilterContextOptions = {},
): FilterContextValue {
  const { syncUrl = true, urlConfig = {}, initialState, serverFilters } = options;

  const router = useRouter();
  const pathname = usePathname();

  // ── Initialize state ──
  const [state, setState] = useState<FilterState>(() => {
    if (initialState) return initialState;
    if (typeof window === "undefined" && serverFilters) {
      // SSR: parse server-provided flat filters
      const result: FilterState = {};
      const sep = urlConfig.separator ?? ",";
      for (const key of filterKeys) {
        const v = serverFilters[key];
        if (v) result[key] = v.split(sep).filter(Boolean);
      }
      return result;
    }
    if (typeof window !== "undefined") {
      return parseUrlToFilterState(window.location.search, filterKeys, urlConfig);
    }
    return {};
  });

  const [search, setSearchRaw] = useState<string>(() => {
    if (typeof window === "undefined") return serverFilters?.q ?? "";
    return new URLSearchParams(window.location.search).get("q") ?? "";
  });

  const stateRef = useRef(state);
  const searchRef = useRef(search);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    searchRef.current = search;
  }, [search]);

  // ── URL sync ──
  const pushToUrl = useCallback(
    (nextState: FilterState, nextSearch?: string) => {
      if (!syncUrl || typeof window === "undefined") return;
      const params = new URLSearchParams(window.location.search);

      // Remove cursor on filter change
      params.delete("cursor");

      // Sync filter state
      const prefix = urlConfig.prefix ?? "";
      for (const key of filterKeys) {
        params.delete(`${prefix}${key}`);
      }
      const sep = urlConfig.separator ?? ",";
      for (const [key, values] of Object.entries(nextState)) {
        if (values.length > 0) {
          params.set(`${prefix}${key}`, values.join(sep));
        }
      }

      // Sync search
      const q = nextSearch ?? searchRef.current;
      if (q) {
        params.set("q", q);
      } else {
        params.delete("q");
      }

      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [syncUrl, router, pathname, filterKeys, urlConfig],
  );

  // ── Mutations ──
  const set = useCallback(
    (key: string, value: string) => {
      const next = setFilterValue(stateRef.current, key, value);
      stateRef.current = next;
      setState(next);
      pushToUrl(next);
    },
    [pushToUrl],
  );

  const add = useCallback(
    (key: string, value: string | string[]) => {
      const next = addFilterValue(stateRef.current, key, value);
      stateRef.current = next;
      setState(next);
      pushToUrl(next);
    },
    [pushToUrl],
  );

  const remove = useCallback(
    (key: string, value: string) => {
      const next = removeFilterValue(stateRef.current, key, value);
      stateRef.current = next;
      setState(next);
      pushToUrl(next);
    },
    [pushToUrl],
  );

  const removeAllForKey = useCallback(
    (key: string) => {
      const next = removeFilter(stateRef.current, key);
      stateRef.current = next;
      setState(next);
      pushToUrl(next);
    },
    [pushToUrl],
  );

  const toggle = useCallback(
    (key: string, value: string) => {
      const next = toggleFilterValue(stateRef.current, key, value);
      stateRef.current = next;
      setState(next);
      pushToUrl(next);
    },
    [pushToUrl],
  );

  const clearAll = useCallback(() => {
    const next = clearAllFilters();
    stateRef.current = next;
    setState(next);
    setSearchRaw("");
    searchRef.current = "";
    pushToUrl(next, "");
  }, [pushToUrl]);

  const setSearch = useCallback(
    (q: string) => {
      setSearchRaw(q);
      searchRef.current = q;
      pushToUrl(stateRef.current, q);
    },
    [pushToUrl],
  );

  // ── Popstate sync ──
  useEffect(() => {
    if (!syncUrl) return;
    const handlePopState = () => {
      const next = parseUrlToFilterState(window.location.search, filterKeys, urlConfig);
      stateRef.current = next;
      setState(next);
      const q = new URLSearchParams(window.location.search).get("q") ?? "";
      setSearchRaw(q);
      searchRef.current = q;
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [syncUrl, filterKeys, urlConfig]);

  // ── Derived ──
  const hasActive = useMemo(() => checkHasActive(state) || search.length > 0, [state, search]);
  const activeCount = useMemo(() => countActiveFilterKeys(state) + (search ? 1 : 0), [state, search]);

  return useMemo(
    () => ({
      state,
      filters,
      filterKeys,
      set,
      add,
      remove,
      removeAll: removeAllForKey,
      toggle,
      clearAll,
      hasActive,
      activeCount,
      search,
      setSearch,
    }),
    [state, filters, filterKeys, set, add, remove, removeAllForKey, toggle, clearAll, hasActive, activeCount, search, setSearch],
  );
}

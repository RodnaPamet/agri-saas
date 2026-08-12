# Enterprise Filter System — Developer Guide

> **Epic 53** · `src/components/ui/filter/`
> The single source of truth for filter UI, state, and URL synchronization.

## Quick Start — Adding Filters to a List Page

```tsx
// 1. Define filters (in a constants file or inline)
import { createFilterDefs, optionsFromEnum } from '@/components/ui/filter';
import { CircleDot, Tag } from 'lucide-react';

const controlFilterDefs = createFilterDefs<Control>({
  status: {
    label: 'Status',
    icon: CircleDot,
    options: optionsFromEnum({
      NOT_STARTED: 'Not Started',
      IN_PROGRESS: 'In Progress',
      IMPLEMENTED: 'Implemented',
    }),
  },
  category: {
    label: 'Category',
    icon: Tag,
    multiple: true,
    options: optionsFromArray(['Technical', 'Operational', 'Compliance']),
  },
});

// 2. Wire up in your page component
import { useFilterContext, FilterProvider } from '@/components/ui/filter';

export function ControlsClient() {
  const filterCtx = useFilterContext(
    controlFilterDefs.filters,
    controlFilterDefs.filterKeys,
    { syncUrl: true },
  );

  return (
    <FilterProvider value={filterCtx}>
      {/* Filter UI and DataTable go here */}
    </FilterProvider>
  );
}
```

---

## Architecture

```
src/components/ui/filter/
├── index.ts               ← Barrel export (public API)
├── types.ts               ← Core types: Filter, FilterOption, ActiveFilter
├── filter-state.ts        ← Pure state functions (URL ↔ FilterState ↔ ActiveFilter)
├── filter-definitions.ts  ← createFilterDefs<T>, optionsFromEnum, optionsFromArray
├── filter-context.tsx     ← React context + useFilterContext + useFilters
├── filter-select.tsx      ← Filter.Select — command-palette picker (cmdk)
├── filter-list.tsx        ← Filter.List — active filter pills
├── filter-range-panel.tsx ← Numeric range panel (internal)
├── filter-date-range-panel.tsx ← Date range panel (internal)
└── filter-scroll.tsx      ← Scroll container (internal)
```

### Facet kinds (`Filter.type`)

| `type` | Body | Value |
|--------|------|-------|
| `default` (default) | the option list | one or more option values |
| `range` | min/max **number** inputs | ONE `"lo\|hi"` token |
| `dateRange` | a `<Calendar mode="range">` | ONE `"YYYY-MM-DD\|YYYY-MM-DD"` token |

`range` and `dateRange` share the token shape, so URL sync, active-filter
state and the pill treat them alike — but **never test the two literals by
hand**. Ask `isRangeType(filter.type)` from the barrel; a third token-shaped
kind should not require finding four `||`s scattered across the module.

They do **not** share the alphabet of a bound. Running the numeric parser
over a date token yields `NaN` on both sides, which reports a fully applied
window as *no filter at all* — so per-kind validity is decided once, in
`rangeTokenBounds` (`filter-range-utils.ts`), and the shape-only questions
("is a bound set?", "are both set?") live in `filter-select-utils.ts`.

Wiring a date facet is three lines on the definition plus a server parse:

```ts
incurredOn: {
  label: 'Date', icon: CalendarDays, options: null, type: 'dateRange',
}
```

```ts
// route handler — the facet arrives as ONE token
const window = parseDateRangeParam(sp.get('incurredOn'), 'incurredOn');
```

`parseDateRangeParam` (`@/lib/validation/query-params`) validates both
sides, swaps an inverted window, and widens the upper bound to end-of-day —
a `DateTime` column compared against a bare midnight upper bound matches
nothing, which a user reads as "my data is missing".

### Module Responsibilities

| Module | Purpose | Pure? |
|--------|---------|-------|
| `filter-state.ts` | URL parsing, state mutations, compatibility bridges | ✅ Yes |
| `filter-definitions.ts` | Factory for typed filter configs | ✅ Yes |
| `filter-context.tsx` | React context, URL sync hook | ❌ React |
| `filter-select.tsx` | Dropdown command palette | ❌ React |
| `filter-list.tsx` | Active filter pill strip | ❌ React |

---

## Filter Definitions

### `createFilterDefs<T>(defs)`

Creates a strongly-typed filter config from a plain object:

```tsx
const myFilters = createFilterDefs<MyEntity>({
  status: {
    label: 'Status',
    icon: CircleDot,
    options: [{ value: 'OPEN', label: 'Open' }],
  },
});

// Returns:
myFilters.filters     // FilterDef[] for Filter.Select
myFilters.filterKeys  // string[] for useFilterContext
myFilters.getFilter('status') // lookup by key
```

### Option Helpers

```tsx
// From enum-like object
optionsFromEnum({ OPEN: 'Open', CLOSED: 'Closed' })

// From string array
optionsFromArray(['Technical', 'Operational'])

// From API data (dynamic)
extractFilterOptions(data, 'status', (v) => prettifyStatus(v))
```

---

## State Management

### Pure Functions (`filter-state.ts`)

All state functions are pure and return new objects (immutable):

```tsx
import {
  addFilterValue,
  removeFilterValue,
  toggleFilterValue,
  setFilterValue,
  removeFilter,
  clearAllFilters,
} from '@/components/ui/filter';

// Add
addFilterValue(state, 'status', 'OPEN')
addFilterValue(state, 'status', ['OPEN', 'CLOSED'])

// Remove
removeFilterValue(state, 'status', 'OPEN')
removeFilter(state, 'status')       // remove entire key
clearAllFilters()                    // empty state

// Toggle (add if absent, remove if present)
toggleFilterValue(state, 'status', 'OPEN')

// Set (replace all values for a key)
setFilterValue(state, 'status', 'OPEN')
```

### URL Synchronization

```tsx
import {
  parseUrlToFilterState,
  filterStateToUrlParams,
  filterStateToActiveFilters,
} from '@/components/ui/filter';

// URL → state
const state = parseUrlToFilterState(window.location.search, ['status', 'category']);

// State → URL
const params = filterStateToUrlParams(state);

// State → UI (for Filter.Select/Filter.List)
const activeFilters = filterStateToActiveFilters(state);
```

### React Context (`useFilterContext`)

The primary hook for page-level filter setup:

```tsx
const filterCtx = useFilterContext(
  myFilters.filters,
  myFilters.filterKeys,
  {
    syncUrl: true,           // sync to URL (default: true)
    urlConfig: {
      separator: ',',        // multi-value separator
      prefix: '',            // param prefix (e.g., 'f_')
    },
    serverFilters: props.serverFilters, // SSR hydration
  },
);

// Use in children via:
const { state, set, toggle, clearAll, hasActive, search, setSearch } = useFilters();
```

---

## Compatibility with CompactFilterBar

The existing `CompactFilterBar` system (Epic 52) uses flat `Record<string, string>`.
Bridge functions are available:

```tsx
import { fromCompactFilterState, toCompactFilterState } from '@/components/ui/filter';

// CompactFilterBar → FilterState
const state = fromCompactFilterState({ status: 'OPEN', q: 'search' });
// → { status: ['OPEN'], q: ['search'] }

// FilterState → CompactFilterBar
const flat = toCompactFilterState(state);
// → { status: 'OPEN', q: 'search' }
```

---

## DO / DON'T

### ✅ DO

- Import from the barrel: `from '@/components/ui/filter'`
- Use `createFilterDefs` for typed definitions
- Use `useFilterContext` for page-level state
- Use `useFilters()` in child components to access state
- Keep filter configs colocated with their page or in a shared constants file
- Test pure state functions directly (no React needed)

### ❌ DON'T

- Import from internal modules (`filter-range-panel`,
  `filter-date-range-panel`, `filter-scroll`)
- Create ad-hoc filter state management (`useState` + manual URL sync)
- Hardcode entity-specific logic in the shared filter module
- Use raw `URLSearchParams` manipulation for filter state
- Skip the compatibility bridge when mixing with CompactFilterBar pages

---

## Query Helpers

```tsx
import {
  isFilterActive,
  isValueSelected,
  countActiveFilters,
  countActiveFilterKeys,
  hasActiveFilters,
} from '@/components/ui/filter';

isFilterActive(state, 'status')           // boolean
isValueSelected(state, 'status', 'OPEN')  // boolean
countActiveFilters(state)                  // total values across all keys
countActiveFilterKeys(state)              // number of active keys
hasActiveFilters(state)                   // any filters active?
```

---

## Migration Path

### From CompactFilterBar (Epic 52) to Enterprise Filters (Epic 53)

1. Create filter definitions using `createFilterDefs`
2. Replace `useUrlFilters` with `useFilterContext`
3. Replace `<CompactFilterBar>` with `<Filter.Select>` + `<Filter.List>`
4. Test URL sync and filter behavior
5. Remove old config from `src/components/filters/configs.ts`

### Gradual adoption

Pages can be migrated individually. The `fromCompactFilterState` / `toCompactFilterState` bridges
ensure both systems can coexist during the transition.

---

## Testing

- **Pure functions**: test directly without React — see `tests/unit/filter-system.test.ts`
- **Architecture**: tests in `filter-system` / `filter-foundation` / `filter-contracts` /
  `filter-primitives` / `filter-select` cover state mutations, URL roundtrips, compatibility
  bridges, primitive contracts, and the typed filter-def model
- **Integration**: page-level filter behavior tested via E2E specs
- **Regression guard**: `tests/unit/filter-standardization.test.ts` enforces that every
  DataTable-backed list page reaches the shared filter architecture (no stray CompactFilterBar
  usage, every `filter-defs.ts` imports from the concrete sub-modules)

---

## Adding a filter to a new list page

A complete rollout is three files and one component import.

### 1. Define the filter config

Colocate the defs with the page:

```tsx
// src/app/t/[tenantSlug]/(app)/my-entity/filter-defs.ts
import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import { createTypedFilterDefs, optionsFromEnum } from '@/components/ui/filter/filter-definitions';
import { CircleDot } from 'lucide-react';

export const MY_ENTITY_STATUS_LABELS = {
  OPEN: 'Open',
  CLOSED: 'Closed',
} as const;

const STATIC_DEFS = {
  status: {
    label: 'Status',
    description: 'Workflow stage.',
    group: 'Attributes',
    icon: CircleDot,
    options: optionsFromEnum(MY_ENTITY_STATUS_LABELS),
    multiple: true,
    resetBehavior: 'clearable',
  },
} satisfies Record<string, FilterDefInput>;

export const myEntityFilterDefs = createTypedFilterDefs()(STATIC_DEFS);
export const MY_ENTITY_FILTER_KEYS = myEntityFilterDefs.filterKeys;

export function buildMyEntityFilters() {
  // Inject runtime-derived options here (owner lists, category dedupes).
  // For fully-static filters, return the static filter array as-is.
  return myEntityFilterDefs.filters;
}
```

> **Always import from `filter-definitions` / `types` / `filter-state` directly**, not the
> `@/components/ui/filter` barrel. The barrel pulls in `.tsx` components that jest's node env
> cannot load; importing from sub-modules keeps the config file test-friendly.

### 2. Wire the toolbar into the page

Wrap the client island in a `FilterProvider` at the outer boundary, then drop `<FilterToolbar>`
exactly where the old `CompactFilterBar` sat:

```tsx
// src/app/t/[tenantSlug]/(app)/my-entity/MyEntityClient.tsx
'use client';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import { buildMyEntityFilters, MY_ENTITY_FILTER_KEYS } from './filter-defs';

export function MyEntityClient(props) {
  const filterCtx = useFilterContext([], MY_ENTITY_FILTER_KEYS, {
    serverFilters: props.initialFilters,
  });
  return (
    <FilterProvider value={filterCtx}>
      <MyEntityPageInner {...props} />
    </FilterProvider>
  );
}

function MyEntityPageInner({ initialRows, tenantSlug }) {
  const { state, search } = useFilters();
  const fetchParams = useMemo(() => toApiSearchParams(state, { search }), [state, search]);

  const query = useQuery({
    queryKey: queryKeys.myEntity.list(tenantSlug, Object.fromEntries(fetchParams)),
    queryFn: async () => {
      const qs = fetchParams.toString();
      const res = await fetch(`/api/t/${tenantSlug}/my-entity${qs ? `?${qs}` : ''}`);
      return res.json();
    },
    initialData: initialRows,
  });

  const liveFilters = useMemo(() => buildMyEntityFilters(), []);

  return (
    <>
      <FilterToolbar
        filters={liveFilters}
        searchId="my-entity-search"
        searchPlaceholder="Search…"
      />
      <DataTable ... />
    </>
  );
}
```

### 3. URL sync

Nothing to do — `useFilterContext` writes to the URL, `toApiSearchParams` reads state into the
API query. Browser back/forward replays via the context's popstate handler. For non-pass-through
API keys (e.g. a UI range token that the API consumes as `min` + `max`), add a transform:

```tsx
import { rangeSplitTransform } from '@/lib/filters/url-sync';

export const MY_ENTITY_API_TRANSFORMS = {
  score: rangeSplitTransform('scoreMin', 'scoreMax'),
};

// In the page:
const fetchParams = useMemo(
  () => toApiSearchParams(state, { search, transforms: MY_ENTITY_API_TRANSFORMS }),
  [state, search],
);
```

### 4. Server page (optional but preferred)

Widen the `searchParams → filters` ingestion in `page.tsx` so the SSR fetch matches the first
client paint. Keys should be the same as `MY_ENTITY_FILTER_KEYS`. For range filters, split the
UI token into the API pair there too — mirrors what `toApiSearchParams` does on the client.

### 5. Do not

- Do not import `CompactFilterBar` / `useUrlFilters` in a DataTable-backed list page. The
  regression guardrail in `tests/unit/filter-standardization.test.ts` fails the build if any
  tracked page reintroduces them.
- Do not build a bespoke toolbar. Compose `<FilterToolbar>`; if you need a page-specific
  gesture, add it next to the toolbar, not inside it.
- Do not re-export `filter-defs.ts` through a package barrel. Filter defs stay colocated with
  their page so option derivation lives next to the data fetch.

/**
 * Tests for the Epic 53 Enterprise Filter System — foundation layer.
 *
 * Covers:
 * 1. filter-state.ts  — URL ↔ FilterState ↔ ActiveFilter conversion, mutations
 * 2. filter-definitions.ts — createFilterDefs, optionsFromEnum, optionsFromArray
 * 3. Architecture compliance — module structure and barrel exports
 */

import {
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
  activeFiltersToFilterState,
  type FilterState,
} from '../../src/components/ui/filter/filter-state';

import {
  createFilterDefs,
  optionsFromEnum,
  optionsFromArray,
} from '../../src/components/ui/filter/filter-definitions';

import { CircleDot, Tag } from 'lucide-react';

// ─── filter-state.ts: URL ↔ FilterState ──────────────────────────────

describe('parseUrlToFilterState', () => {
  it('parses simple params', () => {
    const params = new URLSearchParams('status=OPEN&category=Technical');
    const state = parseUrlToFilterState(params, ['status', 'category']);
    expect(state).toEqual({
      status: ['OPEN'],
      category: ['Technical'],
    });
  });

  it('parses multi-value params with comma separator', () => {
    const params = new URLSearchParams('status=OPEN,IN_PROGRESS');
    const state = parseUrlToFilterState(params, ['status']);
    expect(state).toEqual({ status: ['OPEN', 'IN_PROGRESS'] });
  });

  it('ignores keys not in filterKeys', () => {
    const params = new URLSearchParams('status=OPEN&cursor=abc');
    const state = parseUrlToFilterState(params, ['status']);
    expect(state).toEqual({ status: ['OPEN'] });
    expect(state).not.toHaveProperty('cursor');
  });

  it('returns empty state for no matching params', () => {
    const params = new URLSearchParams('cursor=abc');
    const state = parseUrlToFilterState(params, ['status']);
    expect(state).toEqual({});
  });

  it('handles string input', () => {
    const state = parseUrlToFilterState('?status=OPEN', ['status']);
    expect(state).toEqual({ status: ['OPEN'] });
  });

  it('supports custom separator', () => {
    const params = new URLSearchParams('status=OPEN|CLOSED');
    const state = parseUrlToFilterState(params, ['status'], { separator: '|' });
    expect(state).toEqual({ status: ['OPEN', 'CLOSED'] });
  });

  it('supports prefix', () => {
    const params = new URLSearchParams('f_status=OPEN');
    const state = parseUrlToFilterState(params, ['status'], { prefix: 'f_' });
    expect(state).toEqual({ status: ['OPEN'] });
  });

  it('filters out empty segments', () => {
    const params = new URLSearchParams('status=OPEN,,CLOSED,');
    const state = parseUrlToFilterState(params, ['status']);
    expect(state).toEqual({ status: ['OPEN', 'CLOSED'] });
  });
});

describe('filterStateToUrlParams', () => {
  it('creates params from state', () => {
    const state: FilterState = { status: ['OPEN'], category: ['Tech'] };
    const params = filterStateToUrlParams(state);
    expect(params.get('status')).toBe('OPEN');
    expect(params.get('category')).toBe('Tech');
  });

  it('joins multi-values with comma', () => {
    const state: FilterState = { status: ['OPEN', 'CLOSED'] };
    const params = filterStateToUrlParams(state);
    expect(params.get('status')).toBe('OPEN,CLOSED');
  });

  it('removes empty keys', () => {
    const state: FilterState = { status: [] };
    const params = filterStateToUrlParams(state);
    expect(params.has('status')).toBe(false);
  });

  it('preserves existing params', () => {
    const existing = new URLSearchParams('cursor=abc&page=2');
    const state: FilterState = { status: ['OPEN'] };
    const params = filterStateToUrlParams(state, {}, existing);
    expect(params.get('cursor')).toBe('abc');
    expect(params.get('status')).toBe('OPEN');
  });

  it('supports custom separator', () => {
    const state: FilterState = { status: ['A', 'B'] };
    const params = filterStateToUrlParams(state, { separator: '|' });
    expect(params.get('status')).toBe('A|B');
  });
});

// ─── filter-state.ts: FilterState ↔ ActiveFilter[] ──────────────────

describe('filterStateToActiveFilters', () => {
  it('converts state to ActiveFilter array', () => {
    const state: FilterState = { status: ['OPEN'] };
    const active = filterStateToActiveFilters(state);
    expect(active).toEqual([
      { key: 'status', values: ['OPEN'], operator: 'IS' },
    ]);
  });

  it('uses IS_ONE_OF for multi-value', () => {
    const state: FilterState = { status: ['OPEN', 'CLOSED'] };
    const active = filterStateToActiveFilters(state);
    expect(active[0].operator).toBe('IS_ONE_OF');
  });

  it('skips empty keys', () => {
    const state: FilterState = { status: [] };
    const active = filterStateToActiveFilters(state);
    expect(active).toEqual([]);
  });
});

describe('activeFiltersToFilterState', () => {
  it('converts ActiveFilter array back to state', () => {
    const active = [
      { key: 'status', values: ['OPEN', 'CLOSED'], operator: 'IS_ONE_OF' as const },
    ];
    const state = activeFiltersToFilterState(active);
    expect(state).toEqual({ status: ['OPEN', 'CLOSED'] });
  });

  it('handles empty values', () => {
    const active = [
      { key: 'status', values: [] as string[], operator: 'IS' as const },
    ];
    const state = activeFiltersToFilterState(active);
    expect(state).toEqual({});
  });
});

// ─── filter-state.ts: Mutations ─────────────────────────────────────

describe('addFilterValue', () => {
  it('adds a new value to empty state', () => {
    const state = addFilterValue({}, 'status', 'OPEN');
    expect(state).toEqual({ status: ['OPEN'] });
  });

  it('adds to existing values', () => {
    const state = addFilterValue({ status: ['OPEN'] }, 'status', 'CLOSED');
    expect(state).toEqual({ status: ['OPEN', 'CLOSED'] });
  });

  it('deduplicates values', () => {
    const state = addFilterValue({ status: ['OPEN'] }, 'status', 'OPEN');
    expect(state).toEqual({ status: ['OPEN'] });
  });

  it('supports array input', () => {
    const state = addFilterValue({}, 'status', ['OPEN', 'CLOSED']);
    expect(state).toEqual({ status: ['OPEN', 'CLOSED'] });
  });

  it('does not mutate original state', () => {
    const original: FilterState = { status: ['OPEN'] };
    const next = addFilterValue(original, 'status', 'CLOSED');
    expect(original.status).toEqual(['OPEN']);
    expect(next.status).toEqual(['OPEN', 'CLOSED']);
  });
});

describe('removeFilterValue', () => {
  it('removes a value', () => {
    const state = removeFilterValue({ status: ['OPEN', 'CLOSED'] }, 'status', 'OPEN');
    expect(state).toEqual({ status: ['CLOSED'] });
  });

  it('removes key when last value removed', () => {
    const state = removeFilterValue({ status: ['OPEN'] }, 'status', 'OPEN');
    expect(state).not.toHaveProperty('status');
  });

  it('handles removing non-existent value', () => {
    const state = removeFilterValue({ status: ['OPEN'] }, 'status', 'CLOSED');
    expect(state).toEqual({ status: ['OPEN'] });
  });
});

describe('removeFilter', () => {
  it('removes entire key', () => {
    const state = removeFilter({ status: ['OPEN'], category: ['Tech'] }, 'status');
    expect(state).toEqual({ category: ['Tech'] });
  });

  it('handles removing non-existent key', () => {
    const state = removeFilter({ status: ['OPEN'] }, 'category');
    expect(state).toEqual({ status: ['OPEN'] });
  });
});

describe('clearAllFilters', () => {
  it('returns empty object', () => {
    expect(clearAllFilters()).toEqual({});
  });
});

describe('toggleFilterValue', () => {
  it('adds value if not present', () => {
    const state = toggleFilterValue({}, 'status', 'OPEN');
    expect(state).toEqual({ status: ['OPEN'] });
  });

  it('removes value if present', () => {
    const state = toggleFilterValue({ status: ['OPEN'] }, 'status', 'OPEN');
    expect(state).not.toHaveProperty('status');
  });
});

describe('setFilterValue', () => {
  it('sets single value (replaces)', () => {
    const state = setFilterValue({ status: ['OPEN', 'CLOSED'] }, 'status', 'DRAFT');
    expect(state).toEqual({ status: ['DRAFT'] });
  });

  it('removes key for empty value', () => {
    const state = setFilterValue({ status: ['OPEN'] }, 'status', '');
    expect(state).not.toHaveProperty('status');
  });
});

// ─── filter-state.ts: Queries ───────────────────────────────────────

describe('isFilterActive', () => {
  it('returns true for active filter', () => {
    expect(isFilterActive({ status: ['OPEN'] }, 'status')).toBe(true);
  });

  it('returns false for missing key', () => {
    expect(isFilterActive({}, 'status')).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(isFilterActive({ status: [] }, 'status')).toBe(false);
  });
});

describe('isValueSelected', () => {
  it('returns true for selected value', () => {
    expect(isValueSelected({ status: ['OPEN'] }, 'status', 'OPEN')).toBe(true);
  });

  it('returns false for unselected value', () => {
    expect(isValueSelected({ status: ['OPEN'] }, 'status', 'CLOSED')).toBe(false);
  });
});

describe('countActiveFilters', () => {
  it('counts total values', () => {
    expect(countActiveFilters({ status: ['OPEN', 'CLOSED'], category: ['Tech'] })).toBe(3);
  });

  it('returns 0 for empty state', () => {
    expect(countActiveFilters({})).toBe(0);
  });
});

describe('countActiveFilterKeys', () => {
  it('counts active keys', () => {
    expect(countActiveFilterKeys({ status: ['OPEN'], category: ['Tech'] })).toBe(2);
  });

  it('skips empty keys', () => {
    expect(countActiveFilterKeys({ status: [], category: ['Tech'] })).toBe(1);
  });
});

describe('hasActiveFilters', () => {
  it('true when filters active', () => {
    expect(hasActiveFilters({ status: ['OPEN'] })).toBe(true);
  });

  it('false when empty', () => {
    expect(hasActiveFilters({})).toBe(false);
  });

  it('false when all keys empty', () => {
    expect(hasActiveFilters({ status: [] })).toBe(false);
  });
});

// ─── filter-state.ts: Compatibility ─────────────────────────────────

describe('fromCompactFilterState', () => {
  it('converts flat Record to FilterState', () => {
    const flat = { status: 'OPEN', q: 'search' };
    const state = fromCompactFilterState(flat);
    expect(state).toEqual({ status: ['OPEN'], q: ['search'] });
  });

  it('skips empty values', () => {
    const flat = { status: 'OPEN', category: '' };
    const state = fromCompactFilterState(flat);
    expect(state).toEqual({ status: ['OPEN'] });
  });
});

describe('toCompactFilterState', () => {
  it('converts FilterState to flat Record', () => {
    const state: FilterState = { status: ['OPEN'], category: ['Tech'] };
    const flat = toCompactFilterState(state);
    expect(flat).toEqual({ status: 'OPEN', category: 'Tech' });
  });

  it('joins multi-values', () => {
    const state: FilterState = { status: ['OPEN', 'CLOSED'] };
    const flat = toCompactFilterState(state);
    expect(flat.status).toBe('OPEN,CLOSED');
  });
});

describe('extractFilterOptions', () => {
  it('extracts unique options from data', () => {
    const data = [
      { id: '1', status: 'OPEN' },
      { id: '2', status: 'CLOSED' },
      { id: '3', status: 'OPEN' },
    ];
    const options = extractFilterOptions(data, 'status');
    expect(options).toEqual([
      { value: 'CLOSED', label: 'CLOSED' },
      { value: 'OPEN', label: 'OPEN' },
    ]);
  });

  it('uses custom label function', () => {
    const data = [{ id: '1', status: 'OPEN' }];
    const options = extractFilterOptions(data, 'status', (v) => `Status: ${v}`);
    expect(options[0].label).toBe('Status: OPEN');
  });
});

// ─── filter-definitions.ts ──────────────────────────────────────────

describe('createFilterDefs', () => {
  const result = createFilterDefs({
    status: {
      label: 'Status',
      icon: CircleDot,
      options: [
        { value: 'OPEN', label: 'Open' },
        { value: 'CLOSED', label: 'Closed' },
      ],
    },
    category: {
      label: 'Category',
      icon: Tag,
      multiple: true,
      options: [
        { value: 'Technical', label: 'Technical' },
      ],
    },
  });

  it('produces a filters array', () => {
    expect(result.filters).toHaveLength(2);
    expect(result.filters[0].key).toBe('status');
    expect(result.filters[1].key).toBe('category');
  });

  it('produces filterKeys', () => {
    expect(result.filterKeys).toEqual(['status', 'category']);
  });

  it('looks up by key', () => {
    const status = result.getFilter('status');
    expect(status?.label).toBe('Status');
    expect(status?.paramKey).toBe('status');
  });

  it('sets defaults correctly', () => {
    const status = result.getFilter('status')!;
    expect(status.type).toBe('default');
    expect(status.multiple).toBe(false);

    const category = result.getFilter('category')!;
    expect(category.multiple).toBe(true);
  });

  it('supports paramKey override', () => {
    const result2 = createFilterDefs({
      status: {
        label: 'Status',
        icon: CircleDot,
        options: [],
        paramKey: 'f_status',
      },
    });
    expect(result2.getFilter('status')!.paramKey).toBe('f_status');
    expect(result2.filterKeys).toEqual(['f_status']);
  });
});

describe('optionsFromEnum', () => {
  it('creates options from enum-like object', () => {
    const opts = optionsFromEnum({ OPEN: 'Open', CLOSED: 'Closed' });
    expect(opts).toEqual([
      { value: 'OPEN', label: 'Open' },
      { value: 'CLOSED', label: 'Closed' },
    ]);
  });
});

describe('optionsFromArray', () => {
  it('creates options from string array', () => {
    const opts = optionsFromArray(['Technical', 'Operational']);
    expect(opts).toEqual([
      { value: 'Technical', label: 'Technical' },
      { value: 'Operational', label: 'Operational' },
    ]);
  });
});

// ─── Roundtrip Integration ──────────────────────────────────────────

describe('Roundtrip: URL → FilterState → ActiveFilter → FilterState → URL', () => {
  it('full roundtrip preserves data', () => {
    const originalUrl = 'status=OPEN,IN_PROGRESS&category=Technical';
    const keys = ['status', 'category'];

    // URL → FilterState
    const state1 = parseUrlToFilterState(originalUrl, keys);
    expect(state1).toEqual({
      status: ['OPEN', 'IN_PROGRESS'],
      category: ['Technical'],
    });

    // FilterState → ActiveFilter[]
    const active = filterStateToActiveFilters(state1);
    expect(active).toHaveLength(2);

    // ActiveFilter[] → FilterState
    const state2 = activeFiltersToFilterState(active);
    expect(state2).toEqual(state1);

    // FilterState → URL
    const params = filterStateToUrlParams(state2);
    expect(params.get('status')).toBe('OPEN,IN_PROGRESS');
    expect(params.get('category')).toBe('Technical');
  });
});

// ─── Architecture Compliance ────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';

describe('Filter module architecture', () => {
  const filterDir = path.resolve(__dirname, '../../src/components/ui/filter');

  it('has barrel index.ts', () => {
    expect(fs.existsSync(path.join(filterDir, 'index.ts'))).toBe(true);
  });

  it('barrel exports filter-state module', () => {
    const barrel = fs.readFileSync(path.join(filterDir, 'index.ts'), 'utf-8');
    expect(barrel).toContain('filter-state');
  });

  it('barrel exports filter-definitions module', () => {
    const barrel = fs.readFileSync(path.join(filterDir, 'index.ts'), 'utf-8');
    expect(barrel).toContain('filter-definitions');
  });

  it('barrel exports filter-context module', () => {
    const barrel = fs.readFileSync(path.join(filterDir, 'index.ts'), 'utf-8');
    expect(barrel).toContain('filter-context');
  });

  /**
   * Internal modules (not re-exported from barrel, imported by other public modules).
   * These are implementation details and should NOT be added to the public API.
   */
  const INTERNAL_MODULES = new Set([
    'filter-range-panel',
    // Same class as `filter-range-panel`: a facet BODY, mounted by
    // `filter-select` and `filter-list` when `Filter.type` selects it. A
    // page author never reaches for it — they set `type: 'dateRange'` on a
    // definition and the platform picks the panel. What IS public is the
    // codec, re-exported from the barrel as
    // `encodeDateRangeToken` / `parseDateRangeToken`.
    'filter-date-range-panel',
    'filter-range-utils',
    'filter-scroll',
    'filter-select-utils',
  ]);

  /**
   * Reference modules — deliberately not re-exported from the barrel and not
   * imported by any other module. They exist for docs/tests/playground use
   * (`filter-examples.ts` ships representative patterns for page authors).
   * If a reference module becomes load-bearing, move it out of this set.
   */
  const REFERENCE_MODULES = new Set(['filter-examples']);

  it('all public .ts/.tsx files are referenced in barrel (internal + reference modules excluded)', () => {
    const barrel = fs.readFileSync(path.join(filterDir, 'index.ts'), 'utf-8');
    const files = fs.readdirSync(filterDir)
      .filter(f => (f.endsWith('.ts') || f.endsWith('.tsx')) && f !== 'index.ts');

    for (const file of files) {
      const mod = file.replace(/\.(ts|tsx)$/, '');
      if (INTERNAL_MODULES.has(mod)) continue; // Internal: checked separately
      if (REFERENCE_MODULES.has(mod)) continue; // Reference: intentionally excluded
      expect(barrel).toContain(mod);
    }
  });

  it('reference modules are not imported by any public module (kept isolated)', () => {
    const publicFiles = fs.readdirSync(filterDir)
      .filter(f => (f.endsWith('.ts') || f.endsWith('.tsx')) && f !== 'index.ts')
      .filter(f => {
        const mod = f.replace(/\.(ts|tsx)$/, '');
        return !REFERENCE_MODULES.has(mod);
      });

    for (const ref of REFERENCE_MODULES) {
      const importers = publicFiles.filter(f => {
        const src = fs.readFileSync(path.join(filterDir, f), 'utf-8');
        return src.includes(`./${ref}`);
      });
      // Zero importers — reference modules must stay isolated so production
      // code never accidentally pulls in example / test data.
      expect(importers).toEqual([]);
    }
  });

  it('internal modules are imported by at least one other module (dead-code sentinel)', () => {
    // Previously: "imported by a *public* module". That over-constrained
    // internal → internal imports (e.g. filter-range-utils ← filter-range-panel)
    // where both sides are internal but the util is still load-bearing.
    for (const internal of INTERNAL_MODULES) {
      const otherFiles = fs.readdirSync(filterDir)
        .filter(f => (f.endsWith('.ts') || f.endsWith('.tsx')) && f !== 'index.ts')
        .filter(f => f.replace(/\.(ts|tsx)$/, '') !== internal);

      const importedBy = otherFiles.filter(f => {
        const src = fs.readFileSync(path.join(filterDir, f), 'utf-8');
        return src.includes(`./${internal}`);
      });

      expect(importedBy.length).toBeGreaterThanOrEqual(1);
    }
  });

  const REQUIRED_MODULES = [
    'types.ts',
    'filter-state.ts',
    'filter-definitions.ts',
    'filter-context.tsx',
    'filter-select.tsx',
    'filter-list.tsx',
    'filter-range-panel.tsx',
    'filter-scroll.tsx',
  ];

  for (const mod of REQUIRED_MODULES) {
    it(`module ${mod} exists`, () => {
      expect(fs.existsSync(path.join(filterDir, mod))).toBe(true);
    });
  }
});

export {};

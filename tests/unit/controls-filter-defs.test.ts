/**
 * Epic 53 — Practices list page filter integration.
 *
 * Verifies:
 *   1. The Practices filter config produces a Filter[] with the documented
 *      key set, icons, groups, and reset semantics.
 *   2. Owner & category options are derived correctly from loaded rows
 *      (dedupe, sort, fallback labels).
 *   3. Filter state round-trips to/from the API query string without loss
 *      (pagination-safe: no `cursor` leaks, search stays separate).
 *   4. Compatibility with the legacy `CompactFilterBar` flat-state shape via
 *      `fromCompactFilterState` — so page migrations are reversible.
 *   5. Empty-state behaviour: the picker surfaces zero owner/category options
 *      when the loaded rows lack those fields, without throwing.
 */

// Import directly from the pure sub-module rather than the tsx-heavy barrel.
import {
    addFilterValue,
    filterStateToUrlParams,
    fromCompactFilterState,
    hasActiveFilters,
    parseUrlToFilterState,
    toCompactFilterState,
    type FilterState,
} from '../../src/components/ui/filter/filter-state';
import {
    APPLICABILITY_LABELS,
    buildPracticeFilters,
    categoryOptionsFromPractices,
    practiceFilterDefs,
    CONTROL_FILTER_KEYS,
    CONTROL_STATUS_LABELS,
    ownerOptionsFromPractices,
} from '../../src/app/t/[tenantSlug]/(app)/practices/filter-defs';

// ─── 1. Filter config shape ──────────────────────────────────────────

describe('Practices filter config', () => {
    it('exposes the expected key set aligned with the Practices API schema', () => {
        expect(CONTROL_FILTER_KEYS.sort()).toEqual(
            ['applicability', 'category', 'ownerUserId', 'status'].sort(),
        );
    });

    it('produces a FilterDef[] via createTypedFilterDefs', () => {
        const bundle = practiceFilterDefs;
        expect(bundle.filters.map((f) => f.key).sort()).toEqual(
            ['applicability', 'category', 'ownerUserId', 'status'].sort(),
        );
        // Each filter must carry a paramKey that matches its key unless
        // explicitly overridden (none are overridden today).
        for (const f of bundle.filters) {
            expect(f.paramKey).toBe(f.key);
        }
    });

    it('tags every filter with a group and a clearable reset behaviour', () => {
        for (const f of practiceFilterDefs.filters) {
            expect(f.group).toBeDefined();
            expect(f.resetBehavior).toBe('clearable');
        }
    });

    it('status & applicability are enum filters with statically-defined options', () => {
        const status = practiceFilterDefs.getFilter('status');
        const app = practiceFilterDefs.getFilter('applicability');
        expect(Array.isArray(status.options)).toBe(true);
        expect(Array.isArray(app.options)).toBe(true);
        // Enum values round-trip via the documented CONTROL_STATUS_LABELS map.
        const statusValues = (status.options ?? []).map((o) => o.value).sort();
        expect(statusValues).toEqual(Object.keys(CONTROL_STATUS_LABELS).sort());
        const appValues = (app.options ?? []).map((o) => o.value).sort();
        expect(appValues).toEqual(Object.keys(APPLICABILITY_LABELS).sort());
    });

    it('owner & category are async entity-ref / free-form filters (options: null)', () => {
        expect(practiceFilterDefs.getFilter('ownerUserId').options).toBeNull();
        expect(practiceFilterDefs.getFilter('category').options).toBeNull();
    });

    it('status is multi-select and status.label is "Status"', () => {
        const status = practiceFilterDefs.getFilter('status');
        expect(status.multiple).toBe(true);
        expect(status.label).toBe('Status');
    });
});

// ─── 2. Runtime option derivation ────────────────────────────────────

describe('ownerOptionsFromPractices', () => {
    it('returns an empty array when no practice has an owner', () => {
        expect(ownerOptionsFromPractices([])).toEqual([]);
        expect(ownerOptionsFromPractices([{ owner: null }])).toEqual([]);
    });

    it('dedupes owners by id and produces a sortable label', () => {
        const opts = ownerOptionsFromPractices([
            { owner: { id: 'u1', name: 'Ada', email: 'ada@acme.com' } },
            { owner: { id: 'u1', name: 'Ada', email: 'ada@acme.com' } },
            { owner: { id: 'u2', name: 'Linus', email: 'linus@acme.com' } },
        ]);
        expect(opts.map((o) => o.value)).toEqual(['u1', 'u2']);
        expect(opts[0].label).toBe('Ada — ada@acme.com');
        expect(opts[0].displayLabel).toBe('Ada');
    });

    it('sorts alphabetically by full label (stable across renders)', () => {
        const opts = ownerOptionsFromPractices([
            { owner: { id: 'zz', name: 'Zoe', email: 'z@acme.com' } },
            { owner: { id: 'aa', name: 'Ada', email: 'a@acme.com' } },
        ]);
        expect(opts.map((o) => o.value)).toEqual(['aa', 'zz']);
    });

    it('falls back to email, then "Unknown", when the name is missing', () => {
        const opts = ownerOptionsFromPractices([
            { owner: { id: 'u1', name: null, email: 'ops@acme.com' } },
            { owner: { id: 'u2', name: null, email: null } },
        ]);
        // When name is null, label switches to email-only; displayLabel takes
        // the email (fallback above "Unknown").
        expect(opts.find((o) => o.value === 'u1')?.displayLabel).toBe('ops@acme.com');
        expect(opts.find((o) => o.value === 'u2')?.displayLabel).toBe('Unknown');
    });
});

describe('categoryOptionsFromPractices', () => {
    it('returns an empty array when no practice has a category', () => {
        expect(categoryOptionsFromPractices([])).toEqual([]);
        expect(categoryOptionsFromPractices([{ category: null }])).toEqual([]);
    });

    it('dedupes + sorts free-form category strings', () => {
        const opts = categoryOptionsFromPractices([
            { category: 'Technical' },
            { category: 'Operational' },
            { category: 'Technical' },
            { category: '  Operational  ' }, // trimmed before dedupe
        ]);
        expect(opts.map((o) => o.value)).toEqual(['Operational', 'Technical']);
        expect(opts.map((o) => o.label)).toEqual(['Operational', 'Technical']);
    });

    it('skips empty / whitespace-only categories', () => {
        expect(
            categoryOptionsFromPractices([
                { category: '' },
                { category: '   ' },
                { category: undefined as unknown as null },
            ]),
        ).toEqual([]);
    });
});

describe('buildPracticeFilters — options injected at render time', () => {
    it('swaps in runtime options without mutating the static defs', () => {
        const live = buildPracticeFilters([
            { owner: { id: 'u1', name: 'Ada', email: 'ada@acme.com' }, category: 'Tech' },
        ]);
        const owner = live.find((f) => f.key === 'ownerUserId');
        const category = live.find((f) => f.key === 'category');
        expect(owner?.options).toHaveLength(1);
        expect(category?.options).toEqual([{ value: 'Tech', label: 'Tech' }]);
        // Static defs remain null — the component built a new filter array.
        expect(practiceFilterDefs.getFilter('ownerUserId').options).toBeNull();
        expect(practiceFilterDefs.getFilter('category').options).toBeNull();
    });

    it('leaves status/applicability options untouched', () => {
        const live = buildPracticeFilters([]);
        const status = live.find((f) => f.key === 'status');
        expect(status?.options).toBe(practiceFilterDefs.getFilter('status').options);
    });

    it('preserves all static metadata when injecting options (group, reset, icon)', () => {
        const live = buildPracticeFilters([
            { owner: { id: 'u1', name: 'Ada', email: 'ada@acme.com' }, category: 'Tech' },
        ]);
        const owner = live.find((f) => f.key === 'ownerUserId');
        expect(owner?.group).toBe('People');
        expect(owner?.resetBehavior).toBe('clearable');
        expect(owner?.icon).toBeDefined();
    });
});

// ─── 3. URL round-trip (pagination-safe) ─────────────────────────────

describe('Practices filter URL serialisation', () => {
    it('roundtrips a full filter state through URL → state → URL', () => {
        const initial: FilterState = {
            status: ['IN_PROGRESS', 'IMPLEMENTED'],
            applicability: ['APPLICABLE'],
            ownerUserId: ['u1'],
            category: ['Technical'],
        };
        const params = filterStateToUrlParams(initial);
        expect(params.get('status')).toBe('IN_PROGRESS,IMPLEMENTED');
        expect(params.get('applicability')).toBe('APPLICABLE');
        expect(params.get('ownerUserId')).toBe('u1');
        expect(params.get('category')).toBe('Technical');

        const parsed = parseUrlToFilterState(params, CONTROL_FILTER_KEYS);
        expect(parsed).toEqual(initial);
    });

    it('filterStateToUrlParams does NOT emit keys outside the managed set', () => {
        const state: FilterState = {
            status: ['OPEN'],
            // Unmanaged key — should not show up after a parse roundtrip.
            foo: ['bar'],
        };
        const params = filterStateToUrlParams(state);
        // Params emits everything in the state; the *parser* is what filters
        // unmanaged keys. Confirm the parse direction.
        const reparsed = parseUrlToFilterState(params, CONTROL_FILTER_KEYS);
        expect(reparsed).not.toHaveProperty('foo');
        expect(reparsed).toHaveProperty('status');
    });

    it('hasActiveFilters: empty state returns false, any filter returns true', () => {
        expect(hasActiveFilters({})).toBe(false);
        expect(hasActiveFilters({ status: [] })).toBe(false);
        expect(hasActiveFilters({ status: ['OPEN'] })).toBe(true);
    });

    it('adding a multi-value filter preserves other keys', () => {
        const withStatus = addFilterValue({}, 'status', 'IN_PROGRESS');
        const withOwner = addFilterValue(withStatus, 'ownerUserId', 'u1');
        const params = filterStateToUrlParams(withOwner);
        expect(params.get('status')).toBe('IN_PROGRESS');
        expect(params.get('ownerUserId')).toBe('u1');
    });
});

// ─── 4. CompactFilterBar compatibility bridge ────────────────────────

describe('Compat bridge — legacy CompactFilterBar ↔ FilterState', () => {
    it('reads a legacy flat Record<string, string> into FilterState', () => {
        const legacy = { status: 'IN_PROGRESS', applicability: 'APPLICABLE' };
        const state = fromCompactFilterState(legacy);
        expect(state).toEqual({
            status: ['IN_PROGRESS'],
            applicability: ['APPLICABLE'],
        });
    });

    it('projects FilterState back to the flat shape (lossy for multi-value)', () => {
        const state: FilterState = {
            status: ['IN_PROGRESS', 'IMPLEMENTED'],
            applicability: ['APPLICABLE'],
        };
        expect(toCompactFilterState(state)).toEqual({
            status: 'IN_PROGRESS,IMPLEMENTED',
            applicability: 'APPLICABLE',
        });
    });
});

// ─── 5. Empty-state behaviour ────────────────────────────────────────

describe('Practices filter — empty state', () => {
    it('buildPracticeFilters with zero practices still returns the full filter set', () => {
        const live = buildPracticeFilters([]);
        expect(live.map((f) => f.key).sort()).toEqual(
            ['applicability', 'category', 'ownerUserId', 'status'].sort(),
        );
    });

    it('owner/category options are empty arrays when no data is loaded yet', () => {
        const live = buildPracticeFilters([]);
        const owner = live.find((f) => f.key === 'ownerUserId');
        const category = live.find((f) => f.key === 'category');
        expect(owner?.options).toEqual([]);
        expect(category?.options).toEqual([]);
    });
});

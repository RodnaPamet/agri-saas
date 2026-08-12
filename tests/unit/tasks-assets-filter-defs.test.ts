/**
 * Epic 53 — sanity + URL round-trip for the Tasks and Assets filter
 * configs. Both pages ship static enum filters plus (for Tasks)
 * runtime-derived entity-ref options.
 *
 * Vendors was the third page here until the GRC teardown removed it.
 */

import {
    filterStateToUrlParams,
    parseUrlToFilterState,
    type FilterState,
} from '../../src/components/ui/filter/filter-state';
import {
    assigneeOptionsFromFarmTasks,
    buildFarmTaskFilters,
    FARM_TASK_FILTER_KEYS,
    FARM_STATUS_LABELS,
    farmTaskFilterDefs,
} from '../../src/app/t/[tenantSlug]/(app)/farm-tasks/filter-defs';
import {
    ASSET_CRITICALITY_LABELS,
    ASSET_FILTER_KEYS,
    ASSET_STATUS_LABELS,
    ASSET_TYPE_LABELS,
    assetFilterDefs,
    buildAssetFilters,
} from '../../src/app/t/[tenantSlug]/(app)/assets/filter-defs';

// ─── Tasks ───────────────────────────────────────────────────────────

describe('Farm tasks filter config', () => {
    it('manages the documented key set', () => {
        expect([...FARM_TASK_FILTER_KEYS].sort()).toEqual(
            ['assigneeUserId', 'due', 'status'].sort(),
        );
    });

    it('status is a multi-select enum with full coverage', () => {
        const def = farmTaskFilterDefs.getFilter('status');
        expect(def.multiple).toBe(true);
        expect((def.options ?? []).map((o) => o.value).sort()).toEqual(
            Object.keys(FARM_STATUS_LABELS).sort(),
        );
    });

    it('assigneeUserId starts as async (options: null)', () => {
        expect(farmTaskFilterDefs.getFilter('assigneeUserId').options).toBeNull();
    });

    it('due is single-select with the documented chip values', () => {
        const due = farmTaskFilterDefs.getFilter('due');
        expect(due.multiple).toBe(false);
        expect((due.options ?? []).map((o) => o.value).sort()).toEqual(['next7d', 'overdue']);
    });

    it('assigneeOptionsFromFarmTasks dedupes + sorts by label', () => {
        const opts = assigneeOptionsFromFarmTasks([
            { assignee: { id: 'u2', name: 'Zoe', email: 'z@a' } },
            { assignee: { id: 'u1', name: 'Ada', email: 'a@a' } },
            { assignee: { id: 'u1', name: 'Ada', email: 'a@a' } },
        ]);
        expect(opts.map((o) => o.value)).toEqual(['u1', 'u2']);
        expect(opts[0].displayLabel).toBe('Ada');
    });

    it('buildFarmTaskFilters swaps assignee options without mutating static defs', () => {
        const live = buildFarmTaskFilters((k) => k, [
            { assignee: { id: 'u1', name: 'Ada', email: 'a@a' } },
        ]);
        expect(live.find((f) => f.key === 'assigneeUserId')?.options).toHaveLength(1);
        expect(farmTaskFilterDefs.getFilter('assigneeUserId').options).toBeNull();
    });
});

// ─── Vendors ─────────────────────────────────────────────────────────

// ─── Assets ──────────────────────────────────────────────────────────

describe('Assets filter config', () => {
    it('manages the documented key set', () => {
        expect([...ASSET_FILTER_KEYS].sort()).toEqual(
            ['criticality', 'status', 'type'].sort(),
        );
    });

    it('type / status / criticality cover the documented enums', () => {
        expect((assetFilterDefs.getFilter('type').options ?? []).map((o) => o.value).sort()).toEqual(
            Object.keys(ASSET_TYPE_LABELS).sort(),
        );
        expect((assetFilterDefs.getFilter('status').options ?? []).map((o) => o.value).sort()).toEqual(
            Object.keys(ASSET_STATUS_LABELS).sort(),
        );
        expect((assetFilterDefs.getFilter('criticality').options ?? []).map((o) => o.value).sort()).toEqual(
            Object.keys(ASSET_CRITICALITY_LABELS).sort(),
        );
    });

    it('buildAssetFilters returns the static set', () => {
        expect(buildAssetFilters()).toBe(assetFilterDefs.filters);
    });
});

// ─── Combined URL round-trip ────────────────────────────────────────

describe('URL round-trip for Tasks / Assets', () => {
    it.each([
        ['farm-tasks', FARM_TASK_FILTER_KEYS, { status: ['OPEN', 'IN_PROGRESS'], due: ['overdue'] } as FilterState],
        ['assets', ASSET_FILTER_KEYS, { type: ['SYSTEM'], status: ['ACTIVE'] } as FilterState],
    ])('%s is lossless across serialise/parse', (_name, keys, state) => {
        const parsed = parseUrlToFilterState(filterStateToUrlParams(state), keys);
        expect(parsed).toEqual(state);
    });
});

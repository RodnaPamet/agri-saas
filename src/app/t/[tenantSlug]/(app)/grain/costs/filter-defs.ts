/**
 * Grain cost-entry list page filter configuration (Epic 53).
 *
 * Keys map 1:1 onto the API query parameters accepted by
 * `GET /api/t/:slug/grain/costs`:
 *
 *   q         → free-text search (server-side; `supplier` + `currency`,
 *               NOT `description` — that column is encrypted at rest, so
 *               a `contains` would match ciphertext)
 *   category  → CostCategory, MULTI-select
 *
 * ── Why there is no date facet ──────────────────────────────────────
 *
 * `incurredOn` is the obvious thing to filter by and it is deliberately
 * absent. `Filter.type` is only `"default" | "range"`, and `range` is a
 * NUMERIC min/max panel whose encoder integer-truncates
 * (`String(Math.trunc(min))`) — it cannot carry an ISO date. A real date
 * facet means extending the filter platform with a new type, encoder and
 * decoder, which is its own piece of work with its own tests rather than
 * something to smuggle into a feature PR. The list sorts `incurredOn`
 * descending, so recent entries are on top without one.
 */

import type {
    FilterDef,
    FilterDefInput,
} from '@/components/ui/filter/filter-definitions';
import { createTypedFilterDefs } from '@/components/ui/filter/filter-definitions';
import type { FilterOption } from '@/components/ui/filter/types';
// Nucleo icon cast to the contract's icon shape — keeps this file off the
// lucide allowlist (same precedent as `grain/payroll/filter-defs.ts`).
import { Tag } from '@/components/ui/icons/nucleo';

/** The icon shape the filter contract expects, derived from the contract
 *  type itself (no direct legacy-icon-package dependency). */
type FilterIcon = FilterDefInput['icon'];
const asIcon = (c: unknown): FilterIcon => c as FilterIcon;

/** A next-intl translator scoped to the `grainEnums` namespace. */
type Translator = (key: string) => string;

/** The eight categories, in the order the create form offers them. */
export const COST_CATEGORY_VALUES = [
    'PAYROLL',
    'RENT',
    'FERTILIZER',
    'FUEL',
    'SEED',
    'PESTICIDE',
    'SERVICE',
    'OTHER',
] as const;

// ─── Static filter definitions ───────────────────────────────────────

const STATIC_DEFS = {
    category: {
        label: 'Category',
        labelPlural: 'Categories',
        description: 'What kind of spend the entry records.',
        group: 'Attributes',
        icon: asIcon(Tag),
        options: null, // filled in at render time so labels are localised
        multiple: true,
        resetBehavior: 'clearable',
    },
} satisfies Record<string, FilterDefInput>;

// ─── Public API ──────────────────────────────────────────────────────

export const costFilterDefs = createTypedFilterDefs()(STATIC_DEFS);

/** URL param keys managed by the cost filter set. `q` is the separate
 * search slot owned by `useFilterContext`. */
export const COST_FILTER_KEYS = costFilterDefs.filterKeys;

/**
 * Produce the Filter[] array FilterToolbar consumes.
 *
 * Category options are a FIXED enum, not derived from loaded rows — a
 * facet built from what happened to load would hide a category the farm
 * has not used yet, which is exactly the one someone is looking for when
 * they open the filter to check whether anything was ever filed under it.
 */
export function buildCostFilters(t: Translator): FilterDef[] {
    const options: FilterOption[] = COST_CATEGORY_VALUES.map((value) => ({
        value,
        label: t(`costCategory.${value}`),
    }));

    return costFilterDefs.filters.map((f) =>
        f.key === 'category' ? { ...f, label: t('costCategoryFacet'), options } : f,
    );
}

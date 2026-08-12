/**
 * Grain cost-entry list page filter configuration (Epic 53).
 *
 * Keys map 1:1 onto the API query parameters accepted by
 * `GET /api/t/:slug/grain/costs`:
 *
 *   q         → free-text search (server-side; `supplier` + `currency`,
 *               NOT `description` — that column is encrypted at rest, so
 *               a `contains` would match ciphertext)
 *   category   → CostCategory, MULTI-select
 *   incurredOn → the date window, ONE `"YYYY-MM-DD|YYYY-MM-DD"` token
 *
 * ── The date facet ──────────────────────────────────────────────────
 *
 * `incurredOn` was deliberately absent until the filter platform grew a
 * `dateRange` type: `Filter.type` was only `"default" | "range"`, and
 * `range` is a NUMERIC min/max panel whose encoder integer-truncates
 * (`String(Math.trunc(min))`), which no ISO date survives. That platform
 * work landed with its own panel, codec and tests, so the facet is now a
 * three-line definition here rather than a feature PR carrying a platform
 * change inside it.
 *
 * The window is INCLUSIVE at both ends and interpreted in UTC — see
 * `parseDateRangeParam` in `@/lib/validation/query-params`, which widens
 * the upper bound to end-of-day so a single-day filter (`X|X`) matches the
 * entries typed on X rather than nothing.
 */

import type {
    FilterDef,
    FilterDefInput,
} from '@/components/ui/filter/filter-definitions';
import { createTypedFilterDefs } from '@/components/ui/filter/filter-definitions';
import type { FilterOption } from '@/components/ui/filter/types';
// Nucleo icon cast to the contract's icon shape — keeps this file off the
// lucide allowlist.
import { CalendarDays, Tag } from '@/components/ui/icons/nucleo';

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
    incurredOn: {
        label: 'Date',
        labelPlural: 'Dates',
        description: 'When the cost was incurred.',
        group: 'Attributes',
        icon: asIcon(CalendarDays),
        // A calendar, not a list — the panel is chosen by `type`, and a
        // `dateRange` facet has no options to enumerate.
        options: null,
        type: 'dateRange',
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

    return costFilterDefs.filters.map((f) => {
        if (f.key === 'category') {
            return { ...f, label: t('costCategoryFacet'), options };
        }
        if (f.key === 'incurredOn') {
            return { ...f, label: t('incurredOnFacet') };
        }
        return f;
    });
}

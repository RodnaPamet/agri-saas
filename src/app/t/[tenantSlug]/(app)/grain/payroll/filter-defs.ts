/**
 * Grain payroll-expenses list page filter configuration (Epic 53).
 *
 * Declarative filter defs for the Payroll list toolbar. Keys map 1:1 onto
 * the API query parameters accepted by
 * `GET /api/t/:slug/grain/payroll`:
 *
 *   q         → free-text search (server-side; see
 *               `buildSearchWhere` in `PayrollExpenseRepository`)
 *   seasonId  → Season id (options derived client-side from loaded rows)
 *
 * Season options default to `null` (async-loading) and are patched in at
 * render time from the loaded payroll rows, which carry the `season`
 * relation — no extra API call needed. Mirrors `grain/yield/filter-defs.ts`.
 */

import type {
    FilterDef,
    FilterDefInput,
} from '@/components/ui/filter/filter-definitions';
import { createTypedFilterDefs } from '@/components/ui/filter/filter-definitions';
import type { FilterOption } from '@/components/ui/filter/types';
// Nucleo icon cast to the contract's icon shape — keeps this file off the
// lucide allowlist (same precedent as `grain/yield/filter-defs.ts`).
import { CalendarDays } from '@/components/ui/icons/nucleo';

/** The icon shape the filter contract expects, derived from the contract
 *  type itself (no direct legacy-icon-package dependency). */
type FilterIcon = FilterDefInput['icon'];
const asIcon = (c: unknown): FilterIcon => c as FilterIcon;

/** A next-intl translator scoped to the `grainEnums` namespace. */
type Translator = (key: string) => string;

// ─── Static filter definitions ───────────────────────────────────────

const STATIC_DEFS = {
    seasonId: {
        label: 'Season',
        labelPlural: 'Seasons',
        description: 'Marketing-year season the labour cost belongs to.',
        group: 'Attributes',
        icon: asIcon(CalendarDays),
        options: null, // filled in at render time from loaded rows
        multiple: true,
        resetBehavior: 'clearable',
    },
} satisfies Record<string, FilterDefInput>;

// ─── Public API ──────────────────────────────────────────────────────

export const payrollFilterDefs = createTypedFilterDefs()(STATIC_DEFS);

/** URL param keys managed by the Payroll filter set. `q` is the separate
 * search slot owned by `useFilterContext`. */
export const PAYROLL_FILTER_KEYS = payrollFilterDefs.filterKeys;

// ─── Runtime option builders ─────────────────────────────────────────

interface PayrollLike {
    season?: { id: string; name: string } | null;
}

function dedupeOptions(
    rows: ReadonlyArray<{ id: string; name: string } | null | undefined>,
): FilterOption[] {
    const seen = new Map<string, FilterOption>();
    for (const r of rows) {
        if (!r?.id) continue;
        if (seen.has(r.id)) continue;
        seen.set(r.id, { value: r.id, label: r.name || 'Unnamed' });
    }
    return Array.from(seen.values()).sort((a, b) =>
        a.label.localeCompare(b.label),
    );
}

/**
 * Produce the Filter[] array FilterToolbar consumes, with the season
 * `options` replaced by the runtime-derived list from the loaded payroll
 * rows. Takes a `grainEnums` translator so the facet label renders in the
 * active locale.
 */
export function buildPayrollFilters(
    t: Translator,
    loaded: ReadonlyArray<PayrollLike>,
): FilterDef[] {
    const seasonOpts = dedupeOptions(loaded.map((p) => p.season));
    return payrollFilterDefs.filters.map((f) => {
        if (f.key === 'seasonId')
            return {
                ...f,
                label: t('season'),
                labelPlural: t('seasons'),
                options: seasonOpts,
            };
        return f;
    });
}

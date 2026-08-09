/**
 * Epic 53 — Practices list page filter configuration.
 *
 * Declarative filter defs for the Practices list toolbar. Keys map 1:1 onto
 * the API query parameters accepted by `GET /api/t/:slug/practices`:
 *
 *   q             → free-text search (managed by useFilterContext's search slot)
 *   status        → PracticeStatus enum
 *   applicability → APPLICABLE | NOT_APPLICABLE
 *   ownerUserId   → entity-ref (user IDs; options derived client-side from loaded rows)
 *   category      → free-form string (options derived client-side from loaded rows)
 *
 * `framework` is intentionally excluded — it would require a subquery across
 * `FrameworkMapping` which the practices API does not expose today. Adding it
 * will be a follow-on server + repo change; left as a migration note.
 *
 * This module is the single source of truth for the Practices filter contract.
 * Do not scatter filter logic back into the page; extend the config instead.
 */

// Import from concrete sub-modules (not the barrel) so that jest's node env
// can require this file without transitively pulling the tsx components.
// Next.js / bundlers resolve these identically to the barrel re-exports.
import type {
    FilterDef,
    FilterDefInput,
} from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import type { FilterOption } from '@/components/ui/filter/types';
import { CircleDot, Tag, UserCircle2, ShieldCheck } from 'lucide-react';

// ─── Static labels (enum copy lives here, not in PracticesClient) ─────

export const CONTROL_STATUS_LABELS = {
    NOT_STARTED: 'Not Started',
    PLANNED: 'Planned',
    IN_PROGRESS: 'In Progress',
    IMPLEMENTING: 'Implementing',
    IMPLEMENTED: 'Implemented',
    NEEDS_REVIEW: 'Needs Review',
    NOT_APPLICABLE: 'Not Applicable',
} as const;

export const APPLICABILITY_LABELS = {
    APPLICABLE: 'Applicable',
    NOT_APPLICABLE: 'Not Applicable',
} as const;

// ─── Static filter definitions ───────────────────────────────────────
//
// Owner and Category default to `options: null` — FilterSelect treats that as
// "async loading" and the page swaps in derived options at render time.

const STATIC_DEFS = {
    status: {
        label: 'Status',
        labelPlural: 'Statuses',
        description: 'Lifecycle stage of the practice.',
        group: 'Attributes',
        icon: CircleDot,
        options: optionsFromEnum(CONTROL_STATUS_LABELS),
        multiple: true,
        resetBehavior: 'clearable',
    },
    applicability: {
        label: 'Applicability',
        description: 'Whether the practice applies in the current SoA scope.',
        group: 'Attributes',
        icon: ShieldCheck,
        options: optionsFromEnum(APPLICABILITY_LABELS),
        resetBehavior: 'clearable',
    },
    ownerUserId: {
        label: 'Owner',
        labelPlural: 'Owners',
        description: 'User accountable for this practice.',
        group: 'People',
        icon: UserCircle2,
        options: null, // filled in at render time from loaded practices
        multiple: true,
        shouldFilter: true, // cmdk filters the (client-derived) label text
        resetBehavior: 'clearable',
    },
    category: {
        label: 'Category',
        labelPlural: 'Categories',
        description: 'Free-form grouping assigned to the practice.',
        group: 'Attributes',
        icon: Tag,
        options: null, // filled in at render time from loaded practices
        multiple: true,
        resetBehavior: 'clearable',
    },
} satisfies Record<string, FilterDefInput>;

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Resolved static filter definitions + narrowed `filterKeys` literal union.
 * Page authors iterate `filters` for FilterSelect and hand `filterKeys` to
 * `useFilterContext` so URL round-tripping knows which params to manage.
 */
export const practiceFilterDefs = createTypedFilterDefs()(STATIC_DEFS);

/** URL param keys managed by the Practices filter set. `q` is the separate
 * search slot owned by `useFilterContext`. */
export const CONTROL_FILTER_KEYS = practiceFilterDefs.filterKeys;

// ─── Runtime option builders ─────────────────────────────────────────

interface OwnerLike {
    id: string;
    name?: string | null;
    email?: string | null;
}

/**
 * Build owner options from the practices currently loaded on the page.
 * Dedupes by `owner.id` and sorts by display label. Skips rows with no owner.
 */
export function ownerOptionsFromPractices(
    practices: ReadonlyArray<{ owner?: OwnerLike | null }>,
): FilterOption[] {
    const seen = new Map<string, FilterOption>();
    for (const c of practices) {
        const o = c.owner;
        if (!o?.id) continue;
        if (seen.has(o.id)) continue;
        const name = o.name?.trim() || o.email?.trim() || 'Unknown';
        seen.set(o.id, {
            value: o.id,
            label: o.email ? `${name} — ${o.email}` : name,
            displayLabel: name,
        });
    }
    return Array.from(seen.values()).sort((a, b) =>
        a.label.localeCompare(b.label),
    );
}

/**
 * Build category options from the practices currently loaded on the page.
 * `category` is free-form on the Practice model, so we dedupe on the raw
 * string and surface the same string as both value and label.
 */
export function categoryOptionsFromPractices(
    practices: ReadonlyArray<{ category?: string | null }>,
): FilterOption[] {
    const seen = new Set<string>();
    for (const c of practices) {
        const cat = c.category?.trim();
        if (cat) seen.add(cat);
    }
    return Array.from(seen)
        .sort((a, b) => a.localeCompare(b))
        .map((value) => ({ value, label: value }));
}

/**
 * Produce the Filter[] array that FilterSelect consumes, with `options` on
 * the owner/category defs replaced by the runtime-derived lists. Returns
 * the same `FilterDef[]` shape (options is the only field that changes).
 */
export function buildPracticeFilters(
    loaded: ReadonlyArray<{
        owner?: OwnerLike | null;
        category?: string | null;
    }>,
): FilterDef[] {
    const ownerOpts = ownerOptionsFromPractices(loaded);
    const categoryOpts = categoryOptionsFromPractices(loaded);
    return practiceFilterDefs.filters.map((f) => {
        if (f.key === 'ownerUserId') return { ...f, options: ownerOpts };
        if (f.key === 'category') return { ...f, options: categoryOpts };
        return f;
    });
}

/**
 * Grain contracts list page filter configuration (Epic 53).
 *
 * Declarative filter defs for the Contracts list toolbar. Keys map 1:1
 * onto the API query parameters accepted by
 * `GET /api/t/:slug/grain/contracts`:
 *
 *   q       → free-text search (managed by useFilterContext's search slot;
 *             the contracts API does not filter server-side on q, so the
 *             FilterToolbar live search filters the loaded rows in-memory)
 *   status  → ContractStatus enum
 *   type    → ContractType enum (SALE | PURCHASE)
 *
 * `seasonId` is intentionally excluded from the toolbar — season is a
 * create-time relation, not a list facet the operator reaches for. The
 * API still accepts ?seasonId= for deep links if needed.
 *
 * This module is the single source of truth for the Contracts filter
 * contract. Do not scatter filter logic back into the page; extend the
 * config instead.
 */

// Import from concrete sub-modules (not the barrel) so jest's node env can
// require this file without transitively pulling the tsx components.
import type {
    FilterDef,
    FilterDefInput,
} from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
} from '@/components/ui/filter/filter-definitions';
import {
    ALL_CONTRACT_STATUSES,
    ALL_CONTRACT_TYPES,
} from '@/app-layer/domain/contract-status';
// Icons are Nucleo (the canonical family) cast to the icon shape the
// `FilterDefInput` contract types — the cast is sourced from the contract
// type itself, so this file never depends on the legacy lucide package
// (keeping it off the Nucleo-migration allowlist). Same precedent as
// `planning/filter-defs.ts`.
import {
    CircleDotted,
    ArrowsOppositeDirectionX,
} from '@/components/ui/icons/nucleo';

/** The icon shape the filter contract expects, derived from the contract
 *  type itself (no direct legacy-icon-package dependency). */
type FilterIcon = FilterDefInput['icon'];
const asIcon = (c: unknown): FilterIcon => c as FilterIcon;

/** A next-intl translator scoped to the `grainEnums` namespace (facet
 *  labels — "Status", "Statuses", "Type", "Types"). */
type Translator = (key: string) => string;

/** A next-intl translator scoped to the `ag` namespace — the one that
 *  resolves ENUM MEMBER labels (`status.contract.DRAFT`, …). */
export type AgTranslator = (key: string) => string;

// ─── Enum member labels: ONE source of truth ─────────────────────────
//
// `ag.status.contract.<MEMBER>` / `ag.status.contractType.<MEMBER>` —
// the very keys `<AgStatusBadge>` renders in the table. Every other
// surface that names a ContractStatus or ContractType (the filter chip,
// the create/edit form dropdowns) resolves through the builders below,
// so a label can never be right in one place and wrong in another.
//
// It used to be three copies: hardcoded English literals here, a
// flattened `grainEnums.statusDraft…` set, and `ag.status.contract`.
// The Bulgarian catalogue had already drifted between two of them — the
// filter chip said "Уредена / Отказан" while the table badge two
// columns away said "Уреден / Отменен" for the same row. The literals
// and the `grainEnums` copies are gone; this is the only one left.
//
// The member LIST comes from the domain module, so adding a status to
// the Prisma enum surfaces here without a second edit.

/** `{ value, label }` options for the five ContractStatus members. */
export function contractStatusOptions(t: AgTranslator) {
    return ALL_CONTRACT_STATUSES.map((value) => ({
        value,
        label: t(`status.contract.${value}`),
    }));
}

/** `{ value, label }` options for the two ContractType members. */
export function contractTypeOptions(t: AgTranslator) {
    return ALL_CONTRACT_TYPES.map((value) => ({
        value,
        label: t(`status.contractType.${value}`),
    }));
}

// ─── Static filter definitions ───────────────────────────────────────

const STATIC_DEFS = {
    status: {
        label: 'Status',
        labelPlural: 'Statuses',
        description: 'Lifecycle stage of the contract.',
        group: 'Attributes',
        icon: asIcon(CircleDotted),
        // Placeholder members only — `buildContractFilters` replaces
        // these with translated labels before the toolbar ever sees
        // them. The static def exists so the filter KEYS are typed at
        // module load, which happens before any translator exists.
        options: ALL_CONTRACT_STATUSES.map((value) => ({ value, label: value })),
        multiple: true,
        resetBehavior: 'clearable',
    },
    type: {
        label: 'Type',
        labelPlural: 'Types',
        description: 'Whether the contract sells produce or buys inputs.',
        group: 'Attributes',
        icon: asIcon(ArrowsOppositeDirectionX),
        options: ALL_CONTRACT_TYPES.map((value) => ({ value, label: value })),
        multiple: true,
        resetBehavior: 'clearable',
    },
} satisfies Record<string, FilterDefInput>;

// ─── Public API ──────────────────────────────────────────────────────

export const contractFilterDefs = createTypedFilterDefs()(STATIC_DEFS);

/** URL param keys managed by the Contracts filter set. `q` is the
 * separate search slot owned by `useFilterContext`. */
export const CONTRACT_FILTER_KEYS = contractFilterDefs.filterKeys;

/**
 * Produce the Filter[] array FilterToolbar consumes.
 *
 * Takes TWO translators, deliberately:
 *   - `t`   (`grainEnums`) for the FACET labels — "Status" / "Statuses".
 *   - `tAg` (`ag`)         for the ENUM MEMBER labels, the same keys the
 *                          table badge resolves. This is what stops the
 *                          chip and the badge from disagreeing.
 */
export function buildContractFilters(
    t: Translator,
    tAg: AgTranslator,
): FilterDef[] {
    return contractFilterDefs.filters.map((f) => {
        if (f.key === 'status') {
            return {
                ...f,
                label: t('status'),
                labelPlural: t('statuses'),
                description: t('statusDescription'),
                options: contractStatusOptions(tAg),
            };
        }
        if (f.key === 'type') {
            return {
                ...f,
                label: t('type'),
                labelPlural: t('types'),
                description: t('typeDescription'),
                options: contractTypeOptions(tAg),
            };
        }
        return f;
    });
}

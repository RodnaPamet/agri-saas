/**
 * Epic 53 — Assets list page filter configuration.
 *
 * Keys align with `AssetQuerySchema`: type, status, criticality.
 */

import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import { CircleDot, Flag, Layers } from 'lucide-react';

// Values MUST match the Prisma enums (AssetType, AssetStatus, Criticality) in
// schema.prisma — the UI selection is passed straight through to Prisma, so
// any label key not present in the DB enum produces
// PrismaClientValidationError on query and a 500 in the list page.
export const ASSET_TYPE_LABELS = {
    TRACTOR: 'Tractor',
    HARVESTER: 'Harvester',
    IMPLEMENT: 'Implement',
    VEHICLE: 'Vehicle',
    IRRIGATION: 'Irrigation',
    BUILDING: 'Building',
    STORAGE: 'Storage',
    LIVESTOCK_EQUIPMENT: 'Livestock Equipment',
    TOOL: 'Tool',
    OTHER: 'Other',
} as const;

export const ASSET_STATUS_LABELS = {
    ACTIVE: 'Active',
    IN_MAINTENANCE: 'In maintenance',
    RETIRED: 'Retired',
} as const;

export const ASSET_CRITICALITY_LABELS = {
    LOW: 'Low',
    MEDIUM: 'Medium',
    HIGH: 'High',
} as const;

const STATIC_DEFS = {
    type: {
        label: 'Type',
        description: 'Equipment category.',
        group: 'Attributes',
        icon: Layers,
        options: optionsFromEnum(ASSET_TYPE_LABELS),
        multiple: true,
        resetBehavior: 'clearable',
    },
    status: {
        label: 'Status',
        description: 'Asset lifecycle state.',
        group: 'Attributes',
        icon: CircleDot,
        options: optionsFromEnum(ASSET_STATUS_LABELS),
        multiple: true,
        resetBehavior: 'clearable',
    },
    criticality: {
        label: 'Criticality',
        description: 'Operational importance to the farm.',
        group: 'Quantitative',
        icon: Flag,
        options: optionsFromEnum(ASSET_CRITICALITY_LABELS),
        multiple: true,
        resetBehavior: 'clearable',
    },
} satisfies Record<string, FilterDefInput>;

export const assetFilterDefs = createTypedFilterDefs()(STATIC_DEFS);
export const ASSET_FILTER_KEYS = assetFilterDefs.filterKeys;

/** Surface-namespace resolver (`useTranslations('assets')`). */
type T = (key: string) => string;

/**
 * The asset vocabulary, localized.
 *
 * The `ASSET_*_LABELS` maps above stay as the KEY source of truth (and
 * the English fallback for any non-i18n caller); these builders resolve
 * the visible text. This matters beyond chrome: the same maps feed the
 * CREATE and EDIT dropdowns, so before this a Bulgarian farmer
 * registered a tractor by picking English words.
 */
export const buildAssetTypeLabels = (t: T): Record<string, string> =>
    Object.fromEntries(Object.keys(ASSET_TYPE_LABELS).map((k) => [k, t(`type${k}`)]));

export const buildAssetStatusLabels = (t: T): Record<string, string> =>
    Object.fromEntries(Object.keys(ASSET_STATUS_LABELS).map((k) => [k, t(`status${k}`)]));

export const buildAssetCriticalityLabels = (t: T): Record<string, string> =>
    Object.fromEntries(Object.keys(ASSET_CRITICALITY_LABELS).map((k) => [k, t(`criticality${k}`)]));

/**
 * Localized filter defs. `t` is optional so the untranslated call site
 * keeps working during migration; pass it to get Bulgarian.
 */
export function buildAssetFilters(t?: T, tGroup?: (k: string) => string) {
    if (!t) return assetFilterDefs.filters;
    const localized = {
        ...STATIC_DEFS,
        type: {
            ...STATIC_DEFS.type,
            label: t('type'),
            // Was 'Equipment category.' — untranslated, and named after the
            // Equipment table that no longer exists.
            description: t('filterTypeDesc'),
            ...(tGroup ? { group: tGroup('attributes') } : {}),
            options: optionsFromEnum(buildAssetTypeLabels(t)),
        },
        status: {
            ...STATIC_DEFS.status,
            label: t('statusLabel'),
            ...(tGroup ? { group: tGroup('attributes') } : {}),
            options: optionsFromEnum(buildAssetStatusLabels(t)),
        },
        criticality: {
            ...STATIC_DEFS.criticality,
            label: t('criticalityLabel'),
            ...(tGroup ? { group: tGroup('quantitative') } : {}),
            options: optionsFromEnum(buildAssetCriticalityLabels(t)),
        },
    };
    return createTypedFilterDefs()(localized).filters;
}

/**
 * Farm task-type catalog.
 *
 * A curated list of agriculture task types grouped by category, used to
 * classify a FARM_TASK. The chosen type's `key` + `category` are stored on
 * `Task.metadataJson` (farmTaskType / farmTaskCategory) — the IC Task module
 * is reused unchanged; this catalog is reference data, not a DB table.
 *
 * Provenance: the type names + category grouping are modelled on the
 * LiteFarm task-type catalog (concept/vocabulary only — LiteFarm is GPL, no
 * code was copied; see THIRD_PARTY_NOTICES.md). The keys, enum shape, and
 * TypeScript surface are our own.
 */

export const FARM_TASK_CATEGORIES = [
    'LAND_PREP',
    'PLANTING',
    'CROP_CARE',
    'PEST_DISEASE',
    'IRRIGATION',
    'HARVEST',
    'POST_HARVEST',
    'LIVESTOCK',
    'MAINTENANCE',
    'RECORDKEEPING',
    'OTHER',
] as const;

export type FarmTaskCategory = (typeof FARM_TASK_CATEGORIES)[number];

export interface FarmTaskType {
    /** Stable identifier stored in Task.metadataJson.farmTaskType. */
    key: string;
    /** Human label shown in the picker. */
    name: string;
    category: FarmTaskCategory;
}

export const FARM_TASK_TYPES: readonly FarmTaskType[] = [
    // Land preparation
    { key: 'TILLAGE', name: 'Tillage', category: 'LAND_PREP' },
    { key: 'BED_PREPARATION', name: 'Bed preparation', category: 'LAND_PREP' },
    { key: 'SOIL_AMENDMENT', name: 'Soil amendment', category: 'LAND_PREP' },
    { key: 'COVER_CROP', name: 'Cover crop', category: 'LAND_PREP' },
    // Planting
    { key: 'SEEDING', name: 'Seeding', category: 'PLANTING' },
    { key: 'TRANSPLANTING', name: 'Transplanting', category: 'PLANTING' },
    { key: 'PLANTING', name: 'Planting', category: 'PLANTING' },
    // Crop care
    { key: 'FERTILIZING', name: 'Fertilizing', category: 'CROP_CARE' },
    { key: 'WEEDING', name: 'Weeding', category: 'CROP_CARE' },
    { key: 'PRUNING', name: 'Pruning', category: 'CROP_CARE' },
    { key: 'THINNING', name: 'Thinning', category: 'CROP_CARE' },
    { key: 'MULCHING', name: 'Mulching', category: 'CROP_CARE' },
    // Pest / disease
    { key: 'SCOUTING', name: 'Scouting', category: 'PEST_DISEASE' },
    { key: 'PEST_CONTROL', name: 'Pest control', category: 'PEST_DISEASE' },
    { key: 'DISEASE_CONTROL', name: 'Disease control', category: 'PEST_DISEASE' },
    // Irrigation
    { key: 'IRRIGATION', name: 'Irrigation', category: 'IRRIGATION' },
    { key: 'IRRIGATION_REPAIR', name: 'Irrigation repair', category: 'IRRIGATION' },
    // Harvest
    { key: 'HARVESTING', name: 'Harvesting', category: 'HARVEST' },
    // Post-harvest
    { key: 'WASH_AND_PACK', name: 'Wash and pack', category: 'POST_HARVEST' },
    { key: 'STORAGE', name: 'Storage', category: 'POST_HARVEST' },
    // Livestock
    { key: 'LIVESTOCK_CARE', name: 'Livestock care', category: 'LIVESTOCK' },
    { key: 'GRAZING_MOVE', name: 'Move grazing', category: 'LIVESTOCK' },
    // Maintenance
    { key: 'CLEANING', name: 'Cleaning', category: 'MAINTENANCE' },
    { key: 'EQUIPMENT_MAINTENANCE', name: 'Equipment maintenance', category: 'MAINTENANCE' },
    { key: 'INFRASTRUCTURE', name: 'Infrastructure', category: 'MAINTENANCE' },
    // Recordkeeping
    { key: 'SOIL_SAMPLE', name: 'Soil sample', category: 'RECORDKEEPING' },
    { key: 'RECORD_KEEPING', name: 'Record keeping', category: 'RECORDKEEPING' },
    // Catch-all
    { key: 'OTHER', name: 'Other', category: 'OTHER' },
] as const;

const BY_KEY = new Map(FARM_TASK_TYPES.map((t) => [t.key, t]));

export const FARM_TASK_TYPE_KEYS = FARM_TASK_TYPES.map((t) => t.key);

/** Look up a catalog entry by key (undefined if not a known type). */
export function getFarmTaskType(key: string): FarmTaskType | undefined {
    return BY_KEY.get(key);
}

/** Type guard: is `key` a known farm task type? */
export function isFarmTaskType(key: string): boolean {
    return BY_KEY.has(key);
}

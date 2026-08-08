/**
 * Frontend-safe Zod schema for the new-asset modal form.
 *
 * Mirrors `<NewAssetFields>` (agricultural assets — machines, buildings,
 * equipment):
 *   - name — required.
 *   - type — one of the AssetType values.
 *   - status — ACTIVE / IN_MAINTENANCE / RETIRED.
 *   - criticality — optional LOW / MEDIUM / HIGH.
 *   - manufacturer / model / serialNumber — optional free text.
 *   - year — optional 4-digit year of manufacture / construction.
 *   - purchaseDate — optional ISO date string.
 *   - purchaseCost — optional non-negative amount.
 *   - ownerUserId — optional tenant-member reference (people picker).
 *   - location — optional free text.
 */
import { z } from 'zod';

export const ASSET_TYPE_VALUES = [
    'TRACTOR',
    'HARVESTER',
    'IMPLEMENT',
    'VEHICLE',
    'IRRIGATION',
    'BUILDING',
    'STORAGE',
    'LIVESTOCK_EQUIPMENT',
    'TOOL',
    'OTHER',
] as const;

export const ASSET_STATUS_VALUES = ['ACTIVE', 'IN_MAINTENANCE', 'RETIRED'] as const;
export const ASSET_CRITICALITY_VALUES = ['LOW', 'MEDIUM', 'HIGH'] as const;

const CURRENT_YEAR = 2026;

export const NewAssetFormSchema = z.object({
    name: z.string().trim().min(1, 'Asset name is required').max(255),
    type: z.enum(ASSET_TYPE_VALUES),
    status: z.enum(ASSET_STATUS_VALUES).default('ACTIVE'),
    criticality: z.enum(ASSET_CRITICALITY_VALUES).optional(),
    ownerUserId: z.string().trim().max(255).default(''),
    owner: z.string().trim().max(255).default(''),
    externalRef: z.string().trim().max(255).default(''),
    location: z.string().trim().max(255).default(''),
    /** Structured location (Location.id). Null when unset — the free-text
     *  `location` above is retained for detail a Location row cannot model. */
    locationId: z.string().trim().min(1).nullable().default(null),
    /** Straight-line depreciation denominator; see /costs machinery basis. */
    usefulLifeYears: z
        .number()
        .int('Must be a whole number of years')
        .min(1, 'Must be at least one year')
        .max(100, 'Useful life looks too long')
        .optional(),
    manufacturer: z.string().trim().max(255).default(''),
    model: z.string().trim().max(255).default(''),
    serialNumber: z.string().trim().max(255).default(''),
    year: z
        .number()
        .int('Must be a whole year')
        .min(1900, 'Year looks too early')
        .max(CURRENT_YEAR + 1, 'Year is in the future')
        .optional(),
    purchaseDate: z.string().trim().max(40).default(''),
    purchaseCost: z
        .number()
        .min(0, 'Must be zero or more')
        .max(1_000_000_000, 'Amount looks too large')
        .optional(),
});

export type NewAssetFormValues = z.input<typeof NewAssetFormSchema>;

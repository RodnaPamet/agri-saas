/**
 * Crop planning — the write schemas both the routes and the spec read.
 *
 * Seasons, crop types, varieties, crop plans and plantings. These were INLINE
 * consts in seven route files; they move here for the same reason the catalogue
 * ones did — a paths module cannot import a route file without dragging the
 * handler's import graph into the generator, and retyping a body in the spec is
 * the second spelling this repo keeps paying for.
 *
 * Lifted VERBATIM, including the custom messages. Nothing about validation
 * changes in this move; if it had, the point would be lost.
 *
 * ── `min(8)` on a date field means `yyyy-mm-dd` ──
 *
 * `firstSowDate`, `startDate` and `endDate` are `z.string().min(8)`. That is
 * this repo's idiom for a calendar DAY rather than an instant — eight is the
 * length of `2026-1-1` and the shortest thing that can be one. It is worth
 * naming because the READ side returns these columns as full ISO instants
 * (they are plain `DateTime`), so the write format and the read format for one
 * field genuinely differ.
 */
import { z } from 'zod';

export const CreateSeasonSchema = z
    .object({
        name: z.string().min(1, 'Season name is required').max(200),
        year: z.number().int().min(1900).max(3000).nullable().optional(),
        startDate: z.string().min(8, 'Start date is required'),
        endDate: z.string().min(8, 'End date is required'),
        status: z.enum(['PLANNING', 'ACTIVE', 'CLOSED']).optional(),
        notes: z.string().max(5000).nullable().optional(),
    })
    .strip();

export const UpdateSeasonSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        year: z.number().int().min(1900).max(3000).nullable().optional(),
        startDate: z.string().min(8).optional(),
        endDate: z.string().min(8).optional(),
        status: z.enum(['PLANNING', 'ACTIVE', 'CLOSED']).optional(),
        notes: z.string().max(5000).nullable().optional(),
    })
    .strip();

export const CreateCropTypeSchema = z
    .object({
        name: z.string().min(1, 'Crop type name is required').max(200),
        key: z.string().max(100).nullable().optional(),
        family: z.string().max(200).nullable().optional(),
        category: z.string().max(200).nullable().optional(),
        notes: z.string().max(5000).nullable().optional(),
    })
    .strip();

export const CreateCropVarietySchema = z
    .object({
        cropTypeId: z.string().min(1, 'A crop type is required'),
        name: z.string().min(1, 'Variety name is required').max(200),
        key: z.string().max(100).nullable().optional(),
        defaultMethod: z.enum(['DIRECT_SOW', 'TRANSPLANT']).nullable().optional(),
        daysToGermination: z.number().int().min(0).max(3650).nullable().optional(),
        daysToTransplant: z.number().int().min(0).max(3650).nullable().optional(),
        daysToMaturity: z.number().int().min(0).max(3650).nullable().optional(),
        harvestWindowDays: z.number().int().min(0).max(3650).nullable().optional(),
        inRowSpacingCm: z.number().min(0).max(100000).nullable().optional(),
        betweenRowSpacingCm: z.number().min(0).max(100000).nullable().optional(),
        seedsPerGram: z.number().min(0).max(1000000).nullable().optional(),
        germinationRate: z.number().min(0).max(1).nullable().optional(),
        seedsPerCell: z.number().int().min(0).max(100).nullable().optional(),
        soilDefaultsJson: z
            .object({
                phMin: z.number().min(0).max(14).nullable().optional(),
                phMax: z.number().min(0).max(14).nullable().optional(),
                texturePreference: z.array(z.string().max(40)).max(12).nullable().optional(),
                drainagePreference: z.enum(['well', 'moderate', 'poor']).nullable().optional(),
            })
            .strip()
            .nullable()
            .optional(),
        gddBaseC: z.number().min(0).max(30).nullable().optional(),
        gddToMaturity: z.number().int().min(0).max(10000).nullable().optional(),
        sourceUrn: z.string().max(500).nullable().optional(),
        notes: z.string().max(5000).nullable().optional(),
    })
    .strip();

export const CreateCropPlanSchema = z
    .object({
        seasonId: z.string().min(1, 'A season is required'),
        cropTypeId: z.string().min(1, 'A crop type is required'),
        cropVarietyId: z.string().nullable().optional(),
        locationId: z.string().nullable().optional(),
        parcelId: z.string().nullable().optional(),
        name: z.string().min(1, 'Crop plan name is required').max(200),
        method: z.enum(['DIRECT_SOW', 'TRANSPLANT']).optional(),
        firstSowDate: z.string().min(8, 'First sow date is required'),
        successions: z.number().int().min(1).max(365).optional(),
        intervalDays: z.number().int().min(0).max(365).optional(),
        plantsPerSuccession: z.number().int().min(0).max(10000000).nullable().optional(),
        bedLengthM: z.number().min(0).max(1000000).nullable().optional(),
        rowsPerBed: z.number().int().min(0).max(1000).nullable().optional(),
        targetAreaM2: z.number().min(0).max(100000000).nullable().optional(),
        status: z.enum(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
        notes: z.string().max(5000).nullable().optional(),
    })
    .strip();

export const UpdateCropPlanSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        cropVarietyId: z.string().nullable().optional(),
        locationId: z.string().nullable().optional(),
        parcelId: z.string().nullable().optional(),
        method: z.enum(['DIRECT_SOW', 'TRANSPLANT']).optional(),
        firstSowDate: z.string().min(8).optional(),
        successions: z.number().int().min(1).max(365).optional(),
        intervalDays: z.number().int().min(0).max(365).optional(),
        plantsPerSuccession: z.number().int().min(0).max(10000000).nullable().optional(),
        bedLengthM: z.number().min(0).max(1000000).nullable().optional(),
        rowsPerBed: z.number().int().min(0).max(1000).nullable().optional(),
        targetAreaM2: z.number().min(0).max(100000000).nullable().optional(),
        status: z.enum(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
        notes: z.string().max(5000).nullable().optional(),
    })
    .strip();

export const UpdatePlantingSchema = z
    .object({
        plannedYieldKgPerHa: z.number().min(0).max(1_000_000).nullable().optional(),
    })
    .strip();
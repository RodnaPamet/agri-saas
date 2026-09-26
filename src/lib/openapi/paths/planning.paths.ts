/**
 * Crop planning — seasons, crop types, varieties, plans and plantings.
 *
 * The highest-value surface still undocumented, and not because of its own
 * screens: `seasonId`, `cropPlanId`, `plantingId` and `cropTypeId` are FOREIGN
 * KEYS in payloads that were already documented. Grain costs carry a
 * `seasonId`, yield records carry a `plantingId`, parcel history nests a
 * `planting`, contracts carry a season. A client holding those ids had no
 * described way to turn any of them into a name.
 *
 * ── everything here is a RAW Prisma model ──
 *
 * None of these reads maps to a DTO. `listSeasons`, `listCropTypes`,
 * `listCropVarieties`, `listCropPlans` and `listPlantings` return rows straight
 * from `findMany`, so the soft-delete and retention bookkeeping columns are on
 * the wire too (`deletedAt`, `deletedByUserId`, `retentionUntil`,
 * `isSampleData`), always null or false on a row you can read. They are
 * documented rather than hidden, because a client that sees an undocumented key
 * has to guess whether it matters.
 *
 * ── every list is capped at 500 and says nothing about it ──
 *
 * `LIST_TAKE = 500` with no count and no truncation marker, on all five. The
 * grain module fixed this exact shape — it counts only when the page comes back
 * FULL, so a truncated page cannot read as a total — and planning has not. A
 * farm with more than 500 plantings receives 500 and is told they are all of
 * them. Documented, not changed: adding a count to five hot reads is a decision
 * about queries, not a doc fix.
 *
 * ── Decimal columns are decimal STRINGS ──
 *
 * `bedLengthM`, `targetAreaM2`, `areaM2`, `seedQuantityGrams`,
 * `plannedYieldKgPerHa`, the variety spacings, `seedsPerGram`,
 * `germinationRate` and `gddBaseC` are all `Decimal?` in Prisma and therefore
 * strings on the wire. The write side takes NUMBERS for the same fields. That
 * asymmetry is real and is the sort of thing a round-trip gets wrong silently.
 *
 * ── and the date fields differ between write and read ──
 *
 * `firstSowDate`, `startDate` and `endDate` are written as `yyyy-mm-dd`
 * (`z.string().min(8)`) and READ BACK as full ISO instants, because the columns
 * are plain `DateTime`. A client cannot use one formatter for both directions.
 */
import { z } from '@/lib/openapi/zod';
import {
    CropPlanStatus,
    PlantingMethod,
    PlantingStatus,
    SeasonStatus,
} from '@prisma/client';
import {
    CreateSeasonSchema,
    UpdateSeasonSchema,
    CreateCropTypeSchema,
    CreateCropVarietySchema,
    CreateCropPlanSchema,
    UpdateCropPlanSchema,
    UpdatePlantingSchema,
} from '@/app-layer/schemas/planning.schemas';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const p = (name: string) => TenantParams.extend({
    [name]: z.string().openapi({ param: { name, in: 'path' } }),
});

/** The bookkeeping every one of these raw models carries. */
const LIFECYCLE = {
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /** Seeded demo data. False for anything a farm created. */
    isSampleData: z.boolean(),
    /** Always null on a row you can read — these lists filter it. */
    deletedAt: z.string().datetime().nullable(),
    deletedByUserId: z.string().nullable().optional(),
    retentionUntil: z.string().datetime().nullable(),
};

const SeasonSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        key: z.string().nullable(),
        name: z.string(),
        year: z.number().nullable(),
        /** A full ISO INSTANT on read, though it is written as `yyyy-mm-dd`. */
        startDate: z.string().datetime(),
        endDate: z.string().datetime(),
        status: z.nativeEnum(SeasonStatus),
        notes: z.string().nullable(),
        ...LIFECYCLE,
    })
    .openapi('Season', {
        description:
            'A marketing/growing season — the `seasonId` that grain costs, yield records and contracts refer to. startDate and endDate come back as full instants even though they are written as calendar days.',
    });

const CropTypeSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        key: z.string().nullable(),
        name: z.string(),
        /**
         * Links the crop to the market vocabulary — null when the type has no
         * recognised commodity, which is why a contract can end up without a
         * benchmark.
         */
        commodityCanonical: z.string().nullable(),
        family: z.string().nullable(),
        category: z.string().nullable(),
        notes: z.string().nullable(),
        /** Variety count, from the list's `_count` include. */
        _count: z.object({ varieties: z.number() }).optional(),
        ...LIFECYCLE,
    })
    .openapi('CropType', {
        description:
            'A crop the farm grows. commodityCanonical is what joins it to market prices and contract benchmarking; null there is why a contract may get no benchmark. The LIST carries a `_count.varieties`; the create response does not.',
    });

const CropVarietySchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        cropTypeId: z.string(),
        key: z.string().nullable(),
        name: z.string(),
        defaultMethod: z.nativeEnum(PlantingMethod).nullable(),
        daysToGermination: z.number().nullable(),
        daysToTransplant: z.number().nullable(),
        daysToMaturity: z.number().nullable(),
        harvestWindowDays: z.number().nullable(),
        /** Decimal columns — STRINGS on the wire, numbers on the write. */
        inRowSpacingCm: z.string().nullable(),
        betweenRowSpacingCm: z.string().nullable(),
        seedsPerGram: z.string().nullable(),
        germinationRate: z.string().nullable(),
        seedsPerCell: z.number().nullable(),
        /** Curated soil preferences; drives the suitability verdict. */
        soilDefaultsJson: z.unknown().nullable(),
        gddBaseC: z.string().nullable(),
        gddToMaturity: z.number().nullable(),
        sourceUrn: z.string().nullable(),
        notes: z.string().nullable(),
        cropType: z.object({ id: z.string(), name: z.string() }).optional(),
        ...LIFECYCLE,
    })
    .openapi('CropVariety', {
        description:
            'A variety of a crop type. The spacing, seed-rate, germination and GDD-base columns are Decimal and therefore STRINGS here while the write side takes numbers. soilDefaultsJson holds the curated preferences the soil-suitability verdict compares a parcel against.',
    });

const CropPlanSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        seasonId: z.string(),
        cropTypeId: z.string(),
        cropVarietyId: z.string().nullable(),
        locationId: z.string().nullable(),
        parcelId: z.string().nullable(),
        name: z.string(),
        method: z.nativeEnum(PlantingMethod),
        firstSowDate: z.string().datetime(),
        successions: z.number(),
        intervalDays: z.number(),
        plantsPerSuccession: z.number().nullable(),
        bedLengthM: z.string().nullable(),
        rowsPerBed: z.number().nullable(),
        targetAreaM2: z.string().nullable(),
        status: z.nativeEnum(CropPlanStatus),
        notes: z.string().nullable(),
        season: z
            .object({ id: z.string(), name: z.string(), status: z.nativeEnum(SeasonStatus) })
            .optional(),
        cropType: z.object({ id: z.string(), name: z.string() }).optional(),
        variety: z
            .object({
                id: z.string(),
                name: z.string(),
                defaultMethod: z.nativeEnum(PlantingMethod).nullable(),
            })
            .nullable()
            .optional(),
        location: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
        parcel: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
        /** How many plantings this plan has generated. */
        _count: z.object({ plantings: z.number() }).optional(),
        ...LIFECYCLE,
    })
    .openapi('CropPlan', {
        description:
            'A sowing plan: one crop, one season, and the succession pattern that generates the plantings. `successions` and `intervalDays` describe the intent; the plantings themselves do not exist until POST /generate is called. _count.plantings is how a client tells a plan that has been generated from one that has not.',
    });

const PlantingSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        cropPlanId: z.string(),
        cropVarietyId: z.string().nullable(),
        locationId: z.string().nullable(),
        parcelId: z.string().nullable(),
        /** 1-based position within the plan's succession sequence. */
        successionNumber: z.number(),
        method: z.nativeEnum(PlantingMethod),
        sowDate: z.string().datetime().nullable(),
        transplantDate: z.string().datetime().nullable(),
        harvestStartDate: z.string().datetime().nullable(),
        harvestEndDate: z.string().datetime().nullable(),
        seedQuantityGrams: z.string().nullable(),
        plantCount: z.number().nullable(),
        areaM2: z.string().nullable(),
        plannedYieldKgPerHa: z.string().nullable(),
        status: z.nativeEnum(PlantingStatus),
        notes: z.string().nullable(),
        variety: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
        location: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
        parcel: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
        ...LIFECYCLE,
    })
    .openapi('Planting', {
        description:
            'One succession of a crop plan — the `plantingId` that yield records, cost entries and parcel history refer to. Generated from the plan rather than created directly; the only field a client may update is plannedYieldKgPerHa.',
    });

const GddDaySchema = z
    .object({
        date: z.string().date(),
        /** GDD accrued on this day; never negative. */
        gdd: z.number(),
        /** Running cumulative up to and including this day. */
        cumulative: z.number(),
    })
    .openapi('GddDay', { description: 'One day of growing-degree-day accumulation.' });

const PlantingGddSchema = z
    .object({
        plantingId: z.string(),
        /** Where accumulation starts. Null when the planting has no sow date. */
        sowDate: z.string().nullable(),
        baseTempC: z.number(),
        /** ZERO when there is no weather or no sow date — not an error. */
        totalGdd: z.number(),
        days: z.array(GddDaySchema),
        /**
         * The variety's GDD-to-maturity, when known. NULL means the UI shows
         * raw accumulated GDD with no maturity percentage — a missing target,
         * not a zero one.
         */
        targetGdd: z.number().nullable(),
    })
    .openapi('PlantingGdd', {
        description:
            'Growing-degree-day accumulation for one planting. totalGdd is 0 rather than null when there is no weather or no sow date, so a zero is not evidence of anything by itself — check sowDate. targetGdd null means no maturity percentage can be shown.',
    });

const SoilProfileSchema = z
    .object({
        wrbClass: z.string().nullable().optional(),
        /** USDA texture class — the primary label. */
        textureClass: z.string().nullable(),
        sandPct: z.number().nullable(),
        siltPct: z.number().nullable(),
        clayPct: z.number().nullable(),
        phH2o: z.number().nullable(),
        /** Soil organic carbon, g/kg. */
        socGkg: z.number().nullable(),
        /** Bulk density of the fine earth fraction, g/cm³. */
        bulkDensity: z.number().nullable(),
        depth: z.string(),
        /** Per-property spread, when the provider reports one. Partial. */
        uncertainty: z.record(z.string(), z.unknown()).optional(),
        provider: z.string(),
        fetchedAt: z.string().datetime(),
    })
    .openapi('SoilProfile', {
        description:
            'A parcel’s modelled soil profile, fetched asynchronously — null upstream while the fetch is pending, which is an ordinary state rather than an error.',
    });

const PlantingSoilSchema = z
    .object({
        /** NULL while the parcel's soil fetch is still pending. */
        soil: SoilProfileSchema.nullable(),
        soilType: z.string().nullable(),
        suitability: z
            .object({
                flag: z.enum(['good', 'caution', 'poor', 'unknown']),
                /** Plain-language, advisory in tone. */
                reason: z.string(),
                /** Structured drivers — what the agronomy copilot consumes. */
                reasons: z.array(z.string()),
            })
            .openapi('SoilSuitability', {
                description:
                    'An ADVISORY verdict. `unknown` is returned whenever the variety has no curated preferences or the parcel has no soil yet — never a fabricated verdict, so a client must render unknown as unknown rather than as a neutral pass.',
            }),
    })
    .openapi('PlantingSoilSuitability', {
        description:
            'Soil-aware suitability for one planting, comparing the parcel’s modelled soil to the variety’s curated preferences. Advisory only.',
    });

const OkSchema = z
    .object({ success: z.boolean() })
    .openapi('PlanningAck', { description: 'Acknowledgement only.' });

const CAP_NOTE =
    '\n\n**Capped at 500 with no marker.** There is no total and no truncation flag, so a tenant with more than 500 receives 500 and cannot tell.';

export function registerPlanningPaths(registry: OpenAPIRegistry): void {
    // ── Seasons ──
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/planning/seasons',
        operationId: 'listSeasons',
        summary: 'List seasons',
        description:
            'Seasons newest-start first. This is how a client resolves the `seasonId` carried by grain costs, yield records and contracts.' +
            CAP_NOTE,
        tags: ['Planning'],
        params: TenantParams,
        success: { status: 200, description: 'The seasons. A BARE ARRAY.', schema: z.array(SeasonSchema) },
    });
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/planning/seasons',
        operationId: 'createSeason',
        summary: 'Create a season',
        description:
            '`startDate` and `endDate` are calendar days (`yyyy-mm-dd`) on the way in and come back as full instants.',
        tags: ['Planning'],
        params: TenantParams,
        body: CreateSeasonSchema,
        success: { status: 200, description: 'The created season.', schema: SeasonSchema },
    });
    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/planning/seasons/{seasonId}',
        operationId: 'updateSeason',
        summary: 'Update a season',
        tags: ['Planning'],
        params: p('seasonId'),
        body: UpdateSeasonSchema,
        success: { status: 200, description: 'The updated season.', schema: SeasonSchema },
    });

    // ── Crop types ──
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/planning/crop-types',
        operationId: 'listCropTypes',
        summary: 'List crop types',
        description:
            'The tenant’s crops, by name, each with its variety count. Cached for a day server-side and invalidated by a create, so a client may cache it too.' +
            CAP_NOTE,
        tags: ['Planning'],
        params: TenantParams,
        success: { status: 200, description: 'The crop types. A BARE ARRAY.', schema: z.array(CropTypeSchema) },
    });
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/planning/crop-types',
        operationId: 'createCropType',
        summary: 'Create a crop type',
        tags: ['Planning'],
        params: TenantParams,
        body: CreateCropTypeSchema,
        success: { status: 200, description: 'The created crop type. No `_count`.', schema: CropTypeSchema },
    });

    // ── Varieties ──
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/planning/crop-varieties',
        operationId: 'listCropVarieties',
        summary: 'List crop varieties',
        description:
            'Varieties by name, each carrying its crop type. `cropTypeId` narrows to one crop. Cached for a day.' +
            CAP_NOTE,
        tags: ['Planning'],
        params: TenantParams,
        query: z.object({ cropTypeId: z.string().optional() }),
        success: { status: 200, description: 'The varieties. A BARE ARRAY.', schema: z.array(CropVarietySchema) },
    });
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/planning/crop-varieties',
        operationId: 'createCropVariety',
        summary: 'Create a crop variety',
        description:
            'Note the direction of the Decimal fields: spacings, `seedsPerGram`, `germinationRate` and `gddBaseC` are sent as NUMBERS and read back as decimal STRINGS.',
        tags: ['Planning'],
        params: TenantParams,
        body: CreateCropVarietySchema,
        success: { status: 200, description: 'The created variety.', schema: CropVarietySchema },
    });

    // ── Crop plans ──
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/planning/crop-plans',
        operationId: 'listCropPlans',
        summary: 'List crop plans',
        description:
            'Plans with their season, crop type, variety, location, parcel and a `_count.plantings`. `status` is a COMMA-SEPARATED multi-value param.' +
            CAP_NOTE,
        tags: ['Planning'],
        params: TenantParams,
        query: z.object({
            seasonId: z.string().optional(),
            cropTypeId: z.string().optional(),
            status: z.string().optional().openapi({ description: 'CSV of CropPlanStatus.' }),
        }),
        success: { status: 200, description: 'The plans. A BARE ARRAY.', schema: z.array(CropPlanSchema) },
    });
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/planning/crop-plans',
        operationId: 'createCropPlan',
        summary: 'Create a crop plan',
        description:
            'Creates the PLAN only. No plantings exist until `POST /crop-plans/{id}/generate` is called — `_count.plantings` of 0 is the tell.',
        tags: ['Planning'],
        params: TenantParams,
        body: CreateCropPlanSchema,
        success: { status: 200, description: 'The created plan.', schema: CropPlanSchema },
    });
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/planning/crop-plans/{cropPlanId}',
        operationId: 'getCropPlan',
        summary: 'Get one crop plan',
        tags: ['Planning'],
        params: p('cropPlanId'),
        success: { status: 200, description: 'The plan.', schema: CropPlanSchema },
    });
    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/planning/crop-plans/{cropPlanId}',
        operationId: 'updateCropPlan',
        summary: 'Update a crop plan',
        description:
            '`seasonId` and `cropTypeId` are NOT updatable — they are absent from the body schema, so a plan cannot be moved between seasons or crops by editing it.',
        tags: ['Planning'],
        params: p('cropPlanId'),
        body: UpdateCropPlanSchema,
        success: { status: 200, description: 'The updated plan.', schema: CropPlanSchema },
    });
    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/planning/crop-plans/{cropPlanId}',
        operationId: 'deleteCropPlan',
        summary: 'Delete a crop plan',
        description: 'Soft-deletes the plan. Answers with an acknowledgement, not the plan.',
        tags: ['Planning'],
        params: p('cropPlanId'),
        success: { status: 200, description: 'Acknowledged.', schema: OkSchema },
    });
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/planning/crop-plans/{cropPlanId}/generate',
        operationId: 'generatePlantings',
        summary: 'Generate the plan’s plantings',
        description:
            'Materialises the succession pattern into PLANTINGS — `successions` rows spaced `intervalDays` apart from `firstSowDate`. This is the only way plantings come into existence; there is no create-planting route. ' +
            '\n\nRead `_count.plantings` on the plan before calling if you need to know whether it has already been generated.',
        tags: ['Planning'],
        params: p('cropPlanId'),
        success: { status: 200, description: 'The generated plantings.', schema: z.array(PlantingSchema) },
    });

    // ── Plantings ──
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/planning/plantings',
        operationId: 'listPlantings',
        summary: 'List plantings',
        description:
            'Plantings in succession order, each with its variety, location and parcel. Filter by `cropPlanId` and/or `status`. This resolves the `plantingId` that yield records, cost entries and parcel history carry.' +
            CAP_NOTE,
        tags: ['Planning'],
        params: TenantParams,
        query: z.object({ cropPlanId: z.string().optional(), status: z.string().optional() }),
        success: { status: 200, description: 'The plantings. A BARE ARRAY.', schema: z.array(PlantingSchema) },
    });
    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/planning/plantings/{plantingId}',
        operationId: 'updatePlanting',
        summary: 'Update a planting',
        description:
            'ONE field is updatable: `plannedYieldKgPerHa`. Everything else about a planting comes from the plan that generated it.',
        tags: ['Planning'],
        params: p('plantingId'),
        body: UpdatePlantingSchema,
        success: { status: 200, description: 'The updated planting.', schema: PlantingSchema },
    });
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/planning/plantings/{plantingId}/gdd',
        operationId: 'getPlantingGdd',
        summary: 'Growing-degree-day accumulation',
        description:
            'Per-day and cumulative GDD from the sow date. `totalGdd` is 0 — not null — when there is no weather or no sow date, so a zero alone proves nothing; check `sowDate`. `targetGdd` null means no maturity percentage is showable.',
        tags: ['Planning'],
        params: p('plantingId'),
        success: { status: 200, description: 'The accumulation.', schema: PlantingGddSchema },
    });
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/planning/plantings/{plantingId}/soil',
        operationId: 'getPlantingSoilSuitability',
        summary: 'Soil suitability for a planting',
        description:
            'Compares the parcel’s modelled soil against the variety’s curated preferences. ADVISORY: the verdict is `unknown` whenever the variety has no preferences or the parcel’s soil is still pending, and `soil` is null in the latter case — an ordinary state, since soil is fetched asynchronously, not an error.',
        tags: ['Planning'],
        params: p('plantingId'),
        success: { status: 200, description: 'The verdict.', schema: PlantingSoilSchema },
    });
}

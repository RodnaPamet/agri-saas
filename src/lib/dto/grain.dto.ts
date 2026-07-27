/**
 * Enterprise-grain DTOs — response shapes for the GRAIN-module API
 * (contracts, yield records, grain bins, per-activity cost rollup) and
 * the org-level grain portfolio summary.
 *
 * Field types mirror what the routes ACTUALLY serialise:
 *   - `Contract` is returned as the raw Prisma model
 *     (`listContracts` / `getContract`), so its `Decimal` columns
 *     (`volumeTonnes`, `pricePerTonne`) serialise to JSON STRINGS
 *     (Prisma `Decimal.toJSON()` → string), and dates to ISO strings.
 *   - `YieldRecord`, `GrainBin` and `GrainCostRow` are mapped to DTOs
 *     in their usecases (`yield-record.ts::toDto`, `grain-bin.ts`,
 *     `cost-rollup.ts`) which convert `Decimal` → number, so those
 *     numeric fields are JSON NUMBERS.
 *
 * The encrypted free-text columns (Contract.terms / pricingNotes,
 * YieldRecord.valuationNotes) decrypt transparently on read and are
 * plain strings on the wire.
 */
import { z } from '@/lib/openapi/zod';

// ─── Season summary sub-shape (shared include) ───

const GrainSeasonRefSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        status: z.string().optional(),
    })
    .passthrough();

// ─── Contract ───
// Raw Prisma model (listContracts / getContract). Decimals serialise
// as strings; the `season` include is present when the contract is
// linked to a marketing-year season.

export const ContractDTOSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        seasonId: z.string().nullable().optional(),
        key: z.string().nullable().optional(),
        counterparty: z.string(),
        commodity: z.string().nullable().optional(),
        type: z.enum(['SALE', 'PURCHASE']),
        status: z.string(),
        // Decimal → string over JSON.
        volumeTonnes: z.string().nullable().optional(),
        pricePerTonne: z.string().nullable().optional(),
        priceCurrency: z.string().nullable().optional(),
        deliveryStart: z.string().nullable().optional(),
        deliveryEnd: z.string().nullable().optional(),
        // ENCRYPTED at rest (Epic B) — plaintext on read.
        terms: z.string().nullable().optional(),
        pricingNotes: z.string().nullable().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        season: GrainSeasonRefSchema.nullable().optional(),
    })
    .passthrough()
    .openapi('Contract', {
        description:
            'Grain marketing/supply contract — a forward SALE of produce or PURCHASE of inputs against a counterparty. volumeTonnes/pricePerTonne are decimal strings; terms/pricingNotes are encrypted at rest and returned decrypted.',
    });

export type ContractDTO = z.infer<typeof ContractDTOSchema>;

// ─── YieldRecord ───
// Mapped DTO (yield-record.ts::toDto). Numeric Decimals → numbers;
// tPerHa is COMPUTED (grossTonnes / areaHa), not stored.

export const YieldRecordDTOSchema = z
    .object({
        id: z.string(),
        plantingId: z.string().nullable().optional(),
        locationId: z.string().nullable().optional(),
        seasonId: z.string().nullable().optional(),
        commodity: z.string().nullable().optional(),
        harvestedAt: z.string().nullable().optional(),
        grossTonnes: z.number().nullable(),
        moisturePct: z.number().nullable(),
        areaHa: z.number().nullable(),
        /** Computed yield intensity = grossTonnes / areaHa (null when area is 0/absent). */
        tPerHa: z.number().nullable(),
        valuationNotes: z.string().nullable().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        planting: z
            .object({ id: z.string(), successionNumber: z.number() })
            .passthrough()
            .nullable()
            .optional(),
        location: z
            .object({ id: z.string(), name: z.string() })
            .passthrough()
            .nullable()
            .optional(),
        season: GrainSeasonRefSchema.nullable().optional(),
    })
    .passthrough()
    .openapi('YieldRecord', {
        description:
            'Actual harvest production total. tPerHa is computed (grossTonnes / areaHa) and not stored. valuationNotes is encrypted at rest and returned decrypted.',
    });

export type YieldRecordDTO = z.infer<typeof YieldRecordDTOSchema>;

// ─── GrainBin ───
// BinDto (grain-bin.ts). A BIN/STORAGE Location with computed fill.

export const GrainBinDTOSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        key: z.string().nullable(),
        kind: z.enum(['BIN', 'STORAGE']),
        /** Location lifecycle. ARCHIVED bins are shown but excluded from org capacity metrics. */
        status: z.enum(['ACTIVE', 'ARCHIVED']),
        description: z.string().nullable(),
        capacityTonnes: z.number().nullable(),
        /** HARVESTED_PRODUCE stock CONVERTED to tonnes (the capacity's unit). */
        storedTonnes: z.number(),
        /** Number of stored produce lots, including unconvertible ones. */
        lotCount: z.number(),
        /** storedTonnes / capacityTonnes; null without a capacity or when mixedUnits. */
        fillPct: z.number().nullable(),
        /** True when the bin holds stock that has no tonnage, so fillPct is null. */
        mixedUnits: z.boolean(),
        /** Per-unit breakdown of that unconvertible stock; empty when clean. */
        unconvertible: z
            .array(
                z.object({
                    unitKey: z.string(),
                    symbol: z.string(),
                    quantity: z.number(),
                    lotCount: z.number(),
                }),
            )
            .default([]),
    })
    .passthrough()
    .openapi('GrainBin', {
        description:
            "A grain bin — a BIN/STORAGE Location with a computed fill. storedTonnes is the bin's HARVESTED_PRODUCE stock converted into tonnes via each lot's unit, so it is comparable to capacityTonnes; fillPct is the fraction of capacity used. Stock in a unit with no tonnage (COUNT/VOLUME) is reported in `unconvertible` and sets `mixedUnits`, which suppresses fillPct rather than being counted at face value.",
    });

export type GrainBinDTO = z.infer<typeof GrainBinDTOSchema>;

// ─── Grain cost rollup rows ───
// The /grain/costs endpoint returns ONE of three shapes depending on
// ?by=planting|season|field. Only the planting row was documented, and it
// had drifted from the usecase — so the published contract described a
// `currency` field that no longer exists and omitted the per-hectare and
// per-tonne figures. All three are described here.

/** Fields every cost row carries, whatever it is grouped by. */
const CostRowCommon = {
    logEntryCost: z.number(),
    stockCost: z.number(),
    totalCost: z.number(),
    /** Distinct currencies the costs were recorded in. */
    currencies: z.array(z.string()),
    /** True when the row sums more than one currency — the total is then
     *  not a meaningful single figure and per-unit costs are withheld. */
    currencyMixed: z.boolean(),
};

/** Denominators, present on the season and field rollups. */
const CostRowDenominators = {
    costPerHa: z.number().nullable(),
    costPerTonne: z.number().nullable(),
    harvestedAreaHa: z.number().nullable(),
    producedTonnes: z.number().nullable(),
};

export const GrainCostRowDTOSchema = z
    .object({
        plantingId: z.string(),
        plantingName: z.string(),
        cropVariety: z.string().nullable(),
        seasonId: z.string().nullable(),
        locationId: z.string().nullable(),
        ...CostRowCommon,
    })
    .passthrough()
    .openapi('GrainCostRow', {
        description:
            'One row of the grain cost rollup grouped by planting. totalCost = logEntryCost + stockCost. Cost attributed to a planting: journal entries linked to it plus the stock CONSUMED against those entries. An entry covering several plantings is split evenly between them.',
    });

export type GrainCostRowDTO = z.infer<typeof GrainCostRowDTOSchema>;

export const GrainSeasonCostRowDTOSchema = z
    .object({
        seasonId: z.string().nullable(),
        seasonName: z.string().nullable(),
        plantingCount: z.number(),
        ...CostRowCommon,
        ...CostRowDenominators,
    })
    .passthrough()
    .openapi('GrainSeasonCostRow', {
        description:
            'Grain cost rolled up to a season, with cost per harvested hectare and per tonne. Per-unit figures are null when the yield register has no area/tonnage for the season, or when the costs span multiple currencies.',
    });

export type GrainSeasonCostRowDTO = z.infer<typeof GrainSeasonCostRowDTOSchema>;

export const GrainFieldCostRowDTOSchema = z
    .object({
        locationId: z.string().nullable(),
        locationName: z.string().nullable(),
        plantingCount: z.number(),
        ...CostRowCommon,
        ...CostRowDenominators,
    })
    .passthrough()
    .openapi('GrainFieldCostRow', {
        description:
            'Grain cost rolled up to a field, with cost per harvested hectare and per tonne. Same null rules as the season row.',
    });

export type GrainFieldCostRowDTO = z.infer<typeof GrainFieldCostRowDTOSchema>;

// ─── PortfolioGrainSummary ───
// Org-level cross-tenant aggregation (portfolio-grain.ts). Numbers
// throughout (Decimals converted in the usecase).

const PortfolioGrainTenantRowSchema = z
    .object({
        tenantId: z.string(),
        tenantName: z.string(),
        contractedSaleTonnes: z.number(),
        contractedPurchaseTonnes: z.number(),
        totalYieldTonnes: z.number(),
        totalActivityCost: z.number(),
        currency: z.string().nullable(),
        binCount: z.number(),
        binCapacityTonnes: z.number(),
        binStoredTonnes: z.number(),
    })
    .passthrough();

const PortfolioGrainTotalsSchema = z
    .object({
        contractedSaleTonnes: z.number(),
        contractedPurchaseTonnes: z.number(),
        totalYieldTonnes: z.number(),
        totalActivityCost: z.number(),
        currency: z.string().nullable(),
        binCount: z.number(),
        binCapacityTonnes: z.number(),
        binStoredTonnes: z.number(),
        /** binStoredTonnes / binCapacityTonnes × 100 (clamped); null when no capacity. */
        binUtilisationPct: z.number().nullable(),
        tenantsWithGrain: z.number(),
        tenantsTotal: z.number(),
    })
    .passthrough();

export const PortfolioGrainSummaryDTOSchema = z
    .object({
        organizationId: z.string(),
        organizationSlug: z.string(),
        generatedAt: z.string(),
        totals: PortfolioGrainTotalsSchema,
        perTenant: z.array(PortfolioGrainTenantRowSchema),
    })
    .passthrough()
    .openapi('PortfolioGrainSummary', {
        description:
            'Org-level grain portfolio rollup: contracted volume (sale/purchase), harvested yield, activity cost and bin storage aggregated across every child farm tenant, with org totals plus a per-tenant breakdown. Each per-tenant figure is computed inside an RLS-bound query against that tenant.',
    });

export type PortfolioGrainSummaryDTO = z.infer<typeof PortfolioGrainSummaryDTOSchema>;

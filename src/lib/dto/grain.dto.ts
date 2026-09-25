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
 *   - `YieldRecord`, `CostEntry`, `GrainBin` and `GrainCostRow` are mapped
 *     to DTOs in their usecases (`yield-record.ts::toDto`,
 *     `cost-entry.ts::toDto`, `grain-bin.ts`, `cost-rollup.ts`) which
 *     convert `Decimal` → number, so those numeric fields are JSON
 *     NUMBERS.
 *
 * The encrypted free-text columns (Contract.terms / pricingNotes,
 * YieldRecord.valuationNotes) decrypt transparently on read and are
 * plain strings on the wire.
 */
import { z } from '@/lib/openapi/zod';
// The read side reuses the WRITE side's enums rather than respelling them.
// Two independent spellings of one enum is how a value becomes writable and
// undocumented, or documented and unwritable.
import { CostCategorySchema, CostAllocationBasisSchema } from '@/app-layer/schemas/grain.schemas';

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
        /**
         * The NORMALISED commodity name, and the key market benchmarking
         * joins on — a contract whose `commodity` is free text the matcher
         * did not recognise has this null and gets no benchmark.
         */
        commodityCanonical: z.string().nullable().optional(),
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
            'Grain marketing/supply contract — a forward SALE of produce or PURCHASE of inputs against a counterparty. volumeTonnes/pricePerTonne are decimal strings; terms/pricingNotes are encrypted at rest and returned decrypted. This is the RAW model as create and single-read return it: the soft-delete bookkeeping columns (deletedAt, deletedByUserId, retentionUntil) are on the wire too and are always null on a contract you can read, so they are described here rather than as fields. The LIST endpoint returns this shape plus computed fulfilment/valueAmount/benchmark decorations, which are not part of this schema.',
    });

export type ContractDTO = z.infer<typeof ContractDTOSchema>;

// ─── YieldRecord ───
// Mapped DTO (yield-record.ts::toDto). Numeric Decimals → numbers;
// tPerHa is COMPUTED, not stored — from `netTonnesStd ?? grossTonnes`,
// NOT from grossTonnes alone. `tPerHaBasis` names which was used.

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
        /**
         * Moisture-standardised tonnage. Present on BOTH the list and the
         * single read (`YIELD_LIST_SELECT` projects it), so it is required
         * here rather than optional — absent would be a different claim.
         */
        netTonnesStd: z.number().nullable(),
        /**
         * Computed yield intensity, from `netTonnesStd ?? grossTonnes`
         * divided by `areaHa` — null when area is 0 or absent.
         */
        tPerHa: z.number().nullable(),
        /**
         * WHICH tonnage `tPerHa` was divided from.
         *
         * Not decoration. Two records can carry a t/ha computed on
         * different bases — one standardised, one gross — and the mapper's
         * own comment says the DTO is what stops them being compared
         * silently. It was missing here, so the spec made that impossible:
         * a client could show two figures side by side with no way to know
         * they were not on the same basis.
         */
        tPerHaBasis: z.enum(['standard-moisture', 'gross']),
        /**
         * Encrypted commercial free text. ABSENT (not null) on list rows —
         * `YIELD_LIST_SELECT` omits it. `null` means this record has no
         * notes; absent means they were not sent on this read.
         */
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
            'Actual harvest production total. tPerHa is computed and not stored — from netTonnesStd when a standardised tonnage exists, otherwise grossTonnes; tPerHaBasis says which, so two t/ha figures are never compared across different bases. valuationNotes is encrypted at rest, returned decrypted, and is absent (not null) on list rows.',
    });

export type YieldRecordDTO = z.infer<typeof YieldRecordDTOSchema>;

// ─── CostEntry ───
// Mapped DTO (cost-entry.ts::toDto), shared by ALL FIVE cost operations —
// list, single read, create, update, delete-restore. One mapper means one
// shape, so this schema is written against `toDto`'s return and nothing
// else.
//
// Two absences here carry meaning, and both are DELIBERATE server-side
// decisions rather than oversights:
//
//   `description` is projected only on a single read. It is encrypted
//   commercial free text whose sole renderer is the write-gated edit form,
//   so broadcasting it on a list would decrypt it into every reader's
//   payload — including readers who can never open that form. ABSENT
//   therefore means "not sent on this read"; `null` means "this entry has
//   none". A client that collapses the two shows "no description" over a
//   row that has one.
//
//   `allocationParcels` never reaches the wire at all. The mapper flattens
//   the join rows to `allocationParcelIds` — sorted, because an unsorted
//   list makes a payload change when a query planner does, and the ids are
//   the allocation DENOMINATOR, so a list that comes back shorter than it
//   went in moves money.

const CostPlantingRefSchema = z
    .object({
        id: z.string(),
        successionNumber: z.number(),
        cropPlan: z.object({ name: z.string().nullable() }).passthrough().nullable().optional(),
    })
    .passthrough();

const CostNamedRefSchema = z.object({ id: z.string(), name: z.string() }).passthrough();

export const CostEntryDTOSchema = z
    .object({
        id: z.string(),
        category: CostCategorySchema,
        /**
         * Decimal → number, and `?? 0` in the mapper: an entry with no
         * amount reads as 0, never null.
         */
        amount: z.number(),
        currency: z.string(),
        incurredOn: z.string(),
        supplier: z.string().nullable(),
        invoiceFileId: z.string().nullable(),
        plantingId: z.string().nullable(),
        seasonId: z.string().nullable(),
        locationId: z.string().nullable(),
        parcelId: z.string().nullable(),
        leaseId: z.string().nullable(),
        itemId: z.string().nullable(),
        /** Defaulted to TARGET by the mapper, so always present on the wire. */
        allocationBasis: CostAllocationBasisSchema,
        /**
         * The PARCEL_SUBSET denominator, flattened from the join rows and
         * SORTED. Empty for every other basis.
         */
        allocationParcelIds: z.array(z.string()),
        createdByUserId: z.string().nullable(),
        /** Single-read only — see the note above. Absent ≠ null. */
        description: z.string().nullable().optional(),
        createdAt: z.string(),
        updatedAt: z.string(),
        planting: CostPlantingRefSchema.nullable(),
        season: CostNamedRefSchema.nullable(),
        location: CostNamedRefSchema.nullable(),
        parcel: CostNamedRefSchema.nullable(),
        item: z
            .object({ id: z.string(), name: z.string(), category: z.string() })
            .passthrough()
            .nullable(),
        invoiceFile: z
            .object({
                id: z.string(),
                originalName: z.string(),
                mimeType: z.string(),
                sizeBytes: z.number(),
            })
            .passthrough()
            .nullable(),
    })
    .passthrough()
    .openapi('CostEntry', {
        description:
            'One recorded cost against land, a planting, a season or an inventory item. amount is a JSON number (Decimal converted, absent reads as 0). allocationBasis says WHICH land the cost spreads across and allocationParcelIds is the PARCEL_SUBSET denominator, sorted. description is encrypted commercial free text returned only on a single read — it is ABSENT rather than null on list rows, which is a different claim from "this entry has no description".',
    });

export type CostEntryDTO = z.infer<typeof CostEntryDTOSchema>;

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
// LEGACY (the rollup this described was dropped when /grain/costs became
// the cost-entry register; these DTOs remain for the usecase's own
// consumers, e.g. the net-worth calculator).
// The retired rollup endpoint returned ONE of three shapes depending on
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

// ─── List envelopes ───
//
// `{ rows, totalCount, truncated }`, which is the GRAIN module's convention
// and NOT the `{ items, pageInfo }` one `pagination.ts` documents as the
// standard. The divergence is recorded rather than quietly reconciled: these
// endpoints have shipped this shape to the web client since the module
// landed, and renaming a key is a breaking change for a client that exists.
//
// `truncated` is the load-bearing field. The read is capped, and when the cap
// is hit rows are DROPPED — so a total computed off `rows` is simply wrong on
// a truncated page, and `totalCount` is the only honest denominator. Both are
// required for that reason: a client cannot decide to ignore them.

const listEnvelope = (rows: z.ZodTypeAny) =>
    z.object({
        rows: z.array(rows),
        /** The full count, queried only when the page came back FULL. */
        totalCount: z.number(),
        /** True when the cap was hit and rows were dropped from this page. */
        truncated: z.boolean(),
    });

export const CostEntryListSchema = listEnvelope(CostEntryDTOSchema).openapi('CostEntryList', {
    description:
        'A capped page of cost entries. When truncated is true rows were DROPPED, so any total computed from rows is wrong — use totalCount.',
});

export const YieldRecordListSchema = listEnvelope(YieldRecordDTOSchema).openapi('YieldRecordList', {
    description:
        'A capped page of yield records. When truncated is true rows were DROPPED, so any total computed from rows is wrong — use totalCount. Note that valuationNotes is absent from these rows by design.',
});

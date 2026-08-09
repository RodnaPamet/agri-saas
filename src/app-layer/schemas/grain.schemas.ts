/**
 * Enterprise-grain — Zod schemas for the contract / yield-record / grain-bin
 * / blend / cost-rollup usecase inputs (shared between the route handlers
 * and the usecases).
 *
 * Convention mirrors the other domain schema modules:
 *   - numeric magnitudes (volumeTonnes, pricePerTonne, grossTonnes, …)
 *     stay PLAIN Decimals — accepted as `number | null` so the portfolio /
 *     yield / cost rollups can SUM them in-DB.
 *   - free text (counterparty / commodity / key / terms / pricingNotes /
 *     valuationNotes / bin name+description) is `sanitizePlainText`'d at
 *     the usecase boundary, NOT here — these schemas only shape + bound the
 *     wire input. `terms` / `pricingNotes` / `valuationNotes` are
 *     additionally encrypted at rest via the Epic B manifest.
 */
import { z } from 'zod';
import { MAX_PLAUSIBLE_MOISTURE_PCT } from '@/lib/grain/moisture';
import {
    ContractType,
    ContractStatus,
    LocationKind,
} from '@prisma/client';

// ─── Shared field shapes ─────────────────────────────────────────────

/** An optional free-text string — `undefined` (skip) / `null` (clear) / value. */
const OptionalText = (max: number) =>
    z.union([z.string().max(max), z.null()]).optional();

/** A required short identifier-style string. */
const ShortText = (max: number) => z.string().min(1).max(max);

/** A plain numeric magnitude column: `number | null`, finite, non-negative. */
const NonNegativeNumber = z
    .number()
    .finite()
    .min(0, 'must be zero or positive')
    .nullable()
    .optional();

/**
 * A magnitude bounded to what its DECIMAL column can actually hold.
 *
 * Without an upper bound the API accepted any finite number and handed it
 * to Postgres, where a value wider than the column's precision raises
 * `22003 numeric field overflow` — surfacing to the user as a 500 on a
 * request that was simply out of range. `Decimal(p,s)` holds values below
 * 10^(p−s), so that exponent is the ceiling here and the failure becomes a
 * 400 that names the field.
 */
const BoundedNumber = (max: number, label: string) =>
    z
        .number()
        .finite()
        .min(0, 'must be zero or positive')
        .max(max, `${label} must be ${max} or less`)
        .nullable()
        .optional();

/**
 * Moisture %, bounded to a physically plausible reading.
 *
 * `Decimal(5,2)` accepted 999.99%, which is not a wet harvest — it is a
 * typo, and it produced a NEGATIVE moisture-adjusted tonnage once the
 * standard-basis conversion started using this field (see
 * `src/lib/grain/moisture.ts`). Bounding the input is what keeps that
 * formula's output physical.
 */
const MoisturePercent = z
    .number()
    .finite()
    .min(0, 'must be zero or positive')
    .max(MAX_PLAUSIBLE_MOISTURE_PCT, `moisture must be ${MAX_PLAUSIBLE_MOISTURE_PCT}% or less`)
    .nullable()
    .optional();

/** A date string (ISO / yyyy-mm-dd). Parsed + validated in the usecase. */
const DateString = z.union([z.string().min(8), z.null()]).optional();

// ═════════════════════════════════════════════════════════════════════
//  Contracts
// ═════════════════════════════════════════════════════════════════════

export const CreateContractSchema = z
    .object({
        seasonId: z.string().min(1).nullable().optional(),
        key: OptionalText(120),
        counterparty: ShortText(200),
        commodity: OptionalText(120),
        type: z.nativeEnum(ContractType).optional(),
        status: z.nativeEnum(ContractStatus).optional(),
        volumeTonnes: NonNegativeNumber,
        pricePerTonne: NonNegativeNumber,
        priceCurrency: OptionalText(8),
        deliveryStart: DateString,
        deliveryEnd: DateString,
        terms: OptionalText(20000),
        pricingNotes: OptionalText(8000),
    })
    .strip();

export type CreateContractInput = z.infer<typeof CreateContractSchema>;

export const UpdateContractSchema = z
    .object({
        seasonId: z.string().min(1).nullable().optional(),
        key: OptionalText(120),
        counterparty: z.string().min(1).max(200).optional(),
        commodity: OptionalText(120),
        type: z.nativeEnum(ContractType).optional(),
        status: z.nativeEnum(ContractStatus).optional(),
        volumeTonnes: NonNegativeNumber,
        pricePerTonne: NonNegativeNumber,
        priceCurrency: OptionalText(8),
        deliveryStart: DateString,
        deliveryEnd: DateString,
        terms: OptionalText(20000),
        pricingNotes: OptionalText(8000),
    })
    .strip();

export type UpdateContractInput = z.infer<typeof UpdateContractSchema>;

// ═════════════════════════════════════════════════════════════════════
//  Grain deliveries (fulfilment against a contract)
// ═════════════════════════════════════════════════════════════════════

export const CreateGrainDeliverySchema = z
    .object({
        contractId: z.string().min(1),
        deliveredAt: z.string().min(8),
        // Strictly positive: a zero-tonne delivery closes nothing, and a
        // negative one is a correction that belongs as a deletion of the
        // wrong ticket, not a phantom "negative delivery" row.
        tonnes: z.number().finite().positive('must be greater than zero'),
        reference: OptionalText(120),
    })
    .strip();

export type CreateGrainDeliveryInput = z.infer<typeof CreateGrainDeliverySchema>;

// ═════════════════════════════════════════════════════════════════════
//  Yield records
// ═════════════════════════════════════════════════════════════════════

export const CreateYieldRecordSchema = z
    .object({
        plantingId: z.string().min(1).nullable().optional(),
        locationId: z.string().min(1).nullable().optional(),
        seasonId: z.string().min(1).nullable().optional(),
        commodity: OptionalText(120),
        harvestedAt: DateString,
        grossTonnes: BoundedNumber(99_999_999_999, 'gross tonnes'),
        moisturePct: MoisturePercent,
        areaHa: BoundedNumber(99_999_999, 'area'),
        valuationNotes: OptionalText(8000),
    })
    .strip();

export type CreateYieldRecordInput = z.infer<typeof CreateYieldRecordSchema>;

export const UpdateYieldRecordSchema = z
    .object({
        plantingId: z.string().min(1).nullable().optional(),
        locationId: z.string().min(1).nullable().optional(),
        seasonId: z.string().min(1).nullable().optional(),
        commodity: OptionalText(120),
        harvestedAt: DateString,
        grossTonnes: BoundedNumber(99_999_999_999, 'gross tonnes'),
        moisturePct: MoisturePercent,
        areaHa: BoundedNumber(99_999_999, 'area'),
        valuationNotes: OptionalText(8000),
    })
    .strip();

export type UpdateYieldRecordInput = z.infer<typeof UpdateYieldRecordSchema>;

// ═════════════════════════════════════════════════════════════════════
//  Grain bins (Location rows with kind in BIN / STORAGE)
// ═════════════════════════════════════════════════════════════════════

/** Only the storage kinds are valid for a bin (a FIELD is not a bin). */
const BinKind = z.enum([LocationKind.BIN, LocationKind.STORAGE]);

export const CreateBinSchema = z
    .object({
        name: ShortText(200),
        kind: BinKind.optional(),
        capacityTonnes: NonNegativeNumber,
        key: OptionalText(120),
        description: OptionalText(2000),
    })
    .strip();

export type CreateBinInput = z.infer<typeof CreateBinSchema>;

export const UpdateBinSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        kind: BinKind.optional(),
        capacityTonnes: NonNegativeNumber,
        key: OptionalText(120),
        description: OptionalText(2000),
    })
    .strip();

export type UpdateBinInput = z.infer<typeof UpdateBinSchema>;

// ═════════════════════════════════════════════════════════════════════
//  Blending (consume source lots → one blended output lot)
// ═════════════════════════════════════════════════════════════════════

export const BlendLotsSchema = z
    .object({
        sourceLots: z
            .array(
                z.object({
                    lotId: z.string().min(1),
                    quantity: z.number().finite().positive('blend quantity must be positive'),
                }),
            )
            .min(1, 'at least one source lot is required')
            // Bounded because every source lot becomes a ledger append + a
            // genealogy edge INSIDE one transaction that holds the per-tenant
            // stock advisory lock. An unbounded list stalls every other stock
            // write for that tenant until the 5s transaction timeout.
            .max(50, 'at most 50 source lots can be blended at once'),
        outputItemId: z.string().min(1),
        outputLotCode: OptionalText(120),
        outputLocationId: z.string().min(1).nullable().optional(),
        /** Quality overrides for the blended lot (moisture / testWeight / protein). */
        qualityAttributes: z
            .record(z.string(), z.number().finite())
            .optional(),
    })
    .strip();

export type BlendLotsInput = z.infer<typeof BlendLotsSchema>;

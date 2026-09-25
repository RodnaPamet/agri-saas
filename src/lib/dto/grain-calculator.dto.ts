/**
 * The grain calculator's wire payload, as schemas — and the mechanism that
 * stops them being a second spelling of it.
 *
 * ── the objection this file had to answer ──
 *
 * `grain.paths.ts` left this one operation's response as `z.unknown()`, with a
 * reason that was correct: `CalculatorData` is deep, and hand-writing it as Zod
 * would make a THIRD spelling of one money payload — beside the TypeScript
 * interfaces and the mapper that builds it — free to drift from both, with
 * nothing to make the copies disagree out loud.
 *
 * Writing the copy anyway would have been the wrong answer. So the payload gets
 * a single source of truth instead, in two parts:
 *
 * **1. For the payload's OWN types, the schema IS the type.** `CalculatorData`,
 * `CalculatorRow`, `CalculatorCostSlice`, `CalculatorExclusions` and
 * `CalculatorCashOutLine` are now `z.infer` of the schemas below, exported from
 * `calculator-payload.ts` under their original names. There is no second
 * spelling to drift because there is no second definition — one edit changes
 * the type, the validator and the published contract together.
 *
 * **2. For types other modules OWN, the mirror is PINNED at compile time.**
 * `PerAreaFigures`, `BreakEvenFigures`, `FarmNetWorthTotal`, `ExclusionEntry`,
 * `UncertaintyState` and `GrainImputedLandCharge` are computed by modules that
 * should not have to care that a wire exists, so those stay TypeScript-first
 * and are mirrored here. Each mirror carries an `Equals<>` assertion against
 * the real type: if the two ever diverge by one field or one union member, it
 * is a TYPE ERROR, not a silent lie in the spec.
 *
 * That is precisely the "nothing would make the copy disagree out loud" the
 * original note worried about — so the note's condition is met rather than
 * overridden. Where a const already exists (`UNCERTAINTY`,
 * `IMPUTED_LAND_CHARGE_REFUSAL_CODES`) the enum is DERIVED from it and not even
 * mirrored.
 *
 * ── one thing this corrected ──
 *
 * `CalculatorCostSlice.variant` was typed `StatusBreakdownVariant | undefined`
 * — a REQUIRED key holding undefined. `undefined` does not survive
 * `JSON.stringify`, so on the wire that key is simply ABSENT. The schema says
 * optional, which is what a client actually receives.
 */
import { z } from '@/lib/openapi/zod';
import { UNCERTAINTY, IMPUTED_LAND_CHARGE_REFUSAL_CODES } from '@/lib/grain/uncertainty';
import { CANONICAL_COMMODITIES } from '@/lib/market/commodity-vocabulary';
import type { UncertaintyState, ImputedLandChargeRefusalCode } from '@/lib/grain/uncertainty';
import type { PerAreaFigures, PerAreaRefusalCode } from '@/lib/grain/per-area';
import type { BreakEvenFigures, BreakEvenRefusalCode } from '@/lib/grain/break-even';
import type { FarmNetWorthTotal } from '@/lib/grain/farm-total';
import type { ExclusionEntry } from '@/lib/grain/exclusion-labels';
import type { GrainImputedLandCharge } from '@/app-layer/usecases/grain-net-worth';
// TYPE-only, so no component module is pulled into a server bundle.
import type { StatusBreakdownVariant } from '@/components/ui/status-breakdown';

/**
 * Exact type equality — not mutual assignability.
 *
 * The two differ in the case that matters: `{a: string}` is assignable to
 * `{a: string | undefined}` in one direction, so an `extends` pair would accept
 * a mirror that had quietly widened a field. This version compares the types
 * themselves, so an added member, a dropped one, or an optional that should be
 * required all fail.
 */
type Equals<X, Y> =
    (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/** Fails to compile unless the mirror and the owned type are identical. */
function assertMirrors<_T extends true>(): void {}

// ─── Leaf mirrors, each pinned to the module that owns it ───

/** DERIVED from the const — not a mirror, so nothing to pin. */
const UncertaintyStateSchema = z.nativeEnum(UNCERTAINTY);
assertMirrors<Equals<z.infer<typeof UncertaintyStateSchema>, UncertaintyState>>();

const ImputedLandChargeRefusalCodeSchema = z.enum(IMPUTED_LAND_CHARGE_REFUSAL_CODES);
assertMirrors<Equals<z.infer<typeof ImputedLandChargeRefusalCodeSchema>, ImputedLandChargeRefusalCode>>();

/** No const array exists for these two, so they are spelled and pinned. */
const PerAreaRefusalCodeSchema = z.enum(['NO_STANDING_CROP_AREA', 'NO_STANDING_CROP_VALUE']);
assertMirrors<Equals<z.infer<typeof PerAreaRefusalCodeSchema>, PerAreaRefusalCode>>();

const BreakEvenRefusalCodeSchema = z.enum(['NO_EXPECTED_TONNAGE', 'NO_MARKET_PRICE']);
assertMirrors<Equals<z.infer<typeof BreakEvenRefusalCodeSchema>, BreakEvenRefusalCode>>();

const StatusBreakdownVariantSchema = z.enum([
    'brand',
    'success',
    'warning',
    'error',
    'info',
    'neutral',
]);
assertMirrors<Equals<z.infer<typeof StatusBreakdownVariantSchema>, StatusBreakdownVariant>>();

export const PerAreaFiguresSchema = z
    .object({
        /** Display unit. Storage stays hectares; there is no second stored unit. */
        areaDca: z.number(),
        standingValuePerDca: z.number().nullable(),
        attributableCostPerDca: z.number().nullable(),
        /**
         * `(standingCropValue − attributableCost) / area`. A MARGIN, never
         * "net worth per dca" — it is built from a strict SUBSET of net
         * worth's terms (the ones sharing an area), and the two must not be
         * mistaken for each other.
         */
        marginPerDca: z.number().nullable(),
        uncertainty: UncertaintyStateSchema,
        refusalCode: PerAreaRefusalCodeSchema.nullable(),
    })
    .openapi('CalculatorPerAreaFigures', {
        description:
            'Per-decare figures over the terms that share a standing-crop area. marginPerDca is a margin over a subset of net worth’s terms, not net worth per decare.',
    });
assertMirrors<Equals<z.infer<typeof PerAreaFiguresSchema>, PerAreaFigures>>();

export const BreakEvenFiguresSchema = z
    .object({
        /** Cost ÷ tonnes — the price that clears. */
        breakEvenPricePerTonne: z.number().nullable(),
        marketPricePerTonne: z.number().nullable(),
        currency: z.string().nullable(),
        /** `market / breakEven × 100`. Dimensionless. */
        coverPercent: z.number().nullable(),
        /** Whether the market price clears the cost. Null when unknowable. */
        covered: z.boolean().nullable(),
        uncertainty: UncertaintyStateSchema,
        refusalCode: BreakEvenRefusalCodeSchema.nullable(),
    })
    .openapi('CalculatorBreakEvenFigures', {
        description:
            'Market price against the price that clears cost. covered is null when the comparison cannot be made at all, which is a different claim from false.',
    });
assertMirrors<Equals<z.infer<typeof BreakEvenFiguresSchema>, BreakEvenFigures>>();

export const FarmNetWorthTotalSchema = z
    .object({
        currency: z.string(),
        standingCropValue: z.number(),
        grainOnHandValue: z.number(),
        rentCostProduceValue: z.number(),
        cashCostTotal: z.number(),
        netWorth: z.number(),
        /** Commodities in this currency whose net worth was REFUSED. */
        refusedCommodities: z.array(z.string()),
        /** Composed from the contributing rows — never invented at this level. */
        uncertainty: UncertaintyStateSchema,
    })
    .openapi('CalculatorFarmTotal', {
        description:
            'One currency’s farm-level total. refusedCommodities names what is missing from it, so a total is never quietly short.',
    });
assertMirrors<Equals<z.infer<typeof FarmNetWorthTotalSchema>, FarmNetWorthTotal>>();

export const ExclusionEntrySchema = z
    .object({
        /** The record's id — the calculator's deep links need it. */
        id: z.string(),
        /** Human label. Falls back to the id when nothing resolves. */
        label: z.string(),
    })
    .openapi('CalculatorExclusionEntry', {
        description: 'One excluded record, carrying the id a deep link needs and a resolved label.',
    });
assertMirrors<Equals<z.infer<typeof ExclusionEntrySchema>, ExclusionEntry>>();

export const ImputedLandChargeSchema = z
    .object({
        /** Area-weighted mean of the tenant's own resolved money-lease rates. */
        perHa: z.number().nullable(),
        areaHa: z.number(),
        totalAmount: z.number().nullable(),
        refusalCode: ImputedLandChargeRefusalCodeSchema.nullable(),
    })
    .openapi('CalculatorImputedLandCharge', {
        description:
            'A rent charge imputed for OWNED land, refused with a reason rather than zeroed when the farm has no money lease to observe a rate from.',
    });
assertMirrors<Equals<z.infer<typeof ImputedLandChargeSchema>, GrainImputedLandCharge>>();

// ─── The payload's own shapes — these schemas ARE the types ───

export const CalculatorCostSliceSchema = z
    .object({
        id: z.string(),
        /** i18n key under `grain.calculator` — the consumer resolves it. */
        labelKey: z.string(),
        value: z.number(),
        /**
         * A PRESENTATION hint: which tone a table paints the slice. It travels
         * in the payload because the composition — which categories, in what
         * order, in which tone — is structure rather than data. A non-web
         * client may ignore it. Optional on the wire because `undefined` does
         * not survive JSON.
         */
        variant: StatusBreakdownVariantSchema.optional(),
    })
    .openapi('CalculatorCostSlice', {
        description:
            'One labelled slice of the cost total, composed server-side. labelKey is an i18n key, not a rendered sentence.',
    });

export const CalculatorRowSchema = z
    .object({
        /**
         * DERIVED from the canonical vocabulary, not `string`.
         *
         * The interface said `string`, but `CommodityNetWorthRow.commodity` is
         * `CanonicalCommodity` and the usecase resolves every row through
         * `resolveCanonical`, so a non-canonical value cannot reach here. A
         * client generating types off this now gets the closed set the server
         * actually emits instead of an open string it has to guess at.
         */
        commodity: z.enum(CANONICAL_COMMODITIES),

        pricePerTonne: z.number().nullable(),
        priceCurrency: z.string().nullable(),
        priceObservedAt: z.string().nullable(),
        priceSource: z.string().nullable(),

        standingCropAreaHa: z.number(),
        standingCropExpectedKg: z.number(),
        standingCropValue: z.number().nullable(),
        perArea: PerAreaFiguresSchema,
        breakEven: BreakEvenFiguresSchema,

        grainOnHandTonnes: z.number(),
        grainOnHandValue: z.number().nullable(),

        rentCostProduceKg: z.number(),
        rentCostProduceValue: z.number().nullable(),
        payrollAllocated: z.boolean(),
        cashCostTotal: z.number(),

        /**
         * Carried with their COUNTS rather than collapsing into
         * `costUncertainty`: the state says the cost is a floor, these say by
         * how many records and why.
         */
        unvaluedNoUnitCost: z.number(),
        unvaluedUnitMismatch: z.number(),

        netWorth: z.number().nullable(),
        /**
         * English, authored by the usecase — the FALLBACK for a code the
         * client does not recognise. A client that renders this INSTEAD of
         * translating the code shows English to a Bulgarian operator; that is
         * PARITY.md Gap 1 and the reason the code below exists.
         */
        netWorthUnavailableReason: z.string().nullable(),
        /** Machine-readable reason. Translate this; fall back to the English. */
        netWorthUnavailableCode: z.string().nullable(),
        netWorthUnavailableParams: z.record(z.string(), z.string()).nullable(),

        netUncertainty: UncertaintyStateSchema,
        costUncertainty: UncertaintyStateSchema,
        /** Real ISO codes only — the internal rent sentinel is already gone. */
        costCurrencyCodes: z.array(z.string()),
        /** True when rent currency was the sentinel, stated in its own words. */
        rentCurrencyUnknown: z.boolean(),
        /** Whether the rent-in-grain term is part of this farm's arithmetic. */
        showProduceRent: z.boolean(),
        costBreakdown: z.array(CalculatorCostSliceSchema),
    })
    .openapi('CalculatorRow', {
        description:
            'One commodity’s net-worth answer. Figures are accompanied by an uncertainty state rather than presented bare: netUncertainty and costUncertainty say whether a number is exact, a floor, a ceiling, apportioned, partial or refused. A refused net worth carries a CODE to translate and English to fall back to.',
    });

export const CalculatorExclusionsSchema = z
    .object({
        plantingsMissingYieldEstimate: z.array(ExclusionEntrySchema),
        plantingsUnknownCommodity: z.array(ExclusionEntrySchema),
        lotsUnresolvedUnit: z.array(ExclusionEntrySchema),
        lotsUnknownCommodity: z.array(ExclusionEntrySchema),
        commoditiesWithNoPrice: z.array(ExclusionEntrySchema),
        leasesUnresolvedRent: z.array(ExclusionEntrySchema),
        leasesUnattributed: z.array(ExclusionEntrySchema),
        leasesProduceRentUnpriced: z.array(ExclusionEntrySchema),
        payrollUnattributable: z.array(ExclusionEntrySchema),
    })
    .openapi('CalculatorExclusions', {
        description:
            'Every record left OUT of the figures, by class, each naming the id and a label. This is what makes the totals auditable: a farm can see what was not counted rather than wondering why a number looks low.',
    });

export const CalculatorCashOutLineSchema = z
    .object({
        currency: z.string(),
        amount: z.number(),
        categories: z.array(z.string()),
    })
    .openapi('CalculatorCashOutLine', {
        description: 'One currency’s worth of money that actually left the bank.',
    });

export const CalculatorDataSchema = z
    .object({
        generatedAt: z.string(),
        seasonId: z.string().nullable(),
        rows: z.array(CalculatorRowSchema),
        /** The farm-level answer — one total per currency, folded server-side. */
        farm: z.object({
            totals: z.array(FarmNetWorthTotalSchema),
            refusedWithoutCurrency: z.array(z.string()),
        }),
        exclusions: CalculatorExclusionsSchema,
        /**
         * Farm-wide DISTINCT counts, NOT the sum of the rows'. One transaction
         * attributed to two commodities is 1 here and 1 on each row, so summing
         * the rows would double it. Deliberately not an exclusion class:
         * nothing was excluded — the stock moved and the planting is counted,
         * only the money is missing.
         */
        unvalued: z.object({ noUnitCost: z.number(), unitMismatch: z.number() }),
        /**
         * What LEFT THE BANK, per currency. Its own figure and NEVER added to
         * any cost line: crop cost is consumption-based and rent cost is a
         * lease-terms accrual, so folding a purchase in would bill the same
         * money twice.
         */
        cashOut: z.array(CalculatorCashOutLineSchema),
        /**
         * Cost that landed on land carrying no crop. Carried BECAUSE the rows
         * are short by exactly this: a spread conserves the amount across
         * `rows + this`, so a consumer printing only the rows would show a cost
         * that SHRANK when the farmer changed how it spreads.
         */
        unallocatedToCrop: z.object({
            amount: z.number(),
            areaHa: z.number(),
            parcelIds: z.array(z.string()),
            currencies: z.array(z.string()),
        }),
        imputedLandCharge: ImputedLandChargeSchema,
        /** True when any batched read hit its cap — the figures cover PART of the farm. */
        truncated: z.boolean(),
    })
    .openapi('CalculatorData', {
        description:
            'The grain net-worth calculator’s whole answer. Every figure is a number, string, boolean or array thereof — no Decimal and no Date crosses this boundary. Read `truncated` before trusting a total: when it is true the figures cover only part of the farm. Read `unallocatedToCrop` too — the per-commodity rows are short by exactly that amount, so a client showing only rows displays a cost that shrinks when the farmer changes how it spreads.',
    });

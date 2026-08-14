import { getTenantCtx } from '@/app-layer/context';
import {
    getGrainNetWorth,
    type CommodityNetWorthRow,
} from '@/app-layer/usecases/grain-net-worth';
import { UNKNOWN_RENT_CURRENCY } from '@/lib/grain/cost-metrics';
import { costUncertainty, netWorthUncertainty } from '@/lib/grain/uncertainty';
import { CalculatorClient, type CalculatorData, type CalculatorRow } from './CalculatorClient';

export const dynamic = 'force-dynamic';

/**
 * Grain calculator — Server Component (read-only net-worth report).
 *
 * Same shape as `grain/costs/page.tsx`: resolve the tenant context, call
 * the usecase, hand a payload to the client island.
 *
 * Two things this page deliberately does NOT do:
 *
 *   1. **No second module gate.** `grain/layout.tsx` already runs
 *      `requireModule(ctx, 'GRAIN')` for every page in the route group.
 *      A second check here would be redundant work on every request and
 *      a second place to forget to update.
 *   2. **No client refetch loop.** Unlike /grain/costs (which has a
 *      dimension toggle backed by an API route), the calculator has one
 *      shape and one payload. `force-dynamic` + a server read is the
 *      whole data path; the client island only formats and arranges.
 *
 * ── Why this maps instead of round-tripping ─────────────────────────
 *
 * It used to be `JSON.parse(JSON.stringify(result))`, which handed the
 * island the usecase's row verbatim — thirty fields shaped by what the
 * usecase COMPUTES rather than by what the page STATES. Eight of them the
 * island never read at all, and several more existed only so it could
 * derive something: filtering the rent sentinel out of the currency list,
 * deciding whether the cost was a floor, deciding whether the rent line
 * belonged on screen.
 *
 * Those decisions are made here now. The island receives an answer to
 * format rather than parts to assemble, and the property it already had
 * survives intact and is easier to see: it still never re-derives a cost,
 * a yield or a price — it does not derive anything.
 *
 * The explicit map is also the serialisation guarantee the round-trip was
 * providing. Every field below is a number, string, boolean or array of
 * strings, so no Decimal or Date can cross the RSC boundary.
 */
function toCalculatorRow(row: CommodityNetWorthRow): CalculatorRow {
    return {
        commodity: row.commodity,

        pricePerTonne: row.pricePerTonne,
        priceCurrency: row.priceCurrency,
        priceObservedAt: row.priceObservedAt,
        priceSource: row.priceSource,

        standingCropAreaHa: row.standingCropAreaHa,
        standingCropExpectedKg: row.standingCropExpectedKg,
        standingCropValue: row.standingCropValue,
        perArea: row.perArea,
        breakEven: row.breakEven,

        grainOnHandTonnes: row.grainOnHandTonnes,
        grainOnHandValue: row.grainOnHandValue,

        rentCostProduceKg: row.rentCostProduceKg,
        rentCostProduceValue: row.rentCostProduceValue,
        payrollAllocated: row.payrollAllocated,
        cashCostTotal: row.cashCostTotal,
        unvaluedNoUnitCost: row.unvaluedNoUnitCost,
        unvaluedUnitMismatch: row.unvaluedUnitMismatch,

        netWorth: row.netWorth,
        netWorthUnavailableReason: row.netWorthUnavailableReason,
        netWorthUnavailableCode: row.netWorthUnavailableCode,
        netWorthUnavailableParams: row.netWorthUnavailableParams,

        // ── Derived HERE, not in the island ──
        //
        // The uncertainty states, resolved from the shared vocabulary so
        // the page and the table cannot disagree about whether a figure is
        // bounded.
        netUncertainty: netWorthUncertainty(row),
        costUncertainty: costUncertainty(row),

        // UNKNOWN_RENT_CURRENCY is an internal sentinel, not an ISO code —
        // the usecase's own docblock says it "is never treated as one".
        // Filtering it here means the island renders a list it can trust
        // instead of one it has to clean.
        costCurrencyCodes: row.cashCostCurrencies.filter((c) => c !== UNKNOWN_RENT_CURRENCY),
        rentCurrencyUnknown: row.cashCostCurrencies.includes(UNKNOWN_RENT_CURRENCY),

        // "Should this term be on screen" is a decision, and it belongs
        // with the data. A rent line reading "− €0" states a term the farm
        // does not have.
        showProduceRent: row.rentCostProduceKg > 0,

        // WHICH categories the cost splits into, in what order, in which
        // tone — structure, not data. The island turns each into a label
        // and a formatted amount; it no longer decides that there are
        // three of them or which is which.
        costBreakdown: [
            { id: 'field', labelKey: 'costFieldLabel', value: row.attributedCropCost, variant: 'brand' },
            { id: 'rent', labelKey: 'costRentLabel', value: row.rentCostMoneyAmount, variant: 'warning' },
            { id: 'payroll', labelKey: 'costPayrollLabel', value: row.payrollCost, variant: 'info' },
        ],
    };
}

export default async function GrainCalculatorPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    const result = await getGrainNetWorth(ctx);
    const data: CalculatorData = {
        generatedAt: result.generatedAt,
        seasonId: result.seasonId,
        rows: result.rows.map(toCalculatorRow),
        farm: result.farm,
        exclusions: result.exclusions,
        unvalued: result.unvalued,
        cashOut: result.cashOut,
        truncated: result.truncated,
    };

    return <CalculatorClient tenantSlug={tenantSlug} data={data} />;
}

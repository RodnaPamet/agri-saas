/**
 * Which ZarnoBorsa rows we keep, and what they mean (#3081).
 *
 * Separate from the parser because these are PRODUCT decisions — which
 * regions, which products, which commodity each maps to — and the parser is
 * deliberately ignorant of them. It reads every row on the page; this file
 * decides what survives. Keeping them apart is what makes widening the scope
 * a one-constant change rather than a parser edit.
 */
import { CanonicalCommodity } from './commodity-vocabulary';

/**
 * BULGARIA ONLY — owner ruling 2026-11-15, confirmed directly.
 *
 * This REVERSES the earlier «Bulgaria EXW and Black Sea FOB», so FOB Romania
 * (1051), Ukraine (1054) and Russia (1055) are read off the page and
 * discarded. Black Sea FOB is the benchmark a Bulgarian exporter is priced
 * against, so the earlier decision was not unreasonable; it was narrowed, and
 * re-widening it is this one constant plus copy.
 *
 * The fixtures deliberately KEEP the Russian, Ukrainian and Romanian rows
 * even though nothing stores them: they are the only rows carrying the
 * `colHidde` forward-curve anchor, which is a real parsing hazard, so they
 * earn their place as markup variety whether or not we keep their prices.
 */
export const ZARNOBORSA_EXW_BG = 1044;
export const ZARNOBORSA_FOB_BG = 1129;

export const ZARNOBORSA_MARKETS: ReadonlyMap<number, { region: string; stage: 'EXW' | 'FOB' }> =
    new Map([
        [ZARNOBORSA_EXW_BG, { region: 'BG', stage: 'EXW' as const }],
        [ZARNOBORSA_FOB_BG, { region: 'BG', stage: 'FOB' as const }],
    ]);

/**
 * `(market, product)` → our commodity key.
 *
 * KEYED ON IDS, never on labels. «Пшеница  12.5%» carries a double space in
 * FOB RU, and a label-matched table would have gone quietly empty on it — so
 * the ids are the contract and `MarketPriceSeries.label` keeps the printed
 * name for display only.
 *
 * Wheat needs BOTH pages spelled out because the product id differs by page:
 * EXW Bulgaria prints «Пшеница» as 1007 while FOB Bulgaria prints «Пшеница
 * 11.5%» as 1032. They are the same commodity to us and two different rows to
 * them.
 *
 * ## What is deliberately absent
 *
 * Feed wheat (1009), sunflower meal (1012) and the oils (EXW 1182/1183, FOB
 * 1011) are NOT mapped. Every one of them has a plausible-looking home —
 * feed wheat is nearly `wheat`, oil is nearly `sunflower` — and that is
 * exactly the trap: filing a refined-oil price under `sunflower` would put a
 * €1,100/t number into the same series as a €150/t seed price, and the grain
 * calculator would then value a farm's sunflower at the oil price. There is no
 * canonical key for a processed product, so they stay unmapped until there is
 * one.
 *
 * All five targets are checked against `CANONICAL_COMMODITIES` by a test,
 * because a key that merely looks right here resolves to nothing downstream
 * and the series would be written and never read.
 */
export const ZARNOBORSA_COMMODITY: ReadonlyMap<string, CanonicalCommodity> = new Map([
    // EXW България
    [`${ZARNOBORSA_EXW_BG}:1007`, 'wheat'],
    [`${ZARNOBORSA_EXW_BG}:1006`, 'barley'],
    [`${ZARNOBORSA_EXW_BG}:1005`, 'maize'],
    [`${ZARNOBORSA_EXW_BG}:1010`, 'sunflower'],
    [`${ZARNOBORSA_EXW_BG}:1008`, 'rapeseed'],
    // FOB България — note wheat is 1032 here, not 1007.
    [`${ZARNOBORSA_FOB_BG}:1032`, 'wheat'],
    [`${ZARNOBORSA_FOB_BG}:1006`, 'barley'],
    [`${ZARNOBORSA_FOB_BG}:1005`, 'maize'],
    [`${ZARNOBORSA_FOB_BG}:1010`, 'sunflower'],
    [`${ZARNOBORSA_FOB_BG}:1008`, 'rapeseed'],
]);

/** The commodity for a row, or null when we store it unmapped. */
export function zarnoBorsaCommodity(
    marketId: number,
    productId: number,
): CanonicalCommodity | null {
    return ZARNOBORSA_COMMODITY.get(`${marketId}:${productId}`) ?? null;
}

/** Is this a region we keep at all? */
export function isZarnoBorsaKeptMarket(marketId: number): boolean {
    return ZARNOBORSA_MARKETS.has(marketId);
}

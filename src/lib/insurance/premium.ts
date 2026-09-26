/**
 * The insurance premium engine.
 *
 * Every later step imports these numbers: the calculator wizard, the server
 * recompute on the lead, and the operator email. They are the product's
 * numbers, so nothing here may drift.
 *
 * ## Why integers
 *
 * Money is INTEGER CENTS everywhere and the tariff is INTEGER BASIS POINTS
 * (1000 = 10 %). The only non-integer crossing this module's boundary is
 * `areaDca` — decares legitimately carry up to 3 decimals, because three
 * decimals of a decare are square metres and cadastral areas are written that
 * way. Keeping money in cents means no step ever rounds a float, so the
 * browser and the server cannot disagree about a half-cent.
 */

/** Bump on ANY change to rounding or tariff semantics. Step 2 snapshots it on every lead. */
export const INSURANCE_ENGINE_VERSION = 1;

export type InstalmentCount = 1 | 2 | 3 | 4;
export const INSTALMENT_COUNTS = [1, 2, 3, 4] as const;

/**
 * €1 bn.
 *
 * `sumInsuredCents × tariffBp` must stay a safe integer: 1e11 × 1e4 = 1e15,
 * and 2^53 ≈ 9.007e15. Raising this cap without re-checking that product is
 * how a silent precision loss gets in, which is why a test asserts it.
 */
export const MAX_SUM_INSURED_CENTS = 100_000_000_000;

/** A sanity bound, not a business rule. */
export const MAX_AREA_DCA = 2_000_000;

export interface QuoteInput {
    areaDca: number;
    sumInsuredCents: number;
    tariffBp: number;
    instalments: number;
}

/**
 * @remarks
 * `premiumPerDcaCents` and `sumInsuredPerDcaCents` are DISPLAY-ONLY. Nothing
 * may multiply them back up to reach a total — they are rounded per decare and
 * would not reconstruct the figure that gets paid. The total is what gets paid.
 */
export type QuoteResult =
    | {
          ok: true;
          premiumCents: number;
          instalmentsCents: number[];
          tariffBp: number;
          areaDca: number;
          sumInsuredCents: number;
          premiumPerDcaCents: number;
          sumInsuredPerDcaCents: number;
          engineVersion: number;
      }
    | { ok: false; reason: 'area' | 'sumInsured' | 'tariff' | 'instalments' };

function isInstalmentCount(n: number): n is InstalmentCount {
    return (INSTALMENT_COUNTS as readonly number[]).includes(n);
}

/**
 * Quote a premium. Refuses rather than throwing, and never returns NaN — a
 * caller that mishandles a refusal gets a visible `ok: false`, not a figure
 * that looks like money.
 */
export function quotePremium(input: QuoteInput): QuoteResult {
    const { areaDca, sumInsuredCents, tariffBp, instalments } = input;

    if (!Number.isFinite(areaDca) || areaDca <= 0 || areaDca > MAX_AREA_DCA) {
        return { ok: false, reason: 'area' };
    }
    if (
        !Number.isSafeInteger(sumInsuredCents) ||
        sumInsuredCents <= 0 ||
        sumInsuredCents > MAX_SUM_INSURED_CENTS
    ) {
        return { ok: false, reason: 'sumInsured' };
    }
    if (!Number.isInteger(tariffBp) || tariffBp < 1 || tariffBp > 10_000) {
        return { ok: false, reason: 'tariff' };
    }
    if (!isInstalmentCount(instalments)) {
        return { ok: false, reason: 'instalments' };
    }

    // Round-half-up, done in integer arithmetic: adding half the divisor
    // before flooring is the same as rounding half away from zero, and both
    // operands are integers so nothing is a float at any point.
    const premiumCents = Math.floor((sumInsuredCents * tariffBp + 5_000) / 10_000);

    // Leftover cents go on the FIRST instalment, so the schedule always sums
    // back to the premium exactly.
    const base = Math.floor(premiumCents / instalments);
    const first = premiumCents - base * (instalments - 1);
    const instalmentsCents = [first, ...Array<number>(instalments - 1).fill(base)];

    return {
        ok: true,
        premiumCents,
        instalmentsCents,
        tariffBp,
        areaDca,
        sumInsuredCents,
        premiumPerDcaCents: Math.round(premiumCents / areaDca),
        sumInsuredPerDcaCents: Math.round(sumInsuredCents / areaDca),
        engineVersion: INSURANCE_ENGINE_VERSION,
    };
}

/**
 * The wizard's "per dca" entry mode goes through this, so the client and the
 * server round a per-decare figure back to a total the SAME way. Two
 * implementations of this rounding is how the two ends start disagreeing.
 */
export function sumInsuredFromPerDca(perDcaCents: number, areaDca: number): number | null {
    if (!Number.isFinite(perDcaCents) || perDcaCents <= 0) return null;
    if (!Number.isFinite(areaDca) || areaDca <= 0 || areaDca > MAX_AREA_DCA) return null;
    const total = Math.round(perDcaCents * areaDca);
    if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_SUM_INSURED_CENTS) return null;
    return total;
}

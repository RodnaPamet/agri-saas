/**
 * Margin per decare, grouped into one scale per currency.
 *
 * ── Why margin needs grouping and cover does not ────────────────────
 *
 * Cover is a RATIO — `market / breakEven`, both sides in the same
 * currency by construction — so it is dimensionless and every crop shares
 * one 0-100 scale whatever it is priced in. Margin per decare is MONEY.
 * Putting a EUR bar and a BGN bar on one axis would be a blend, and this
 * product refuses to blend currencies anywhere: `foldFarmTotals` buckets
 * by currency and emits one total per bucket precisely because there is
 * no FX table in the repo, and the view layer is the worst possible place
 * to invent one.
 *
 * So this is not a new rule. It is the farm total's rule applied to a
 * second figure — including its second half, which is that a row excluded
 * from a bucket gets NAMED rather than omitted. A comparison that quietly
 * shrinks describes a smaller farm than the one being read about.
 *
 * ── Why `comparable` is a field and not the caller's business ───────
 *
 * A single drawable crop always fills its own scale, because it IS the
 * scale. That picture cannot be wrong and cannot inform, so the decision
 * not to draw it belongs with the arithmetic rather than being re-derived
 * at each call site.
 *
 * @module lib/grain/margin-scale
 */
import type { PerAreaRefusalCode } from './per-area';
import type { UncertaintyState } from './uncertainty';

export interface MarginScaleInput {
    commodity: string;
    /** `perArea.marginPerDca` — SIGNED, null when the per-dca figure was refused. */
    marginPerDca: number | null;
    refusalCode: PerAreaRefusalCode | null;
    uncertainty: UncertaintyState;
    priceCurrency: string | null;
}

export interface MarginScaleItem extends MarginScaleInput {
    /** Whether this row can be drawn on its group's axis. */
    drawable: boolean;
}

export interface MarginScaleGroup {
    currency: string;
    /**
     * Largest MAGNITUDE in this group, so a loss is on-axis too. A −500
     * beside a +80 needs a 500 axis; an 80 one would run the loss past the
     * end of its own track.
     */
    maxAbs: number;
    /** At least two drawable crops AND a non-zero axis to draw them on. */
    comparable: boolean;
    /** Best margin first; refused crops last, still listed. */
    items: MarginScaleItem[];
}

export interface MarginScaleResult {
    groups: MarginScaleGroup[];
    /** Commodities with no currency at all — named, never silently dropped. */
    unscaled: string[];
}

export function foldMarginScales(rows: readonly MarginScaleInput[]): MarginScaleResult {
    const byCurrency = new Map<string, MarginScaleItem[]>();
    const unscaled: string[] = [];

    for (const r of rows) {
        if (r.priceCurrency == null) {
            // No price ⇒ no currency ⇒ no axis this row could belong to.
            unscaled.push(r.commodity);
            continue;
        }
        const item: MarginScaleItem = {
            ...r,
            drawable: r.marginPerDca != null && Number.isFinite(r.marginPerDca),
        };
        const bucket = byCurrency.get(r.priceCurrency);
        if (bucket) bucket.push(item);
        else byCurrency.set(r.priceCurrency, [item]);
    }

    const groups: MarginScaleGroup[] = [];
    for (const [currency, items] of byCurrency) {
        const drawable = items.filter((i) => i.drawable);
        const maxAbs = drawable.reduce((m, i) => Math.max(m, Math.abs(i.marginPerDca as number)), 0);
        groups.push({
            currency,
            maxAbs,
            comparable: drawable.length >= 2 && maxAbs > 0,
            items: [...items].sort(byMarginDescRefusedLast),
        });
    }

    return { groups, unscaled };
}

/**
 * Best margin first. A refused crop sorts last rather than being treated
 * as a zero — "we could not work it out" is not a middling result, and
 * placing it among the numbers invites reading it as one.
 */
function byMarginDescRefusedLast(a: MarginScaleItem, b: MarginScaleItem): number {
    if (!a.drawable && !b.drawable) return 0;
    if (!a.drawable) return 1;
    if (!b.drawable) return -1;
    return (b.marginPerDca as number) - (a.marginPerDca as number);
}

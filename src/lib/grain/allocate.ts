/**
 * Spreading a cost over several targets without changing what it was.
 *
 * ── The invariant ───────────────────────────────────────────────────
 *
 * Choosing a different allocation basis REDISTRIBUTES a cost. It must
 * never change it. The obvious implementation violates that on the first
 * awkward number: 100.00 across three equal parcels, rounded per share,
 * is 33.33 three times and a farm total of 99.99. A cost that shrinks
 * when you look at it a different way is worse than no allocation feature
 * at all, because cash cost, net worth and margin per decare all inherit
 * the error and none of them can say where it came from.
 *
 * So shares are computed in integer CENTS — money has no business in
 * binary floating point once it is being divided — and the remainder is
 * handed out one cent at a time by the largest-remainder rule.
 *
 * ── Why the tie-break is by id ──────────────────────────────────────
 *
 * With equal weights every fractional part is identical, so "who gets the
 * odd cent" is decided by the tie-break. Falling back on Map insertion
 * order would make a farmer's numbers depend on the order a query
 * returned rows, and a later `orderBy` change would move money between
 * commodities with no code change anywhere near this file. Sorting by id
 * is arbitrary but STABLE, which is the property that matters.
 *
 * @module lib/grain/allocate
 */

/**
 * Pro-rata weights by area, with an even split when no target has any.
 *
 * Moved here verbatim from `grain-net-worth.ts` so that allocation has ONE
 * weighting rule rather than a second one that drifts. The zero-area
 * fallback is load-bearing: a holding whose parcels all have null area
 * must still allocate, because dropping the cost is the silent failure
 * mode and an even split is at least a stated one.
 */
export function computeAreaWeights(
    targets: readonly { id: string; areaHa: number }[],
): Map<string, number> {
    const weights = new Map<string, number>();
    if (targets.length === 0) return weights;
    const totalArea = targets.reduce((sum, t) => sum + (t.areaHa > 0 ? t.areaHa : 0), 0);
    if (totalArea > 0) {
        for (const t of targets) weights.set(t.id, (t.areaHa > 0 ? t.areaHa : 0) / totalArea);
    } else {
        const even = 1 / targets.length;
        for (const t of targets) weights.set(t.id, even);
    }
    return weights;
}

/**
 * Split `amount` across weighted targets so the shares sum to it EXACTLY.
 *
 * Weights need not sum to 1 — they are normalised here — because a caller
 * that has filtered its target list should not have to renormalise before
 * calling. A non-finite weight counts as zero rather than poisoning the
 * whole split.
 *
 * @returns money per target, 2dp, summing to `round2(amount)` to the cent.
 */
export function allocateByWeights(
    amount: number,
    weights: ReadonlyMap<string, number>,
): Map<string, number> {
    const shares = new Map<string, number>();
    if (weights.size === 0 || !Number.isFinite(amount)) return shares;

    // Sign is carried outside the arithmetic so `Math.floor` cannot round
    // a negative share the wrong way (floor(-3.5) is -4, not -3).
    const sign = amount < 0 ? -1 : 1;
    const totalCents = Math.round(Math.abs(amount) * 100);

    const ids = [...weights.keys()].sort();
    const clean = ids.map((id) => {
        const w = weights.get(id) ?? 0;
        return { id, weight: Number.isFinite(w) && w > 0 ? w : 0 };
    });
    const totalWeight = clean.reduce((s, t) => s + t.weight, 0);

    // Every weight was zero or unusable. The amount still has to go
    // somewhere, and an even split is the same answer `computeAreaWeights`
    // gives for a zero-area holding — consistency beats a second rule.
    const effective =
        totalWeight > 0
            ? clean.map((t) => ({ id: t.id, exact: (totalCents * t.weight) / totalWeight }))
            : clean.map((t) => ({ id: t.id, exact: totalCents / clean.length }));

    let assigned = 0;
    const parts = effective.map((t) => {
        const floorCents = Math.floor(t.exact);
        assigned += floorCents;
        return { id: t.id, floorCents, remainder: t.exact - floorCents };
    });

    // Largest remainder first; exact ties by id, so the result cannot
    // depend on the order rows came back from the database.
    const order = [...parts].sort((a, b) =>
        b.remainder !== a.remainder ? b.remainder - a.remainder : a.id < b.id ? -1 : 1,
    );
    let deficit = totalCents - assigned;
    for (let i = 0; i < order.length && deficit > 0; i += 1, deficit -= 1) {
        order[i].floorCents += 1;
    }

    for (const p of parts) shares.set(p.id, (sign * p.floorCents) / 100);
    return shares;
}

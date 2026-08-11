/**
 * Structural guard: an INPUT-category CostEntry never reaches crop cost.
 *
 * ── The regression class ────────────────────────────────────────────
 *
 * `src/lib/grain/cost-metrics.ts` exists because three incompatible
 * definitions of "cost" once shipped under one word, so the same season
 * showed different totals depending which page you opened. Wiring
 * `CostEntry` into the net-worth calculator can recreate that in ONE
 * line — `a.attributedCropCost += amount` inside the wrong loop — and the
 * result would not look broken. Every figure would still render; the
 * fertiliser would simply be billed twice, once when bought and again
 * when applied.
 *
 * The behaviour is pinned by executing tests in
 * `tests/unit/grain-net-worth.test.ts` (a FERTILIZER entry plus a
 * CONSUMPTION of the same fertiliser counts ONCE). This file pins the
 * SHAPE, because the executing tests can only catch a mistake in a case
 * someone thought to write down, and the shape is what a well-meaning
 * refactor breaks.
 *
 * ── Why this is a source scan and not a behaviour test ──────────────
 *
 * Per CLAUDE.md, a guard asserting on source text contributes zero
 * runtime coverage and is the RIGHT tool only for "this pattern is
 * present / this token is absent". That is exactly the claim here: the
 * cost-side accumulators must not be reachable from a loop over every
 * cost entry. The companion executing tests carry the behavioural half.
 *
 * A mutation proof lives at the bottom — the detector is run against a
 * planted violation, so this file cannot quietly stop detecting.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const NET_WORTH = path.join(ROOT, 'src/app-layer/usecases/grain-net-worth.ts');
const COST_METRICS = path.join(ROOT, 'src/lib/grain/cost-metrics.ts');

const source = fs.readFileSync(NET_WORTH, 'utf-8');

/** The accumulator fields that feed a commodity's COST side. */
const COST_SIDE_FIELDS = [
    'attributedCropCost',
    'payrollCost',
    'rentCostMoneyAmount',
    'rentCostProduceKg',
] as const;

/** Categories that are purchases or cash settlements — never crop cost. */
const NON_COST_CATEGORIES = [
    'FERTILIZER',
    'FUEL',
    'SEED',
    'PESTICIDE',
    'SERVICE',
    'OTHER',
    'RENT',
] as const;

/**
 * The detector.
 *
 * Finds the block that reduces cost entries and reports any COST-side
 * accumulator mutated inside it. `computePayroll` is the ONE sanctioned
 * writer, and it is reached only after the caller has filtered to
 * `category === 'PAYROLL'` — which the assertions below check separately.
 */
function costSideWritesInCashOutReducer(src: string): string[] {
    const start = src.indexOf('function computeCashOut');
    if (start === -1) return ['computeCashOut not found — the detector is looking at the wrong shape'];
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    return COST_SIDE_FIELDS.filter((f) => body.includes(f));
}

describe('CostEntry ↔ crop cost — purchases never enter the cost side', () => {
    it('the cash-out reducer writes NO cost-side accumulator', () => {
        expect(costSideWritesInCashOutReducer(source)).toEqual([]);
    });

    it('computePayroll is reached only after filtering to the PAYROLL category', () => {
        // The filter is the whole safety property: computePayroll writes
        // `a.payrollCost`, so handing it every cost entry would put fuel,
        // seed and rent into the crop-cost line.
        expect(source).toMatch(
            /filter\(\s*\(\s*\w+\s*\)\s*=>\s*\w+\.category === 'PAYROLL'\s*\)/,
        );
        expect(source).toMatch(/computePayroll\(\s*payrollEntries/);
    });

    it('no non-payroll category name appears near a cost-side accumulator', () => {
        // A blunt proximity check, deliberately. It is not trying to parse
        // the module — it is trying to notice that someone wrote
        // `if (e.category === 'FUEL') a.attributedCropCost += …`.
        for (const category of NON_COST_CATEGORIES) {
            for (const match of source.matchAll(new RegExp(`'${category}'`, 'g'))) {
                const window = source.slice(match.index ?? 0, (match.index ?? 0) + 400);
                for (const field of COST_SIDE_FIELDS) {
                    expect(`${category}/${field}: ${window.includes(field)}`).toBe(
                        `${category}/${field}: false`,
                    );
                }
            }
        }
    });

    it('cash-out is a NAMED metric, not an unnamed number', () => {
        // Four cost definitions already ship in this product. A fifth
        // money figure without a name in COST_METRICS is precisely the
        // condition that module exists to prevent.
        const metrics = fs.readFileSync(COST_METRICS, 'utf-8');
        expect(metrics).toContain('GRAIN_CASH_OUT');
        expect(metrics).toContain('metricGrainCashOut');
    });

    it('the cash-out figure is never folded into cashCostTotal', () => {
        // `cashCostTotal` is the COST side. If cash-out ever lands in it,
        // the purchase and the consumption are summed — the exact bug.
        const finalize = source.slice(source.indexOf('const cashCostTotal ='));
        expect(finalize.slice(0, 300)).not.toContain('cashOut');
    });
});

describe('the detector actually detects (mutation proof)', () => {
    it('fails when a cost-side write is planted in the cash-out reducer', () => {
        // Plant the violation in a COPY of the source and confirm the
        // detector reports it. Without this, a refactor that renamed
        // `computeCashOut` would make every assertion above pass over a
        // block it never found.
        const mutated = source.replace(
            'bucket.amount += dec(row.amount);',
            'bucket.amount += dec(row.amount); a.attributedCropCost += dec(row.amount);',
        );
        expect(mutated).not.toBe(source); // the anchor still exists

        const found = costSideWritesInCashOutReducer(mutated);
        expect(found).toContain('attributedCropCost');
    });

    it('fails when the reducer is renamed out from under it', () => {
        const mutated = source.replace('function computeCashOut', 'function computeSomethingElse');
        expect(costSideWritesInCashOutReducer(mutated)[0]).toMatch(/wrong shape/);
    });
});

/**
 * Structural contract for the grain costs page.
 *
 * Nothing exercised this page at all — which is how it shipped with
 * `sortableColumns` never passed to `DataTable` (so nothing sorted) while
 * TWO guard exemptions justified its missing toolbar by claiming the page
 * had "+ sort". A false exemption is worse than a missing feature: it tells
 * the next reader the gap was considered and accepted.
 *
 * These assertions are deliberately structural rather than rendered. What
 * broke here was wiring — a prop not passed, a param accepted and ignored, a
 * literal that never reached a translator — and wiring is what a source scan
 * catches cheaply and reliably.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CLIENT = 'src/app/t/[tenantSlug]/(app)/grain/costs/CostsClient.tsx';
const ROUTE = 'src/app/api/t/[tenantSlug]/grain/costs/route.ts';
const ROLLUP = 'src/app-layer/usecases/cost-rollup.ts';

describe('costs page — navigability', () => {
    const source = read(CLIENT);

    it('passes sortableColumns to every table', () => {
        // The defect: the array existed in spirit but was never handed to
        // DataTable, which defaults it to [] — so the headers rendered
        // unsortable and the guard rationales were describing fiction.
        const tables = source.match(/<DataTable</g) ?? [];
        const sortProps = source.match(/sortableColumns=\{SORTABLE\}/g) ?? [];
        expect(tables.length).toBeGreaterThan(0);
        expect(sortProps).toHaveLength(tables.length);
    });

    it('defaults to the most expensive first', () => {
        // A farmer's first question is "what cost me most"; answering it
        // should not require reading 500 rows.
        expect(source).toMatch(/useState<string>\('totalCost'\)/);
        expect(source).toMatch(/useState<'asc' \| 'desc'>\('desc'\)/);
    });

    it('offers a search over the rows', () => {
        expect(source).toContain('grain-costs-search');
        expect(source).toContain("tc('searchPlaceholder')");
    });

    it('sorts rows with missing values last, in either direction', () => {
        // A row with no cost-per-tonne is missing a denominator, not cheap —
        // sorting it to the top of "cheapest first" would read as a finding.
        expect(source).toMatch(/if \(av == null\) return 1;/);
        expect(source).toMatch(/if \(bv == null\) return -1;/);
    });
});

describe('costs page — honesty of the figures', () => {
    const source = read(CLIENT);

    it('renders money through the tenant currency, not a per-row label', () => {
        // Was `useTenantCurrencySymbol` + a local `useCostFormatter` hook
        // spelling `symbol + formatDecimal(v, 2)` inline. /grain/calculator
        // then wrote that same expression again under the name `formatMoney`,
        // which polish-06-single-currency.test.ts caught — so the expression
        // moved to ONE home and both pages now bind it through this hook.
        // The invariant is unchanged: the symbol comes from tenant context.
        expect(source).toContain('useExactMoneyFormatter');
        // The old formatter took the row's own currency, which is null for
        // every entry the journal UI creates.
        expect(source).not.toMatch(/money\([^)]*,\s*row\.original\.currency\)/);
    });

    it('formats to the CENT, never through the compact formatter', () => {
        // `useMoneyFormatter` rounds (€1.2M) — right for a dashboard tile,
        // wrong for a page a farmer reconciles against invoices, where it
        // hides everything between €1,150,000 and €1,249,999. The two hooks
        // differ by one word, so the wrong one is an easy import away.
        expect(source).not.toContain('useMoneyFormatter');
    });

    it('surfaces a mixed-currency warning and a truncation warning', () => {
        expect(source).toContain("tc('currencyMixedWarning'");
        expect(source).toContain("tc('truncatedWarning')");
    });

    it('states what the total does NOT cover', () => {
        // "Total cost" claimed a completeness the rollup does not have:
        // no machinery, labour, rent, fuel or purchase contracts.
        expect(source).toContain("tc('scopeNote')");
    });

    it('no longer advertises category columns that do not exist', () => {
        // The residue of a designed-and-dropped breakdown. The comment was
        // the only part that shipped.
        const commentBlock = source.slice(0, source.indexOf('</ListPageShell>'));
        expect(commentBlock).not.toMatch(/seed \/ fertiliser \/\n\s*chemical \/ labour \/ fuel \/ total cost columns per row/);
    });

    it('names which of the three cost metrics it reports', () => {
        expect(source).toContain('COST_METRICS.ATTRIBUTED_CROP_COST');
    });
});

describe('costs endpoint — parameters are honoured, not swallowed', () => {
    const route = read(ROUTE);
    const rollup = read(ROLLUP);

    it('applies ?seasonId to every dimension', () => {
        // It used to be read only on the planting branch, so a shared
        // filtered link showed the whole farm on the field/season views.
        expect(route).toMatch(/getCostRollupBySeason\(ctx, \{ seasonId \}\)/);
        expect(route).toMatch(/getCostRollupByField\(ctx, \{ seasonId \}\)/);
        expect(route).toMatch(/getCostRollupByPlanting\(ctx, \{ seasonId \}\)/);
    });

    it('returns the truncation flag with every shape', () => {
        const shapes = route.match(/rows, truncated/g) ?? [];
        expect(shapes.length).toBeGreaterThanOrEqual(3);
    });

    it('uses a conditional response for the list read', () => {
        expect(route).toContain('jsonWithETag');
    });

    it('carries no hardcoded English planting label', () => {
        // "Planting #3" rendered untranslated for a Bulgarian farmer.
        expect(rollup).not.toContain("?? 'Planting'");
    });

    it('counts only CONSUMPTION as cost', () => {
        expect(rollup).toMatch(/COST_BEARING_MOVEMENTS = \['CONSUMPTION'\]/);
    });
});

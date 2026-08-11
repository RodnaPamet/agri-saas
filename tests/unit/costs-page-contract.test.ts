/**
 * Structural contract for the /grain/costs surface.
 *
 * This file used to assert on a ROLLUP: `useState('totalCost')`,
 * `sortableColumns`, a dimension toggle, a slice at `</ListPageShell>`.
 * That page is gone. It was a read-only report of
 * `COST_METRICS.ATTRIBUTED_CROP_COST`, and the grain net-worth calculator
 * already reports that same figure as part of a larger answer — two pages
 * over one number is exactly the condition `src/lib/grain/cost-metrics.ts`
 * exists to prevent, so the duplicate was DROPPED rather than moved.
 *
 * What the page is now: the register where a farmer enters a cost. The
 * assertions below pin the properties that make that safe, and the FIRST
 * one pins the removal itself — a rollup quietly reappearing here is the
 * regression this file now exists to catch.
 *
 * These are source-text assertions and contribute no runtime coverage;
 * the executing coverage lives in `tests/unit/cost-entry-usecase.test.ts`
 * and `tests/rendered/grain-costs-client.test.tsx`.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/grain/costs');
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf-8');

describe('grain costs — the rollup is gone, not relocated', () => {
    const page = read('page.tsx');
    const client = read('CostsClient.tsx');

    it('the page no longer server-renders a cost rollup', () => {
        expect(page).not.toContain('getCostRollupByPlanting');
        expect(page).not.toContain('getCostRollupBySeason');
        expect(page).not.toContain('getCostRollupByField');
        // It reads the register instead.
        expect(page).toContain('listCostEntries');
    });

    it('the client has no dimension toggle', () => {
        // planting / field / season was the rollup's shape. A facet is a
        // filter; a dimension is a different report — and the second
        // report is the thing that was removed.
        expect(client).not.toMatch(/initialBy|by=planting|dimensionOptions/);
    });

    it('says in prose WHY the rollup went, so the next reader does not restore it', () => {
        // The docblock is the only place this decision survives once the
        // diff is old. Both files carry it.
        expect(page).toMatch(/cost-metrics/);
        expect(client).toMatch(/cost-metrics/);
    });
});

describe('grain costs — entry surface contract', () => {
    const client = read('CostsClient.tsx');
    const modal = read('CostEntryFormModal.tsx');
    const filters = read('filter-defs.ts');

    it('adopts EntityListPage rather than hand-rolling the composition', () => {
        expect(client).toContain('EntityListPage');
        expect(client).not.toMatch(/<ListPageShell\b/);
    });

    it('wires the category facet and a live search', () => {
        expect(client).toContain('buildCostFilters');
        expect(client).toContain('searchPlaceholder');
        expect(client).toContain('searchId');
    });

    it('sends search to the SERVER, not an in-memory filter', () => {
        // An in-memory pass only ever sees the capped page, so a match
        // beyond it is invisible — a silent wrong answer.
        expect(client).toContain('useDebounce');
        expect(client).toMatch(/params\.set\('q'/);
    });

    it('surfaces a failed read as an error, never as the empty state', () => {
        expect(client).toContain('loadError');
        // Gated on having nothing to show, so a failed background refetch
        // keeps stale rows instead of blanking them.
        expect(client).toMatch(/isError && rows\.length === 0/);
    });

    it('discloses the server cap rather than presenting a page as the total', () => {
        expect(client).toContain('truncated');
        expect(client).toContain('truncatedNotice');
    });

    it('prints the RECORDED currency code, never a single tenant symbol', () => {
        // Entries in different currencies sit in one list and there is no
        // FX table in this repo, so one symbol over all of them would be
        // a claim the data does not support.
        expect(client).toMatch(/row\.original\.currency/);
        expect(client).not.toContain('useExactMoneyFormatter');
        expect(client).not.toContain('useTenantCurrencySymbol');
    });

    it('the create button is a bare noun with a Plus icon', () => {
        expect(client).toMatch(/icon=\{<Plus/);
        expect(client).toContain("t('addCost')");
    });

    it('the modal picks the attribution KIND before the target', () => {
        // A cost may link to at most one domain. Five independent pickers
        // would invite filling in two and then reject them; choosing the
        // kind first makes the rule structural in the UI.
        expect(modal).toContain('linkKind');
        expect(modal).toContain('LINK_COLUMN');
    });

    it('the modal offers a lease link ONLY on a RENT entry', () => {
        expect(modal).toMatch(/k !== 'lease' \|\| watchedCategory === 'RENT'/);
    });

    it('has NO date facet, and says why', () => {
        // The filter platform has no date type — `range` is numeric and
        // integer-truncates, so it cannot carry an ISO date. Adding one is
        // platform work with its own tests, not a line in a feature PR.
        expect(filters).not.toMatch(/incurredOn:\s*\{/);
        expect(filters).toMatch(/no date facet/i);
    });
});

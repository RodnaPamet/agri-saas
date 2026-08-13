/**
 * R23-PR-D — Assets KPI rollout ratchet.
 *
 * Originally covered Assets + Practices. GRC teardown phase 2 deleted the
 * Practices page; Assets is the surviving rollout and keeps every
 * invariant unchanged.
 *
 * Locks that the page adopted the shared primitive + hook in the
 * standard shape. Three invariants per page:
 *   1. KpiFilterCard import from the shared module.
 *   2. useKpiFilter import + invocation.
 *   3. At least one <KpiFilterCard> JSX with `selected={activeKpiId === ...}`
 *      driving the active-state affordance.
 *
 * Also locks the EntityListPage `kpis` slot — a future PR that strips
 * the slot would orphan a page's KPI strip silently.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

const ASSETS_PATH =
    'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx';
const ENTITY_LIST_PAGE_PATH = 'src/components/layout/EntityListPage.tsx';

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const ROLLOUT_PAGES: Array<{ name: string; path: string; activeVar: string }> = [
    {
        name: 'Assets',
        path: ASSETS_PATH,
        activeVar: 'activeAssetKpi',
    },
];

describe('R23-PR-D — Assets KPI rollout', () => {
    for (const page of ROLLOUT_PAGES) {
        describe(`${page.name} page`, () => {
            const src = read(page.path);

            it('imports KpiFilterCard from the shared module', () => {
                expect(src).toMatch(
                    /import\s*\{\s*KpiFilterCard\s*\}\s*from\s+["']@\/components\/ui\/kpi-filter-card["']/,
                );
            });

            it('imports useKpiFilter from the shared barrel', () => {
                expect(src).toMatch(
                    /import\s*\{[\s\S]*?useKpiFilter[\s\S]*?\}\s*from\s+["']@\/components\/ui\/kpi-filter["']/,
                );
            });

            it('invokes useKpiFilter', () => {
                expect(src).toMatch(/useKpiFilter\(/);
            });

            it('mounts at least one <KpiFilterCard /> with a selected= prop', () => {
                expect(src).toMatch(/<KpiFilterCard\b/);
                // R-filter-gear (#3, 2026-06-07): the KPI grid is data-driven
                // over the gear's visibleKpiCards, so `selected` compares the
                // active id against the per-card id (`=== card.id`) rather than
                // a literal. Accept either form.
                expect(src).toMatch(
                    new RegExp(
                        `selected=\\{${page.activeVar}\\s*===\\s*(card\\.id|['"])`,
                    ),
                );
            });

            it('mounts a "total" KPI (the implicit-default card)', () => {
                // Every rollout page should expose a "total / show
                // all" card so the user can return to the unfiltered
                // view by clicking it (toggle off semantics).
                expect(src).toMatch(/['"]total['"]/);
            });
        });
    }

    describe('EntityListPage `kpis` slot', () => {
        const src = read(ENTITY_LIST_PAGE_PATH);

        it('declares the kpis prop on EntityListPageProps', () => {
            expect(src).toMatch(/kpis\?\:\s*ReactNode/);
        });

        it('renders the kpis slot inside ListPageShell.Filters', () => {
            // The kpis prop must compose with the existing filter
            // slot, not as a sibling region. Otherwise spacing /
            // scroll behaviour drifts from the Risks-page reference.
            expect(src).toMatch(/\{kpis\}/);
        });
    });
});

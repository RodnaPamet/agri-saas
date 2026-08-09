/**
 * R23-PR-F — Policies + Vendors rollout + Roadmap-23 capstone.
 *
 * Two layers:
 *   1. Per-page rollout assertions for Policies + Vendors (same
 *      shape as PR-D/PR-E ratchets).
 *   2. Capstone meta-ratchet — locks the existence of all 6 R23
 *      ratchet files + the 7 consumer pages that mount KpiFilterCard.
 *      A future PR that strips a ratchet or a consumer fails CI.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

const ROLLOUT_PAGES: Array<{ name: string; path: string; activeVar: string }> = [
    {
        name: 'Policies',
        path: 'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx',
        activeVar: 'activePolicyKpi',
    },
    {
        name: 'Vendors',
        path: 'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
        activeVar: 'activeVendorKpi',
    },
];

const ALL_R23_RATCHETS = [
    'tests/guards/r23-pra-kpi-primitive.test.ts',
    'tests/guards/r23-prb-kpi-filter-hook.test.ts',
    'tests/guards/r23-prc-kpi-url-sync.test.ts',
    'tests/guards/r23-prd-assets-controls-rollout.test.ts',
    'tests/guards/r23-pre-tasks-evidence-rollout.test.ts',
    'tests/guards/r23-prf-policies-vendors-capstone.test.ts',
] as const;

const ALL_R23_CONSUMERS = [
    'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/farm-tasks/FarmTasksClient.tsx',
    'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
    'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx',
    'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
] as const;

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('R23-PR-F — Policies + Vendors rollout', () => {
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

            it('mounts <KpiFilterCard /> with a selected= prop tied to activeKpiId', () => {
                expect(src).toMatch(/<KpiFilterCard\b/);
                expect(src).toMatch(
                    new RegExp(
                        `selected=\\{${page.activeVar}\\s*===\\s*['"]`,
                    ),
                );
            });

            it('exposes a "total" KPI for the show-all default', () => {
                expect(src).toMatch(/['"]total['"]/);
            });
        });
    }
});

describe('R23 capstone — meta-ratchet', () => {
    it('all 6 R23 PR ratchet files exist (strip one → fails CI)', () => {
        for (const ratchet of ALL_R23_RATCHETS) {
            expect(fs.existsSync(path.join(ROOT, ratchet))).toBe(true);
        }
    });

    it('all 7 consumer pages mount the shared <KpiFilterCard>', () => {
        for (const consumer of ALL_R23_CONSUMERS) {
            const src = read(consumer);
            expect(src).toMatch(/<KpiFilterCard\b/);
            expect(src).toMatch(/useKpiFilter\(/);
        }
    });

    it('all 7 consumer pages route through the shared primitive (no inline KPIStat-only KPIs)', () => {
        // The only legitimate `<KPIStat>` usage on a consumer page
        // is INSIDE the KpiFilterCard primitive — never as a sibling
        // standing in for a KPI card. A future PR that re-introduces
        // inline `<KPIStat>` as a KPI breaks the unified design.
        //
        // Stripping comments avoids the explanatory header in
        // kpi-filter-card.tsx from triggering a false positive when
        // the consumer page imports nothing of the kind.
        for (const consumer of ALL_R23_CONSUMERS) {
            const stripped = read(consumer)
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(stripped).not.toMatch(/<KPIStat\b/);
        }
    });
});

/**
 * R23-PR-E — Tasks + Evidence KPI rollout ratchet.
 *
 * Same shape as PR-D's ratchet: each rollout page imports the shared
 * primitive + hook, invokes useKpiFilter, mounts at least one
 * <KpiFilterCard> driving selected via activeKpiId, and exposes a
 * "total" card.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

const ROLLOUT_PAGES: Array<{ name: string; path: string; activeVar: string }> = [
    {
        name: 'Farm Tasks',
        path: 'src/app/t/[tenantSlug]/(app)/farm-tasks/FarmTasksClient.tsx',
        activeVar: 'activeKpiId',
    },
    {
        name: 'Evidence',
        path: 'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
        activeVar: 'activeEvidenceKpi',
    },
];

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('R23-PR-E — Tasks + Evidence KPI rollout', () => {
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

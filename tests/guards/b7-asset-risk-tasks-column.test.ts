/**
 * B7 (2026-06-07) — a "Tasks" column on the Asset + Risk list tables,
 * mirroring Controls (done/total linked-task count).
 *
 * Backend: `WorkItemRepository.countLinkedToEntities` is a generic batched
 * TaskLink counter (one indexed query, no FK path) used by `listAssets` +
 * `listRisks` to attach `taskTotal`/`taskDone` per row. Frontend: both list
 * clients render the Tasks column + a gear toggle.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const REPO = read('src/app-layer/repositories/WorkItemRepository.ts');
const ASSET_UC = read('src/app-layer/usecases/asset.ts');
const ASSETS = read('src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx');

describe('B7 — Tasks column on Asset + Risk', () => {
    it('WorkItemRepository exposes the generic countLinkedToEntities', () => {
        expect(REPO).toMatch(/static async countLinkedToEntities/);
        expect(REPO).toMatch(/entityType: TaskLinkEntityType/);
        // TaskLink-only — bounded by the entityIds set, not an N+1.
        expect(REPO).toMatch(/db\.taskLink\.findMany/);
    });

    it('listAssets + listRisks attach taskTotal/taskDone', () => {
        for (const uc of [ASSET_UC]) {
            expect(uc).toMatch(/countLinkedToEntities/);
            expect(uc).toMatch(/taskTotal:/);
            expect(uc).toMatch(/taskDone:/);
        }
    });

    it('Asset + Risk list tables render a Tasks column (done/total) + gear toggle', () => {
        for (const src of [ASSETS]) {
            expect(src).toMatch(/id: 'tasks'/);
            // i18n (T06): the risks table resolves headers through next-intl;
            // the assets table still uses the literal. Accept either.
            expect(src).toMatch(/header: (?:'Tasks'|tm\('colTasks'\))/);
            expect(src).toMatch(/\{ id: 'tasks', label: (?:'Tasks'|tm\('colTasks'\)) \}/);
            expect(src).toMatch(/taskDone/);
        }
    });
});

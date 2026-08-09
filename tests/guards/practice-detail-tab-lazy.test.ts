/**
 * #102 item 1 — practice-detail tab-lazy ratchet.
 *
 * Before this refactor, `PracticeRepository.getById` eager-loaded
 * `practiceTasks` / `evidenceLinks` / `evidence` / `frameworkMappings`
 * into every practice-detail page-data payload — bytes the Overview
 * tab never reads. The split:
 *
 *   - page-data calls `getPracticeHeader` (header scalars + user refs
 *     + `contributors` + relation `_count`s), NOT the full getter;
 *   - the Tasks / Evidence / Mappings tab bodies each fetch their
 *     own slice on demand via a `useTenantSWR` key gated on the
 *     active tab.
 *
 * This ratchet fails if a regression re-points page-data at the
 * full getter, or the page goes back to reading the heavy arrays
 * off the practice payload.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PAGE_DATA = read('src/app-layer/usecases/practice/page-data.ts');
const QUERIES = read('src/app-layer/usecases/practice/queries.ts');
const REPO = read('src/app-layer/repositories/PracticeRepository.ts');
const PAGE = read(
    'src/app/t/[tenantSlug]/(app)/practices/[practiceId]/page.tsx',
);

describe('practice detail — tab-lazy page-data (#102 item 1)', () => {
    it('page-data uses the header-only getter, not the full getPractice', () => {
        expect(PAGE_DATA).toMatch(/getPracticeHeader\(ctx, practiceId\)/);
        expect(PAGE_DATA).not.toMatch(/\bgetPractice\(/);
    });

    it('getPracticeHeader is exported and getHeaderById exists', () => {
        expect(QUERIES).toMatch(/export async function getPracticeHeader\b/);
        expect(REPO).toMatch(/static async getHeaderById\b/);
    });

    it('the header getter counts the tabbed relations, not loads them', () => {
        // `getHeaderById` carries a `_count` for the four tabbed
        // relations; it must NOT array-include them (that's the very
        // over-fetch this refactor removed).
        const m = REPO.match(/static async getHeaderById[\s\S]*?\n {4}}/);
        expect(m).not.toBeNull();
        const body = m![0];
        expect(body).toMatch(/_count:\s*{/);
        expect(body).not.toMatch(/practiceTasks:\s*{\s*orderBy/);
        expect(body).not.toMatch(/evidenceLinks:\s*{\s*orderBy/);
        expect(body).not.toMatch(/frameworkMappings:\s*{\s*include/);
    });

    it('lazily loads the Evidence tab; the Tasks tab is delegated to LinkedTasksPanel', () => {
        // B4 (2026-06-07): the Tasks tab no longer page-fetches — it renders
        // <LinkedTasksPanel> (which self-fetches the unified tasks), matching
        // the Asset + Risk Tasks tabs. The page-level CACHE_KEYS.practices.tasks
        // fetch was removed.
        expect(PAGE).toMatch(/tab === 'tasks' &&/);
        expect(PAGE).toMatch(/<LinkedTasksPanel[\s\S]*?entityType="PRACTICE"/);
        expect(PAGE).not.toMatch(/CACHE_KEYS\.practices\.tasks/);
        // Evidence still uses a per-tab SWR key that's null until active.
        expect(PAGE).toMatch(
            /tab === 'evidence'[\s\S]{0,90}CACHE_KEYS\.practices\.evidence/,
        );
    });

    it('the Mappings tab is extracted into _tabs/ and self-fetches', () => {
        // The whole Mappings tab — fetch + map/unmap + JSX — moved
        // off the page into its own component, which mounts only
        // when the tab is active.
        expect(PAGE).toMatch(/<PracticeMappingsTab\b/);
        const TAB = read(
            'src/app/t/[tenantSlug]/(app)/practices/[practiceId]/_tabs/PracticeMappingsTab.tsx',
        );
        expect(TAB).toMatch(/useTenantSWR<[^>]*>\(\s*CACHE_KEYS\.practices\.mappings/);
    });

    it('the page no longer reads the heavy arrays off the practice payload', () => {
        expect(PAGE).not.toMatch(/practice\.practiceTasks/);
        expect(PAGE).not.toMatch(/practice\.evidenceLinks/);
        expect(PAGE).not.toMatch(/practice\.frameworkMappings/);
    });
});

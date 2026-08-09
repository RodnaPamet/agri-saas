/**
 * B4 (2026-06-07) — the Practice detail "Tasks" tab matches the Asset + Risk
 * "Tasks" tabs: a single card-wrapped <LinkedTasksPanel>.
 *
 * Before B4 the Practice tab also rendered a divergent legacy "Practice tasks
 * (legacy)" DataTable (the old per-practice PracticeTask model) below the
 * panel, and wasn't card-wrapped — so its table view differed from the
 * other two detail pages. B4 removed the legacy table + its supporting flow
 * (practiceTaskColumns / updateTaskStatus / the tasksSWR fetch) and
 * card-wraps the panel.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CONTROL = read('src/app/t/[tenantSlug]/(app)/practices/[practiceId]/page.tsx');
const ASSET = read('src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx');

describe('B4 — Practice Tasks tab matches Asset/Risk', () => {
    it('Practice Tasks tab is a single card-wrapped LinkedTasksPanel', () => {
        expect(CONTROL).toMatch(
            /tab === 'tasks'[\s\S]*?cardVariants\(\)[\s\S]*?<LinkedTasksPanel/,
        );
        expect(CONTROL).toContain('id="practice-tasks-tab"');
    });

    it('the divergent legacy "Practice tasks" DataTable + flow are gone', () => {
        expect(CONTROL).not.toContain('practice-tasks-table');
        expect(CONTROL).not.toContain('Practice tasks (legacy)');
        // the legacy declarations are gone (a removal comment may still name
        // them, so match the actual `const` declarations, not the bare word).
        expect(CONTROL).not.toMatch(/const practiceTaskColumns/);
        expect(CONTROL).not.toMatch(/const updateTaskStatus/);
    });

    it('all three detail pages render LinkedTasksPanel for their Tasks tab', () => {
        for (const src of [CONTROL, ASSET]) {
            expect(src).toMatch(/<LinkedTasksPanel/);
        }
    });
});

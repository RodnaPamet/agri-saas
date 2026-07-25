/**
 * Control / Asset / Risk detail pages — task creation MUST go through
 * the SAME canonical modal as the Tasks page "+ Task" button, via the
 * shared `<LinkedTasksPanel>`.
 *
 * History: asset/risk used a bespoke `<LinkedTaskCreateModal>` (a
 * 3-field create dialog) while the Tasks page used the full
 * `<NewTaskModal>`. 2026-05-30 unified them — `LinkedTasksPanel` now
 * opens the canonical `<NewTaskModal>` (imported from the tasks route),
 * preset with a TaskLink back to the host entity, so a task created
 * from a control/asset/risk detail page is identical to a standalone
 * task and lands in the global Tasks list.
 *
 * This ratchet locks:
 *   1. LinkedTasksPanel renders the canonical NewTaskModal with a
 *      preset entity link + onCreated refresh (NOT a bespoke modal).
 *   2. The create UI is gated on canWrite AND a canonical entity type
 *      (ASSET / RISK / CONTROL).
 *   3. The Asset + Risk detail pages pass canWrite through.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8");

const PANEL_PATH = "src/components/LinkedTasksPanel.tsx";
const ASSET_PAGE = "src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx";
const RISK_PAGE = "src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx";

describe("Control/Asset/Risk task creation — unified canonical modal", () => {
    describe("1. LinkedTasksPanel uses the canonical NewTaskModal", () => {
        const src = () => read(PANEL_PATH);

        it("imports the shared NewTaskModal (the Tasks-page create modal)", () => {
            // Same component the Tasks list page mounts — so the
            // create experience is identical everywhere.
            expect(src()).toMatch(
                /import\s*\{\s*NewTaskModal\s*\}\s*from\s+['"]@\/components\/tasks\/NewTaskModal['"]/,
            );
        });

        it("mounts NewTaskModal with a preset entity link + onCreated refresh", () => {
            const s = src();
            expect(s).toMatch(/<NewTaskModal\b/);
            // The preset link wires the new task back to this entity
            // (entityType + entityId) so it shows in the panel + the
            // global Tasks list.
            expect(s).toMatch(/initialPendingLinks=\{/);
            expect(s).toMatch(/entityType:\s*canonicalEntityType/);
            expect(s).toMatch(/entityId,/);
            // Reuse the memoised loader so the list refreshes in place.
            expect(s).toMatch(/onCreated=\{\(\)\s*=>\s*void loadTasks\(\)\}/);
        });

        it("no longer depends on the bespoke LinkedTaskCreateModal", () => {
            expect(src()).not.toMatch(
                /import[\s\S]{0,80}LinkedTaskCreateModal/,
            );
        });
    });

    describe("2. Create UI gated on canWrite + canonical entity type", () => {
        const src = () => read(PANEL_PATH);

        it("accepts a canWrite prop (default false for read-only callers)", () => {
            const s = src();
            expect(s).toMatch(/canWrite\?:\s*boolean/);
            expect(s).toMatch(/canWrite = false/);
        });

        it("gates the create UI on canWrite AND entityType in (ASSET, RISK, CONTROL)", () => {
            const s = src();
            expect(s).toMatch(/entityType === ['"]ASSET['"]/);
            expect(s).toMatch(/entityType === ['"]RISK['"]/);
            expect(s).toMatch(/entityType === ['"]CONTROL['"]/);
            expect(s).toMatch(/showCreate = canWrite && /);
        });

        it("the '+ Task' button is gated by showCreate and has the canonical testid", () => {
            const s = src();
            expect(s).toMatch(/showCreate &&/);
            expect(s).toMatch(/data-testid="linked-task-create-btn"/);
            expect(s).toMatch(/id="linked-task-create-btn"/);
        });
    });

    describe("3. Consumer pages pass canWrite through", () => {
        it("Asset detail page passes canWrite={permissions.canWrite}", () => {
            const s = read(ASSET_PAGE);
            const mounts = s.match(/<LinkedTasksPanel[\s\S]*?\/>/g) ?? [];
            expect(mounts.length).toBeGreaterThan(0);
            const writable = mounts.find((m) =>
                /canWrite=\{permissions\.canWrite\}/.test(m),
            );
            expect(writable).toBeDefined();
            expect(writable).toMatch(/entityType="ASSET"/);
        });

        it("Risk detail page passes canWrite={canWrite}", () => {
            const s = read(RISK_PAGE);
            const mounts = s.match(/<LinkedTasksPanel[\s\S]*?\/>/g) ?? [];
            expect(mounts.length).toBeGreaterThan(0);
            const writable = mounts.find((m) =>
                /canWrite=\{canWrite\}/.test(m),
            );
            expect(writable).toBeDefined();
            expect(writable).toMatch(/entityType="RISK"/);
        });
    });
});

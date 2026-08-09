/**
 * Practice detail page — Tasks tab — task creation MUST go through the
 * SAME canonical modal as the Tasks page "+ Task" button, and the
 * created task MUST land in the global Tasks table (so it appears in
 * the Tasks list).
 *
 * History: the practice detail page used to create tasks via a bespoke
 * `<NewPracticeTaskModal>` + a dedicated `POST /practices/:id/tasks`
 * endpoint that wrote a separate `PracticeTask` row — invisible to the
 * global Tasks list and a different (3-field) modal than every other
 * surface. 2026-05-30 unified all task creation: the Tasks tab now
 * mounts the shared `<LinkedTasksPanel entityType="CONTROL">`, which
 * opens the canonical `<NewTaskModal>` (preset with a CONTROL TaskLink)
 * and POSTs to `/tasks`. The wiring is locked here so a future refactor
 * can't silently fork the practice task-create flow again.
 *
 * Pairs with `tests/guards/asset-risk-task-create-modal.test.ts`
 * (the shared LinkedTasksPanel contract).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8");

const PAGE_PATH =
    "src/app/t/[tenantSlug]/(app)/practices/[practiceId]/page.tsx";

describe("Practice task creation — unified through LinkedTasksPanel", () => {
    const src = () => read(PAGE_PATH);

    it("Tasks tab mounts <LinkedTasksPanel entityType=\"CONTROL\"> with canWrite", () => {
        const s = src();
        // The panel is the single create+list surface for practice
        // tasks now. It must receive entityType CONTROL + the page's
        // write permission so the "+ Task" affordance shows for
        // editors and the created task links back to this practice.
        const block = s.slice(
            s.indexOf("entityType=\"CONTROL\""),
            s.indexOf("entityType=\"CONTROL\"") + 400,
        );
        expect(s).toMatch(/<LinkedTasksPanel\b/);
        expect(s).toMatch(/entityType="CONTROL"/);
        expect(block).toMatch(/canWrite=\{permissions\.canWrite\}/);
    });

    it("no longer imports or mounts the bespoke NewPracticeTaskModal", () => {
        const s = src();
        expect(s).not.toMatch(/NewPracticeTaskModal/);
    });

    it("no longer POSTs to the per-practice PracticeTask create endpoint", () => {
        // New tasks go through the global POST /tasks (via the shared
        // modal). A reintroduced `POST /practices/:id/tasks` create
        // would mean practice tasks are once again invisible to the
        // Tasks list.
        const s = src();
        expect(s).not.toMatch(/\/practices\/\$\{practiceId\}\/tasks`/);
    });

    it("has no inline task-create <form> block", () => {
        const s = src();
        const formMatches = s.match(/<form[\s\S]*?<\/form>/g) ?? [];
        for (const formBlock of formMatches) {
            expect(formBlock).not.toMatch(/data-testid="task-title-input"/);
            expect(formBlock).not.toMatch(/id="task-title-input"/);
        }
    });
});

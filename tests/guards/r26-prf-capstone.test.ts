/**
 * R26-PR-F — Capstone meta-ratchet for the Processes roadmap.
 *
 * Asserts that every PR-A through PR-F deliverable still ships:
 *
 *   PR-A — domain model + APIs + persistence wiring
 *   PR-B — node taxonomy + richer palette
 *   PR-C — proximity auto-bind + snap
 *   PR-D — edge-first practices + semantic categories
 *   PR-E — editor UX (rename, duplicate, inspector)
 *   PR-F — polish (help strip, improved empty state, this ratchet)
 *
 * The meta-ratchet does NOT duplicate the structural assertions
 * each PR-specific ratchet already enforces. It locks the
 * EXISTENCE of every R26 file the roadmap depends on so a future
 * "tidy-up" PR that mass-deletes process/ files would fail CI
 * with a clear "you killed the roadmap" message.
 *
 * When a future R27 lands: this file stays as a historical
 * snapshot of "what R26 shipped". DO NOT update it for new
 * components — add a sibling capstone test instead. The list
 * here is meant to be frozen.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

const R26_FILES_THAT_MUST_EXIST = [
    // PR-A — domain + persistence.
    // `prisma/schema/processes.prisma` was here until GRC teardown
    // phase 3. The DELIVERABLE did not go anywhere — the ProcessMap /
    // ProcessNode / ProcessEdge / ProcessEdgePractice models live in
    // `automation.prisma`, where phase 1 moved them; the file left
    // behind was comment-only and its header still described a
    // now-deleted `compliance.prisma`. The migration below is the real
    // record of the persistence deliverable.
    "prisma/migrations/20260519120000_r26_pra_process_maps/migration.sql",
    "src/app-layer/schemas/process-map.ts",
    "src/app-layer/repositories/ProcessMapRepository.ts",
    "src/app-layer/usecases/process-map.ts",
    "src/app/api/t/[tenantSlug]/processes/route.ts",
    "src/app/api/t/[tenantSlug]/processes/[id]/route.ts",
    // PR-B — taxonomy + renderer
    "src/components/processes/node-taxonomy.ts",
    "src/components/processes/ProcessTypedNode.tsx",
    // PR-C — proximity hook
    "src/lib/processes/use-proximity-auto-bind.ts",
    // PR-D — semantics doc
    "docs/processes-canvas-semantics.md",
    // PR-E — editor UX
    "src/components/processes/ProcessInspector.tsx",
    // PR-F — polish. The CanvasHelpStrip file shipped here was
    // retired in R31 (the "one message per state" principle
    // moved the onboarding affordance into the empty-state hint
    // at canvas-bottom-centre). The supersession is documented
    // in the empty-state-anchor assertion below.
    // Persistence canvas — the central composition that wires
    // every PR's plumbing into one surface.
    "src/components/processes/PersistedProcessCanvas.tsx",
];

const R26_RATCHETS_THAT_MUST_EXIST = [
    "tests/guards/r25-prb-canvas-integration.test.ts",
    "tests/guards/r25-prc-process-step-node.test.ts",
    "tests/guards/r25-prd-edge-and-practice-overlay.test.ts",
    "tests/guards/r26-prb-node-taxonomy.test.ts",
    "tests/guards/r26-prc-proximity-auto-bind.test.ts",
    "tests/guards/r26-prd-edge-practices-semantics.test.ts",
    "tests/guards/r26-pre-editor-ux.test.ts",
];

describe("R26-PR-F — Processes roadmap capstone", () => {
    it("every R26 source / schema / doc file still exists", () => {
        const missing: string[] = [];
        for (const rel of R26_FILES_THAT_MUST_EXIST) {
            const abs = path.join(ROOT, rel);
            if (!fs.existsSync(abs)) missing.push(rel);
        }
        if (missing.length > 0) {
            throw new Error(
                `R26 roadmap deliverables missing:\n  ${missing.join("\n  ")}\n\nIf a file was renamed, update tests/guards/r26-prf-capstone.test.ts to point at the new path. If a file was intentionally deleted, the PR description must justify it (the deliverable should re-land somewhere or be explicitly retired).`,
            );
        }
        expect(missing).toEqual([]);
    });

    it("every R26 ratchet test file still exists", () => {
        const missing: string[] = [];
        for (const rel of R26_RATCHETS_THAT_MUST_EXIST) {
            const abs = path.join(ROOT, rel);
            if (!fs.existsSync(abs)) missing.push(rel);
        }
        if (missing.length > 0) {
            throw new Error(
                `R26 ratchet tests missing:\n  ${missing.join("\n  ")}\n\nRatchets exist to lock the contracts each PR introduced. Deleting one without re-pointing the assertions removes the regression-prevention floor R26 committed to.`,
            );
        }
        expect(missing).toEqual([]);
    });

    it("Processes page mounts the persisted canvas (the integration point)", () => {
        // The single composition target. If `<ProcessesClient>`
        // stops mounting `<PersistedProcessCanvas>`, the entire
        // roadmap is structurally disconnected from the route.
        const src = fs.readFileSync(
            path.join(
                ROOT,
                "src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx",
            ),
            "utf8",
        );
        expect(src).toMatch(/<PersistedProcessCanvas\b/);
    });

    it("PersistedProcessCanvas wires every PR's deliverable", () => {
        // One file-level scan that locks the wiring of the four
        // PR deliverables that share the canvas as their surface:
        //   PR-A: save (PUT) + load (GET) + create (POST)
        //   PR-C: useProximityAutoBind hook usage
        //   PR-E: ProcessInspector + handleRenameCommit +
        //         handleDuplicate
        //   PR-F: CanvasHelpStrip mount
        // Each is asserted at a coarse level here; per-PR
        // ratchets carry the granular contracts.
        const src = fs.readFileSync(
            path.join(
                ROOT,
                "src/components/processes/PersistedProcessCanvas.tsx",
            ),
            "utf8",
        );
        // PR-A
        expect(src).toMatch(/method:\s*["']PUT["']/);
        expect(src).toMatch(/method:\s*["']POST["']/);
        expect(src).toMatch(/fetch\(`\/api\/t\/\$\{tenantSlug\}\/processes/);
        // PR-C
        expect(src).toMatch(/useProximityAutoBind/);
        // PR-E
        expect(src).toMatch(/<ProcessInspector\b/);
        expect(src).toMatch(/handleRenameCommit/);
        expect(src).toMatch(/handleDuplicate/);
        // PR-F — superseded by R31. The CanvasHelpStrip mount
        // was removed; the empty-but-loaded hint at canvas-bottom-
        // centre is the canonical onboarding affordance now. The
        // assertion below pins the new anchor so an accidental
        // re-introduction of the strip or removal of the hint
        // fails CI.
        expect(src).toMatch(/data-canvas-empty-state="true"/);
        expect(src).not.toMatch(/<CanvasHelpStrip\b/);
    });
});

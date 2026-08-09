/**
 * R25-PR-F — Polish + Roadmap-25 capstone.
 *
 * Two layers:
 *   1. Polish assertions: empty state, MiniMap omitted, aria-label,
 *      React.memo wrap.
 *   2. Capstone meta-ratchet — locks all 6 R25 ratchet files +
 *      defense-in-depth re-assertions on the most load-bearing
 *      contracts (WorkspaceShell exists, ProcessCanvas wraps
 *      ReactFlowProvider, custom node + edge types registered).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

const ALL_R25_RATCHETS = [
    "tests/guards/r25-pra-route-and-shell.test.ts",
    "tests/guards/r25-prb-canvas-integration.test.ts",
    "tests/guards/r25-prc-process-step-node.test.ts",
    "tests/guards/r25-prd-edge-and-practice-overlay.test.ts",
    "tests/guards/r25-pre-interaction-model.test.ts",
    "tests/guards/r25-prf-polish-and-capstone.test.ts",
] as const;

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("R25-PR-F — Polish + capstone", () => {
    describe("Empty-state polish", () => {
        const canvasSrc = read("src/components/processes/ProcessCanvas.tsx");

        it("renders an empty-state hint when nodes.length === 0", () => {
            expect(canvasSrc).toMatch(/nodes\.length\s*===\s*0/);
        });

        it("empty-state copy: short instructional sentence", () => {
            // The R25 calmness commitment: one sentence, no card,
            // no illustration. Affordances should not linger past
            // the moment of need.
            expect(canvasSrc).toMatch(/processCanvas\.emptyDragHint/);
        });

        it("empty-state container is pointer-events-none (does not block canvas)", () => {
            // The hint sits over the canvas surface. Without
            // `pointer-events-none` it would swallow the first
            // palette drop — fatal UX bug. Pin the attribute.
            expect(canvasSrc).toMatch(/data-canvas-empty-state[\s\S]*?pointer-events-none|pointer-events-none[\s\S]*?data-canvas-empty-state/);
        });
    });

    describe("Restraint — visual chatter rejected", () => {
        const canvasSrc = read("src/components/processes/ProcessCanvas.tsx");

        it("MiniMap deliberately NOT mounted", () => {
            // The MiniMap reads as clutter on a calm canvas surface.
            // R25 commits to omitting it. A future "add overview"
            // PR has to justify why this changed.
            expect(canvasSrc).not.toMatch(/<MiniMap\b/);
        });

        it("Practices (pan/zoom toolbar) deliberately NOT mounted", () => {
            // Trackpad + scroll-zoom carry the interaction. The
            // explicit Practices component reads as a busy debug
            // affordance.
            expect(canvasSrc).not.toMatch(/<Practices\b/);
        });
    });

    describe("Accessibility", () => {
        const canvasSrc = read("src/components/processes/ProcessCanvas.tsx");

        it("ReactFlow surface has an aria-label", () => {
            expect(canvasSrc).toMatch(/aria-label=\{t\("processCanvas\.ariaLabel"\)\}/);
        });
    });

    describe("Perf — memo wrap on the inner canvas", () => {
        const canvasSrc = read("src/components/processes/ProcessCanvas.tsx");

        it("ProcessCanvasInner is memo-wrapped", () => {
            // Prevents re-renders when the page wrapper re-renders
            // for reasons unrelated to nodes/edges state.
            expect(canvasSrc).toMatch(/memo\(ProcessCanvasInner\)/);
        });
    });

    describe("Capstone meta-lock — all 6 R25 ratchet files exist", () => {
        for (const ratchet of ALL_R25_RATCHETS) {
            it(`${ratchet} exists`, () => {
                expect(fs.existsSync(path.join(ROOT, ratchet))).toBe(true);
            });
        }
    });

    describe("Capstone defense-in-depth on load-bearing contracts", () => {
        // Re-asserted here so each contract is locked at TWO points
        // (the originating PR's ratchet AND the capstone). A single-
        // ratchet revert can't silently undo R25's commitments.

        it("WorkspaceShell primitive exists", () => {
            expect(
                fs.existsSync(
                    path.join(ROOT, "src/components/layout/WorkspaceShell.tsx"),
                ),
            ).toBe(true);
        });

        it("ProcessCanvas wraps ReactFlowProvider", () => {
            const src = read("src/components/processes/ProcessCanvas.tsx");
            expect(src).toMatch(/<ReactFlowProvider\b/);
        });

        it("Custom node + edge types both registered + consumed", () => {
            const src = read("src/components/processes/ProcessCanvas.tsx");
            expect(src).toMatch(/nodeTypes=\{NODE_TYPES\}/);
            expect(src).toMatch(/edgeTypes=\{EDGE_TYPES\}/);
        });

        it("Page consumer uses WorkspaceShell, not ListPageShell", () => {
            const src = read(
                "src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx",
            );
            expect(src).toMatch(/<WorkspaceShell\b/);
            expect(src).not.toMatch(/<ListPageShell\b/);
        });

        it("no longer exposes a /processes Manage nav entry (intentionally removed)", () => {
            // The compliance surfaces were dropped from the farm-app
            // sidebar. The /processes route + canvas still exist (asserted
            // above) and stay reachable by direct URL; only the nav
            // affordance was removed.
            const src = read("src/components/layout/SidebarNav.tsx");
            expect(src).not.toMatch(/href:\s*tenantHref\(['"]\/processes['"]\)/);
        });
    });
});

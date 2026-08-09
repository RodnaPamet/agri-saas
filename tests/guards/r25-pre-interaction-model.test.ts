/**
 * R25-PR-E — interaction model ratchet.
 *
 * The R25 interaction model is deliberately constrained:
 *   - Drag from palette → drop creates a node (PR-B).
 *   - Drag from node handle → connect creates an edge (PR-B).
 *   - Click on edge → "+ Add practice" affordance at midpoint;
 *     click → adds PracticeOnEdge with default label "Practice".
 *   - Standard xyflow drag for repositioning.
 *   - Standard xyflow Backspace for delete.
 *
 * Out-of-scope (and the ratchet enforces the absence):
 *   - Right-click context menus.
 *   - Inspector / properties panel.
 *   - Inline editing dialogs for practice label.
 *
 * This ratchet locks the "+ Add practice" affordance contract:
 *   1. The affordance appears ONLY when edge.selected === true.
 *   2. The affordance disappears once a practice is added.
 *   3. Clicking the affordance mutates the edge's data.practice via
 *      useReactFlow().setEdges.
 *   4. The affordance uses a contextual icon (ShieldPlus) distinct
 *      from the placed-practice icon (ShieldCheck) so users see the
 *      action vs the result.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const EDGE_PATH = "src/components/processes/ProcessEdge.tsx";

const SRC = fs.readFileSync(path.join(ROOT, EDGE_PATH), "utf8");

describe("R25-PR-E — interaction model", () => {
    describe("Add-practice affordance", () => {
        it("uses useReactFlow().setEdges to mutate edge data", () => {
            // setEdges is the xyflow-blessed way to update edge
            // state from inside a custom edge component. Mutating
            // a parent's state directly would break xyflow's
            // change-detection optimisations.
            expect(SRC).toMatch(/useReactFlow\(\)/);
            expect(SRC).toMatch(/setEdges\(/);
        });

        it("affordance is rendered conditionally on (selected && !practice)", () => {
            // The affordance must NOT be always-on — that would
            // clutter every edge at rest. Pattern: only show when
            // the edge is SELECTED and does NOT yet carry a practice.
            expect(SRC).toMatch(
                /\{!practice\s*&&\s*selected\s*&&\s*\(/,
            );
        });

        it("affordance click handler adds a practice with the default label", () => {
            // The constrained model: one click adds a practice with
            // a default label. No naming dialog, no inline editing
            // (those are explicitly out of R25 scope).
            expect(SRC).toMatch(
                /practice:\s*\{\s*label:\s*t\("processEdge\.practiceDefault"\)\s*\}/,
            );
        });

        it("affordance uses ShieldPlus icon (distinct from placed practice's ShieldCheck)", () => {
            // Different icons for the AFFORDANCE (action) vs the
            // RESULT (placed practice). Visual feedback that the
            // click did something.
            expect(SRC).toMatch(/ShieldPlus/);
            expect(SRC).toMatch(/ShieldCheck/);
        });

        it("affordance positions at the edge midpoint (labelX/labelY)", () => {
            // Affordances must appear AT the connection. R27-PR-B
            // groups the variant cycle + add-practice into one
            // selection cluster positioned via getBezierPath's
            // labelX/labelY midpoint.
            expect(SRC).toMatch(/translate\(\$\{labelX\}px/);
        });

        it("affordance marker for downstream selectors", () => {
            expect(SRC).toMatch(/data-add-practice-affordance/);
        });
    });

    describe("Constrained model — explicit absences", () => {
        it("no context-menu wiring (right-click)", () => {
            // R25 scope: no per-edge context menu. xyflow has
            // onEdgeContextMenu — we deliberately don't use it.
            expect(SRC).not.toMatch(/onEdgeContextMenu/);
            expect(SRC).not.toMatch(/contextMenu/);
        });

        it("no inline label-editing input/dialog inside ProcessEdge", () => {
            // The constrained model: practice labels are not edited
            // inline. Adding an <input> here would expand scope
            // into label editing semantics — explicitly out.
            const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
                /\/\/[^\n]*/g,
                "",
            );
            expect(stripped).not.toMatch(/<input\b/);
        });
    });
});

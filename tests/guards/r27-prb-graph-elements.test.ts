/**
 * Roadmap-27 PR-B — Processes graph-elements ratchet.
 *
 * PR-B redesigns the node SHAPE language (prompt 3) and the edge
 * CONNECTION language (prompt 4). This ratchet locks the load-bearing
 * pieces:
 *
 *   Nodes:
 *   1. A real diamond — the decision node renders a 45°-rotated
 *      body, not the R25/R26 fake (a small rounded rect).
 *   2. Three discrete size variants (sm / md / lg) on `data.size`.
 *
 *   Edges:
 *   3. A three-variant connection vocabulary — flow (solid),
 *      conditional (dashed), reference (dotted).
 *   4. The variant is settable (cycle affordance) and persists
 *      through the `edgeKind` column.
 *
 *   Persistence:
 *   5. Node size round-trips via `ProcessNode.dataJson`; edge
 *      variant via `ProcessEdge.edgeKind`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const NODE = read("src/components/processes/ProcessTypedNode.tsx");
const EDGE = read("src/components/processes/ProcessEdge.tsx");
const CANVAS = read("src/components/processes/PersistedProcessCanvas.tsx");
const INSPECTOR = read("src/components/processes/ProcessInspector.tsx");
const TOKENS = read("src/styles/tokens.css");

describe("R27-PR-B — node shape language (R31-superseded for decision)", () => {
    // R31 retired the diamond. The four assertions below previously
    // pinned the 45°-rotated body, the DIAMOND_SIZE size table, and
    // the "no fake-diamond" guard. All four are now flipped into
    // their NEGATIVE forms — re-introducing any of them would split
    // the visual vocabulary again, which R31's design verdict
    // explicitly walks back. The supersession is documented here so
    // a future PR that tries to revive the diamond fails CI loudly.

    it("decision is NOT a 45°-rotated body any more (R31 retired the diamond)", () => {
        // The rotate-45 chassis is gone; the decision kind renders
        // through the rect path now, with a "?" corner sticker as
        // the per-kind hint.
        expect(NODE).not.toMatch(/rotate-45/);
    });

    it("DIAMOND_SIZE table is gone (rect chassis covers every kind)", () => {
        expect(NODE).not.toMatch(/DIAMOND_SIZE/);
    });

    it("exposes the three rect size variants", () => {
        expect(NODE).toMatch(/ProcessNodeSize/);
        expect(NODE).toMatch(/PROCESS_NODE_SIZES/);
        expect(NODE).toMatch(/DEFAULT_NODE_SIZE/);
        expect(NODE).toMatch(/RECT_SIZE/);
        for (const step of ["sm:", "md:", "lg:"]) {
            expect(NODE).toMatch(new RegExp(step));
        }
    });

    it("keeps the brand selected ring (R25 selection vocabulary)", () => {
        // R32-PR11 inserted `ring-offset-2 ring-offset-canvas-
        // surface` between `ring-2` and the brand colour for
        // Apple-style emphasis breathing space. Anchor on both
        // pieces independently — they share a line but with
        // arbitrary content between them.
        expect(NODE).toMatch(/ring-2\b/);
        expect(NODE).toMatch(/ring-\[color:var\(--brand-default\)\]/);
        expect(NODE).toMatch(/bg-bg-elevated/);
    });

    it("decision + external get a corner sticker (R31 per-kind affordance)", () => {
        // The retired diamond's job — disambiguating decision —
        // moves into a quiet corner sticker. The same affordance
        // gives external its "EXT" badge; future kinds plug into
        // the same slot.
        expect(NODE).toMatch(
            /kind === ["']decision["'][\s\S]{0,80}\?/,
        );
        expect(NODE).toMatch(
            /kind === ["']external["'][\s\S]{0,80}["']EXT["']/,
        );
        expect(NODE).toMatch(/data-process-node-sticker/);
    });
});

describe("R27-PR-B — edge connection language", () => {
    it("defines the three-variant vocabulary", () => {
        expect(EDGE).toMatch(/ProcessEdgeVariant/);
        expect(EDGE).toMatch(/EDGE_VARIANT_ORDER/);
        expect(EDGE).toMatch(/isProcessEdgeVariant/);
        for (const v of ['"flow"', '"conditional"', '"reference"']) {
            expect(EDGE).toMatch(new RegExp(v));
        }
    });

    it("solid / dashed / dotted — one line style per variant", () => {
        // conditional → dashed; reference → dotted (round-capped).
        expect(EDGE).toMatch(/strokeDasharray:\s*["']7 5["']/);
        expect(EDGE).toMatch(/strokeDasharray:\s*["']1 6["']/);
        expect(EDGE).toMatch(/strokeLinecap:\s*["']round["']/);
    });

    it("rest stroke uses --canvas-edge; selected uses --brand-default", () => {
        expect(EDGE).toMatch(/var\(--canvas-edge\)/);
        expect(EDGE).toMatch(/var\(--brand-default\)/);
    });

    it("the variant is settable from a selection affordance", () => {
        expect(EDGE).toMatch(/cycleVariant/);
        expect(EDGE).toMatch(/data-edge-variant-affordance/);
    });

    it("preserves the practice-on-edge affordance", () => {
        expect(EDGE).toMatch(/!practice && selected/);
        expect(EDGE).toMatch(/Add practice/);
        expect(EDGE).toMatch(/data-practice-on-edge-badge/);
    });
});

describe("R27-PR-B — persistence", () => {
    it("edge variant round-trips via edgeKind", () => {
        expect(CANVAS).toMatch(/edgeKindOf/);
        // No more hardcoded "flow".
        expect(CANVAS).not.toMatch(/edgeKind:\s*["']flow["']/);
    });

    it("node size round-trips via dataJson", () => {
        expect(CANVAS).toMatch(/nodeDataJson/);
        expect(CANVAS).toMatch(/dataJson:\s*nodeDataJson\(n\)/);
    });

    it("the inspector exposes the size practice", () => {
        expect(INSPECTOR).toMatch(/ToggleGroup/);
        expect(INSPECTOR).toMatch(/processInspector\.nodeSize/);
    });

    it("--canvas-edge has light + dark theme parity", () => {
        const defs = TOKENS.match(/--canvas-edge:/g) ?? [];
        expect(defs.length).toBe(2);
    });
});

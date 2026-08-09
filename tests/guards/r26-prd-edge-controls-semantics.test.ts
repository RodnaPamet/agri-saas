/**
 * R26-PR-D — Edge-mounted controls + asset semantics ratchet.
 *
 * Locks the THREE structural commitments PR-D makes:
 *
 *   1. CONTROL IS EDGE-FIRST. The `control` kind is intentionally
 *      ABSENT from `NODE_TAXONOMY_ORDER` — the palette no longer
 *      offers a Control stamp. The canonical entry point is the
 *      "Add control" affordance on the edge selection.
 *
 *   2. THE TAXONOMY ENTRY SURVIVES. The kind stays in
 *      `NODE_TAXONOMY` so legacy map data (R25 / R26-PR-A through
 *      PR-C) carrying `nodeType: 'control'` still rehydrates
 *      correctly. A future PR dropping the entry would silently
 *      break older maps.
 *
 *   3. EVERY KIND CARRIES A SEMANTIC CATEGORY. The renderer
 *      branches on `meta.category` for the flow / context / note
 *      surface tone. A kind without a category would fall through
 *      to the default flow tone, undoing the second-order visual
 *      distinction.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const TAXONOMY_PATH = "src/components/processes/node-taxonomy.ts";
const RENDERER_PATH = "src/components/processes/ProcessTypedNode.tsx";
const EDGE_PATH = "src/components/processes/ProcessEdge.tsx";

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("R26-PR-D — edge-first controls + semantic categories", () => {
    const taxonomySrc = read(TAXONOMY_PATH);

    it("'control' is OMITTED from NODE_TAXONOMY_ORDER (edge-first)", () => {
        const match = taxonomySrc.match(
            /NODE_TAXONOMY_ORDER:\s*ProcessNodeKind\[\]\s*=\s*\[([\s\S]*?)\]/,
        );
        expect(match).not.toBeNull();
        const order = match![1];
        const items =
            order.match(/['"](\w+)['"]/g)?.map((s) => s.replace(/['"]/g, "")) ??
            [];
        expect(items).not.toContain("control");
        // Sanity — the other six are still there. A future PR
        // dropping additional kinds without intent would surface
        // here.
        for (const kept of [
            "processStep",
            "decision",
            "asset",
            "external",
            "annotation",
        ]) {
            expect(items).toContain(kept);
        }
    });

    it("'control' SURVIVES in NODE_TAXONOMY (legacy maps rehydrate)", () => {
        // The kind must remain defined so legacy `nodeType:
        // 'control'` rows don't fall through to the unknown-kind
        // fallback (which would re-render them as plain process
        // steps and silently rebrand the data).
        expect(taxonomySrc).toMatch(/^\s*control:\s*\{/m);
    });

    it("every kind declares a semantic category", () => {
        for (const kind of [
            "processStep",
            "decision",
            "control",
            "asset",
            "external",
            "annotation",
        ]) {
            const re = new RegExp(
                `^\\s*${kind}:\\s*\\{[\\s\\S]*?\\bcategory:\\s*['"](flow|context|note)['"]`,
                "m",
            );
            expect(taxonomySrc).toMatch(re);
        }
    });

    it("flow kinds: processStep + decision", () => {
        // Sanity-check the category assignment for the two flow
        // kinds. Drift here would mean a flow node renders with
        // context-tone surface (or vice versa) — visually wrong.
        for (const flowKind of ["processStep", "decision"]) {
            const re = new RegExp(
                `^\\s*${flowKind}:\\s*\\{[\\s\\S]*?\\bcategory:\\s*['"]flow['"]`,
                "m",
            );
            expect(taxonomySrc).toMatch(re);
        }
    });

    it("context kinds: control + asset + external", () => {
        for (const contextKind of ["control", "asset", "external"]) {
            const re = new RegExp(
                `^\\s*${contextKind}:\\s*\\{[\\s\\S]*?\\bcategory:\\s*['"]context['"]`,
                "m",
            );
            expect(taxonomySrc).toMatch(re);
        }
    });

    it("note kind: annotation", () => {
        expect(taxonomySrc).toMatch(
            /^\s*annotation:\s*\{[\s\S]*?\bcategory:\s*['"]note['"]/m,
        );
    });
});

describe("R26-PR-D — renderer branches on category", () => {
    const rendererSrc = read(RENDERER_PATH);

    it("ProcessTypedNode reads meta.category for surface tone", () => {
        // The whole point of PR-D's semantic distinction is that
        // the renderer applies it. A shape-only branch would
        // collapse flow vs context back into the R26-PR-B
        // shape-only vocabulary.
        expect(rendererSrc).toMatch(/meta\.category\s*===\s*["']note["']/);
        expect(rendererSrc).toMatch(/meta\.category\s*===\s*["']context["']/);
    });
});

describe("R26-PR-D — edge-mounted control affordance preserved", () => {
    const edgeSrc = read(EDGE_PATH);

    it("ControlOnEdge component exists + carries the shield icon", () => {
        // R25-PR-D landed the edge-mounted control overlay; PR-D
        // makes it the canonical control surface. The component
        // + its visual signature MUST persist.
        expect(edgeSrc).toMatch(/export function ControlOnEdge\b/);
        expect(edgeSrc).toMatch(/ShieldCheck/);
    });

    it("the 'Add control' affordance fires on selected, control-less edges", () => {
        // The contextual affordance is the entry point users
        // discover. Removing the gating would make the button
        // always-on (cluttering); removing the affordance
        // entirely would leave no way to add a control without
        // an inspector panel (PR-E future work).
        expect(edgeSrc).toMatch(/!control && selected/);
        expect(edgeSrc).toMatch(/Add control/);
    });
});

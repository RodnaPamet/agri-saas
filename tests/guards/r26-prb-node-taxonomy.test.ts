/**
 * R26-PR-B — Process Canvas node taxonomy ratchet.
 *
 * Locks the six canonical node kinds + the three-level visual
 * vocabulary (shape × accent × icon) introduced by PR-B. Each
 * invariant the rest of R26 depends on is asserted here:
 *
 *   1. The taxonomy carries EXACTLY the six canonical kinds.
 *      Adding an eighth needs a justification + a written reason
 *      in the doc comment AND an update to this ratchet's
 *      `CANONICAL_KINDS` array. The bar for new kinds is high —
 *      see the doc-comment in `node-taxonomy.ts` for what's been
 *      deliberately omitted.
 *
 *   2. Every kind declares a description + icon + accent +
 *      shape + handles flag + defaultLabel. The renderer + palette
 *      consume each field unconditionally; a missing one would
 *      crash at runtime instead of failing CI.
 *
 *   3. The palette renders one stamp per canonical kind, in the
 *      canonical order. A future PR that hides one of the six
 *      kinds from the palette (e.g. "let's drop annotation, no
 *      one uses it") must edit this ratchet too.
 *
 *   4. The typed-node renderer registers EXACTLY one xyflow node-
 *      type per canonical kind on the canvas. The renderer
 *      component is the SAME instance across all six (chassis-
 *      shared); the registry value matters less than the key set.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

const TAXONOMY_PATH = "src/components/processes/node-taxonomy.ts";
const TYPED_NODE_PATH = "src/components/processes/ProcessTypedNode.tsx";
const PALETTE_PATH = "src/components/processes/ProcessPalette.tsx";
const CANVAS_PATH =
    "src/components/processes/PersistedProcessCanvas.tsx";

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const CANONICAL_KINDS = [
    "processStep",
    "decision",
    "control",
    "asset",
    "external",
    "annotation",
    // R30 (2026-05-25) — eighth canonical kind. A translucent
    // labelled container. Persistence rides the new
    // `ProcessNode.parentNodeKey` column (children reference the
    // group's `nodeKey`); xyflow's `parentId` is the runtime
    // mirror. The ratchet at `r30-group-nodes.test.ts` locks the
    // schema migration + renderer branch + canvas wiring.
    "group",
    // VR-1 (2026-06-08) — four automation kinds for the Visual Rule
    // Editor. Visible only in AUTOMATION canvas mode (gated by the
    // CanvasModeContext); `ProcessPalette` renders them as a separate
    // "automation" section via AUTOMATION_NODE_ORDER. Locked by
    // `vr1-vr2-automation-canvas.test.ts`.
    "trigger",
    "condition",
    "action",
    "slaGate",
] as const;

describe("R26-PR-B — node taxonomy", () => {
    const taxonomySrc = read(TAXONOMY_PATH);

    it("declares exactly the six canonical kinds in the ProcessNodeKind union", () => {
        // The union is the source-of-truth string-literal contract.
        // A drift here without a ratchet update would let unknown
        // kinds slip past the type system.
        const unionMatch = taxonomySrc.match(
            /export\s+type\s+ProcessNodeKind\s*=\s*([\s\S]*?);/,
        );
        expect(unionMatch).not.toBeNull();
        const unionBody = unionMatch![1];
        // Accept either single- or double-quoted literals; the file
        // is formatted by prettier which prefers single-quotes.
        for (const kind of CANONICAL_KINDS) {
            expect(unionBody).toMatch(new RegExp(`['"]${kind}['"]`));
        }
        // No surprise kinds — count the quoted literals.
        const literals = unionBody.match(/['"][a-zA-Z]+['"]/g) ?? [];
        expect(literals).toHaveLength(CANONICAL_KINDS.length);
    });

    it("NODE_TAXONOMY carries one entry per canonical kind", () => {
        for (const kind of CANONICAL_KINDS) {
            // Match the key on its own line — avoids false positives
            // from kind names mentioned in doc comments.
            const re = new RegExp(`^\\s*${kind}:\\s*\\{`, "m");
            expect(taxonomySrc).toMatch(re);
        }
    });

    it("NODE_TAXONOMY_ORDER lists each PALETTE kind exactly once", () => {
        // R26-PR-D dropped `control` from the palette (edge-first
        // canonical surface) while keeping the taxonomy entry for
        // legacy-map rehydration. The palette order = canonical
        // six MINUS control. The dedicated R26-PR-D ratchet
        // (r26-prd-edge-controls-semantics) locks the exclusion.
        const orderMatch = taxonomySrc.match(
            /NODE_TAXONOMY_ORDER:\s*ProcessNodeKind\[\]\s*=\s*\[([\s\S]*?)\]/,
        );
        expect(orderMatch).not.toBeNull();
        const body = orderMatch![1];
        const items =
            body.match(/['"](\w+)['"]/g)?.map((s) => s.replace(/['"]/g, "")) ??
            [];
        // VR-1 — automation kinds live in AUTOMATION_NODE_ORDER (a
        // separate, mode-gated palette section), NOT NODE_TAXONOMY_ORDER,
        // so they're excluded from the document palette order alongside
        // `control`.
        const AUTOMATION_KINDS = ["trigger", "condition", "action", "slaGate"];
        const palette = CANONICAL_KINDS.filter(
            (k) => k !== "control" && !AUTOMATION_KINDS.includes(k),
        );
        expect(items.sort()).toEqual([...palette].sort());
    });

    it("every kind declares the required visual fields (icon, accent, shape, defaultLabel)", () => {
        // Cheap structural assertion — each kind's object literal
        // must mention every required field name. Catches typos +
        // missing entries without parsing the file.
        for (const kind of CANONICAL_KINDS) {
            const re = new RegExp(
                `^\\s*${kind}:\\s*\\{[\\s\\S]*?` +
                    `\\bid:[\\s\\S]*?` +
                    `\\blabel:[\\s\\S]*?` +
                    `\\bdescription:[\\s\\S]*?` +
                    `\\bicon:[\\s\\S]*?` +
                    `\\baccent:[\\s\\S]*?` +
                    `\\bshape:[\\s\\S]*?` +
                    `\\bhasHandles:[\\s\\S]*?` +
                    `\\bdefaultLabel:[\\s\\S]*?` +
                    `\\}`,
                "m",
            );
            expect(taxonomySrc).toMatch(re);
        }
    });
});

describe("R26-PR-B — palette consumer", () => {
    const paletteSrc = read(PALETTE_PATH);

    it("iterates NODE_TAXONOMY_ORDER to render stamps", () => {
        // The palette MUST drive its render loop from the canonical
        // order — hand-rolling a parallel array of items would
        // drift from the taxonomy on every PR that adds a kind.
        // R31 Bundle 4 (PR 2) widened the iteration shape: the
        // vertical-rail palette `for...of`-loops NODE_TAXONOMY_ORDER
        // to bucket kinds into category groups before rendering,
        // instead of a direct `.map`. Accept either form — the
        // invariant is "iterate the canonical order", not the
        // exact iteration syntax.
        expect(paletteSrc).toMatch(/NODE_TAXONOMY_ORDER/);
        // Either canonical iteration form is accepted:
        //   • `NODE_TAXONOMY_ORDER.map(...)` — direct render-list
        //   • `for (... of NODE_TAXONOMY_ORDER)` — for-of bucket
        // The invariant is "iterate the canonical order"; both
        // forms preserve it.
        expect(
            paletteSrc.match(/NODE_TAXONOMY_ORDER\.map\(/) ||
                paletteSrc.match(/of NODE_TAXONOMY_ORDER/),
        ).not.toBeNull();
    });

    it("ships a JSON drop payload with kind + label", () => {
        // R25 sent a raw label on drag. R26-PR-B widens to a
        // typed `{ kind, label }` JSON payload. The contract is
        // documented as `PaletteDropPayload` so the canvas + tests
        // stay in lockstep.
        expect(paletteSrc).toMatch(/PaletteDropPayload/);
        expect(paletteSrc).toMatch(/setData\(PALETTE_DRAG_MIME,\s*JSON\.stringify/);
    });
});

describe("R26-PR-B — canvas consumer", () => {
    const canvasSrc = read(CANVAS_PATH);

    it("registers every canonical kind in NODE_TYPES", () => {
        // The canvas must map ALL six kinds → ProcessTypedNode.
        // A drop emitting an unregistered kind would render with
        // the xyflow default node (a plain grey box), bypassing
        // the per-kind chrome.
        expect(canvasSrc).toMatch(
            /NODE_TYPES[\s\S]*?Object\.fromEntries\(\s*NODE_TAXONOMY_ORDER\.map/,
        );
    });

    it("uses the kind-aware drop handler", () => {
        // The drop must parse the typed payload via
        // PaletteDropPayload + isProcessNodeKind. R25's raw-label
        // path remains as a fallback (parse failure → default kind),
        // but the structured path is the canonical case.
        expect(canvasSrc).toMatch(/PaletteDropPayload/);
        expect(canvasSrc).toMatch(/JSON\.parse\(raw\)/);
        expect(canvasSrc).toMatch(/isProcessNodeKind/);
    });

    it("persists the kind back on save", () => {
        // The save mapper must thread the node's kind into
        // `nodeType` — otherwise round-tripping through the
        // server would collapse every node back to processStep.
        expect(canvasSrc).toMatch(/nodeType:\s*kind/);
    });
});

describe("R26-PR-B — typed-node renderer", () => {
    const renderSrc = read(TYPED_NODE_PATH);

    it("falls back to processStep on unknown kinds", () => {
        // The `nodeType` column is forward-compatible — strings, not
        // an enum. The renderer MUST tolerate unknown kinds so a
        // future PR's new kind doesn't crash older clients reading
        // newer maps.
        expect(renderSrc).toMatch(/isProcessNodeKind/);
        expect(renderSrc).toMatch(/processStep/);
    });

    it("branches the shape (rect / note) on the kind's meta", () => {
        // R31 superseded the diamond branch — the visual vocabulary
        // is now TWO shapes total (rect + note). The decision kind
        // moved onto the rect chassis with a "?" corner sticker;
        // adding a third shape would require both the renderer
        // branch + a `NodeShape` union update.
        expect(renderSrc).toMatch(/meta\.shape\s*===\s*"note"/);
        // The diamond branch must NOT come back — re-introducing
        // it would split the vocabulary again. R31 ratchet
        // explicitly enforces the retirement.
        expect(renderSrc).not.toMatch(/meta\.shape\s*===\s*"diamond"/);
    });

    it("annotation kind drops the handles (no flow semantics)", () => {
        // Annotations float free of the graph. The renderer's
        // `meta.hasHandles` gate is the structural lock for that
        // contract.
        expect(renderSrc).toMatch(/meta\.hasHandles\s*&&/);
    });
});

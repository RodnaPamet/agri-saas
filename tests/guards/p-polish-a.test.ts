/**
 * PR-A polish — Structural ratchet for the four micro-polish items
 * shipped together:
 *
 *   1. `connectionMode={ConnectionMode.Loose}` is wired on the
 *      ReactFlow root in `PersistedProcessCanvas`. The xyflow
 *      default is 'strict'; loose mode lets the user retrace a
 *      connection in either direction.
 *   2. `handleInspectorUpdate` no longer uses
 *      `setNodes(prev => prev.map(...))` — it routes through
 *      xyflow v12's `updateNodeData` hook so the render scope
 *      shrinks to the touched node.
 *   3. The `isValidConnection` reject path surfaces a
 *      human-readable reason via `toast.warning(...)`. The
 *      mapping table lives at module scope (`REJECT_MESSAGES`)
 *      so the strings are findable, lintable, and locked here.
 *   4. `computeAutoLayout` accepts an optional `nodeIdsFilter`,
 *      and the canvas exposes `Auto-arrange selection (LR/TB)`
 *      command-palette entries gated on `selectionCount >= 2`.
 *
 * Why structural: each item is a small targeted change across
 * the canvas surface; the natural regression risk is a future
 * refactor silently reverting one ("we don't need loose
 * connections anymore", "let's roll the updateNodeData path
 * back through setNodes for symmetry"). Locking each surface
 * keeps the polish accumulating monotonically.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => blankNonCode(readFileSync(path.join(ROOT, p), "utf-8"));

describe("PR-A polish — canvas micro-polish wiring", () => {
    const canvas = () =>
        read("src/components/processes/PersistedProcessCanvas.tsx");
    const layout = () => read("src/lib/processes/canvas-auto-layout.ts");

    describe("1. ConnectionMode.Loose", () => {
        it("imports ConnectionMode from @xyflow/react", () => {
            // Multi-line import block — `[\s\S]*?` keeps the
            // match dotAll-free so the tsconfig target stays put.
            expect(canvas()).toMatch(
                /import\s*\{[\s\S]*?\bConnectionMode\b[\s\S]*?\}\s*from\s*"@xyflow\/react"/,
            );
        });
        it("wires connectionMode={ConnectionMode.Loose} on ReactFlow", () => {
            expect(canvas()).toMatch(
                /connectionMode=\{ConnectionMode\.Loose\}/,
            );
        });
    });

    describe("2. updateNodeData migration", () => {
        it("destructures updateNodeData from useReactFlow", () => {
            // Destructure form: `{ ..., updateNodeData, ... } = useReactFlow()`.
            expect(canvas()).toMatch(
                /\{[^}]*\bupdateNodeData\b[^}]*\}\s*=\s*useReactFlow\(\)/,
            );
        });
        it("handleInspectorUpdate calls updateNodeData (not setNodes)", () => {
            const src = canvas();
            // Scope to the handleInspectorUpdate body — terminate
            // at the first `[updateNodeData]` dependency array,
            // which we explicitly authored as the closing marker.
            const start = src.indexOf(
                "const handleInspectorUpdate = useCallback(",
            );
            expect(start).toBeGreaterThan(-1);
            const end = src.indexOf("[updateNodeData]", start);
            expect(end).toBeGreaterThan(start);
            const body = src.slice(start, end);
            expect(body).toMatch(/updateNodeData\(nodeId,/);
            expect(body).not.toMatch(/\bsetNodes\(/);
        });
    });

    describe("3. Reject reason toast", () => {
        it("reject() is invoked for all three rejection reasons", () => {
            const src = canvas();
            // The reason strings feed the i18n key
            // `persistedCanvas.reject.<reason>` (all three defined in
            // messages/en.json + bg.json).
            for (const key of ["self", "duplicate", "annotation"] as const) {
                expect(src).toMatch(new RegExp(`reject\\("${key}"\\)`));
            }
        });
        it("isValidConnection's reject() fires toast.warning with the mapped message", () => {
            const src = canvas();
            const match = src.match(
                /const reject = \(reason:[\s\S]*?\}\s*;\s*$/m,
            );
            expect(match).not.toBeNull();
            const body = match![0];
            expect(body).toMatch(
                /toast\.warning\(t\(`persistedCanvas\.reject\.\$\{reason\}`\)/,
            );
        });
    });

    describe("4. Selection-only auto-layout", () => {
        it("computeAutoLayout exposes a fourth `nodeIdsFilter` parameter", () => {
            expect(layout()).toMatch(
                /export function computeAutoLayout\(\s*nodes:[\s\S]*?direction:[\s\S]*?nodeIdsFilter\?:/,
            );
        });
        it("computeAutoLayout preserves the selection centroid", () => {
            // The centroid-translation branch lives inside the
            // `if (nodeIdsFilter && participatingIds.size > 0)`
            // arm. Locking the presence of both the dx/dy
            // computation AND the application loop ensures the
            // translation step can't silently regress.
            const src = layout();
            expect(src).toMatch(/before\.x\s*\/\s*before\.count/);
            expect(src).toMatch(/after\.x\s*\/\s*after\.count/);
            expect(src).toMatch(/positions\[id\]\.x\s*\+\s*dx/);
        });
        it("canvas exposes handleAutoLayoutSelection + two palette entries", () => {
            const src = canvas();
            expect(src).toMatch(/const handleAutoLayoutSelection = useCallback/);
            expect(src).toMatch(/id: "arrange-selection-lr"/);
            expect(src).toMatch(/id: "arrange-selection-tb"/);
            // Both entries should require selectionCount >= 2.
            const lr = src.match(
                /id: "arrange-selection-lr"[\s\S]*?onSelect:[^}]*\}/,
            );
            const tb = src.match(
                /id: "arrange-selection-tb"[\s\S]*?onSelect:[^}]*\}/,
            );
            expect(lr![0]).toMatch(/selectionCount < 2/);
            expect(tb![0]).toMatch(/selectionCount < 2/);
        });
    });
});

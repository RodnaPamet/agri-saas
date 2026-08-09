/**
 * R32-PR10 — Canvas decomposition ratchet (slice 1: document bar).
 *
 * The brutal-verdict review's PR 10 called out the
 * `<PersistedProcessCanvas>` god-component (1,950+ lines post-R31).
 * The verdict named five extraction targets:
 *
 *   • `<CanvasDocumentBar>` — the inline toolbar JSX
 *   • `<CanvasLeftPalette>` — already separate (`<ProcessPalette>`)
 *   • `<CanvasMinimap>` + `<CanvasZoomPractices>` — already xyflow
 *     primitives mounted inline
 *   • `<CanvasCommandPalette>` — shipped Bundle 8 (#724)
 *   • `<CanvasInspector>` — already separate (`<ProcessInspector>`)
 *
 * Plus consolidating the three save-payload serialisers into a
 * `useProcessMapDocument` hook.
 *
 * Slice 1 (this PR) — extract the document bar. The serialiser
 * consolidation defers to a future bundle because its data-
 * integrity implications (three current paths handle slightly
 * different payload shapes) warrant a dedicated PR with focused
 * tests against the save → load round-trip.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("R32-PR10 — canvas decomposition (document bar)", () => {
    describe("CanvasDocumentBar primitive", () => {
        const src = read("src/components/processes/CanvasDocumentBar.tsx");

        it("exports the component + its five grouped prop types", () => {
            expect(src).toMatch(/export function CanvasDocumentBar/);
            expect(src).toMatch(/export interface CanvasDocumentBarDoc/);
            expect(src).toMatch(/export interface CanvasDocumentBarBusy/);
            expect(src).toMatch(
                /export interface CanvasDocumentBarEditorState/,
            );
            expect(src).toMatch(/export interface CanvasDocumentBarHandlers/);
        });

        it("preserves every testid the R26/R28/R31 ratchets pin", () => {
            // The extraction is byte-identical for these IDs;
            // breaking any one of them would break upstream
            // ratchets without a clear signal.
            for (const id of [
                "process-selector",
                "process-name-input",
                "new-process-btn",
                "duplicate-process-btn",
                "canvas-undo-btn",
                "canvas-redo-btn",
                "canvas-snap-toggle",
                "autosave-status",
                "save-process-btn",
            ]) {
                expect(src).toMatch(new RegExp(`data-testid="${id}"`));
            }
        });

        it("preserves the canonical document-bar + breadcrumb markers", () => {
            expect(src).toMatch(/data-persisted-canvas-toolbar="true"/);
            expect(src).toMatch(/data-canvas-document-bar="true"/);
            expect(src).toMatch(/data-canvas-document-breadcrumb="true"/);
        });

        it("owns no state — every field flows through props", () => {
            // The bar must NOT call `useState`, `useReducer`,
            // `useEffect`, etc. State ownership stays with `Inner`
            // upstream; the bar is a pure render.
            expect(src).not.toMatch(/useState\b/);
            expect(src).not.toMatch(/useEffect\b/);
            expect(src).not.toMatch(/useReducer\b/);
            expect(src).not.toMatch(/useRef\b/);
        });
    });

    describe("PersistedProcessCanvas — toolbar JSX retired", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("imports + mounts CanvasDocumentBar", () => {
            expect(src).toMatch(
                /import\s*\{\s*CanvasDocumentBar\s*\}\s*from\s*["']\.\/CanvasDocumentBar["']/,
            );
            expect(src).toMatch(/<CanvasDocumentBar\b/);
        });

        it("passes the five canonical prop groups", () => {
            // The bar takes `tenantSlug` directly + four grouped
            // objects. Locked on the canonical group names so a
            // future refactor that drops one (e.g. rolls `busy`
            // into `editorState`) trips this and gets a written
            // justification.
            expect(src).toMatch(/tenantSlug=\{tenantSlug\}/);
            expect(src).toMatch(/doc=\{/);
            expect(src).toMatch(/busy=\{/);
            expect(src).toMatch(/editorState=\{/);
            expect(src).toMatch(/handlers=\{/);
        });

        it("the legacy inline toolbar block is gone", () => {
            // The pre-R32 inline toolbar carried both the
            // breadcrumb <nav> AND the action buttons within the
            // same wrapper div. The retirement comment leaves a
            // single line marker; the JSX itself is gone. The
            // markers below now live INSIDE the extracted
            // component, NOT inside PersistedProcessCanvas.tsx.
            expect(src).not.toMatch(/data-canvas-document-breadcrumb="true"/);
            // The data-persisted-canvas-toolbar marker is also
            // gone from PersistedProcessCanvas — it lives in the
            // extracted CanvasDocumentBar now.
            expect(src).not.toMatch(/data-persisted-canvas-toolbar="true"/);
        });
    });

    describe("Decomposition progress — file size", () => {
        it("PersistedProcessCanvas.tsx shrinks below the post-R32 floor", () => {
            // Pre-R32 the file was 2018 lines. R32-PR10 decomposed
            // the toolbar (≈195 lines out, ≈30 lines in) and the
            // file landed at ≈1859 lines.
            //
            // Subsequent feature growth (continuing the extraction
            // trend at each step) added two helper modules without
            // bloating the canvas back to the pre-R32 footprint:
            //   - Epic P1 — `surfaceVersionConflict` extracted to
            //     `src/lib/processes/version-conflict-toast.ts`
            //     (the canvas wires the helper but doesn't own
            //     the toast-message + body-parse boilerplate);
            //   - Epic P2-PR-A — `edgePracticesForSave` extracted
            //     to `src/lib/processes/edge-practices.ts` (the
            //     canvas calls one function instead of declaring
            //     a 50-line peeler inline).
            //
            // The cap moves with each absorbed feature; bumps
            // come paired with a written justification rather than
            // silently floating. Current cap: 2150. Bumps:
            //   - 1900 → 1925 (Epic P1 + P2-PR-A) — concurrency
            //     check + edge practice picker.
            //   - 1925 → 1950 (Epic P2-PR-B) — node entity
            //     pickers + linkedEntityId dataJson round-trip.
            //   - 1950 → 1975 (Epic P3-PR-A) — PNG/SVG export
            //     menu wiring.
            //   - 1975 → 2025 (Epic P4-PR-A) — dagre auto-layout
            //     handler + "Layout" command group.
            //   - 2025 → 2150 (Epic P4-PR-B) — clipboard handlers
            //     (Cmd+C/V/D) + Tab-to-create + connection-
            //     rejection state + rejected-node className
            //     projection.
            //   - 2150 → 2200 (Epic P6-PR-A) — sub-flow drill-
            //     down hook + filter + breadcrumb + the
            //     onNodeDoubleClick wire.
            //   - 2200 → 2225 (P5-PR-A visibility fix) — mount
            //     the version-history sidebar component that
            //     shipped without a render site. ~16 lines.
            //   - 2225 → 2300 (Epic P5-PR-B) — diff/restore wire-
            //     up: diff state, buildLiveSnapshot projection
            //     helper, CanvasDiffOverlay mount, sidebar
            //     callbacks. ~62 lines. Helper kept inline because
            //     it reuses the file-local nodeDataJson / nodeParent
            //     / edgeKindOf trio that already live here.
            //   - 2300 → 2375 (PR-A polish bundle) — 4 micro-items:
            //     ConnectionMode.Loose prop, REJECT_MESSAGES table
            //     + toast call, updateNodeData migration in
            //     handleInspectorUpdate, handleAutoLayoutSelection
            //     callback + 2 command-palette entries. ~55 net
            //     lines. The REJECT_MESSAGES table is at module
            //     scope (locked by p-polish-a ratchet) so the
            //     strings stay findable; the rest is inline canvas
            //     wiring that can't reasonably extract.
            //   - 2375 → 2450 (PR-C ELK force-layout) — async
            //     handleAutoLayoutForce callback + 2 command-
            //     palette entries (full canvas + selection-only).
            //     ~41 net lines. The helper itself (elkjs dynamic
            //     import + force-algorithm options) sits in
            //     canvas-auto-layout.ts to keep the bundle impact
            //     off the canvas's static chunk.
            //   - 2450 → 2475 (PR-B visual-editor reachability) —
            //     wired the dead VR-5/VR-6 code: RunMode+Overlay
            //     provider mount + OverlayBridge, inferEdgeKind on
            //     onConnect, and a "New automation workflow" create
            //     path so AUTOMATION mode is reachable. ~25 net lines;
            //     the providers/inference already live in helper
            //     modules under src/lib/processes/.
            //   - 2475 → 2491 (PR-B follow-up) — handleSwitchMode:
            //     convert an existing map DOCUMENT⇄AUTOMATION from the
            //     doc bar. ~16 lines; the PATCH itself lives in the
            //     helper src/lib/processes/switch-canvas-mode.ts.
            // Future P6 follow-ups follow the same helper-module-
            // per-feature pattern.
            const src = read(
                "src/components/processes/PersistedProcessCanvas.tsx",
            );
            const lines = src.split("\n").length;
            expect(lines).toBeLessThan(2491);
        });
    });
});

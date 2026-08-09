/**
 * Epic P3-PR-A — Canvas export (PNG / SVG) ratchet.
 *
 * Brief gap #2 🟠 "Export / Print" — pre-P3 the only way to put a
 * process map in an audit pack was a browser screenshot. P3-PR-A
 * wires html-to-image + xyflow's fit-to-bounds helpers into a
 * dropdown menu mounted in the document bar's action group.
 *
 * The chain:
 *
 *   1. `src/lib/processes/canvas-export.ts` owns the export
 *      mechanics (`exportCanvasAsPng`, `exportCanvasAsSvg`,
 *      filename sanitisation, fit-to-content transform).
 *   2. `<CanvasExportMenu>` mounts a `<Popover>` trigger with two
 *      items; each fires the corresponding helper.
 *   3. `<CanvasDocumentBar>` accepts an `exportSlot` ReactNode so
 *      the canvas can pass the menu without breaking the bar's
 *      "owns no state" decomposition contract.
 *   4. `<PersistedProcessCanvas>` mounts the menu via the
 *      `exportSlot` prop, threading a ref to the
 *      `[data-process-canvas]` wrapper + the live nodes + the
 *      active map's name.
 *
 * Locks each link so a future refactor that drops one fails CI.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("Epic P3-PR-A — canvas export (PNG / SVG)", () => {
    describe("Export helpers module", () => {
        const src = read("src/lib/processes/canvas-export.ts");

        it("exports both PNG + SVG helpers with the canonical signature", () => {
            expect(src).toMatch(
                /export async function exportCanvasAsPng\(\s*opts:\s*CanvasExportOptions,?\s*\):\s*Promise<string>/,
            );
            expect(src).toMatch(
                /export async function exportCanvasAsSvg\(\s*opts:\s*CanvasExportOptions,?\s*\):\s*Promise<string>/,
            );
        });

        it("declares the canonical options shape", () => {
            expect(src).toMatch(
                /interface CanvasExportOptions \{[\s\S]{0,800}canvasEl:\s*HTMLElement;[\s\S]{0,400}nodes:\s*Node\[\];[\s\S]{0,400}mapName:\s*string;/,
            );
        });

        it("walks down to the xyflow viewport child for capture", () => {
            // The xyflow viewport (.react-flow__viewport) is the
            // node+edge subtree; capturing IT excludes the Practices
            // overlay + Background siblings. A refactor that
            // captures the wrapper itself would include the zoom
            // strip — wrong for evidence artefacts.
            expect(src).toMatch(
                /canvasEl\.querySelector<HTMLElement>\(["']\.react-flow__viewport["']\)/,
            );
        });

        it("computes a fit-to-content viewport via xyflow's helpers", () => {
            // The export must NOT capture the user's current zoom/
            // scroll position — the rendered artefact would be
            // meaningless if they were zoomed in on one node.
            expect(src).toMatch(
                /getNodesBounds\(nodes\)/,
            );
            expect(src).toMatch(/getViewportForBounds\(/);
        });

        it("imports html-to-image's toPng + toSvg (canonical xyflow recipe)", () => {
            expect(src).toMatch(
                /import\s*\{\s*toPng,\s*toSvg\s*\}\s*from\s*["']html-to-image["']/,
            );
        });

        it("sanitises the download filename + caps it at 60 chars", () => {
            // Anchor the sanitiser shape — strip non-alphanumeric,
            // collapse repeats, cap length. A regression that lets
            // through path separators / quotes would surface as a
            // browser download warning.
            expect(src).toMatch(/replace\(\/\[\^a-z0-9\]\+\/g/);
            expect(src).toMatch(/\.slice\(0,\s*60\)/);
        });

        it("resolves the background colour from the active [data-theme]", () => {
            // The export should match what the user sees — the
            // canvas-frame token differs between light + dark.
            // Anchor on the data-theme read so a refactor that
            // hardcodes one colour breaks.
            expect(src).toMatch(/document\.documentElement/);
            expect(src).toMatch(
                /getAttribute\(["']data-theme["']\)/,
            );
        });
    });

    describe("CanvasExportMenu component", () => {
        const src = read("src/components/processes/CanvasExportMenu.tsx");

        it("exports the component + accepts canvasEl + nodes + mapName", () => {
            expect(src).toMatch(/export function CanvasExportMenu/);
            expect(src).toMatch(/canvasEl:\s*HTMLElement \| null/);
            expect(src).toMatch(/nodes:\s*Node\[\]/);
            expect(src).toMatch(/mapName:\s*string/);
        });

        it("imports both helpers from the canvas-export module", () => {
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,300}exportCanvasAsPng[\s\S]{0,200}exportCanvasAsSvg[\s\S]{0,200}\}\s*from\s*["']@\/lib\/processes\/canvas-export["']/,
            );
        });

        it("renders both menu items + the trigger with canonical testids", () => {
            for (const id of [
                "canvas-export-trigger",
                "canvas-export-png",
                "canvas-export-svg",
            ]) {
                expect(src).toMatch(new RegExp(`data-testid="${id}"`));
            }
        });

        it("disables the menu items + trigger while a render is in flight", () => {
            // Double-clicks shouldn't queue two downloads. Anchor
            // the busy flag + the disabled gate.
            expect(src).toMatch(/\bbusy,\s*setBusy\b/);
            expect(src).toMatch(/disabled=\{disabled \|\| busy \|\| !canvasEl\}/);
        });

        it("surfaces export errors via the canonical useToast hook", () => {
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,200}useToast[\s\S]{0,200}\}\s*from\s*["']@\/components\/ui\/hooks["']/,
            );
            expect(src).toMatch(/toast\.error\(/);
        });
    });

    describe("CanvasDocumentBar — accepts the exportSlot prop", () => {
        const src = read("src/components/processes/CanvasDocumentBar.tsx");

        it("declares exportSlot on the props interface", () => {
            expect(src).toMatch(/exportSlot\?:\s*import\(["']react["']\)\.ReactNode;/);
        });

        it("the bar renders {exportSlot} in the action group", () => {
            expect(src).toMatch(/\{exportSlot\}/);
        });
    });

    describe("PersistedProcessCanvas — wires the export menu", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("imports CanvasExportMenu + useRef", () => {
            expect(src).toMatch(
                /import\s*\{\s*CanvasExportMenu\s*\}\s*from\s*["']\.\/CanvasExportMenu["']/,
            );
            expect(src).toMatch(/\buseRef\b/);
        });

        it("declares the canvas wrapper ref", () => {
            expect(src).toMatch(/canvasWrapperRef\s*=\s*useRef<HTMLDivElement>\(null\)/);
        });

        it("attaches the ref to the [data-process-canvas] wrapper", () => {
            expect(src).toMatch(
                /ref=\{canvasWrapperRef\}[\s\S]{0,200}data-process-canvas="true"/,
            );
        });

        it("passes the menu into the bar's exportSlot when a map is active", () => {
            // Conditional on `activeId && activeProcess` — the
            // menu has nothing meaningful to export on the empty
            // state. Anchor the conditional so a refactor that
            // always-renders it (and crashes on null activeProcess)
            // breaks.
            expect(src).toMatch(
                /exportSlot=\{[\s\S]{0,300}activeId\s*&&\s*activeProcess[\s\S]{0,400}<CanvasExportMenu/,
            );
            expect(src).toMatch(
                /canvasEl=\{canvasWrapperRef\.current\}/,
            );
            expect(src).toMatch(/mapName=\{activeProcess\.name\}/);
        });
    });
});

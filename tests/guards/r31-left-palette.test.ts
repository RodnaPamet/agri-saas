/**
 * R31 (Bundle 4) — Left palette (PR 2 of the design roadmap).
 *
 * Pre-R31 the ProcessPalette lived as a horizontal strip across
 * the top of the canvas — eight icon-and-label pills wrapping
 * into a second row once the eighth taxonomy kind landed in R30.
 * Every world-class design tool — Figma, Sketch, Adobe XD,
 * Linear's canvas, Excalidraw — positions its tool palette on
 * the LEFT, not above.
 *
 * R31 Bundle 4 moves the palette where the vocabulary expects:
 *
 *   • Vertical 56px-wide column on the left of the canvas body.
 *   • Icon-only buttons. Kind label appears on hover via the
 *     native `title` attribute (deliberate small-surface choice
 *     to avoid the Epic 56 Tooltip's extra render path in the
 *     canvas critical path).
 *   • Category dividers — a thin hairline between Flow → Context
 *     → Container → Note groups, exposing the taxonomy
 *     hierarchy hidden by the legacy flat strip.
 *   • Drag-source contract: the
 *     `application/x-agrent-process-step` MIME type + the
 *     `{ kind, label }` JSON payload from R26-PR-B / R30 stay
 *     intact. Only the LAYOUT shifted.
 *
 * The R25-PR-B + R26-PR-B ratchets that pin the drag contract
 * stay green; this ratchet adds the new layout assertions on top.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => blankNonCode(fs.readFileSync(path.join(ROOT, rel), "utf8"));

describe("R31 (Bundle 4) — left palette", () => {
    describe("ProcessPalette — vertical column shape", () => {
        const src = read("src/components/processes/ProcessPalette.tsx");

        it("renders an <aside> with the canonical layout marker", () => {
            // The outer element is `<aside>` so screen-reader
            // landmark navigation finds the palette as a sibling
            // of the canvas's main region.
            expect(src).toMatch(/<aside\b[\s\S]{0,200}data-process-palette="true"/);
            // The new layout marker — future ratchets can target
            // it without ambiguity. Vertical vs the legacy
            // horizontal strip.
            expect(src).toMatch(
                /data-process-palette-layout="vertical"/,
            );
        });

        it("the column is 56px wide (w-14 token) and flex-col", () => {
            // The width is locked because the canvas body's
            // 3-column flex row sizes itself off it. A future
            // refactor that bumps the column wider must update
            // this ratchet AND the inspector mount + the empty-
            // state anchor calculation.
            expect(src).toMatch(/w-14[\s\S]{0,200}flex-col/);
        });

        it("groups by category with dividers between groups", () => {
            // The category attribute is set via a JSX expression
            // `data-process-palette-category={category}` — assert
            // the SOURCE form rather than the rendered value.
            expect(src).toMatch(
                /data-process-palette-category=\{category\}/,
            );
            // The CATEGORY_ORDER constant locks the visual order
            // — flow first (build the spine), context next (layer
            // governance), group third, note last.
            expect(src).toMatch(
                /CATEGORY_ORDER:\s*readonly NodeCategory\[\][\s\S]{0,200}["']flow["'][\s\S]{0,100}["']context["'][\s\S]{0,100}["']group["'][\s\S]{0,100}["']note["']/,
            );
        });

        it("hover label rides on the native title attribute (not a Tooltip dep)", () => {
            // Per the file header note — `title=` is a deliberate
            // small-surface choice for the canvas critical path.
            expect(src).toMatch(/title=\{meta\.label\}/);
        });

        it("preserves the drag-source contract (PALETTE_DRAG_MIME + JSON payload)", () => {
            // The shape every existing ratchet (R25-PR-B,
            // R26-PR-B, R30) asserts. The LAYOUT changed, the
            // CONTRACT didn't.
            expect(src).toMatch(/export const PALETTE_DRAG_MIME\s*=/);
            expect(src).toMatch(
                /setData\(PALETTE_DRAG_MIME,\s*JSON\.stringify/,
            );
        });

        it("retires the legacy horizontal strip layout", () => {
            // Pre-R31 the wrapper was `flex flex-wrap items-center
            // gap-tight border-b ...` — a horizontal row with a
            // bottom border. The vertical wrapper has NONE of
            // `flex-wrap`, `border-b`, or `items-center` at the
            // root (it uses `flex-col items-center` instead).
            // Anchor on the disappearance of `flex-wrap` since
            // that's the most distinctive marker of the old layout.
            expect(src).not.toMatch(/<aside\b[\s\S]{0,200}flex-wrap/);
            expect(src).not.toMatch(/<aside\b[\s\S]{0,200}border-b /);
        });
    });

    describe("PersistedProcessCanvas — palette mounted in the body's left rail", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("the palette mounts INSIDE the 3-column body row, not above the canvas", () => {
            // The new structure is:
            //   <body-row className="flex flex-1 min-h-0">
            //     <ProcessPalette />
            //     <canvas-plane />
            //     <ProcessInspector />
            //   </body-row>
            // The 3-column flex row carries `flex flex-1 min-h-0`;
            // the palette is the FIRST child in that row.
            expect(src).toMatch(
                /flex flex-1 min-h-0[\s\S]{0,800}<ProcessPalette \/>/,
            );
        });

        it("the legacy above-canvas mount is gone", () => {
            // Pre-R31, `<ProcessPalette />` mounted DIRECTLY
            // between the toolbar div and the body row, with no
            // wrapping context. That site now carries the
            // retirement-comment block and NO sibling
            // <ProcessPalette /> element.
            // Anchor on the long-lived toolbar marker. R32-PR10
            // extracted the toolbar JSX into `<CanvasDocumentBar>`,
            // so the canvas now carries the COMPONENT MOUNT in
            // place of the inline attribute. Anchor on whichever
            // is present — the marker survives every refactor that
            // doesn't tear out the document bar entirely.
            const toolbarEndIdx =
                src.indexOf('<CanvasDocumentBar') >= 0
                    ? src.indexOf('<CanvasDocumentBar')
                    : src.indexOf('data-persisted-canvas-toolbar="true"');
            expect(toolbarEndIdx).toBeGreaterThan(0);
            const bodyRowIdx = src.indexOf(
                'flex flex-1 min-h-0',
                toolbarEndIdx,
            );
            expect(bodyRowIdx).toBeGreaterThan(toolbarEndIdx);
            // Between the toolbar block close and the body-row
            // open, no <ProcessPalette /> may appear. The window
            // captures the multi-select toolbar + single-group
            // toolbar + the comment block — but never the
            // palette mount.
            const between = src.slice(toolbarEndIdx, bodyRowIdx);
            expect(between).not.toMatch(/<ProcessPalette \/>/);
        });
    });
});

/**
 * R31 (Bundle 7) — Edge label chip (slice of PR 5 of the roadmap).
 *
 * The brutal-verdict review's PR 5 ("Connection language elevation")
 * called out four edge-language gaps: hover-state thickening,
 * inline variant picker at the edge midpoint, selection-aware
 * emphasis (dim non-connected nodes), and chip-style edge label
 * backgrounds. The first two already existed pre-R31; the third
 * (selection-aware emphasis) is substantial and queued. This
 * bundle ships the fourth.
 *
 *   • Pre-R31, the R28 inspector set `edge.label` but xyflow's
 *     default bezier render ignored the field — the label
 *     written never appeared on the canvas.
 *   • R31 mounts a token-styled CHIP via `EdgeLabelRenderer`
 *     when `edge.label` is non-empty AND no practice occupies the
 *     midpoint (practice is the more semantic anchor; only one
 *     thing sits at the centre).
 *   • The chip uses the same surface vocabulary as every other
 *     canvas overlay: `bg-canvas-frame`, `border-canvas-border`,
 *     `rounded-[4px]` (one notch tighter than the 8px node /
 *     practice radius — chips read smaller).
 *
 * Selection-aware emphasis + hover-state thickening defer to a
 * future R31 bundle (or a future round of refinement).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("R31 (Bundle 7) — edge label chip", () => {
    const src = read("src/components/processes/ProcessEdge.tsx");

    it("destructures the `label` prop from EdgeProps", () => {
        // Pre-R31 the prop was never read. The destructure block
        // sits BEFORE `} = props;` — anchor on the canonical
        // `label,\n        ...} = props;` pattern.
        expect(src).toMatch(/label,\s*\n[\s\S]{0,40}\}\s*=\s*props/);
    });

    it("renders a chip via EdgeLabelRenderer when label is set + no practice occupies the midpoint", () => {
        // Gated on both conditions:
        //   (a) typeof label === "string" && label.length > 0
        //   (b) !practice (the practice overlay wins the centre)
        expect(src).toMatch(/typeof label === ["']string["'][\s\S]{0,200}label\.length > 0/);
        expect(src).toMatch(/!practice[\s\S]{0,400}typeof label/);
    });

    it("the chip surface matches the canvas chrome language", () => {
        // Same token set as the document bar + AsidePanel +
        // minimap overlay shipped earlier in R31 — one canvas
        // chrome vocabulary across every overlay.
        expect(src).toMatch(
            /data-edge-label-chip="true"[\s\S]{0,800}bg-canvas-frame/,
        );
        expect(src).toMatch(
            /data-edge-label-chip="true"[\s\S]{0,800}border-canvas-border/,
        );
        // Chips render at a tighter 4px radius — visually smaller
        // than the node 8px / 10px radius.
        expect(src).toMatch(
            /data-edge-label-chip="true"[\s\S]{0,800}rounded-\[4px\]/,
        );
    });

    it("the chip carries the canonical data-* marker", () => {
        // Tests + E2E selectors anchor on this marker.
        expect(src).toMatch(/data-edge-label-chip="true"/);
    });

    it("the chip pulls itself out of the SVG via EdgeLabelRenderer", () => {
        // xyflow's `<BaseEdge>` lives inside an SVG; chips with
        // text content render properly only when hoisted via
        // `<EdgeLabelRenderer>` (an absolute-positioned HTML
        // overlay).
        // Two EdgeLabelRenderer call sites — one for the practice
        // badge (pre-R31) + one for the new chip.
        const renderers = src.match(/<EdgeLabelRenderer>/g) ?? [];
        expect(renderers.length).toBeGreaterThanOrEqual(2);
    });
});

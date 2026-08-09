/**
 * R31 (Bundle 6) — Zoom practices (PR 7 of the roadmap).
 *
 * Pre-R31 the canvas shipped without a zoom UI: on a large process
 * map the user couldn't get back to the origin. Every canvas tool
 * that has shipped in the last 15 years has +/- / fit practices.
 * R31 wired xyflow's `<Practices>` primitive as an overlay inside
 * the canvas plane (not a new chrome strip above) and toned it to
 * match the canvas frame.
 *
 *   • Bottom-left zoom strip — `<Practices position="bottom-left"
 *     showInteractive={false} />`. The `showInteractive` flag is
 *     OFF deliberately: the "lock interaction" toggle xyflow ships
 *     by default is for graph viewers, not authoring canvases.
 *
 * The overlay surface-matches the document bar + AsidePanel
 * primitives — `bg-canvas-frame/90`, hairline border,
 * rounded-[8px], backdrop-blur — so it reads as part of one
 * coherent chrome language. The +/- glyph + button surface colours
 * are themed via a `globals.css` rule that wires xyflow's
 * `--xy-controls-button-*` cascade to the canvas-frame token suite
 * (xyflow's built-in `.dark` class flip never fires on our trees
 * since we theme via `[data-theme]` on `<html>` instead).
 *
 * Minimap intentionally absent — the original R31 Bundle 6 also
 * shipped a `<MiniMap>` in the bottom-right; user feedback
 * (2026-05-26) found it added clutter on the canvas surface
 * without earning the corner real-estate. Removed at the same
 * time as the dark-theme zoom-button fix.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("R31 (Bundle 6) — zoom controls", () => {
    const src = read("src/components/processes/PersistedProcessCanvas.tsx");

    it("imports xyflow's Controls primitive", () => {
        // The Practices import drives the render branch below.
        const importMatch = src.match(
            /import\s*\{[\s\S]{0,2000}\}\s*from\s*["']@xyflow\/react["']/,
        );
        expect(importMatch).not.toBeNull();
        expect(importMatch![0]).toMatch(/\bControls\b/);
    });

    it("does NOT import the MiniMap primitive (removed 2026-05-26)", () => {
        // The MiniMap was removed in fix/processes-drop-minimap-darken-zoom.
        // A future "bring it back" PR has to make the case in writing
        // — the import addition trips this ratchet first.
        const importMatch = src.match(
            /import\s*\{[\s\S]{0,2000}\}\s*from\s*["']@xyflow\/react["']/,
        );
        expect(importMatch).not.toBeNull();
        expect(importMatch![0]).not.toMatch(/\bMiniMap\b/);
    });

    it("does NOT mount the MiniMap JSX (removed 2026-05-26)", () => {
        // Belt-and-braces: the absence of the import is the structural
        // guarantee, but a renamed re-export could sneak around it. The
        // JSX-tag absence catches that.
        expect(src).not.toMatch(/<MiniMap\b/);
        expect(src).not.toMatch(/data-testid="canvas-minimap"/);
    });

    it("mounts the zoom strip at the bottom-left of the canvas plane", () => {
        // `<Practices position="bottom-left" ...>` — xyflow places
        // the strip absolute-positioned inside its viewport.
        expect(src).toMatch(/<Controls\b[\s\S]{0,400}position="bottom-left"/);
        // The `showInteractive` flag is OFF deliberately — locked
        // here so a future "show the lock toggle" PR has to make
        // the case in writing.
        expect(src).toMatch(/showInteractive=\{false\}/);
        // Token-driven surface so the overlay matches the canvas
        // frame language.
        expect(src).toMatch(
            /<Controls\b[\s\S]{0,500}bg-canvas-frame\/90/,
        );
        expect(src).toMatch(
            /data-testid="canvas-zoom-practices"/,
        );
    });

    it("the zoom strip surface-matches the canvas chrome language", () => {
        // bg-canvas-frame/90 + border-canvas-border + rounded-[8px]
        // + backdrop-blur — same set the document bar + AsidePanel
        // use elsewhere in the canvas. The overlay vocabulary is
        // one language, not a per-overlay invention.
        expect(src).toMatch(
            /<Controls\b[\s\S]{0,500}rounded-\[8px\]/,
        );
        expect(src).toMatch(
            /<Controls\b[\s\S]{0,500}backdrop-blur/,
        );
    });

    describe("dark-theme +/- button readability (globals.css wire-up)", () => {
        const css = read("src/app/globals.css");

        it("scopes the wire-up to the Processes canvas", () => {
            // The rule lives under `[data-process-canvas="true"]
            // .react-flow__controls` so the GraphExplorer's xyflow
            // tree (different surface vocabulary) is untouched.
            expect(css).toMatch(
                /\[data-process-canvas="true"\]\s+\.react-flow__controls\s*\{/,
            );
        });

        it("maps xyflow's practice-button cascade onto canvas tokens", () => {
            // Each of the five custom properties xyflow consults
            // for the button surface + glyph + border must be
            // mapped to a `--canvas-*` / `--content-*` token. The
            // canvas tokens already flip with the user's `[data-
            // theme]`, so the buttons follow the theme for free.
            //
            // Locked together to catch a "fix one but forget the
            // hover" partial revert.
            const rule = css.match(
                /\[data-process-canvas="true"\]\s+\.react-flow__controls\s*\{[^}]+\}/,
            );
            expect(rule).not.toBeNull();
            const body = rule![0];
            expect(body).toMatch(
                /--xy-controls-button-background-color:\s*var\(--canvas-frame\)/,
            );
            expect(body).toMatch(
                /--xy-controls-button-background-color-hover:\s*var\(--canvas-node\)/,
            );
            expect(body).toMatch(
                /--xy-controls-button-color:\s*var\(--content-default\)/,
            );
            expect(body).toMatch(
                /--xy-controls-button-color-hover:\s*var\(--content-default\)/,
            );
            expect(body).toMatch(
                /--xy-controls-button-border-color:\s*var\(--canvas-border\)/,
            );
        });
    });
});

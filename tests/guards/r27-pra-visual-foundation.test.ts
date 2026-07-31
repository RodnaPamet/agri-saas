/**
 * Roadmap-27 PR-A — Processes visual-foundation ratchet.
 *
 * PR-A redesigns the Processes page's colour system, surface
 * layering, and container architecture (prompts 1 + 2 + 5). This
 * ratchet locks the load-bearing pieces so a later refactor can't
 * silently collapse the page back to the flat blue-on-blue draft:
 *
 *   1. A dedicated `--canvas-*` token family exists, with full
 *      light/dark theme parity (every token defined in BOTH
 *      `:root` and `[data-theme="light"]`).
 *   2. Tailwind exposes the `canvas` colour group.
 *   3. The Processes Body is the elevated "workspace frame"
 *      (frame surface + rounded + hairline border).
 *   4. The canvas plane is the recessed surface (distinct token +
 *      the inner recess shadow) — a real tonal separation from the
 *      chrome around it.
 *   5. The dot grid resolves through `--canvas-grid`.
 *   6. Process nodes are SOLID elevated cards — no translucent
 *      fills, no backdrop-blur tints of the plane.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const TOKENS = read("src/styles/tokens.css");
const TAILWIND = read("tailwind.config.js");
const CLIENT = read("src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx");
const CANVAS = read("src/components/processes/PersistedProcessCanvas.tsx");
const NODE = read("src/components/processes/ProcessTypedNode.tsx");

/** Every token in the dedicated Processes surface ramp. */
const CANVAS_TOKENS = [
    "--canvas-surface",
    "--canvas-frame",
    "--canvas-grid",
    "--canvas-node",
    "--canvas-node-muted",
    "--canvas-border",
    "--canvas-shadow",
    "--canvas-recess",
];

describe("R27-PR-A — Processes visual foundation", () => {
    describe("Token family + theme parity", () => {
        for (const token of CANVAS_TOKENS) {
            it(`defines ${token} in both the dark and light theme`, () => {
                // A definition is `  --token: <value>;`. Counting the
                // `name:` form (not bare `name`) avoids matching
                // `--canvas-node` inside `--canvas-node-muted`.
                const defs = TOKENS.match(
                    new RegExp(`${token}:`, "g"),
                ) ?? [];
                // One in :root, one in [data-theme="light"].
                expect(defs.length).toBe(2);
            });
        }

        it("the canvas plane is darker than the page (dark theme recess)", () => {
            // The recessed work plane MUST resolve to its own token, not
            // reuse --bg-page. Drift here flattens the depth.
            //
            // This asserted a literal #05121F — the navy-era value — while
            // its own name and comment describe a RELATIONSHIP. When the
            // dark ground moved to green on 2026-07-30 the pin failed even
            // though the recess it exists to protect was intact, and
            // "fixing" it by swapping in the new hex would just reset the
            // same trap for the next re-theme. It now measures the property
            // directly: own token, and genuinely darker than the page.
            const hex = (name: string) => {
                const m = TOKENS.match(
                    new RegExp(`${name}:\\s*#([0-9a-f]{6})`, "i"),
                );
                if (!m) throw new Error(`${name} is not declared as a hex`);
                return m[1];
            };
            // WCAG relative luminance — the same measure the contrast
            // guards use, so "darker" means the same thing everywhere.
            const luminance = (h: string) => {
                const ch = [0, 2, 4].map((i) => {
                    const v = parseInt(h.slice(i, i + 2), 16) / 255;
                    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
                });
                return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
            };
            const surface = hex("--canvas-surface");
            const page = hex("--bg-page");
            expect(surface.toLowerCase()).not.toBe(page.toLowerCase());
            expect(luminance(surface)).toBeLessThan(luminance(page));
        });
    });

    describe("Tailwind exposure", () => {
        it("registers the `canvas` colour group", () => {
            expect(TAILWIND).toMatch(/canvas:\s*\{/);
            expect(TAILWIND).toMatch(/surface:\s*['"]var\(--canvas-surface\)['"]/);
            expect(TAILWIND).toMatch(/frame:\s*['"]var\(--canvas-frame\)['"]/);
        });

        it("registers the elevated-node + recess shadows", () => {
            expect(TAILWIND).toMatch(/['"]canvas-node['"]:\s*['"]var\(--canvas-shadow\)['"]/);
            expect(TAILWIND).toMatch(/['"]canvas-recess['"]:\s*['"]var\(--canvas-recess\)['"]/);
        });
    });

    describe("Workspace frame (container architecture)", () => {
        it("the Body is the elevated frame — frame surface, rounded, bordered", () => {
            expect(CLIENT).toMatch(/bg-canvas-frame/);
            expect(CLIENT).toMatch(/rounded-lg/);
            expect(CLIENT).toMatch(/border-canvas-border/);
        });

        it("the frame clips its inner strips (overflow-hidden)", () => {
            expect(CLIENT).toMatch(/overflow-hidden/);
        });
    });

    describe("Recessed canvas plane", () => {
        it("the canvas plane uses the dedicated recessed surface", () => {
            expect(CANVAS).toMatch(/bg-canvas-surface/);
        });

        it("the plane carries the inner recess shadow (reads as sunk)", () => {
            expect(CANVAS).toMatch(/shadow-canvas-recess/);
        });

        it("the dot grid resolves through --canvas-grid", () => {
            expect(CANVAS).toMatch(/var\(--canvas-grid\)/);
        });

        it("chrome strips divide with the canvas hairline token", () => {
            // Toolbar + palette + help strips read as one cohesive
            // chrome zone — hairline dividers, not heavy panels.
            expect(CANVAS).toMatch(/border-canvas-border/);
        });
    });

    describe("Nodes are solid elevated cards", () => {
        it("the flow surface uses the elevated node token", () => {
            expect(NODE).toMatch(/bg-canvas-node\b/);
        });

        it("the context surface uses the quieter node token", () => {
            expect(NODE).toMatch(/bg-canvas-node-muted/);
        });

        it("nodes carry the elevated-card shadow", () => {
            expect(NODE).toMatch(/shadow-canvas-node/);
        });

        it("no translucent fills or backdrop-blur (no washed-out tints)", () => {
            // R27 replaced `bg-bg-default/90 backdrop-blur-sm` with
            // opaque, shadowed cards. Re-introducing translucency
            // collapses the node back into the plane.
            expect(NODE).not.toMatch(/backdrop-blur/);
            expect(NODE).not.toMatch(/bg-bg-default\/\d/);
        });
    });
});

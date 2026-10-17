/**
 * PR-C polish — Structural ratchet for force-directed layout via
 * elkjs. Locks the wiring across three concerns:
 *
 *   1. Dependency. `elkjs` is in `package.json` `dependencies`
 *      (not devDependencies — the layout runs in the browser).
 *   2. Helper. `computeForceLayout(nodes, edges, nodeIdsFilter?)`
 *      lives in `canvas-auto-layout.ts`, dynamically imports
 *      `elkjs/lib/elk.bundled.js` (so the ~600KB bundle ships
 *      only when used), and routes through the shared
 *      `finaliseSubsetPositions` helper for centroid preservation.
 *   3. Wire. The canvas exposes `handleAutoLayoutForce(selectionOnly)`
 *      and two new command-palette entries
 *      ("arrange-force" / "arrange-force-selection").
 *
 * Why structural: ELK is an async dependency added in one PR.
 * A future refactor could silently revert any link (drop the dep,
 * inline-import the bundle, drop the menu entry) without breaking
 * surface behaviour at first glance.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, "../..");
/**
 * Read a TS/TSX source file with comments blanked (#1774).
 *
 * Split from `readRaw` because the old single helper also served
 * `package.json`, and blanking JSON is not a no-op — it is damaging. JSON has
 * no comments, so a `//` inside a string VALUE (every `https://` URL) would be
 * blanked, and a `/*` in one would open a "comment" that runs to the next
 * `*\/` and swallows the quotes and braces in between. `JSON.parse` then
 * fails, or worse succeeds on a corrupted value.
 */
const read = (p: string) => blankNonCode(readFileSync(path.join(ROOT, p), "utf-8"));

/** Read a NON-source file verbatim — JSON, and anything else without TS comments. */
const readRaw = (p: string) => readFileSync(path.join(ROOT, p), "utf-8");

describe("PR-C polish — force-directed layout via elkjs", () => {
    describe("1. Dependency", () => {
        it("elkjs is in production dependencies (not devDependencies)", () => {
            const pkg = JSON.parse(readRaw("package.json")) as {
                dependencies: Record<string, string>;
                devDependencies: Record<string, string>;
            };
            expect(pkg.dependencies.elkjs).toBeDefined();
            expect(pkg.devDependencies?.elkjs).toBeUndefined();
        });
    });

    describe("2. Helper", () => {
        const src = () => read("src/lib/processes/canvas-auto-layout.ts");

        it("exports computeForceLayout as an async function", () => {
            expect(src()).toMatch(
                /export async function computeForceLayout\(\s*nodes:\s*Node\[\],\s*edges:\s*Edge\[\],\s*nodeIdsFilter\?:\s*ReadonlySet<string>,?\s*\):\s*Promise<AutoLayoutResult>/,
            );
        });

        it("dynamically imports elkjs to keep the static bundle slim", () => {
            // Static `import ... from "elkjs"` would put the ~600KB
            // bundle in the initial chunk; the dynamic `await
            // import(...)` defers it.
            expect(src()).toMatch(
                /await import\("elkjs\/lib\/elk\.bundled\.js"\)/,
            );
            expect(src()).not.toMatch(
                /^import [^{]*from "elkjs"/m,
            );
        });

        it("uses ELK's force algorithm with the documented iteration count", () => {
            const s = src();
            expect(s).toMatch(/"elk\.algorithm":\s*"force"/);
            expect(s).toMatch(/"elk\.force\.iterations":/);
        });

        it("routes through finaliseSubsetPositions for centroid preservation", () => {
            // Both `computeAutoLayout` AND `computeForceLayout`
            // should call the same helper so selection-only mode
            // behaves identically across the two engines.
            const s = src();
            expect(s).toMatch(/function finaliseSubsetPositions/);
            // Two call sites — once from dagre, once from force.
            const calls = s.match(/finaliseSubsetPositions\(/g) ?? [];
            expect(calls.length).toBeGreaterThanOrEqual(3); // 1 decl + 2 calls
        });

        it("skips annotation nodes (parity with dagre)", () => {
            // The same convention the dagre helper holds — floating
            // tags don't participate in flow algorithms.
            const s = src();
            const forceStart = s.indexOf("export async function computeForceLayout");
            expect(forceStart).toBeGreaterThan(-1);
            const forceBody = s.slice(forceStart);
            expect(forceBody).toMatch(/kind === "annotation"/);
            expect(forceBody).toMatch(/continue;/);
        });
    });

    describe("3. Canvas wire", () => {
        const src = () =>
            read("src/components/processes/PersistedProcessCanvas.tsx");

        it("imports computeForceLayout alongside computeAutoLayout", () => {
            expect(src()).toMatch(
                /import\s*\{[\s\S]*?\bcomputeAutoLayout\b[\s\S]*?\bcomputeForceLayout\b[\s\S]*?\}\s*from\s*"@\/lib\/processes\/canvas-auto-layout"/,
            );
        });

        it("declares handleAutoLayoutForce as an async useCallback", () => {
            const s = src();
            expect(s).toMatch(
                /const handleAutoLayoutForce = useCallback\(\s*async\s*\(/,
            );
        });

        it("force handler awaits computeForceLayout before applying positions", () => {
            const s = src();
            const start = s.indexOf("const handleAutoLayoutForce = useCallback");
            expect(start).toBeGreaterThan(-1);
            // The next line containing `await computeForceLayout` MUST
            // appear BEFORE the next `setNodes((nds) =>` — that's the
            // ordering invariant (we don't want partial state).
            const body = s.slice(start, start + 1500);
            const awaitIdx = body.indexOf("await computeForceLayout");
            const setNodesIdx = body.indexOf("setNodes((nds)");
            expect(awaitIdx).toBeGreaterThan(-1);
            expect(setNodesIdx).toBeGreaterThan(-1);
            expect(awaitIdx).toBeLessThan(setNodesIdx);
        });

        it("the command palette has both force-layout entries", () => {
            const s = src();
            expect(s).toMatch(/id: "arrange-force"/);
            expect(s).toMatch(/id: "arrange-force-selection"/);
            expect(s).toMatch(/handleAutoLayoutForce\(false\)/);
            expect(s).toMatch(/handleAutoLayoutForce\(true\)/);
            // Selection variant must require 2+ nodes selected.
            const sel = s.match(
                /id: "arrange-force-selection"[\s\S]*?onSelect:[^}]*\}/,
            );
            expect(sel).not.toBeNull();
            expect(sel![0]).toMatch(/selectionCount < 2/);
        });
    });
});

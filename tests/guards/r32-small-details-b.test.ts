/**
 * R32-PR12 — Small details bundle B (6 of 12).
 *
 * Second half of the verdict's "12 small details that matter".
 * Bundle A (R32-PR11) shipped the first six. This bundle ships:
 *
 *   7. Process selector → `<Combobox>` (Epic 55 canonical). The
 *      pre-R32 native `<select>` rendered as raw browser chrome;
 *      Combobox brings keyboard search, fuzzy match, large-list
 *      virtualisation, and IC's token vocabulary.
 *
 *   8. Inline document title → Figma-style auto-grow. The
 *      `<input>` width tracks the typed content via the `ch`
 *      unit; min/max clamped so empty inputs still read as a
 *      target and long names don't crowd the action cluster.
 *
 *   9. Autosave status placement — moved adjacent to the Save
 *      button. Pre-R32 it sat between the snap toggle and the
 *      version pill (a wandering status). Notion's "All changes
 *      saved" placement is the canonical reference: status reads
 *      as the verb-tense of the action it sits beside.
 *
 *  10. Group button explanatory Tooltip on the disabled state.
 *      Pre-R32 the button silently disabled when the user picked
 *      a node already inside a group OR picked a group itself —
 *      no signal as to WHY. R32 wraps the disabled state in a
 *      `<Tooltip>` explaining the rule.
 *
 *  11. Practice-on-edge pill vocabulary — radius drops from
 *      `rounded-[8px]` to `rounded-[4px]` to match the edge-label
 *      chip shipped in R31 Bundle 7. Pre-R32 two pills on the
 *      same edge had two different radii.
 *
 *  12. `--canvas-grid` token — verified to already live in the IC
 *      token system (tokens.css dark + light theme values +
 *      Tailwind config alias). The verdict's "fold into
 *      `--background-subtle`" recommendation conflicts with the
 *      canvas-as-distinct-work-plane intent shipped in R31; this
 *      bundle documents the verification rather than degrading
 *      the canvas's own colour family.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("R32-PR12 — small details bundle B", () => {
    const docBar = read("src/components/processes/CanvasDocumentBar.tsx");
    const canvas = read(
        "src/components/processes/PersistedProcessCanvas.tsx",
    );
    const edge = read("src/components/processes/ProcessEdge.tsx");

    describe("Detail #7 — process selector → Combobox", () => {
        it("imports the canonical Combobox primitive", () => {
            expect(docBar).toMatch(
                /import\s*\{\s*Combobox[\s\S]{0,80}\}\s*from\s*["']@\/components\/ui\/combobox["']/,
            );
        });

        it("the raw native <select> is retired", () => {
            // No <select> + no <option> tags. Combobox owns the
            // option-rendering surface now.
            expect(docBar).not.toMatch(/<select\b/);
            expect(docBar).not.toMatch(/<option\b/);
        });

        it("Combobox option mapping is memoised", () => {
            // Stable references — primitive doesn't re-render on
            // every parent tick.
            expect(docBar).toMatch(
                /useMemo<ComboboxOption\[\]>/,
            );
            expect(docBar).toMatch(
                /useMemo<ComboboxOption \| null>/,
            );
        });

        it("preserves the process-selector testid for E2E selectors", () => {
            expect(docBar).toMatch(/data-testid="process-selector"/);
        });
    });

    describe("Detail #8 — inline title auto-grow", () => {
        it("input width tracks typed content via `ch` units", () => {
            // The min-clamp (12ch) keeps empty inputs targetable;
            // the max-clamp (28ch) prevents long names crowding
            // the action cluster.
            expect(docBar).toMatch(
                /style=\{\{\s*\n?\s*width:\s*`\$\{Math\.max\([\s\S]{0,200}\)\}ch`/,
            );
            expect(docBar).toMatch(/max-w-\[28ch\]/);
        });

        it("placeholder reads as a target, not a hint", () => {
            // Pre-R32 the placeholder was the single word
            // "Untitled". R32 widens to "Untitled process" so
            // the empty input still communicates the document
            // context, not just the document state.
            expect(docBar).toMatch(/placeholder=\{t\("processDocBar\.untitledProcess"\)\}/);
        });
    });

    describe("Detail #9 — autosave status placement", () => {
        it("version pill renders BEFORE the autosave status block", () => {
            // The order is: error → version pill → autosave →
            // Save. The version pill is the JSX literal
            // `v{loadedMap.version}` (curly-brace expression);
            // the autosave block carries the canonical testid.
            const versionIdx = docBar.indexOf("v{loadedMap.version}");
            const autosaveIdx = docBar.indexOf(
                'data-testid="autosave-status"',
            );
            expect(versionIdx).toBeGreaterThan(0);
            expect(autosaveIdx).toBeGreaterThan(versionIdx);
        });
    });

    describe("Detail #10 — Group button disabled tooltip", () => {
        it("the disabled Group button surfaces an explanatory Tooltip", () => {
            // The Tooltip primitive wraps the disabled button so
            // the user reads WHY clicking won't fire.
            expect(canvas).toMatch(/<Tooltip\b/);
            expect(canvas).toMatch(
                /persistedCanvas\.groupDisabledTitle/,
            );
            // Both the button's `title=` attribute AND the
            // Tooltip carry the same explanation so screen-readers
            // + sighted users both get the rationale.
            expect(canvas).toMatch(
                /title=\{[\s\S]{0,200}persistedCanvas\.groupDisabledTitle[\s\S]{0,200}persistedCanvas\.groupSelected/,
            );
        });

        it("imports the Tooltip primitive", () => {
            expect(canvas).toMatch(
                /import\s*\{\s*Tooltip\s*\}\s*from\s*["']@\/components\/ui\/tooltip["']/,
            );
        });
    });

    describe("Detail #11 — practice-on-edge chip vocabulary match", () => {
        it("PracticeOnEdge radius matches the edge-label chip (4px)", () => {
            // Pre-R32 `rounded-[8px]` — twice the radius of the
            // R31-Bundle-7 edge label chip (4px). Now unified.
            const start = edge.indexOf("function PracticeOnEdge");
            expect(start).toBeGreaterThan(0);
            const slice = edge.slice(start, start + 800);
            expect(slice).toMatch(/rounded-\[4px\]/);
            expect(slice).not.toMatch(/rounded-\[8px\]/);
        });

        it("PracticeOnEdge surface tokens match the edge-label chip", () => {
            // Both use `bg-canvas-frame` + `border-canvas-border`.
            // Pre-R32 the practice pill used `bg-bg-elevated` +
            // `border-border-emphasis` — different token family.
            const start = edge.indexOf("function PracticeOnEdge");
            const slice = edge.slice(start, start + 800);
            expect(slice).toMatch(/bg-canvas-frame/);
            expect(slice).toMatch(/border-canvas-border/);
        });
    });

    describe("Detail #12 — canvas-grid token verification", () => {
        it("--canvas-grid is defined in the IC token system (both themes)", () => {
            const tokens = read("src/styles/tokens.css");
            // At least two definitions — one per theme — confirm
            // theme-swap correctness.
            const matches = tokens.match(/--canvas-grid:/g) ?? [];
            expect(matches.length).toBeGreaterThanOrEqual(2);
        });

        it("--canvas-grid is wired into the Tailwind theme aliases", () => {
            const tw = read("tailwind.config.js");
            // `canvas.grid` alias — so consumers can use
            // `bg-canvas-grid` / `border-canvas-grid` if needed.
            expect(tw).toMatch(/grid:\s*['"]var\(--canvas-grid\)['"]/);
        });
    });
});

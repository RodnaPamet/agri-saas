/**
 * R32-PR11 — Small details bundle A (6 of 12).
 *
 * First half of the verdict's "12 small details that matter".
 * The verdict explicitly framed these as work for the rounds
 * AFTER R31's structural reset, when "the aggregation of small
 * refinements is what makes a design tool feel world-class".
 *
 * Items closed in this bundle:
 *
 *   1. Node corner radius unification — rect chassis at 8px
 *      (was 10px), notes at 6px, group containers at 12px
 *   2. Handle dot visibility — `opacity-0` at rest, full opacity
 *      on `group-hover` of the parent node
 *   3. Edge stroke-width hierarchy — explicit rest 1.5 / preview
 *      1.5-dashed / selected 2.5 (was 1.75 / 2 / 2.25 — too
 *      subtle a rest→selected gap to read on a dense graph)
 *   4. Selected ring offset — `ring-offset-2 ring-offset-canvas-
 *      surface` (Apple's emphasis pattern). Pre-R32 the ring
 *      overlapped the node border.
 *   5. Inspector field spacing — every `<label>` and inner `<div>`
 *      uses `gap-tight` (8px). Pre-R32 mixed `gap-1` (4px) and
 *      `gap-default` (16px); two values for one role.
 *   6. Empty-state typography voice — lead line `text-base font-
 *      medium` (was `text-sm`). Voice anchored to the design-tool
 *      authority the verdict named.
 *
 * Bundle B (6 of 12, R32-PR12) closes the remaining six:
 * process selector → Combobox, inline-title auto-grow, autosave
 * status placement, Group-button explanatory tooltip, practice-
 * on-edge chip vocabulary match, `--canvas-grid` theme fold.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("R32-PR11 — small details bundle A", () => {
    describe("Detail #1 — node corner radius unification", () => {
        const src = read("src/components/processes/ProcessTypedNode.tsx");

        it("rect chassis radius is 8px (was 10px)", () => {
            // The non-note radius is the canonical card radius.
            // Locked on the literal value so a refactor that
            // re-introduces 10px fails CI.
            expect(src).toMatch(
                /radiusClass = isNote\s*\?\s*["']rounded-\[6px\]["']\s*:\s*["']rounded-\[8px\]["']/,
            );
            expect(src).not.toMatch(/isNote\s*\?\s*["']rounded-\[6px\]["']\s*:\s*["']rounded-\[10px\]["']/);
        });

        it("group containers keep their 12px radius (container reading)", () => {
            // The 12px group radius is one notch larger than the
            // 8px card radius — preserves the "I hold other
            // things" reading. Locked here so a future
            // simplification can't accidentally flatten the
            // hierarchy.
            expect(src).toMatch(/rounded-\[12px\][\s\S]{0,80}border-2 border-dashed/);
        });
    });

    describe("Detail #2 — handle dot visibility", () => {
        const src = read("src/components/processes/ProcessTypedNode.tsx");

        it("handle dots default to opacity-0 + lift on group-hover", () => {
            // The chassis carries `group` so the dots can use
            // `group-hover:opacity-100`. Without `group`, hover
            // on a sibling node would not propagate.
            expect(src).toMatch(/HANDLE_CLASS[\s\S]{0,400}!opacity-0/);
            expect(src).toMatch(
                /HANDLE_CLASS[\s\S]{0,400}group-hover:!opacity-100/,
            );
            expect(src).toMatch(
                /HANDLE_CLASS[\s\S]{0,400}transition-opacity/,
            );
        });

        it("the rect chassis carries the `group` className", () => {
            // The chassis className string must START with
            // `group` for Tailwind's group-hover variant to apply.
            expect(src).toMatch(/["']group relative border transition-colors["']/);
        });
    });

    describe("Detail #3 — edge stroke-width hierarchy", () => {
        const src = read("src/components/processes/ProcessEdge.tsx");

        it("rest stroke is 1.5 (the new floor)", () => {
            // Flow + conditional both rest at 1.5; reference is
            // 1.25 (one notch finer for the "informational"
            // signal). Locked on the canonical values.
            expect(src).toMatch(/strokeWidth: selected \? 2\.5 : 1\.5/);
            expect(src).toMatch(/strokeWidth: selected \? 2\.25 : 1\.25/);
        });

        it("selected stroke is 2.5 — the explicit emphasis", () => {
            // 2.5 (was 2.25) — selected/rest ratio now ≥1.67×,
            // up from 1.29×. The hierarchy is unmistakable.
            const selectedMatches = src.match(/selected \? 2\.5/g) ?? [];
            expect(selectedMatches.length).toBeGreaterThanOrEqual(2);
        });

        it("preview stroke is 1.5 dashed (matches the new rest floor)", () => {
            // Preview is "in flight, not yet committed" — same
            // weight as rest, dashed-pattern signals tentative.
            expect(src).toMatch(/isPreview[\s\S]{0,200}strokeWidth:\s*1\.5/);
        });
    });

    describe("Detail #4 — selected ring offset", () => {
        const src = read("src/components/processes/ProcessTypedNode.tsx");

        it("SELECTED_CHROME composes `ring-offset-2 ring-offset-canvas-surface`", () => {
            // The offset gives the ring breathing space against
            // the node border — Apple's emphasis pattern. Pre-R32
            // the ring overlapped the border.
            expect(src).toMatch(
                /SELECTED_CHROME[\s\S]{0,400}ring-offset-2\s+ring-offset-canvas-surface/,
            );
        });
    });

    describe("Detail #5 — inspector field spacing", () => {
        const src = read("src/components/processes/ProcessInspector.tsx");

        it("every inner label/div block uses gap-tight (no mixed gap-1)", () => {
            // Pre-R32 some inner blocks used `gap-1` (4px) and
            // others `gap-default` (16px) — two values for one
            // role. Locked here on `gap-tight` (8px) inside the
            // label flex columns. The outer body still uses
            // `gap-default` between sections — that's intentional
            // hierarchy.
            expect(src).not.toMatch(/className="flex flex-col gap-1"/);
            // At least three `gap-tight` flex-col blocks exist
            // (label, subtitle, size) plus more in the edge body.
            const tightMatches =
                src.match(/className="flex flex-col gap-tight"/g) ?? [];
            expect(tightMatches.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe("Detail #6 — empty-state typography voice", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("the lead empty-state line uses text-base font-medium", () => {
            // Pre-R32 the line was `text-sm font-medium` — too
            // quiet for a design tool's authority. Locked on the
            // exact selector + tone tone so a future regression
            // (someone tightens it back to `text-sm`) fails CI.
            expect(src).toMatch(
                /text-base font-medium text-content-emphasis[\s\S]{0,100}persistedCanvas\.emptyTitle/,
            );
        });
    });
});

/**
 * Epic P6-PR-B — Touch / mobile ergonomics ratchet.
 *
 * Closes the brief's #9 🟡 "Touch / Mobile Gestures" gap (subset).
 * Pre-P6 the canvas worked but the xyflow handle hit-targets
 * (~8px) were unusable for fingers (Apple HIG: 44px minimum).
 *
 * P6-PR-B ships:
 *   - Coarse-pointer hit-target expansion on xyflow handles +
 *     palette items via a `::before` pseudo-element (no visual
 *     change — pure pointer-events).
 *   - Larger zoom-practice buttons (32px) on coarse pointer.
 *   - Mobile-layout marker that folds the vertical palette into
 *     a horizontal scroll strip below the `md` breakpoint.
 *
 * What's deferred: long-press context menu (a fuller UX layer
 * that earns its own PR), and full pinch-zoom validation
 * (xyflow supports it natively; the rest is QA).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("Epic P6-PR-B — touch / mobile ergonomics", () => {
    describe("globals.css — coarse-pointer rules", () => {
        const src = read("src/app/globals.css");

        it("scopes the rules to the Processes canvas (not GraphExplorer)", () => {
            expect(src).toMatch(
                /\[data-process-canvas="true"\] \.react-flow__handle/,
            );
        });

        it("expands the handle hit-target via a transparent ::before", () => {
            // The expansion MUST stay transparent — visible
            // changes to the handle dot would break the design
            // language. Anchor on the inset + transparent
            // background.
            expect(src).toMatch(
                /\.react-flow__handle::before \{[\s\S]{0,400}inset:\s*-10px;[\s\S]{0,200}background:\s*transparent;/,
            );
        });

        it("widens the zoom practice buttons to the Apple HIG minimum (32px)", () => {
            expect(src).toMatch(
                /\.react-flow__controls-button \{[\s\S]{0,200}width:\s*32px;[\s\S]{0,200}height:\s*32px;/,
            );
        });

        it("palette items get a 44px minimum hit-target", () => {
            expect(src).toMatch(
                /\[data-process-palette-item="true"\] \{[\s\S]{0,200}min-height:\s*44px;/,
            );
        });

        it("wraps the coarse-pointer rules in `@media (pointer: coarse)`", () => {
            expect(src).toMatch(/@media \(pointer:\s*coarse\)/);
        });

        it("folds the vertical palette to a horizontal strip below the md breakpoint", () => {
            expect(src).toMatch(/@media \(max-width:\s*767px\)/);
            expect(src).toMatch(
                /\[data-mobile-layout="true"\] \[data-process-palette="true"\][\s\S]{0,500}flex-direction:\s*row;/,
            );
        });
    });

    describe("ProcessPalette — emits the canonical hit-target marker", () => {
        const src = read("src/components/processes/ProcessPalette.tsx");

        it("each palette card carries data-process-palette-item='true'", () => {
            // The CSS rule above selects on this attribute; if the
            // emit ever drops the marker, touch-target ergonomics
            // silently regress. Anchor here so it can't.
            expect(src).toMatch(/data-process-palette-item="true"/);
        });
    });

    describe("PersistedProcessCanvas — emits the mobile-layout marker", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("imports useMediaQuery", () => {
            expect(src).toMatch(
                /import\s*\{\s*useMediaQuery\s*\}\s*from\s*["']@\/components\/ui\/hooks\/use-media-query["']/,
            );
        });

        it("threads `data-mobile-layout` onto the canvas wrapper", () => {
            // The attribute drives the responsive-palette media
            // query. Anchor on both the hook destructure and the
            // attribute emit.
            expect(src).toMatch(/const \{ isMobile \} = useMediaQuery\(\)/);
            expect(src).toMatch(
                /data-mobile-layout=\{isMobile \? ["']true["'] : undefined\}/,
            );
        });
    });
});

/**
 * R31 (Bundle 5) — Inspector → AsidePanel parity (PR 6 of the roadmap).
 *
 * Pre-R31 the `<ProcessInspector>` rendered a bespoke 260px
 * `<aside>` with hand-rolled chrome — no collapse-to-spine, no
 * `<Sheet>` fallback below xl, no resizable handle, no
 * `?aside=…` deep-link, no `surfaceKey`-persisted user
 * preferences. The Risks list (R28) and Practices list (#714)
 * had already converged on the canonical `<AsidePanel>`
 * primitive; the Processes page was the odd one out.
 *
 * R31 Bundle 5 wraps both inspector modes (node + edge) inside
 * `<AsidePanel title="Inspector" surfaceKey="processes-inspector">`.
 * Same surfaceKey for both modes so a user toggling between
 * node + edge selection sees ONE persistent inspector panel
 * preserve its collapse + width preferences.
 *
 * Every R28-pinned testid (`inspector-label-input`,
 * `inspector-subtitle-input`, `inspector-edge-label-input`,
 * `data-process-inspector`, `data-inspector-mode="edge"`)
 * survives the migration — the inner body moved, the markers
 * stayed.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("R31 (Bundle 5) — inspector AsidePanel parity", () => {
    const src = read("src/components/processes/ProcessInspector.tsx");

    it("imports the AsidePanel primitive", () => {
        expect(src).toMatch(
            /import\s*\{\s*AsidePanel\s*\}\s*from\s*["']@\/components\/ui\/aside-panel["']/,
        );
    });

    it("both inspector modes (node + edge) mount inside <AsidePanel>", () => {
        // Two <AsidePanel> opens in the file: one in the node body,
        // one in EdgeInspectorBody. Anchor on the canonical surfaceKey
        // so future drift to per-mode keys (which would split the
        // user's preference) fails CI.
        const opens = src.match(/<AsidePanel\b/g) ?? [];
        expect(opens.length).toBeGreaterThanOrEqual(2);
        // Both call sites must use the SAME surfaceKey so collapse
        // state persists across node ↔ edge selection.
        const surfaceKeyMatches = src.match(
            /surfaceKey=["']processes-inspector["']/g,
        );
        expect((surfaceKeyMatches ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it("retires the bespoke 260px <aside> chrome", () => {
        // The pre-R31 aside carried `w-[260px] shrink-0 ... border-l
        // ... bg-canvas-frame p-default`. The new chrome is in the
        // AsidePanel primitive; the body is just a flex column.
        expect(src).not.toMatch(/<aside\b[\s\S]{0,400}w-\[260px\]/);
        expect(src).not.toMatch(/<aside\b[\s\S]{0,400}border-l border-canvas-border/);
    });

    it("preserves the R28-pinned testids + markers", () => {
        // The inner body MOVED but the markers STAYED. Existing
        // R28 ratchets (and any E2E selectors) continue to find
        // their targets.
        for (const marker of [
            "data-process-inspector",
            'data-inspector-mode="edge"',
            "inspector-label-input",
            "inspector-subtitle-input",
            "inspector-edge-label-input",
        ]) {
            // CodeQL `js/identity-replacement` flagged the prior
            // `.replace(/"/g, '"')` as a no-op (replace with self).
            // `"` isn't a regex metachar — feed the marker straight
            // to `new RegExp(...)`.
            expect(src).toMatch(new RegExp(marker));
        }
    });

    it("the title 'Inspector' moves from inline span to AsidePanel.title", () => {
        // Pre-R31 the inspector had an inline header span:
        //   <span>Inspector</span>
        // The AsidePanel primitive owns the title bar now;
        // the inline span is gone.
        expect(src).toMatch(/title=\{t\("processInspector\.inspector"\)\}/);
    });
});

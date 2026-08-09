/**
 * PR-7 — Interaction state discipline ratchet.
 *
 * Locks the four polish items shipped in PR-7:
 *   1. DataTable row hover uses `bg-bg-muted` (solid surface), not
 *      `bg-bg-subtle` (alpha-tinted, ~7% opacity, nearly invisible).
 *   2. Sortable column headers carry `focus-visible:ring-2 ring-ring`
 *      so keyboard users see focus.
 *   3. Selected DataTable rows render a left-edge brand accent via
 *      inset box-shadow on the leftmost cell.
 *   4. Sticky pagination footer paints a gradient fade ABOVE the
 *      footer so the last visible row never butts directly against
 *      the footer's top edge.
 *
 * Pairs with the rendered DataTable tests at
 * `tests/rendered/data-table-virtualize.test.tsx` and the existing
 * Epic 52 ratchet at `tests/guards/epic52-datatable-ratchet.test.ts`.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("PR-7 interaction state discipline", () => {
  describe("DataTable row hover", () => {
    const tableSrc = read("src/components/ui/table/table.tsx");

    it("clickable rows hover to `bg-bg-muted`, not the older `bg-bg-subtle`", () => {
      // The hover utility lives in the row-cell composition. We
      // assert both the positive (the muted token is present in a
      // group-hover/row clause) and the negative (the older subtle
      // token is NOT used as the hover background).
      expect(tableSrc).toMatch(/group-hover\/row:bg-bg-muted/);
      expect(tableSrc).not.toMatch(/group-hover\/row:bg-bg-subtle/);
    });

    it("clickable rows still carry the transition utility", () => {
      expect(tableSrc).toMatch(
        /group-hover\/row:bg-bg-muted\s+transition-colors/,
      );
    });
  });

  describe("Sortable column header focus ring", () => {
    const tableSrc = read("src/components/ui/table/table.tsx");

    it("sortable column header carries the focus-visible recipe", () => {
      // The header `<ButtonOrDiv>` block applies the focus-ring utility
      // when `isSortableColumn` is true. We check the structural shape
      // of the recipe (ring-2 + ring-ring + offset). Roadmap-6 PR-3
      // upgraded the page-level offset from 1 → 2 + ring-offset-background
      // so the ring sits one extra px clear of the surface.
      expect(tableSrc).toMatch(/focus-visible:ring-2/);
      expect(tableSrc).toMatch(/focus-visible:ring-ring/);
      expect(tableSrc).toMatch(/focus-visible:ring-offset-2/);
      expect(tableSrc).toMatch(/focus-visible:ring-offset-background/);
    });
  });

  describe("Selected-row left-edge accent", () => {
    const tableSrc = read("src/components/ui/table/table.tsx");

    it("selected rows render a brand-default left edge via inset box-shadow", () => {
      // The accent uses Tailwind's arbitrary box-shadow to paint a
      // 2-px inset stroke on the FIRST non-utility cell. R13-PR15
      // replaced the CSS `:first-of-type:` selector with an
      // `isFirstContent` boolean computed at render time — the
      // pseudo silently broke once the select column became
      // default-on (R12-PR1) because it then matched the select
      // cell. The recipe is now plain
      // `group-data-[selected=true]/row:shadow-…`, gated in JS to
      // apply only to the first non-utility cell.
      expect(tableSrc).toMatch(
        /group-data-\[selected=true\]\/row:shadow-\[inset_2px_0_0_var\(--brand-default\)\]/,
      );
    });
  });

  describe("Pagination footer overlap fade", () => {
    const standaloneSrc = read("src/components/ui/table/pagination-controls.tsx");
    const inlineSrc = read("src/components/ui/table/table.tsx");

    it("standalone PaginationControls paints the gradient fade above the footer", () => {
      expect(standaloneSrc).toMatch(/before:bg-gradient-to-t/);
      expect(standaloneSrc).toMatch(/before:from-bg-default/);
      expect(standaloneSrc).toMatch(/before:to-transparent/);
    });

    it("DataTable inline pagination footer paints the same gradient fade", () => {
      expect(inlineSrc).toMatch(/before:bg-gradient-to-t/);
      expect(inlineSrc).toMatch(/before:from-bg-default/);
      expect(inlineSrc).toMatch(/before:to-transparent/);
    });

    it("both footers keep the sticky bottom-0 + z-10 positioning that fillBody tables rely on", () => {
      expect(standaloneSrc).toMatch(/sticky\s+bottom-0\s+z-10/);
      expect(inlineSrc).toMatch(/sticky\s+bottom-0\s+z-10/);
    });
  });
});

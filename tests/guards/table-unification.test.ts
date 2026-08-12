/**
 * Roadmap-9 PR-4 — DataTable unification (Assets as the canonical reference).
 *
 * User directive locked 2026-05-11 named the Practices page DataTable as
 * the reference shape every other table unifies around. That page was
 * deleted in GRC teardown phase 2; the Assets DataTable inherits the
 * role — it is the surviving table that carries all four traits. Four
 * rules follow:
 *
 * (The Assets path is spelled once, at the assertion below. A sibling
 * ratchet, `pr-asset-practice-codes.test.ts`, locates the registry entry
 * in this file by slicing from the FIRST occurrence of that path string,
 * so a second mention up here silently points it at prose.)
 *
 *   1. **Selection circle.** Row-select Checkbox renders as a
 *      circle (`rounded-full`), not the prior `rounded-md`. Locks
 *      both the per-row select cell (table.tsx) AND the select-all
 *      cell (selection-toolbar.tsx) AND the in-toolbar live mirror.
 *
 *   2. **Row hover.** Clickable rows get the canonical
 *      `group-hover/row:bg-bg-muted transition-colors duration-75`
 *      treatment from the DataTable primitive. The primitive's
 *      `clickable && ...` ternary handles this for every consumer
 *      that wires `onRowClick`.
 *
 *   3. **First column = Code.** Where the entity has a code/
 *      identifier (assets), the first column should be `id: 'code'`.
 *      Migration target — coverage ratchet registers candidate tables.
 *
 *   4. **Stable row IDs.** `getRowId: (row) => row.id` set on every
 *      table to anchor row selection across data refreshes.
 *
 * This ratchet locks the geometry contracts at the primitive level
 * (circle-select shape, hover recipe). Consumer migration for "first
 * column = Code" is registered for follow-up work.
 *
 * Supersedes the R9-PR4 "selected-state vocabulary" framing per the
 * user-locked memory entry.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

describe("DataTable unification — Assets as the canonical shape", () => {
    it("row-select Checkbox in table.tsx is rounded-full (circular select)", () => {
        const src = fs.readFileSync(
            path.join(ROOT, "src/components/ui/table/table.tsx"),
            "utf8",
        );
        // The select-cell Checkbox renders TWICE in this file (header
        // select-all + body per-row). Both must be rounded-full.
        const matches = src.match(
            /size-4\s+rounded-full\s+data-\[state=checked\]:bg-\[var\(--brand-emphasis\)\]/g,
        );
        expect(matches).not.toBeNull();
        expect(matches!.length).toBeGreaterThanOrEqual(2);
        // And the legacy rounded-md shape is gone.
        expect(src).not.toMatch(
            /size-4\s+rounded\s+data-\[state=checked\]/,
        );
    });

    it("select-all Checkbox in selection-toolbar.tsx is rounded-full", () => {
        const src = fs.readFileSync(
            path.join(ROOT, "src/components/ui/table/selection-toolbar.tsx"),
            "utf8",
        );
        expect(src).toMatch(
            /size-4\s+rounded-full\s+data-\[state=checked\]:bg-\[var\(--brand-emphasis\)\]/,
        );
        expect(src).not.toMatch(
            /size-4\s+rounded\s+data-\[state=checked\]/,
        );
    });

    it("primitive hover recipe is `group-hover/row:bg-bg-muted` on clickable rows", () => {
        // The primitive ternary `clickable && "group-hover/row:..."`
        // is what gives every <DataTable onRowClick=> consumer the
        // canonical hover treatment. Locking the literal here prevents
        // a future "simplify" PR from stripping the transition or
        // changing the bg recipe.
        const src = fs.readFileSync(
            path.join(ROOT, "src/components/ui/table/table.tsx"),
            "utf8",
        );
        expect(src).toMatch(
            /clickable\s*&&\s*"group-hover\/row:bg-bg-muted\s+transition-colors\s+duration-75"/,
        );
    });

    // GRC teardown phase 2 deleted PracticesClient, the original
    // canonical reference. Assets inherits the role: it is the only
    // surviving list table whose first column is `id: 'code'`, and it
    // sets the other three traits too. It mounts <DataTable> directly
    // rather than through EntityListPage's table config, so the props
    // are JSX attributes (`getRowId={…}`) instead of object keys.
    //
    // One sub-assertion is NOT carried over: Practices extracted its
    // row-id fn to a stable `useCallback` (`getPracticeRowId`). Assets
    // passes an inline arrow, so only the wiring is asserted here —
    // dropped deliberately rather than weakened silently.
    it("Assets table — the canonical reference — sets the four locked traits", () => {
        const src = fs.readFileSync(
            path.join(
                ROOT,
                "src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx",
            ),
            "utf8",
        );
        // 1. First column is `id: 'code'`.
        expect(src).toMatch(/id:\s*['"]code['"]/);
        // 2. getRowId is set, anchoring selection across data refreshes.
        expect(src).toMatch(/getRowId=\{/);
        // 3. onRowClick wires the canonical primitive hover.
        expect(src).toMatch(/onRowClick=\{/);
        // 4. The hover className is preserved on the table chrome.
        expect(src).toMatch(/hover:bg-bg-muted/);
    });
});

// ── First-column adoption registry ───────────────────────────────
//
// R10-PR4 reframed the R9-PR4 "first column = Code" principle. The
// underlying rule is: every list-page table should open with the
// entity's canonical, scannable identifier. For Assets that's the
// code (`AST-1`); for Evidence it's the title (evidence records have
// no separate code field). The label varies; the principle (canonical
// identifier first, not a fact pulled from the row) is invariant.
//
// Adoption tracker — flip `adopted: true` when a page's first non-
// utility column matches its declared `firstColumnId`. Same registry
// shape as `pageheader-adoption.test.ts` and the EntityDetailLayout
// family.

interface FirstColumnEntry {
    file: string;
    /** The expected TanStack id / accessorKey for column 0. */
    firstColumnId: string;
    /** Whether the file's first non-utility column matches `firstColumnId`. */
    adopted: boolean;
    /** Why this table belongs in the registry. */
    note: string;
}

const FIRST_COLUMN_TABLES: FirstColumnEntry[] = [
    // R10-PR5 — registry expansion across the remaining list-page
    // tables. Every entity converges on the same shape: column 0 is
    // the canonical scannable identifier (name, title, or code).
    {
        file: "src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx",
        firstColumnId: "code",
        adopted: true,
        note: "Assets list — per-tenant `AST-N` code minted via AssetKeySequence is the canonical identifier; Name comes second.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx",
        firstColumnId: "title",
        adopted: true,
        note: "Evidence list — title is the canonical identifier of an evidence record (e.g. 'Q3 access review PDF'). No separate code or key.",
    },
];

describe("DataTable first-column registry", () => {
    it("every registered table exists in the codebase", () => {
        for (const entry of FIRST_COLUMN_TABLES) {
            const full = path.join(ROOT, entry.file);
            expect(fs.existsSync(full)).toBe(true);
        }
    });

    it("every page marked `adopted: true` contains its declared firstColumnId", () => {
        for (const entry of FIRST_COLUMN_TABLES) {
            if (!entry.adopted) continue;
            const src = fs.readFileSync(
                path.join(ROOT, entry.file),
                "utf8",
            );
            // Match either `id: '<X>'` (TanStack explicit id) or
            // `accessorKey: '<X>'` (the row-key path, which TanStack
            // uses as the column id when no explicit id is given).
            const re = new RegExp(
                `(?:id|accessorKey):\\s*['"]${entry.firstColumnId}['"]`,
            );
            expect(src).toMatch(re);
        }
    });

    it("every entry carries a structural note", () => {
        for (const entry of FIRST_COLUMN_TABLES) {
            expect(entry.note.length).toBeGreaterThan(25);
        }
    });
});

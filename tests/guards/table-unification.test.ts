/**
 * Roadmap-9 PR-4 — DataTable unification (Controls as the canonical reference).
 *
 * User directive locked 2026-05-11: the Controls page DataTable
 * (`src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx`) is
 * the reference shape every other table unifies around. Four rules
 * follow:
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
 *      identifier (controls, risks, frameworks, policies, audits,
 *      assets), the first column should be `id: 'code'`. Migration
 *      target — coverage ratchet registers candidate tables.
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

describe("DataTable unification — Controls as the canonical shape", () => {
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

    it("Controls table — the canonical reference — sets the four locked traits", () => {
        const src = fs.readFileSync(
            path.join(
                ROOT,
                "src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx",
            ),
            "utf8",
        );
        // 1. First column is `id: 'code'`.
        expect(src).toMatch(/id:\s*['"]code['"]/);
        // 2. getRowId is set. Right-rail Phase 2 extracted the row-id
        //    fn to a stable `useCallback` (`getControlRowId`) so a
        //    selection-toggle re-render doesn't rebuild the table
        //    model — assert both the wiring and the definition.
        expect(src).toMatch(/getRowId:\s*getControlRowId/);
        expect(src).toMatch(
            /getControlRowId\s*=\s*useCallback\(\(c:[^)]*\)\s*=>\s*c\.id/,
        );
        // 3. onRowClick wires the canonical primitive hover.
        expect(src).toMatch(/onRowClick:/);
        // 4. The hover className is preserved on the table chrome.
        expect(src).toMatch(/hover:bg-bg-muted/);
    });
});

// ── First-column adoption registry ───────────────────────────────
//
// R10-PR4 reframed the R9-PR4 "first column = Code" principle. The
// underlying rule is: every list-page table should open with the
// entity's canonical, scannable identifier. For Controls that's the
// code (`AC-1`); for Risks it's the title (Risks have no separate
// code field — see prisma/schema/compliance.prisma); for Frameworks
// it's the name. The label varies; the principle (canonical
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
    {
        file: "src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx",
        firstColumnId: "code",
        adopted: true,
        note: "Controls — the canonical reference. First column is `id: 'code'` accessing `c.code || ''`.",
    },
    // R10-PR5 — registry expansion across the remaining list-page
    // tables. Every entity converges on the same shape: column 0 is
    // the canonical scannable identifier (name, title, or code).
    {
        file: "src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx",
        firstColumnId: "code",
        adopted: true,
        note: "Assets list — per-tenant `AST-N` code minted via AssetKeySequence is the canonical identifier (Risk/Controls parity); Name comes second.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx",
        firstColumnId: "title",
        adopted: true,
        note: "Evidence list — title is the canonical identifier of an evidence record (e.g. 'Q3 access review PDF'). No separate code or key.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx",
        firstColumnId: "title",
        adopted: true,
        note: "Policies list — title is the canonical identifier (e.g. 'Information Security Policy v2.1'). Versions are a separate column.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx",
        firstColumnId: "title",
        adopted: true,
        note: "Findings list — title is the canonical identifier (the finding's short name). No separate code field on findings.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx",
        firstColumnId: "name",
        adopted: true,
        note: "Vendors list — name is the canonical identifier (e.g. 'Stripe Inc'). No separate code field on vendors.",
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

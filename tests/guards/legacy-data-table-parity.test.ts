/**
 * R13-PR3 — legacy `.data-table` CSS visual parity with `<DataTable>`.
 *
 * Three raw-<table> sites still ship the `.data-table` CSS class:
 *
 *   - src/app/t/[tenantSlug]/(app)/admin/rbac/page.tsx
 *     (Permission Matrix — resource rows × role columns)
 *   - src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx
 *     (Custom role permission editor — toggle matrix)
 *     (SoA report — expandable rows; not a flat list)
 *
 * Each is genuinely a matrix or expandable surface that the
 * `<DataTable>` primitive's row-model doesn't fit. They stay on the
 * raw <table> path BUT the legacy `.data-table` CSS class must
 * mirror `<DataTable>`'s visual contract — same row height, same
 * cell border, same hover tone — so the surfaces look uniform on
 * the page.
 *
 * This ratchet locks the parity invariants. Touching either side
 * forces a re-pin in this file.
 *
 * NOTE: this is a parity ratchet, not an exhaustive style check.
 * It asserts the load-bearing triplet that gives the visual match
 * (vertical rhythm + separator tone + hover treatment).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const GLOBALS_CSS = read('src/app/globals.css');
const TABLE_TSX = read('src/components/ui/table/table.tsx');

describe('legacy .data-table CSS — visual parity with <DataTable> (R13-PR3)', () => {
    it('`.data-table td` carries the canonical row-rhythm tokens', () => {
        // Row height — must match `<DataTable>`'s
        // `py-2.5 text-sm leading-6` baseline.
        const tdBlock = GLOBALS_CSS.match(
            /\.data-table td\s*\{[^}]*\}/,
        )?.[0];
        expect(tdBlock).toBeDefined();
        expect(tdBlock).toMatch(/\bpy-2\.5\b/);
        expect(tdBlock).toMatch(/\btext-sm\b/);
        expect(tdBlock).toMatch(/\bleading-6\b/);
    });

    it('`.data-table td` uses border-b (matches DataTable cell separator)', () => {
        const tdBlock = GLOBALS_CSS.match(
            /\.data-table td\s*\{[^}]*\}/,
        )?.[0];
        expect(tdBlock).toBeDefined();
        expect(tdBlock).toMatch(/\bborder-b\b/);
        // border-t is the old separator vocabulary — DataTable
        // uses border-b so the last row gets cleared by the
        // `[&_td]:border-b-0` last-row trick.
        expect(tdBlock).not.toMatch(/@apply[^;]*\bborder-t\b/);
    });

    it('`.data-table tr:hover td` uses --bg-muted (matches DataTable row hover)', () => {
        // The shared primitive uses `group-hover/row:bg-bg-muted`.
        // The legacy CSS must hit the same token, not the prior
        // `--bg-subtle` (rgba 7% alpha which read as nearly
        // invisible on dark theme).
        const hoverBlock = GLOBALS_CSS.match(
            /\.data-table tr:hover td\s*\{[^}]*\}/,
        )?.[0];
        expect(hoverBlock).toBeDefined();
        expect(hoverBlock).toMatch(/var\(--bg-muted\)/);
        expect(hoverBlock).not.toMatch(/var\(--bg-subtle\)/);
    });

    it('`.data-table th` background matches DataTable sticky-header tone', () => {
        // DataTable uses `bg-bg-muted` on sticky headers. Legacy
        // CSS must hit the same token.
        const thBlock = GLOBALS_CSS.match(
            /\.data-table th\s*\{[^}]*\}/,
        )?.[0];
        expect(thBlock).toBeDefined();
        expect(thBlock).toMatch(/var\(--bg-muted\)/);
        expect(thBlock).not.toMatch(/var\(--bg-subtle\)/);
    });

    it('DataTable primitive still defines the parity baseline', () => {
        // Cross-check — if someone edits the DataTable primitive
        // to a NEW row-height vocabulary, this ratchet flags the
        // legacy CSS as out of sync. The asserted triplet is the
        // canonical `<DataTable>` cell rhythm (line 54-ish of
        // table.tsx).
        expect(TABLE_TSX).toMatch(/py-2\.5\b/);
        expect(TABLE_TSX).toMatch(/leading-6\b/);
        expect(TABLE_TSX).toMatch(
            /clickable\s*&&\s*"group-hover\/row:bg-bg-muted/,
        );
    });
});

/**
 * Epic 54 — Practice quick-inspect / edit Sheet migration.
 *
 * Node-env jest source-inspects the new Sheet surface:
 *
 *   1. Sheet composition — uses shared <Sheet> primitives (no bespoke
 *      overlay), sits at size="md", provides actions with left-aligned
 *      "Open full detail" and right-aligned Cancel / Save.
 *   2. Data flow — loads via the same queryKeys.practices.detail used by
 *      the full detail page, PATCHes the identical endpoint the legacy
 *      edit modal used, fires the separate owner POST only when changed.
 *   3. UX invariants — unsaved-changes guard, focus on name, canSave gate,
 *      read-only summary (status / applicability / owner / code).
 *   4. List wiring — quick-edit icon per row opens the Sheet; row click
 *      retains the legacy navigation to the full detail page (two entries,
 *      one cognitive model).
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const SHEET_SRC = read('src/app/t/[tenantSlug]/(app)/practices/PracticeDetailSheet.tsx');
const CLIENT_SRC = read('src/app/t/[tenantSlug]/(app)/practices/PracticesClient.tsx');

// ─── 1. Sheet composition ────────────────────────────────────────

describe('PracticeDetailSheet — shared Sheet composition', () => {
    it('is a client component', () => {
        expect(SHEET_SRC).toMatch(/^'use client'/);
    });

    it('uses the shared <Sheet> (no bespoke overlay)', () => {
        expect(SHEET_SRC).toMatch(/from ['"]@\/components\/ui\/sheet['"]/);
        expect(SHEET_SRC).not.toMatch(/fixed inset-0 bg-black/);
    });

    it('sits at size="md" — the documented detail-view width', () => {
        expect(SHEET_SRC).toMatch(/size=["']md["']/);
    });

    it('composes Sheet.Header + Sheet.Body + Sheet.Actions', () => {
        expect(SHEET_SRC).toMatch(/<Sheet\.Header\b/);
        expect(SHEET_SRC).toMatch(/<Sheet\.Body\b/);
        expect(SHEET_SRC).toMatch(/<Sheet\.Actions\b/);
    });

    it('Actions align="between" splits "Open full detail" from Cancel/Save', () => {
        expect(SHEET_SRC).toMatch(/align=["']between["']/);
    });

    it('provides an explicit Sheet.Close affordance for Cancel', () => {
        expect(SHEET_SRC).toMatch(/<Sheet\.Close asChild>/);
    });
});

// ─── 2. Data flow ────────────────────────────────────────────────

describe('PracticeDetailSheet — data flow', () => {
    it('loads the practice via queryKeys.practices.detail (shared cache with the full detail page)', () => {
        expect(SHEET_SRC).toMatch(/queryKeys\.practices\.detail\(tenantSlug,\s*practiceId\)/);
    });

    it('enables the query only when a practiceId is selected', () => {
        expect(SHEET_SRC).toMatch(/enabled:\s*open/);
    });

    it('PATCHes /practices/:id with the legacy field set', () => {
        expect(SHEET_SRC).toMatch(/method:\s*['"]PATCH['"]/);
        expect(SHEET_SRC).toMatch(/apiUrl\(`\/practices\/\$\{practiceId\}`\)/);
        for (const field of ['name', 'description', 'intent', 'category', 'frequency']) {
            expect(SHEET_SRC).toContain(field);
        }
    });

    it('fires the owner POST only when the owner actually changed', () => {
        expect(SHEET_SRC).toMatch(/draft\.owner\.trim\(\)\s*!==\s*originalOwner/);
        expect(SHEET_SRC).toMatch(/apiUrl\(`\/practices\/\$\{practiceId\}\/owner`\)/);
    });

    it('invalidates practices.all(tenantSlug) on success — list reflects new values', () => {
        expect(SHEET_SRC).toMatch(/invalidateQueries\(\{\s*queryKey:\s*queryKeys\.practices\.all\(tenantSlug\)/);
    });

    it('closes the Sheet on save success (setPracticeId(null))', () => {
        expect(SHEET_SRC).toMatch(/setPracticeId\(null\)/);
    });

    it('surfaces mutation errors into a data-testid-reachable alert', () => {
        expect(SHEET_SRC).toMatch(/data-testid=["']practice-sheet-save-error["']/);
        expect(SHEET_SRC).toMatch(/role=["']alert["']/);
    });
});

// ─── 3. UX invariants ────────────────────────────────────────────

describe('PracticeDetailSheet — UX invariants', () => {
    it('focuses the name input shortly after open', () => {
        expect(SHEET_SRC).toMatch(/nameInputRef\.current\?\.focus\(\)/);
    });

    it('gates save behind canWrite + dirty + name length ≥ 3 + not pending', () => {
        expect(SHEET_SRC).toMatch(/canWrite\s*&&\s*dirty\s*&&\s*form\.name\.trim\(\)\.length\s*>=\s*3\s*&&\s*!mutation\.isPending/);
    });

    it('fieldset disables edits when the user lacks write permission', () => {
        expect(SHEET_SRC).toMatch(/<fieldset[\s\S]*?disabled=\{!canWrite\s*\|\|\s*mutation\.isPending\}/);
    });

    it('unsaved-changes guard prompts before close', () => {
        expect(SHEET_SRC).toMatch(/window\.confirm\(['"]Discard unsaved changes\?['"]\)/);
    });

    it('renders a read-only summary card (status / applicability / owner / code)', () => {
        expect(SHEET_SRC).toMatch(/data-testid=["']practice-sheet-summary["']/);
        expect(SHEET_SRC).toMatch(/Applicability/);
        expect(SHEET_SRC).toMatch(/Owner/);
    });

    it('"Open full detail" link routes to the canonical practice page', () => {
        expect(SHEET_SRC).toMatch(/href=\{tenantHref\(`\/practices\/\$\{practice\.id\}`\)\}/);
        expect(SHEET_SRC).toMatch(/data-testid=["']practice-sheet-open-full["']/);
    });

    it('uses semantic tokens only — no raw Dub palette', () => {
        for (const pattern of [
            /\bbg-white\b/,
            /\btext-black\b/,
            /\bbg-neutral-\d/,
            /\btext-neutral-\d/,
        ]) {
            expect(SHEET_SRC).not.toMatch(pattern);
        }
    });
});

// ─── 4. PracticesClient wiring ────────────────────────────────────

describe('PracticesClient — Sheet entry points', () => {
    it('imports PracticeDetailSheet', () => {
        // Accept both static and dynamic imports (lazy-loading via next/dynamic)
        const hasImport = /from ['"]\.\/PracticeDetailSheet['"]/.test(CLIENT_SRC) ||
            /import\(['"]\.\/PracticeDetailSheet['"]\)/.test(CLIENT_SRC);
        expect(hasImport).toBe(true);
    });

    it('owns sheetPracticeId state (null = closed)', () => {
        expect(CLIENT_SRC).toMatch(/sheetPracticeId/);
        expect(CLIENT_SRC).toMatch(/setSheetPracticeId/);
    });

    it('mounts <PracticeDetailSheet> with tenant-scoped helpers + canWrite', () => {
        expect(CLIENT_SRC).toMatch(/<PracticeDetailSheet\b/);
        expect(CLIENT_SRC).toMatch(/practiceId=\{sheetPracticeId\}/);
        expect(CLIENT_SRC).toMatch(/setPracticeId=\{setSheetPracticeId\}/);
        expect(CLIENT_SRC).toMatch(/canWrite=\{appPermissions\.practices\.edit\}/);
    });

    it('adds a quick-edit icon column that opens the Sheet', () => {
        expect(CLIENT_SRC).toMatch(/id:\s*['"]quick-edit['"]/);
        expect(CLIENT_SRC).toMatch(/practice-quick-edit-\$\{row\.original\.id\}/);
        expect(CLIENT_SRC).toMatch(/setSheetPracticeId\(row\.original\.id\)/);
    });

    it('row-click navigation to the full detail page is preserved', () => {
        // Regression guard — the Sheet is an *additional* entry point; the
        // list row still navigates for users who want the tabbed detail.
        // Right-rail Phase 2 extracted the handler to a stable
        // `useCallback` (`handleRowClick`) so a selection-toggle
        // re-render doesn't rebuild the table model — assert both the
        // wiring (`onRowClick: handleRowClick`) and the navigation
        // logic inside the callback.
        expect(CLIENT_SRC).toMatch(/onRowClick:\s*handleRowClick/);
        expect(CLIENT_SRC).toMatch(
            /handleRowClick\s*=\s*useCallback\([\s\S]*?router\.push\(tenantHref\(`\/practices\/\$\{row\.original\.id\}`\)\)/,
        );
    });
});

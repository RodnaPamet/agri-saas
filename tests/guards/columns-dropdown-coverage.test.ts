/**
 * Roadmap-10 PR-8 — column-visibility gear coverage ratchet.
 *
 * The gear is the user's lever for tailoring a dense list to the
 * columns they actually care about. After R10-PR6 introduced
 * `useColumnsDropdown` and R10-PR7 mounted it on the four pages
 * that lacked it, every entity list page in the product carries
 * the gear. This ratchet locks the coverage so a new entity list
 * page can't ship without one (or without an explicit exemption).
 *
 * Same EXEMPTIONS shape as the sibling ratchets
 * (`filter-toolbar-coverage`, `list-page-shell-coverage`,
 * `no-raw-tables-in-app-pages`). Three legitimate exemption shapes:
 *
 *   (a) Sub-component embedded inside a parent page — the parent
 *       owns the toolbar surface; the sub-component is the table
 *       only (e.g. `MembersTable.tsx` inside `admin/rbac/page.tsx`).
 *   (b) Multi-table dashboard — multiple stacked DataTables; a
 *       per-table gear would be more chrome than the data deserves
 *       (e.g. `admin/members`, `admin/api-keys`).
 *   (c) Findings / pages still without a toolbar — designing the
 *       toolbar is its own change; the gear lands when the toolbar
 *       does.
 *
 * The direction of travel: this list shrinks. New entity list pages
 * should reach for `useColumnsDropdown` from `@/components/ui/table`
 * and mount its `dropdown` into the toolbar's `actions` slot.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/app/t/[tenantSlug]/(app)';

/**
 * Files mounting `<DataTable>` without `<ColumnsDropdown>` /
 * `useColumnsDropdown`. Each entry carries a category prefix and a
 * one-line reason. PRs that add a new entry must justify the
 * absence of a gear; PRs that mount a gear should REMOVE the entry.
 */
const EXEMPTIONS: Record<string, string> = {
    // Certification scheme detail (schemes roadmap PR2).

    // Grain bin detail (bins roadmap PR2).
    "grain/bins/[binId]/BinDetailClient.tsx":
        "(a) detail-page sub-table — the lots INSIDE one bin, not a list page. The set is one bin's contents (bounded, already sorted soonest-expiry first), so faceted filtering, a column gear and viewport-clamping all add chrome without adding reach.",

    // Platform-support console (#12) — bounded global-catalogue rosters.
    "admin/promotions/PromotionsAdminClient.tsx":
        "(b) lean curation roster — five fixed columns (offer/status/window/enquiries/actions); every one is load-bearing for support, so there is nothing to hide behind a gear.",
    "admin/companies/CompaniesAdminClient.tsx":
        "(b) lean supplier roster — four fixed columns (company/contact/offers/actions); nothing optional to toggle.",
    // Journal Trash — bounded ADMIN soft-deleted sub-view.
    "journal/DeletedJournalView.tsx":
        "(c) lean Trash roster — five fixed columns (entry/type/occurred/deleted/actions); the parent journal list owns the column-visibility gear.",
    // Assets Trash (B2) — bounded ADMIN soft-deleted sub-view.
    "assets/DeletedAssetsView.tsx":
        "(c) lean Trash roster — five fixed columns (name/type/keeper/deleted/actions); the parent assets list owns the column-visibility gear.",
    // Agriculture (Feature 1) — lean locations roster, three fixed columns.
    "locations/LocationsClient.tsx":
        "(c) lean agriculture roster — three fixed columns (name/status/parcels); column-visibility gear deferred to the Phase 2 inventory module.",
    // Agriculture (Phase 1) — lean inventory lots roster, four fixed columns.
    "inventory/InventoryClient.tsx":
        "(c) lean inventory roster — four fixed columns (lot/product/on-hand/expiry); column-visibility gear deferred until the lots table grows wider.",
    // Enterprise-grain (GRAIN) — read-only cost rollup report.
    "grain/costs/CostsClient.tsx":
        "(b) read-only cost rollup report — dimension toggle (planting/field/season) plus sortable columns and a name search; the column SET is fixed per dimension, so a visibility gear has nothing to hide. The \"+ sort\" this rationale claimed was not real until 2026-07-27: sortableColumns was never passed to DataTable. It is now.",
    // ─── (a) Sub-components — parent owns the toolbar ──────────────
    // R13-PR10 — `admin/AdminClient.tsx` was deleted; audit log
    // moved to `admin/audit-log/AuditLogClient.tsx`. The new sub-
    // component is still a chronological log (no per-column
    // hide/show needed), so the exemption follows the move.
    'admin/audit-log/AuditLogClient.tsx':
        '(a) sub-component — chronological audit log; parent page owns chrome.',
    'admin/billing/BillingEventLog.tsx':
        '(a) sub-component — billing-page event log; parent decides chrome.',
    'admin/ledger-integrity/LedgerIntegrityClient.tsx':
        '(a) sub-component — reconciliation-history table on a status+history admin page; parent owns chrome.',
    'admin/rbac/MembersTable.tsx':
        '(a) sub-component — RBAC members sub-table; parent dashboard owns chrome.',
    'access-reviews/[reviewId]/AccessReviewDetailClient.tsx':
        '(a) sub-component — detail-page roster sub-table; EntityDetailLayout owns chrome.',
    'vendors/[vendorId]/page.tsx':
        '(a) sub-component — vendor-detail documents sub-table (R11-PR7); EntityDetailLayout owns chrome.',
    'locations/[locationId]/page.tsx':
        '(a) sub-component — location-detail parcels sub-table (a11y pass, off raw table); EntityDetailLayout owns chrome.',
    'controls/[controlId]/page.tsx':
        '(a) sub-component — control-detail tasks sub-table (R11-PR6); EntityDetailLayout owns chrome.',
    'controls/[controlId]/_tabs/EvidenceSubTable.tsx':
        '(a) sub-component — control-detail evidence sub-table (R10-PR3 follow-up); EntityDetailLayout owns chrome.',
    'controls/[controlId]/_tabs/ControlMappingsTab.tsx':
        '(a) sub-component — control-detail mappings sub-table (R10-PR3 follow-up); EntityDetailLayout owns chrome.',
    'farm-tasks/[taskId]/FarmTaskDetailClient.tsx':
        '(a) sub-component — farm-task-detail links sub-table; EntityDetailLayout owns chrome.',
    'planning/[cropPlanId]/PlantingBoard.tsx':
        '(a) sub-component — crop-plan succession board (Gantt + plan-vs-actual table); EntityDetailLayout owns chrome, fixed columns.',

    // ─── (b) Multi-table / multi-section pages ─────────────────────
    'admin/api-keys/page.tsx':
        '(b) multi-table page — active + revoked stacked tables; a per-table gear would noise the chrome.',
    'admin/members/page.tsx':
        '(b) multi-table page — members + pending invites stacked; per-table gear unnecessary at this scale.',
    'admin/notifications/page.tsx':
        '(b) tabbed admin settings page — small fixed table + a form tab; column visibility isn\'t the user need.',
    'admin/integrations/page.tsx':
        '(b) multi-section admin page — small fixed catalogue with inline controls.',
    'admin/roles/page.tsx':
        '(b) custom roles admin — small fixed list with inline create + permission controls.',
    'access-reviews/AccessReviewsClient.tsx':
        '(b) multi-section dashboard — review cycle list inside a tabbed composition.',

    // ─── (c) Toolbar pending ────────────────────────────────────────
    // (none today — Findings got the gear in R10-PR11 mounted
    // standalone above the table, like Frameworks.)
};

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, results);
        } else if (entry.name.endsWith('.tsx')) {
            results.push(full);
        }
    }
    return results;
}

// Match the two gear-mount idioms: the new useColumnsDropdown hook
// AND the legacy direct ColumnsDropdown component mount (some
// callers wire the dropdown manually for one-off layouts).
const GEAR_USE_RE = /\buseColumnsDropdown\b/;
const GEAR_COMPONENT_RE = /<ColumnsDropdown\b/;

describe('columns-dropdown gear coverage (R10-PR8)', () => {
    const APP_ROOT = path.resolve(ROOT, SCAN_DIR);

    test('every file mounting <DataTable> mounts the gear or is in EXEMPTIONS', () => {
        const violators: string[] = [];
        for (const file of walk(APP_ROOT)) {
            const content = fs.readFileSync(file, 'utf-8');
            if (!/<DataTable\b/.test(content)) continue;
            if (GEAR_USE_RE.test(content)) continue;
            if (GEAR_COMPONENT_RE.test(content)) continue;
            const rel = path
                .relative(APP_ROOT, file)
                .split(path.sep)
                .join('/');
            if (EXEMPTIONS[rel]) continue;
            violators.push(rel);
        }
        if (violators.length > 0) {
            throw new Error(
                `${violators.length} app page(s) mount <DataTable> without a column-visibility gear:\n  ` +
                    violators.join('\n  ') +
                    '\n\nFix options:\n' +
                    '  • Import `useColumnsDropdown` from `@/components/ui/table`, declare a\n' +
                    '    column list, and mount the returned `dropdown` into your FilterToolbar\n' +
                    '    `actions` slot (see R10-PR7 for the canonical pattern).\n' +
                    '  • OR add the file path to EXEMPTIONS in this test with a category\n' +
                    '    prefix ((a) sub-component, (b) multi-table, (c) toolbar pending)\n' +
                    '    and a one-line reason.\n',
            );
        }
    });

    test('no exempt entry has a stale path (file moved / deleted / migrated)', () => {
        const stale: string[] = [];
        for (const exemptPath of Object.keys(EXEMPTIONS)) {
            const abs = path.join(APP_ROOT, exemptPath);
            if (!fs.existsSync(abs)) {
                stale.push(`${exemptPath} (file missing)`);
                continue;
            }
            const content = fs.readFileSync(abs, 'utf-8');
            if (
                /<DataTable\b/.test(content) &&
                (GEAR_USE_RE.test(content) || GEAR_COMPONENT_RE.test(content))
            ) {
                stale.push(
                    `${exemptPath} (gear has been mounted — remove from EXEMPTIONS)`,
                );
            }
        }
        if (stale.length > 0) {
            throw new Error(
                `EXEMPTIONS contains ${stale.length} stale entry/entries:\n  ` +
                    stale.join('\n  ') +
                    '\n\nRemove these entries from the EXEMPTIONS object.',
            );
        }
    });

    test('EXEMPTIONS entries are uniquely-prefixed by category', () => {
        for (const [file, reason] of Object.entries(EXEMPTIONS)) {
            expect(reason).toMatch(/^\((a|b|c)\)\s+\S/);
            expect(file).not.toMatch(/^\//);
        }
    });
});

// R-filter-gear (2026-06-07) — the two toolbar gears (Edit filter cards +
// Toggle columns) are differentiated by icon (Settings vs Columns3) but
// share ONE primitive: <ChecklistGearButton>. This locks that delegation
// so a future PR can't fork the checklist UI back into two copies.
describe('R-filter-gear — both gears mount the shared ChecklistGearButton', () => {
    const read = (rel: string) =>
        fs.readFileSync(path.join(ROOT, rel), 'utf8');

    it('columns gear delegates to ChecklistGearButton (Columns3, toggle-columns-button)', () => {
        const src = read('src/components/ui/table/columns-dropdown.tsx');
        expect(src).toMatch(/ChecklistGearButton/);
        expect(src).toMatch(/\bColumns3\b/);
        expect(src).toMatch(/data-testid="toggle-columns-button"/);
        // Title routes through next-intl (i18n Bulgarian sweep).
        expect(src).toMatch(/title=\{t\(['"]toggleColumns['"]\)\}/);
    });

    it('filter gear delegates to ChecklistGearButton (Settings, edit-filters-button)', () => {
        const src = read('src/components/ui/filter/edit-filters-button.tsx');
        expect(src).toMatch(/ChecklistGearButton/);
        expect(src).toMatch(/\bSettings\b/);
        expect(src).toMatch(/data-testid="edit-filters-button"/);
        // Title routes through next-intl (i18n Bulgarian sweep).
        expect(src).toMatch(/title=\{t\(['"]editFilterCards['"]\)\}/);
    });
});

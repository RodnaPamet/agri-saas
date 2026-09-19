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
    // Asset maintenance tab (assets roadmap PR2).
    "assets/[id]/MaintenanceTab.tsx":
        "(a) detail-page sub-table — one machine's service history, not a list page. The set is bounded by MAINTENANCE_PAGE_SIZE and already ordered newest-first, which is how a service log is read; the open records a farmer is actually looking for sit at the top by construction. Faceted filtering, a column gear and viewport-clamping all add chrome without adding reach.",

    // Certification scheme detail (schemes roadmap PR2).

    // Grain calculator (GRAIN_NET_WORTH report).

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
    // GRC teardown phase 2 removed the vendor-detail and practice-detail
    // sub-table exemptions — those files no longer exist.
    'locations/[locationId]/page.tsx':
        '(a) sub-component — location-detail parcels sub-table (a11y pass, off raw table); EntityDetailLayout owns chrome.',
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
        '(b) multi-section admin page — small fixed catalogue with inline practices.',
    'admin/roles/page.tsx':
        '(b) custom roles admin — small fixed list with inline create + permission practices.',
    'access-reviews/AccessReviewsClient.tsx':
        '(b) multi-section dashboard — review cycle list inside a tabbed composition.',

    // ─── (c) Toolbar pending ────────────────────────────────────────
    // (none today — Findings got the gear in R10-PR11 mounted
    // standalone above the table, like Frameworks.)
};

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
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

    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `walk` and NOT ONE test failed. Its only
    // call site is the `for (const file of walk(APP_ROOT))` loop in the
    // test below, so every EMPTY-ITERABLE gut — `[]`, `''`, `new Set()`,
    // `new Map()` — makes that loop run zero times: `violators` stays
    // empty, the `violators.length > 0` throw never fires, green. "174
    // pages scanned, every <DataTable> has a gear or an exemption" and
    // "no file was ever opened" were the same result. (The non-iterable
    // guts — `0` / `null` / `undefined` / `false` / `{}` — throw at the
    // for-of, so the hole is precisely the direction the tool reaches.)
    //
    // The `fs.existsSync` throw INSIDE `walk` (#875) does not cover it:
    // gutting replaces the whole function, so that floor never runs — a
    // check one layer down cannot protect a caller that stops calling
    // it. Nor do this file's other two tests: both iterate `EXEMPTIONS`
    // directly and never touch `walk`.

    it('control: walk returns the real .tsx tree under the scan root', () => {
        const files = walk(APP_ROOT);
        // Kills `''` / `new Set()` / `new Map()` at the seam, instead of
        // letting them read as a zero-length scan.
        expect(Array.isArray(files)).toBe(true);
        // Measured 2026-09-19: 174 `.tsx` files under
        // `src/app/t/[tenantSlug]/(app)`. The floor sits far below that,
        // so ordinary feature PRs never move it.
        expect(files.length).toBeGreaterThan(100);

        const rels = files.map((f) =>
            path.relative(APP_ROOT, f).split(path.sep).join('/'),
        );
        expect(rels.filter((r) => r.startsWith('..'))).toEqual([]);

        // The extension filter is the ONLY exclusion `walk` has, and it
        // must actually bite. Derived rather than named: `.ts` siblings
        // live one level inside the root (8 at that depth, measured —
        // `*/filter-defs.ts`, `calendar/range.ts`, …).
        const tsSiblings = fs
            .readdirSync(APP_ROOT, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .flatMap((d) =>
                fs
                    .readdirSync(path.join(APP_ROOT, d.name), {
                        withFileTypes: true,
                    })
                    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
                    .map((e) => `${d.name}/${e.name}`),
            );
        expect(tsSiblings.length).toBeGreaterThan(3);
        expect(rels.filter((r) => tsSiblings.includes(r))).toEqual([]);
        expect(rels.filter((r) => !r.endsWith('.tsx'))).toEqual([]);

        // RECURSION is the part the gut set cannot express, and real
        // product source proves it: the deepest pages sit four segments
        // down (`grain/bins/[binId]/BinDetailClient.tsx`, measured).
        expect(
            Math.max(...rels.map((r) => r.split('/').length)),
        ).toBeGreaterThanOrEqual(3);
    });

    it('control: walk reaches the pages this ratchet reasons about', () => {
        const rels = walk(APP_ROOT).map((f) =>
            path.relative(APP_ROOT, f).split(path.sep).join('/'),
        );
        const found = new Set(rels);

        // POSITIVE CONTROL against real product source. Every EXEMPTIONS
        // key is a live page that mounts `<DataTable>` with NO gear —
        // the exact shape this ratchet exists to catch, carved out by
        // name rather than absent. If `walk` cannot reach them, "zero
        // violators" only means "zero files opened". Derived from
        // EXEMPTIONS, so it cannot go stale as that list shrinks (the
        // direction of travel the docblock states).
        expect(
            Object.keys(EXEMPTIONS).filter((rel) => !found.has(rel)),
        ).toEqual([]);

        // The other half of the ledger. Measured 2026-09-19: 25 files
        // under the root mount `<DataTable>` — 22 exempt, 3 geared
        // (assets / evidence / rent clients). A population holding the
        // exemptions and nothing else would leave this ratchet looking
        // only at its own carve-out list.
        let mounts = 0;
        let geared = 0;
        for (const rel of rels) {
            const src = fs.readFileSync(path.join(APP_ROOT, rel), 'utf-8');
            if (!/<DataTable\b/.test(src)) continue;
            mounts += 1;
            if (GEAR_USE_RE.test(src) || GEAR_COMPONENT_RE.test(src)) {
                geared += 1;
            }
        }
        expect(mounts).toBeGreaterThan(10);
        expect(geared).toBeGreaterThan(0);
    });

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

/**
 * List-page-shell coverage ratchet.
 *
 * Phase 3 of the list-page-shell work. Every page under
 * `src/app/t/[tenantSlug]/(app)/**` that imports `DataTable` falls
 * into one of three buckets:
 *
 *   1. **Migrated** — wraps the page in `<ListPageShell>` so the
 *      table card is viewport-clamped and only the table body
 *      scrolls. This is the canonical pattern for list pages.
 *
 *   2. **Exempt** — explicitly listed in `EXEMPTIONS` below with a
 *      one-line written reason. Use this for pages that legitimately
 *      need natural document scroll (multi-table dashboards, detail
 *      pages with inline sub-tables, wizards, etc.).
 *
 *   3. **Neither** — fails this test. Either wrap in
 *      `<ListPageShell>` (the default for any new list page), or
 *      add to `EXEMPTIONS` with a concrete reason.
 *
 * The ratchet matters because the new layout is opt-in: a future
 * contributor who copy-pastes an existing list page can quietly
 * skip the wrapper and the regression (whole-page scroll, header
 * scrolling out of view) returns silently. CI catches it.
 *
 * To MIGRATE a previously-exempt page: remove the entry from
 * EXEMPTIONS, wrap the page in `<ListPageShell>`, and add `fillBody`
 * to the page's primary `<DataTable>`.
 *
 * To EXEMPT a new file: add an entry to EXEMPTIONS with a short
 * comment explaining why the page genuinely doesn't fit the
 * single-primary-table shape (multi-card dashboard, detail-page
 * sub-table, wizard, etc.).
 */

import * as fs from 'fs';
import * as path from 'path';

const APP_ROOT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)',
);

/**
 * Files that import `DataTable` but are intentionally NOT wrapped in
 * `<ListPageShell>`. Each entry is a path relative to APP_ROOT and
 * carries a one-line reason. Audit the list when adding entries —
 * the cost of the layout primitive is tiny; the benefit of
 * consistency is large.
 */
const EXEMPTIONS: Record<string, string> = {
    // Certification scheme detail (schemes roadmap PR2).

    // Grain bin detail (bins roadmap PR2).
    "grain/bins/[binId]/BinDetailClient.tsx":
        "detail-page sub-table — the lots INSIDE one bin, not a list page. The set is one bin's contents (bounded, already sorted soonest-expiry first), so faceted filtering, a column gear and viewport-clamping all add chrome without adding reach.",

    // Multi-section dashboard with KPI strip + summary bar + two
    // side-by-side gap tables. Viewport-clamping would compress the
    // whole grid awkwardly. Natural scroll is the right shape.

    // Two stacked tables (active / revoked). A single fillBody
    // would force one of them to overflow internally while the
    // other stays static — confusing UX.
    'admin/api-keys/page.tsx':
        'multi-table page (active + revoked stacked)',

    // Same shape as api-keys: members + pending-invites tables
    // stacked. Viewport-clamping a stacked-table layout would
    // force the bottom table to scroll while the top stays
    // static — unhelpful UX.
    'admin/members/page.tsx':
        'multi-table page (members + pending invites stacked)',

    // Tabbed admin settings page. The "stats" tab shows a fixed
    // 3-row table that doesn't need internal scroll; the "settings"
    // tab is a form. Neither benefits from viewport-clamping.
    'admin/notifications/page.tsx':
        'tabbed admin settings (form + 3-row stats table)',

    // Header + message banner + webhook URL info card +
    // connections list card. The connections list is one section
    // among several; viewport-clamping would consume space the
    // banner / info-card content needs.
    'admin/integrations/page.tsx':
        'multi-section admin page',

    // Sub-component embedded inside the billing page. Parent
    // decides layout; this file just renders a table given data.
    'admin/billing/BillingEventLog.tsx':
        'sub-component (parent owns layout)',

    // Multi-section admin page: a hero integrity-status card + run
    // button on top, a reconciliation-history table below. Parent
    // owns layout; viewport-clamping the table alone would crowd the
    // hero card.
    'admin/ledger-integrity/LedgerIntegrityClient.tsx':
        'multi-section admin page (status hero + history table)',

    // R10-PR1 — sub-component embedded inside the RBAC page (which is
    // a multi-section dashboard: members + permission matrix). Parent
    // owns layout.
    'admin/rbac/MembersTable.tsx':
        'sub-component (parent owns layout — members + matrix dashboard)',

    // R10-PR2 — detail page (EntityDetailLayout). The DataTable is
    // the roster sub-table inside the detail body; the page itself
    // is not a list page.
    'access-reviews/[reviewId]/AccessReviewDetailClient.tsx':
        'detail page — DataTable is the inner roster sub-table',

    // R11-PR7 — vendor detail page now mounts DataTable for the
    // documents sub-table. Detail page (EntityDetailLayout).
    'vendors/[vendorId]/page.tsx':
        'detail page — DataTable is the inner documents sub-table (R11-PR7)',

    // R11-PR6 — control detail page now mounts DataTable for the
    // tasks sub-table. Detail page (EntityDetailLayout), not a list
    // page.
    'controls/[controlId]/page.tsx':
        'detail page — DataTable is the inner tasks sub-table (R11-PR6)',

    // R10-PR3 follow-up — control detail page evidence + mappings
    // sub-tables migrated off raw <table> to DataTable. Detail-page
    // sub-tables; the page itself is not a list page.
    'controls/[controlId]/_tabs/EvidenceSubTable.tsx':
        'detail page sub-table — evidence rows for one control (R10-PR3 follow-up)',
    'controls/[controlId]/_tabs/ControlMappingsTab.tsx':
        'detail page sub-table — framework mappings for one control (R10-PR3 follow-up)',

    // Farm task detail — the single task-detail page; DataTable is the inner
    // links/traceability sub-table. Detail page (EntityDetailLayout).
    'farm-tasks/[taskId]/FarmTaskDetailClient.tsx':
        'detail page — DataTable is the inner links sub-table',
    // Crop-plan detail page mounts DataTable for the succession board
    // (plan-vs-actual rows beside the Gantt). Detail page sub-table.
    'planning/[cropPlanId]/PlantingBoard.tsx':
        'detail page sub-table — plantings of one crop plan (succession board)',

    // A11y pass — location detail page mounts DataTable for the parcels
    // sub-table (migrated off a raw <table>). Detail page
    // (EntityDetailLayout), not a list page.
    'locations/[locationId]/page.tsx':
        'detail page — DataTable is the inner parcels sub-table',

    // Browse-and-install template picker — multi-section browser,
    // not a list page in the perf-complaint sense.

    // Risk import wizard. Result table appears mid-flow inside a
    // wizard step; not a primary list-page experience.

    // Epic 66 — frameworks client island that owns the table/cards
    // view toggle. Cards mode is a responsive grid (no clamping
    // needed); table mode delegates fillBody to the inner
    // <DataTable>. Wrapping the toggle outer in <ListPageShell>
    // would compress the toggle chrome unnaturally in cards view.
};

// Accept either the raw `ListPageShell` primitive or the `EntityListPage`
// composition (which wraps `ListPageShell` internally — see
// `src/components/layout/EntityListPage.tsx`). Both satisfy the
// viewport-clamped scroll contract this ratchet exists to enforce.
const SHELL_IMPORT_RE =
    /['"]@\/components\/layout\/(ListPageShell|EntityListPage)['"]/;
const DATATABLE_IMPORT_RE = /from\s+['"]@\/components\/ui\/table[^'"]*['"]/;

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

interface Finding {
    relPath: string;
    importsDataTable: boolean;
    importsListPageShell: boolean;
    referencesDataTable: boolean;
}

function audit(): Finding[] {
    return walk(APP_ROOT).map((file) => {
        const content = fs.readFileSync(file, 'utf-8');
        return {
            relPath: path
                .relative(APP_ROOT, file)
                .split(path.sep)
                .join('/'),
            importsDataTable: DATATABLE_IMPORT_RE.test(content),
            importsListPageShell: SHELL_IMPORT_RE.test(content),
            referencesDataTable: /\bDataTable\b/.test(content),
        };
    });
}

describe('list-page-shell coverage ratchet', () => {
    const findings = audit();

    test('every DataTable consumer is wrapped, exempt, or only re-exports', () => {
        const violators: string[] = [];
        for (const f of findings) {
            if (!f.importsDataTable) continue;
            if (!f.referencesDataTable) continue;
            if (f.importsListPageShell) continue;
            if (EXEMPTIONS[f.relPath]) continue;
            violators.push(f.relPath);
        }
        if (violators.length > 0) {
            throw new Error(
                `${violators.length} app page(s) import DataTable without wrapping in ListPageShell:\n  ` +
                    violators.join('\n  ') +
                    '\n\nFix options:\n' +
                    '  • Wrap the page in <ListPageShell> (see Risks/Controls/Tasks for the canonical pattern)\n' +
                    '    and add `fillBody` to the primary DataTable.\n' +
                    '  • OR add the file path to EXEMPTIONS in this test with a one-line reason.\n',
            );
        }
    });

    test('no exempt entry has a stale path (file moved/deleted)', () => {
        const stale: string[] = [];
        for (const exemptPath of Object.keys(EXEMPTIONS)) {
            const abs = path.join(APP_ROOT, exemptPath);
            if (!fs.existsSync(abs)) {
                stale.push(exemptPath);
            }
        }
        if (stale.length > 0) {
            throw new Error(
                `EXEMPTIONS contains ${stale.length} stale path(s) — file no longer exists:\n  ` +
                    stale.join('\n  ') +
                    '\n\nRemove these entries; the underlying file was moved or deleted.',
            );
        }
    });

    test('coverage floor is met (defence against the audit collapsing to zero)', () => {
        const migrated = findings.filter(
            (f) => f.importsDataTable && f.importsListPageShell,
        );
        // Snapshot after Epic 48 admin/roles migration — 13 list
        // pages migrated (the regex now also recognises
        // `EntityListPage`, the unified shell that wraps
        // `ListPageShell` internally). The floor stops a future PR
        // from quietly removing the shell from one of them without
        // bumping this number in the same diff (which forces a code
        // review conversation).
        expect(migrated.length).toBeGreaterThanOrEqual(13);
    });
});

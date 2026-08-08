/**
 * Roadmap-7 PR-4 — FilterToolbar coverage ratchet.
 *
 * Heavy entity-level list pages — Risks, Vendors, Audits, Frameworks
 * (templates), Tasks, Evidence, Controls — wear `<FilterToolbar>` so
 * search, faceted filters, view-toggle, and primary action sit in
 * the same order, with the same spacing, on every page. New pages
 * mounting `<DataTable>` should reach for `<FilterToolbar>` before
 * inventing their own toolbar chrome.
 *
 * The ratchet enforces that any file mounting `<DataTable>` either
 * also mounts `<FilterToolbar>` OR appears in EXEMPTIONS with a
 * written reason describing why the page legitimately doesn't need
 * faceted filters. Today's exemption list captures the empirical
 * pattern after surveying production: cross-tenant read-only
 * aggregation tables, admin sub-pages with one fixed entity-type
 * and inline controls, wizards, dashboard composites, and detail-
 * tab sub-tables.
 *
 * The direction of travel: this list shrinks as pages organically
 * gain faceted filtering. New pages added to the codebase should
 * either mount FilterToolbar or land in this list with reasoning —
 * never bypass silently.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIR = "src/app";

const EXEMPT_DIR_NAMES = new Set<string>([
    "node_modules",
    "__tests__",
    "__mocks__",
]);
const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

/**
 * Files mounting `<DataTable>` without `<FilterToolbar>`. Each entry
 * documents the structural reason the page doesn't need (or doesn't
 * yet have) faceted filters. PRs that ADD a new entry must carry a
 * non-trivial reason in this map; the ratchet validates the reason
 * length to stop hand-waved exemptions.
 */
const EXEMPTIONS: Record<string, string> = {
    // Certification scheme detail (schemes roadmap PR2).

    // Grain bin detail (bins roadmap PR2).
    "src/app/t/[tenantSlug]/(app)/grain/bins/[binId]/BinDetailClient.tsx":
        "detail-page sub-table — the lots INSIDE one bin, not a list page. The set is one bin's contents (bounded, already sorted soonest-expiry first), so faceted filtering, a column gear and viewport-clamping all add chrome without adding reach.",

    // Platform-support console (#12) — admin sub-pages over a GLOBAL catalogue
    // that only platform staff can reach. Both are bounded curation rosters
    // (hundreds of rows at most, not a tenant's operational data), and support
    // works from the derived status column rather than faceted filters.
    "src/app/t/[tenantSlug]/(app)/admin/promotions/PromotionsAdminClient.tsx":
        "Admin sub-page, one fixed entity type + inline publish/edit controls — bounded global catalogue, no faceted filtering.",
    "src/app/t/[tenantSlug]/(app)/admin/companies/CompaniesAdminClient.tsx":
        "Admin sub-page, one fixed entity type + inline edit control — bounded supplier roster, no faceted filtering.",
    // Journal Trash — a bounded ADMIN-only soft-deleted list reached in-page
    // from the journal toggle. Restore/purge affordances only; the parent
    // journal list owns the faceted filters.
    "src/app/t/[tenantSlug]/(app)/journal/DeletedJournalView.tsx":
        "Bounded ADMIN Trash sub-view — restore/purge only, filters live on the parent journal list.",
    // Assets Trash (B2) — a bounded ADMIN-only soft-deleted list reached
    // in-page from the assets toggle. Restore/purge affordances only; no
    // faceted filtering (the parent list owns filters).
    "src/app/t/[tenantSlug]/(app)/assets/DeletedAssetsView.tsx":
        "Bounded ADMIN Trash sub-view — restore/purge only, filters live on the parent assets list.",
    // Agriculture (Feature 1) — lean locations roster.
    "src/app/t/[tenantSlug]/(app)/locations/LocationsClient.tsx":
        "Lean agriculture roster — name/status/parcel-count with no faceted filters yet; search/filter arrives with the Phase 2 inventory module.",
    // Land administration (roadmap 3/3) — lean lease register.
    "src/app/t/[tenantSlug]/(app)/rent/RentClient.tsx":
        "Lean lease register (lessor/parcel/type/rent/term/status) fronted by the rent-roll summary; no faceted filters yet — search/filter arrives if the register grows.",
    // Agriculture (Phase 1) — lean inventory lots roster.
    "src/app/t/[tenantSlug]/(app)/inventory/InventoryClient.tsx":
        "Lean inventory lots roster — lot/product/on-hand/expiry; faceted filtering (by item/low-stock) arrives once the catalog grows past a single screen.",
    // Enterprise-grain (GRAIN) — read-only cost rollup report.
    "src/app/t/[tenantSlug]/(app)/grain/costs/CostsClient.tsx":
        "Read-only cost rollup report — dimension toggle (planting/field/season), sortable columns and a name search, but no FACETED filters: the rollup has dimensions, not facets. The claim of \"+ sort\" in this rationale was false until 2026-07-27 — sortableColumns was never passed to DataTable, so it defaulted to [] and nothing sorted. Sorting and search now exist; if a facet ever does, this exemption must go rather than be reworded again.",
    // ── Cross-tenant read-only aggregation views (org-level) ──
    // These render a portfolio of tenant-scoped data without the
    // per-tenant filtering surface that FilterToolbar provides.
    // Sort + cursor pagination is the entire interaction surface.
    "src/app/org/[orgSlug]/(app)/audit/AuditLogTable.tsx":
        "Org-level cross-tenant audit log — chronological view with sort + load-more, no faceted filters appropriate at the portfolio aggregation tier.",
    "src/app/org/[orgSlug]/(app)/controls/ControlsTable.tsx":
        "Org-level non-performing controls digest — fixed scope (status != IMPLEMENTED) + sort, no per-tenant facets.",
    "src/app/org/[orgSlug]/(app)/evidence/EvidenceTable.tsx":
        "Org-level overdue-evidence digest — fixed scope (review past due) + sort, no per-tenant facets.",
    "src/app/org/[orgSlug]/(app)/members/MembersTable.tsx":
        "Org-level membership list — small aggregate with sort, faceted filtering not yet a need at this scale.",
    "src/app/org/[orgSlug]/(app)/tenants/TenantsTable.tsx":
        "Org-level tenant health roll-up — fixed scope, no faceted filtering at portfolio tier.",
    "src/app/org/[orgSlug]/(app)/grain/PortfolioGrainClient.tsx":
        "Org-level grain portfolio roll-up — per-farm contracted/yield/cost/bin aggregation with sort only; faceted filtering is not meaningful over a cross-tenant aggregate.",

    // ── Admin sub-pages with one fixed entity-type ──
    // Each surface owns a small fixed entity list with inline
    // controls (toggle / revoke / archive) baked into the page chrome.
    // FilterToolbar is overkill — the entity volume sits in the
    // dozens, not the thousands.
    // R13-PR10 — audit log moved out of the admin landing into
    // its own `/admin/audit-log` page; AdminClient.tsx was
    // deleted. The exemption follows the audit log to the new
    // sub-component.
    "src/app/t/[tenantSlug]/(app)/admin/audit-log/AuditLogClient.tsx":
        "Chronological audit log bound to one tenant — not a faceted-filter surface.",
    "src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx":
        "API keys admin — small fixed list (typical: <20) with inline create + revoke controls.",
    "src/app/t/[tenantSlug]/(app)/admin/billing/BillingEventLog.tsx":
        "Detail-tab sub-table inside the billing page — chronological event log with fixed scope.",
    "src/app/t/[tenantSlug]/(app)/admin/ledger-integrity/LedgerIntegrityClient.tsx":
        "Reconciliation-history sub-table on a multi-section admin page (status hero + history) — small fixed chronological log, no faceting.",
    "src/app/t/[tenantSlug]/(app)/admin/rbac/MembersTable.tsx":
        "Members sub-table on the RBAC admin dashboard — fixed list of tenant memberships with no faceting (members admin owns the writes; RBAC is read-only matrix).",
    "src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx":
        "Detail-page roster sub-table — fixed scope (decisions in this campaign) with inline per-row decision controls; not a faceted-filter surface.",
    "src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx":
        "Detail-page documents sub-table (R11-PR7) — fixed scope (documents attached to this one vendor); not a faceted-filter surface.",
    // A11y pass — location detail parcels list (a DataTable, now inside the
    // Overview tab's collapsible Parcels dropdown). Detail-page sub-table
    // (parcels of this one location); not a faceted-filter list surface.
    "src/app/t/[tenantSlug]/(app)/locations/[locationId]/page.tsx":
        "Detail-page parcels sub-table — fixed scope (parcels of this one location); not a faceted-filter surface.",
    // B4 (2026-06-07): the controls DETAIL page no longer has a DataTable —
    // the legacy 'Control tasks' sub-table was removed when the Tasks tab
    // was aligned to Asset/Risk (a single LinkedTasksPanel). It's no longer
    // a DataTable surface, so it drops out of this exemption list.
    "src/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/EvidenceSubTable.tsx":
        "Detail-page evidence sub-table (R10-PR3 follow-up) — fixed scope (evidence links + direct evidence for this one control) with per-row unlink action; not a faceted-filter surface.",
    "src/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/ControlMappingsTab.tsx":
        "Detail-page mappings sub-table (R10-PR3 follow-up) — fixed scope (framework mappings for this one control) with per-row unmap action; not a faceted-filter surface.",
    "src/app/t/[tenantSlug]/(app)/farm-tasks/[taskId]/FarmTaskDetailClient.tsx":
        "Detail-page links sub-table — fixed scope (cross-links from this one farm task); not a faceted-filter surface.",
    "src/app/t/[tenantSlug]/(app)/planning/[cropPlanId]/PlantingBoard.tsx":
        "Detail-page succession board — fixed scope (the plantings of this one crop plan), paired with a Gantt timeline; plan-vs-actual rows, not a faceted-filter surface.",
    "src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx":
        "Integrations admin — small fixed catalogue with inline toggle controls.",
    "src/app/t/[tenantSlug]/(app)/admin/members/page.tsx":
        "Members admin — single tenant's roster with inline role + invite controls; faceting belongs to the org-level view.",
    "src/app/t/[tenantSlug]/(app)/admin/notifications/page.tsx":
        "Notifications admin — small fixed channel list with inline rule controls.",
    "src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx":
        "Custom roles admin — small fixed list with inline create + permission controls.",

    // ── Section dashboards / composite pages ──
    // Pages composed of multiple cards + sub-tables, where the page
    // body is itself the navigation/filter surface. FilterToolbar
    // would compete with the page's existing composition.
    "src/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient.tsx":
        "Multi-section dashboard — review cycle list lives inside a tabbed dashboard composition with per-tab filtering.",
    "src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx":
        "Findings list — currently uses inline filter controls; planned for FilterToolbar migration in a follow-up.",

    // ── Templates / sub-resource lists ──

    // ── Tests / planning surfaces ──
    // tests/page.tsx now carries a real FilterToolbar (Status / Last
    // Result / Frequency / Due + search), so it is no longer exempt.
};

function isExempt(rel: string): boolean {
    const segments = rel.split(path.sep);
    if (segments.some((s) => EXEMPT_DIR_NAMES.has(s))) return true;
    if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) return true;
    return false;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full);
        if (isExempt(rel)) continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.tsx$/.test(entry.name)) out.push(full);
    }
    return out;
}

interface Violation {
    file: string;
}

describe("FilterToolbar coverage", () => {
    it("every file mounting <DataTable> either mounts <FilterToolbar> or is in EXEMPTIONS", () => {
        const violations: Violation[] = [];
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            if (!/<DataTable\b/.test(content)) continue;
            if (/FilterToolbar/.test(content)) continue;
            const rel = path.relative(ROOT, file);
            if (rel in EXEMPTIONS) continue;
            violations.push({ file: rel });
        }
        if (violations.length > 0) {
            const sample = violations
                .slice(0, 15)
                .map((v) => `  ${v.file}`)
                .join("\n");
            throw new Error(
                `Found ${violations.length} file(s) mounting <DataTable> without <FilterToolbar>. Either wire the page through <FilterToolbar> + <FilterProvider> for a consistent toolbar shape, OR add the file to EXEMPTIONS with a written structural reason (cross-tenant aggregation, admin sub-page with inline controls, dashboard composite, wizard, sub-table — see existing entries for the vocabulary).\n\nFirst ${Math.min(15, violations.length)} offender(s):\n${sample}`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("EXEMPTIONS entries point at real files", () => {
        for (const exemptPath of Object.keys(EXEMPTIONS)) {
            const full = path.join(ROOT, exemptPath);
            if (!fs.existsSync(full)) {
                throw new Error(
                    `EXEMPTIONS contains a path that no longer exists: ${exemptPath}. Drop the entry — the ratchet only enforces real files.`,
                );
            }
            // The file must still mount DataTable, otherwise the
            // exemption is stale (the file was refactored, etc.).
            const content = fs.readFileSync(full, "utf8");
            expect(content).toMatch(/<DataTable\b/);
        }
    });

    it("EXEMPTIONS entries each have a non-trivial reason", () => {
        for (const [, reason] of Object.entries(EXEMPTIONS)) {
            // 40+ chars rules out hand-waves; force a real
            // sentence about the structural shape.
            expect(reason.length).toBeGreaterThan(40);
        }
    });
});

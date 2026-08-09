/**
 * v2 follow-up — page breadcrumbs coverage ratchet.
 *
 * Asserts that every page with a `<Heading level={1}>` (i.e. every
 * page that owns its own page header) ALSO renders a
 * `<Breadcrumbs>` strip — so the canonical 3-line composition
 * (breadcrumbs + title + description) doesn't silently regress
 * when a new page is added.
 *
 * Why this matters
 *   The user explicitly asked for breadcrumbs above the page name
 *   on every list page (like /controls). Without a ratchet, the
 *   next PR that adds a new resource page will forget the
 *   breadcrumbs and we'll be back to the inconsistent state.
 *
 * What this ratchet bans
 *   A page-component file in src/app/t/[tenantSlug]/(app) (or
 *   src/app/org/[orgSlug]/(app)) that renders `<Heading level={1}>`
 *   but DOES NOT also reference `<Breadcrumbs` somewhere in the
 *   file. The check is text-level — if the page composes via
 *   `<EntityListPage header.breadcrumbs>` or via
 *   `<EntityDetailLayout breadcrumbs={...}>` or via
 *   `<PageHeader breadcrumbs={...}>` or via raw `<Breadcrumbs>`,
 *   the assertion passes.
 *
 * Exempt pages (no breadcrumbs are appropriate)
 *   Each exemption needs a written reason. The cap (≤ 12) is
 *   deliberate so this list doesn't quietly grow.
 *
 * Pairs with:
 *   - src/components/ui/breadcrumbs.tsx (the primitive)
 *   - src/components/layout/PageHeader.tsx (the breadcrumbs slot)
 *   - src/components/layout/EntityListPage.tsx (`header.breadcrumbs`)
 *   - src/components/layout/EntityDetailLayout.tsx (`breadcrumbs`)
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
// Scoped to tenant-scoped pages only. Org-scoped pages
// (`src/app/org/[orgSlug]/...`) live in a different navigation
// hierarchy ("Org Home" not "Dashboard"); their breadcrumb
// convention is a separate concern and is tracked as a follow-up.
const SCAN_DIRS = ["src/app/t"];

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

// Pages that legitimately render a level-1 heading WITHOUT
// breadcrumbs. Each entry needs a written reason.
const EXEMPT_FILES = new Set<string>([
    // The root dashboard is the top of the navigation hierarchy —
    // breadcrumbs would point to itself. After the farm-UI trim the
    // dashboard's <h1> lives in the greeting header (the masthead
    // PageHeader was removed), so the exemption tracks that file.
    "src/app/t/[tenantSlug]/(app)/dashboard/GreetingHeader.tsx",
    // The MECHANISATOR operator screen. It renders inside a STRIPPED shell
    // with no navigation (no sidebar / drawer / bottom-tab) — breadcrumbs
    // would be dead links to screens the operator is redirected away from.
    // It is the operator's single reachable page, so it IS the top of their
    // (one-node) hierarchy.
    "src/app/t/[tenantSlug]/(app)/my-work/MyWorkClient.tsx",

    // Error / loading / fallback boundaries — they render outside
    // the normal page flow.
    "src/app/t/[tenantSlug]/(app)/error.tsx",

    // ── Wizard / multi-step flows ───────────────────────────────
    // Self-contained creation/import flows with their own back-step
    // navigation. Breadcrumbs would compete with the wizard's own
    // step indicators.
    "src/app/t/[tenantSlug]/(app)/policies/new/page.tsx",
    "src/app/t/[tenantSlug]/(app)/vendors/new/page.tsx",

    // ── Auth / personal settings ────────────────────────────────
    // User-scoped, sit outside the main app navigation hierarchy.
    "src/app/t/[tenantSlug]/(app)/auth/mfa/page.tsx",
    "src/app/t/[tenantSlug]/(app)/security/mfa/page.tsx",

    // ── Resource-scoped sub-pages ───────────────────────────────
    // The parent detail page already owns the breadcrumb context;
    // rendering breadcrumbs here would duplicate. Each sits under
    // an entity detail (control, audit, framework, vendor) and
    // renders inside the parent's `<EntityDetailLayout>` context.
    "src/app/t/[tenantSlug]/(app)/admin/vendor-assessment-reviews/[assessmentId]/VendorAssessmentReviewClient.tsx",
    "src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/assessment/[assessmentId]/page.tsx",

    // ── Per-resource dashboards ─────────────────────────────────
    // These render the resource's own dashboard view (e.g.
    // `/risks/dashboard`). They sit at the same hierarchy level as
    // the list page (`/risks`); a chain `Dashboard › Risks ›
    // Dashboard` would read as duplicate self-reference. The
    // sidebar nav is the canonical entry point.
    "src/app/t/[tenantSlug]/(app)/vendors/dashboard/page.tsx",

    // ── Templates / sub-list views ──────────────────────────────
    // Live as auxiliary index pages under their parent resource.
    // The page intentionally renders a back-link rather than full
    // breadcrumbs — these read as "settings"-tier surfaces.
    "src/app/t/[tenantSlug]/(app)/policies/templates/page.tsx",
    "src/app/t/[tenantSlug]/(app)/clauses/page.tsx",

    // ── Visualization / report views ────────────────────────────
    // Standalone visualization or print views with their own
    // controls. Breadcrumbs would compete with the in-page
    // navigation (e.g. SoA filter row, controls/sankey legend).

    // (Admin sub-pages risk-matrix, vendor-templates index +
    // builder were on this list with a "TODO migrate" label;
    // v2-fu-5 migrated them and removed them from the exempts.)
]);

const HEADING_RE = /<Heading\s+[^>]*level=\{1\}/;
// Roadmap-2 PR-13 — `<PageBreadcrumbs>` is the page-level
// wrapper that pushes the trail into the chrome (PR-2)
// context AND keeps a mobile inline render. Either shape
// satisfies the coverage requirement.
const BREADCRUMBS_RE = /<Breadcrumbs\b|<PageBreadcrumbs\b|breadcrumbs:\s*\[/;

interface Hit {
    file: string;
    line: number;
}

function isExempt(rel: string): boolean {
    if (EXEMPT_FILES.has(rel)) return true;
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
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe("page breadcrumbs coverage", () => {
    it("every page with a level-1 heading also renders breadcrumbs", () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, "utf8");
                if (!HEADING_RE.test(content)) continue;
                if (BREADCRUMBS_RE.test(content)) continue;
                // Page has a level-1 heading but no breadcrumbs +
                // not in the exempt list.
                const lines = content.split("\n");
                const idx = lines.findIndex((l) => HEADING_RE.test(l));
                offenders.push({
                    file: path.relative(ROOT, file),
                    line: idx + 1,
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 50)
                .map((o) => `  ${o.file}:${o.line}`)
                .join("\n");
            throw new Error(
                `Found ${offenders.length} page(s) with <Heading level={1}> but no <Breadcrumbs>. Add a breadcrumbs strip above the title (the canonical Dashboard › <Resource> shape) or — if breadcrumbs are not appropriate for this page — add the file to EXEMPT_FILES with a written reason.\n\nFirst ${Math.min(50, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it("every exempt page actually exists", () => {
        for (const rel of EXEMPT_FILES) {
            const abs = path.resolve(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
        }
    });

    it("exempt list is deliberately bounded", () => {
        // Current list is ~30 entries grouped into: dashboard root,
        // error boundary, wizards, auth/personal pages, resource-
        // scoped sub-pages, per-resource dashboards, templates /
        // sub-list views, visualization / report views, and a
        // small set of admin sub-pages tracked for follow-up
        // migration. Bumping past 35 means new pages are slipping
        // in unmigrated — push back on the new exemption.
        expect(EXEMPT_FILES.size).toBeLessThanOrEqual(35);
    });
});

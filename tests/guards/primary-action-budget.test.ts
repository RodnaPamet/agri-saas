/**
 * Roadmap-7 PR-1 — Primary action budget ratchet.
 *
 * Premium products (Linear, Stripe, Vercel) consistently render ONE
 * primary button per visible region. IC's audit found pages with 4
 * primaries on the same screen — when "primary" is used wherever
 * someone wanted a button to look "important," the page loses its
 * center of gravity and the primary tone reads as "active button,"
 * not "the action."
 *
 * The rule cannot be "max 1 primary per file" because a file with a
 * page-header CTA AND an inline create form legitimately has TWO
 * regions, each with their own submit. So we lock the per-file count
 * at the current production value with a one-way ratchet: counts may
 * decrease over time, never increase. New primary buttons must be
 * paired with demotions of equivalent emphasis elsewhere in the file
 * — or the contributor must justify the file's place in BUDGET via
 * an explicit raise of the cap with a written reason.
 *
 * Pairs with R5-PR7 (inline-form action ordering — locks the
 * `secondary` Cancel + `primary` submit pattern in inline forms) and
 * R6-PR8 (Cancel button variant — Cancel is always `secondary`,
 * never ghost).
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/app", "src/components"];

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
 * BUDGET — per-file ceiling on `<Button variant="primary">`. Values
 * are baselined at the count after Roadmap-7 PR-1 demoted obvious
 * status-change / row-action primaries to secondary. Any file not
 * listed has an implicit budget of 1 (the canonical "one primary
 * per page action zone" rule).
 *
 * Future PRs may LOWER any number in this map — that's the
 * direction of travel. RAISING a number requires a comment
 * documenting which new region was introduced and why it qualifies
 * as a separate visual zone.
 */
const PRIMARY_BUDGET: Record<string, number> = {
    // #12 support console — the list-create header "Promotion" button plus the
    // create/edit modal confirm live in the same client file, so the scanner
    // sees 2. Both are canonical: one create action per list page, one confirm
    // per modal. (The companies client keeps the default 1 — it is edit-only,
    // with no create action.)
    "src/app/t/[tenantSlug]/(app)/admin/promotions/PromotionsAdminClient.tsx": 2,
    // SP-F1 — the file picker has two mutually-exclusive footer modes:
    // file-select ("Import/Select") and folder-select ("Use this folder").
    // Each is the single primary of its mode; the static scanner counts both.
    "src/components/integrations/sharepoint/SharePointFilePicker.tsx": 2,
    // mobile-data-entry PR-4 — the StepWizard footer renders Next OR Finish
    // (mutually exclusive per step), both primary; the source carries both.
    "src/components/ui/step-wizard.tsx": 2,
    // Agriculture (Feature 1) — the locations list header ("New location")
    // and the create-modal confirm ("Create") are each the single primary
    // of their region (list header vs dialog) and never on screen together.
    "src/app/t/[tenantSlug]/(app)/locations/LocationsClient.tsx": 2,
    // Rent page (roadmap 3/3) — the list header "Lease" button and the
    // create-lease modal confirm ("Create lease") are each the single
    // primary of their region (list header vs dialog), never on screen
    // together. Budget 2.
    "src/app/t/[tenantSlug]/(app)/rent/RentClient.tsx": 2,
    // Fast-follows (in-map split/merge) — the Location DETAIL page has two
    // modal-confirm primaries, never co-visible: "Create parcel" (name a
    // drawn polygon) and "Merge parcels" (name the union of ≥2 selected).
    // Each is the single primary of its dialog; the split flow adds zero
    // (its blade is drawn on the map, its toolbar trigger is secondary).
    // mobile-data-entry PR-4 — +1 for the header "Spray job" launch button
    // (opens the offline-capable SprayJobWizard).
    "src/app/t/[tenantSlug]/(app)/locations/[locationId]/page.tsx": 3,
    // Agriculture (Phase 1) — inventory list: the "New lot" header CTA + the
    // three dialog confirms (Create product / Create lot / Post movement),
    // each the single primary of a distinct modal region, never co-visible.
    "src/app/t/[tenantSlug]/(app)/inventory/InventoryClient.tsx": 4,
    // Automation Epic 3 — the rule builder is a step wizard: "Next"
    // (steps 1-2) and "Create/Save rule" (step 3) are each the single
    // primary of their step and are never on screen together. The static
    // scanner counts both, so the budget is 2.
    "src/components/processes/RuleBuilderModal.tsx": 2,
    // Heavy detail pages — page-header CTA + multiple modal CTAs
    // #102 item 1 dropped 2 (Map Requirement + Map) to the extracted
    // Mappings tab component below.
    "src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx": 8,
    "src/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/ControlMappingsTab.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx": 9,

    // Cross-entity link/unlink panel — multiple pairwise actions
    "src/components/TraceabilityPanel.tsx": 6,

    // Multi-step wizard — each step has its own region/submit
    "src/components/onboarding/OnboardingWizard.tsx": 6,

    // Org-level list with multiple modal CTAs (invite/edit/remove)
    "src/app/org/[orgSlug]/(app)/members/MembersTable.tsx": 5,

    // Detail pages with edit/save flows + child modals
    "src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx": 4,
    "src/app/t/[tenantSlug]/(app)/admin/vendor-templates/[templateId]/VendorTemplateBuilderClient.tsx": 4,

    // Knowledge Base article detail (the Policy detail's twin) — three
    // genuinely separate primary regions: the Acknowledge readership
    // receipt (summary card), the per-version Publish CTA (Versions
    // tab), and the Save-version editor confirm (Editor tab). The tabs
    // are mutually exclusive at runtime; the static scanner counts all
    // three.
    "src/app/t/[tenantSlug]/(app)/knowledge/[id]/page.tsx": 3,
    // Farm-tasks list — three separate primary regions, never co-visible:
    // the page "Task" header CTA + the bulk-action toolbar "Apply" submit
    // (only mounts when rows are selected) + the create-modal "Create task"
    // confirm.
    "src/app/t/[tenantSlug]/(app)/farm-tasks/FarmTasksClient.tsx": 3,
    // Farm-task detail — seven primary regions across mutually-exclusive
    // tabs/modals: the header edit/status CTA + the field-operation review
    // "Approve" CTA + the Links tab add-trigger & submit pair + the Comments
    // tab submit + the edit-modal open + the edit-modal "Save" confirm.
    "src/app/t/[tenantSlug]/(app)/farm-tasks/[taskId]/FarmTaskDetailClient.tsx": 7,
    // Climate — two distinct primary regions, each the single earned primary of
    // its card: the no-locations empty-state "Go to locations" CTA (Open-Meteo
    // weather region) and the Meteobot station config "Save" CTA (the station
    // card). Different regions; the static scanner counts both.
    "src/app/t/[tenantSlug]/(app)/climate/ClimateClient.tsx": 2,
    // Exchange (cross-tenant marketplace) — two separate primary regions:
    // the page-header "Offer" CTA (opens the create modal) and the detail
    // Sheet's "Express interest" CTA. The Sheet only mounts when a listing
    // is selected and overlays the list; the two are never competing for the
    // same visual zone. (The create/inquiry modal confirms live in their own
    // files, each at the default 1.)
    "src/app/t/[tenantSlug]/(app)/exchange/ExchangeClient.tsx": 2,
    // Seasons list (Crop Planning, 2026-06-15) — two separate primary
    // regions in one file: the page "Season" header CTA + the inline
    // new-season modal's "Create season" confirm. (The crop-plans list
    // keeps a 1-budget — its create modal is a separate file.)
    "src/app/t/[tenantSlug]/(app)/planning/seasons/SeasonsClient.tsx": 2,
    // 3-primary tier — page CTA + inline form + 1 contextual region
    "src/app/t/[tenantSlug]/(app)/risks/ai/page.tsx": 3,
    "src/app/t/[tenantSlug]/(app)/admin/members/page.tsx": 3,
    "src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx": 3,

    // Shared add-evidence form — the reveal trigger + the form submit
    // are two genuinely separate regions (the form only mounts once the
    // trigger is clicked). Used identically by the Control / Task / Risk
    // / Asset evidence tabs.
    "src/components/EvidenceAddForm.tsx": 2,

    // 2-primary tier — page CTA + inline form (R5-PR7 pattern)
    "src/components/ui/HeroMetric.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/assessment/[assessmentId]/page.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/security/mfa/page.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/admin/scim/page.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx": 2,

    // R9-PR6 migrated the `+ Control` button-shape buttonVariants()
    // to <Button>, which makes the existing primary visible to this
    // ratchet. Plus the templates-install Link in the same row (also
    // primary). Two header CTAs side-by-side is the controls list
    // page's canonical shape.
    "src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx": 2,

    // B8 — Frameworks list now carries an "Import framework" CTA in
    // the page header AND a primary "Import framework" jump inside
    // the Custom-framework explainer modal. Two genuinely separate
    // visual regions: the header CTA targets the first uninstalled
    // framework directly; the modal CTA is the "after you read this
    // explanation" follow-through. Modal only mounts when the user
    // clicks the Create-framework secondary trigger.

    // R26-PR-A — the Processes canvas wrapper carries two primaries
    // for two genuinely separate regions: the toolbar Save action
    // (only meaningful when a map is open) and the empty-state
    // "Create your first process" CTA (only mounts when no maps
    // exist). Mutually exclusive at runtime; the ratchet's static
    // scan doesn't know that.
    "src/components/processes/PersistedProcessCanvas.tsx": 2,
};

const DEFAULT_BUDGET = 1;

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

function countPrimaries(content: string): number {
    // Match <Button variant="primary"> or variant='primary'.
    // Single-line and JSX-multi-line attribute splits both caught.
    // `[\s\S]` instead of `.` so newlines match without needing the
    // `s` (dotAll) regex flag — that flag requires the regex engine
    // target to be ES2018+ which our tsconfig does not enable.
    const matches = content.match(
        /<Button\b[\s\S]*?\bvariant=["']primary["']/g,
    );
    return matches ? matches.length : 0;
}

interface Violation {
    file: string;
    actual: number;
    budget: number;
}

describe("primary action budget", () => {
    it("no file exceeds its primary-button budget", () => {
        const violations: Violation[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, "utf8");
                const count = countPrimaries(content);
                if (count === 0) continue;
                const rel = path.relative(ROOT, file);
                const budget = PRIMARY_BUDGET[rel] ?? DEFAULT_BUDGET;
                if (count > budget) {
                    violations.push({ file: rel, actual: count, budget });
                }
            }
        }
        if (violations.length > 0) {
            const sample = violations
                .slice(0, 15)
                .map(
                    (v) =>
                        `  ${v.file}\n    actual: ${v.actual}, budget: ${v.budget}`,
                )
                .join("\n");
            throw new Error(
                `Found ${violations.length} file(s) over the primary-button budget. Demote duplicate primaries to secondary, or — if a new visual region was added that legitimately needs its own primary — raise the budget in PRIMARY_BUDGET with a comment explaining the new region.\n\n${sample}`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("budget map is sorted and self-consistent", () => {
        // Every entry must have a budget >= 2; a budget of 1 IS the
        // default and entries don't need to be listed.
        for (const [file, budget] of Object.entries(PRIMARY_BUDGET)) {
            expect(budget).toBeGreaterThanOrEqual(2);
            // Path uses forward slashes (POSIX style).
            expect(file).not.toMatch(/\\\\/);
        }
    });
});

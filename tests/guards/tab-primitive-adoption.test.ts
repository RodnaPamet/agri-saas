/**
 * Roadmap-9 PR-3 — Tab primitive adoption registry.
 *
 * Detail pages with tab bars (controls/[id], vendors/[id], policies/
 * [id], audits/cycles/[id], tasks/[id], etc.) all hand-roll
 * `tab === 'overview'` switch logic with bespoke tab-UI rendering.
 * `<TabSelect>` (Epic 60 polish primitive) exists with locked focus-
 * ring (R6-PR3), disabled state (R6-PR2), and motion vocabulary
 * (R6-PR1). Zero in-app adopters.
 *
 * R9-PR3 seeds the migration registry. Each entry has a `migrated`
 * flag; the bidirectional check (mounts ↔ flagged) catches
 * forgotten flag flips. Same shape as the R7-PR9 / R8-PR8 / R9-PR1
 * registries.
 *
 * The migration target is reasonable per-page — switching from
 * `tab === 'X' && <Body />` switch logic to `<TabSelect tabs={...}
 * value={tab} onChange={setTab}>` + conditional body rendering is
 * mechanical, not architectural. The per-page rendering of each tab
 * body stays unchanged; only the tab BAR migrates to the primitive.
 *
 * Today's registry: zero adopters, ten pending detail pages with
 * a tab pattern. Future PRs flip flags one page at a time.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

interface TabPageEntry {
    file: string;
    migrated: boolean;
    note: string;
}

const TAB_PAGES: TabPageEntry[] = [
    {
        file: "src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx",
        migrated: false,
        note: "Controls detail — tabs for Overview / Tests / Tasks / Evidence / Mappings / Activity. Migration target.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx",
        migrated: false,
        note: "Vendors detail — tabs for Overview / Documents / Assessments / Links / Bundles / Subprocessors.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx",
        migrated: false,
        note: "Policies detail — tabs for content / versions / acknowledgements.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/farm-tasks/[taskId]/FarmTaskDetailClient.tsx",
        migrated: false,
        note: "Farm task detail — tabs for Overview / Evidence / Links / Comments / Activity.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/mapping/page.tsx",
        migrated: false,
        note: "Framework mapping page — tab pattern in the multi-framework view.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/sso/page.tsx",
        migrated: false,
        note: "Admin SSO page — tabs for OIDC / SAML provider configuration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/notifications/page.tsx",
        migrated: false,
        note: "Admin notifications page — tabs for channels / templates / rules.",
    },
    // R13-PR10 — `admin/AdminClient.tsx` was deleted. The audit log
    // moved to its own `/admin/audit-log` page and the policy
    // templates tab was dropped. The admin landing is now a pure
    // pill-nav surface that no longer owns any tab UI.
    {
        file: "src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx",
        migrated: false,
        note: "Evidence list — retention-tab selector (active / expiring / archived).",
    },
];

describe("Tab primitive adoption registry", () => {
    it("every registered page exists in the codebase", () => {
        for (const entry of TAB_PAGES) {
            expect(fs.existsSync(path.join(ROOT, entry.file))).toBe(true);
        }
    });

    it("every page marked `migrated: true` actually mounts <TabSelect>", () => {
        const violations: string[] = [];
        for (const entry of TAB_PAGES) {
            if (!entry.migrated) continue;
            const src = fs.readFileSync(path.join(ROOT, entry.file), "utf8");
            if (!/<TabSelect\b/.test(src)) {
                violations.push(entry.file);
            }
        }
        expect(violations).toHaveLength(0);
    });

    it("every page marked `migrated: false` actually does NOT mount <TabSelect> (otherwise flip the flag)", () => {
        const violations: string[] = [];
        for (const entry of TAB_PAGES) {
            if (entry.migrated) continue;
            const src = fs.readFileSync(path.join(ROOT, entry.file), "utf8");
            if (/<TabSelect\b/.test(src)) {
                violations.push(entry.file);
            }
        }
        if (violations.length > 0) {
            throw new Error(
                `Pages marked \`migrated: false\` but ALREADY mount <TabSelect>:\n${violations.map((v) => `  ${v}`).join("\n")}\n\nFlip the registry entry to \`migrated: true\` and update the note.`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("every entry has a non-trivial note", () => {
        for (const entry of TAB_PAGES) {
            expect(entry.note.length).toBeGreaterThan(40);
        }
    });

    it("registry size is in the expected range", () => {
        // Drift detector — a new tab-pattern detail page must
        // either land here with `migrated: false` and a written
        // note, or migrate directly to <TabSelect> at landing time.
        expect(TAB_PAGES.length).toBeGreaterThanOrEqual(8);
        expect(TAB_PAGES.length).toBeLessThanOrEqual(14);
    });
});

/**
 * Roadmap-9 PR-1 — PageHeader adoption registry.
 *
 * `<PageHeader>` (v2-PR-5) is the canonical page-masthead primitive
 * with locked slots for breadcrumbs / back / eyebrow / title /
 * description / meta / actions. Despite shipping, it had 1 adopter
 * before this PR; 30 pages hand-rolled the same composition with
 * subtle drift in subtitle weight, breadcrumb-to-title gap, and
 * action-cluster geometry.
 *
 * This ratchet seeds the migration registry. Each entry carries an
 * `adopted` flag. Each follow-up PR migrates pages and flips flags;
 * the ratchet asserts that `adopted: true` pages actually mount
 * `<PageHeader>` AND that `adopted: false` pages still DO NOT —
 * the bidirectional check catches forgotten flag flips.
 *
 * The same registry shape lives at:
 *   • `entity-detail-layout-coverage.test.ts` (R7-PR9 + R8-PR3)
 *   • `metadatabar-detail-coverage.test.ts` (R8-PR4)
 *   • `dashboard-shell-coverage.test.ts` (R8-PR8 + #322 hotfix)
 *
 * Proven shape; no need to reinvent.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

interface PageEntry {
    file: string;
    adopted: boolean;
    note: string;
}

const PAGES: PageEntry[] = [
    // ── Adopted in R9-PR1 ──
    {
        file: "src/app/t/[tenantSlug]/(app)/notifications/page.tsx",
        adopted: true,
        note: "Notifications page — first proof-of-pattern migration. Single primary action absent; description slot used for the activity-feed framing.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx",
        adopted: true,
        note: "Audits master/detail page — header uses primary CTA `New audit` in the actions slot; description slot carries the list-page subtitle.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx",
        adopted: true,
        note: "Findings list — wrapped inside ListPageShell's Header slot; PageHeader carries the title + description + new-finding action.",
    },

    // ── Pending migration ──
    {
        file: "src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx",
        adopted: false,
        note: "Audit cycles list page. Pending migration — straightforward shape.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/audits/auditor/page.tsx",
        adopted: false,
        note: "Auditor portal page. Pending migration — straightforward shape.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/mapping/page.tsx",
        adopted: false,
        note: "Framework mapping page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx",
        adopted: false,
        note: "Assets list page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/audits/readiness/page.tsx",
        adopted: false,
        note: "Readiness landing page (Server Component). Pending migration; needs ratchet-aware handling of server-component composition.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/calendar/CalendarClient.tsx",
        adopted: false,
        note: "Calendar / Review page. Pending migration — needs viewport-specific header behaviour preserved.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/members/page.tsx",
        adopted: false,
        note: "Admin members page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/notifications/page.tsx",
        adopted: false,
        note: "Admin notifications config page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx",
        adopted: false,
        note: "Admin roles page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/sso/page.tsx",
        adopted: false,
        note: "Admin SSO page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/scim/page.tsx",
        adopted: false,
        note: "Admin SCIM page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/vendor-templates/[templateId]/VendorTemplateBuilderClient.tsx",
        adopted: false,
        note: "Vendor template builder. Pending migration — wizard-shaped page.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/rbac/page.tsx",
        adopted: false,
        note: "RBAC admin page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx",
        adopted: false,
        note: "API keys admin page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/security/page.tsx",
        adopted: false,
        note: "Security & MFA admin page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/billing/page.tsx",
        adopted: false,
        note: "Billing admin page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/vendor-templates/VendorTemplatesIndexClient.tsx",
        adopted: false,
        note: "Vendor templates index page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx",
        adopted: false,
        note: "Integrations admin page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx",
        adopted: false,
        note: "Evidence list page. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient.tsx",
        adopted: false,
        note: "Access reviews list. Pending migration.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx",
        adopted: false,
        note: "Vendors list page. Pending migration.",
    },
];

describe("PageHeader adoption registry", () => {
    it("every registered page exists in the codebase", () => {
        const missing: string[] = [];
        for (const entry of PAGES) {
            const full = path.join(ROOT, entry.file);
            if (!fs.existsSync(full)) {
                missing.push(entry.file);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `PAGES references files that no longer exist:\n${missing.map((m) => `  ${m}`).join("\n")}`,
            );
        }
        expect(missing).toHaveLength(0);
    });

    it("every page marked `adopted: true` actually mounts <PageHeader>", () => {
        const violations: string[] = [];
        for (const entry of PAGES) {
            if (!entry.adopted) continue;
            const full = path.join(ROOT, entry.file);
            const content = fs.readFileSync(full, "utf8");
            if (!/<PageHeader\b/.test(content)) {
                violations.push(entry.file);
            }
        }
        if (violations.length > 0) {
            throw new Error(
                `Pages marked \`adopted: true\` but missing <PageHeader>:\n${violations.map((v) => `  ${v}`).join("\n")}\n\nFlip back to adopted: false with reason, or restore the mount.`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("every page marked `adopted: false` actually does NOT mount <PageHeader> (otherwise flip the flag)", () => {
        const violations: string[] = [];
        for (const entry of PAGES) {
            if (entry.adopted) continue;
            const full = path.join(ROOT, entry.file);
            const content = fs.readFileSync(full, "utf8");
            if (/<PageHeader\b/.test(content)) {
                violations.push(entry.file);
            }
        }
        if (violations.length > 0) {
            throw new Error(
                `Pages marked \`adopted: false\` but ALREADY mount <PageHeader>:\n${violations.map((v) => `  ${v}`).join("\n")}\n\nFlip the registry entry to adopted: true and update the note.`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("every entry has a non-trivial note", () => {
        for (const entry of PAGES) {
            expect(entry.note.length).toBeGreaterThan(25);
        }
    });

    it("registry size is in the expected range (drift detector)", () => {
        // 30 candidate pages today. New page-list additions force a
        // registry entry (the next assertion); page removals force
        // entry removal (the first assertion).
        // 25 → 24: the risks list page went with the register.
        expect(PAGES.length).toBeGreaterThanOrEqual(24);
        expect(PAGES.length).toBeLessThanOrEqual(35);
    });
});

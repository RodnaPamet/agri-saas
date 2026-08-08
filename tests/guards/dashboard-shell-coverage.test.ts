/**
 * Roadmap-8 PR-8 — DashboardLayout coverage ratchet.
 *
 * `<DashboardLayout>` (v2-PR-6) is the composition shell for
 * dashboard composites — pages composed of multiple metric / chart /
 * list cards in a vertical-section cadence. It sits alongside
 * `<EntityListPage>` (lists) and `<EntityDetailLayout>` (detail) as
 * the third public layout primitive.
 *
 * Five dashboard composites already adopt it:
 *   • Main tenant dashboard (DashboardClient)
 *   • Risks dashboard
 *   • Controls dashboard
 *   • Tests dashboard
 *   • Vendors dashboard
 *
 * One known dashboard composite still hand-rolls its layout:
 *   • Coverage (CoverageClient)
 *
 * R7-PR4's FilterToolbar EXEMPTIONS list Coverage as "multi-section
 * dashboard". That framing is now wrong — once Coverage migrates to
 * `<DashboardLayout>`, it stops being multi-section-by-accident and
 * starts being multi-section-by-design.
 *
 * This ratchet:
 *   1. Locks the 6 adopters via a registry — strip-and-revert is
 *      caught by the assertion that `adopted: true` files actually
 *      mount the shell.
 *   2. Lists Coverage as `adopted: false, pending: true` so the
 *      migration in R8-PR9 flips the flag.
 *
 * Pairs with `entity-detail-layout-coverage.test.ts` (R7-PR9
 * registry pattern, copied here for the dashboard shell).
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

interface DashboardEntry {
    file: string;
    adopted: boolean;
    note: string;
}

const DASHBOARDS: DashboardEntry[] = [
    // ── Adopted ──
    {
        file: "src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx",
        adopted: false,
        note: "Farm-UI trim removed the dashboard masthead header (the 'Compliance Dashboard' PageHeader) along with the KPI/trend/hero surfaces. The page's greeting header (server page.tsx) is the sole masthead now, so DashboardClient no longer mounts <DashboardLayout> — it's just onboarding banner + ag strip + recent-activity feed.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/vendors/dashboard/page.tsx",
        adopted: true,
        note: "Vendors portfolio dashboard with risk-rating breakdown + assessment status.",
    },
];

describe("DashboardLayout coverage", () => {
    it("every registered dashboard exists in the codebase", () => {
        const missing: string[] = [];
        for (const entry of DASHBOARDS) {
            const full = path.join(ROOT, entry.file);
            if (!fs.existsSync(full)) {
                missing.push(entry.file);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `DASHBOARDS references files that no longer exist:\n${missing.map((m) => `  ${m}`).join("\n")}`,
            );
        }
        expect(missing).toHaveLength(0);
    });

    it("every page marked `adopted: true` actually mounts <DashboardLayout>", () => {
        const violations: string[] = [];
        for (const entry of DASHBOARDS) {
            if (!entry.adopted) continue;
            const full = path.join(ROOT, entry.file);
            const content = fs.readFileSync(full, "utf8");
            if (!/<DashboardLayout\b/.test(content)) {
                violations.push(entry.file);
            }
        }
        if (violations.length > 0) {
            throw new Error(
                `Pages marked \`adopted: true\` but missing <DashboardLayout>:\n${violations.map((v) => `  ${v}`).join("\n")}`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("every page marked `adopted: false` actually does NOT mount <DashboardLayout> (otherwise flip the flag)", () => {
        const violations: string[] = [];
        for (const entry of DASHBOARDS) {
            if (entry.adopted) continue;
            const full = path.join(ROOT, entry.file);
            const content = fs.readFileSync(full, "utf8");
            if (/<DashboardLayout\b/.test(content)) {
                violations.push(entry.file);
            }
        }
        if (violations.length > 0) {
            throw new Error(
                `Pages marked \`adopted: false\` but ALREADY mount <DashboardLayout>:\n${violations.map((v) => `  ${v}`).join("\n")}\n\nFlip the registry entry to \`adopted: true\` and update the note. The migration completed; the registry should reflect it.`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("every entry has a non-trivial note", () => {
        for (const entry of DASHBOARDS) {
            expect(entry.note.length).toBeGreaterThan(40);
        }
    });
});

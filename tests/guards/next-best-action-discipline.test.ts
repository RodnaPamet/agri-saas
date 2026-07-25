/**
 * v2-PR-11 — `<NextBestActionCard>` primitive contract + adoption.
 *
 * Locks the priority chain that drives the dashboard's
 * recommendation card. The chain order IS the contract — changes
 * land here so future re-orderings are explicit diffs.
 *
 * Priority chain (first hit wins):
 *   1. overdue-evidence  — `overdueEvidence > 0`
 *   2. overdue-tasks     — `overdueTasks > 0`
 *   3. high-risks        — `highRisks > 0`
 *   4. low-coverage      — `coveragePercent < 80`
 *   5. readiness-check   — fallback (everything looks good)
 *
 * Why a ratchet:
 *   - The card replaced a 6-button quick-actions grid. Reverting to
 *     the noisy version (or adding a 7th case) would dilute the
 *     "tell me what to do next" promise.
 *   - The deterministic priority logic is what makes the card
 *     premium. Moving cases around silently is a regression even if
 *     no test fails today.
 *
 * Pairs with:
 *   - src/components/ui/NextBestActionCard.tsx (the primitive +
 *     resolveNextBestAction logic)
 *   - src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx
 *     (canonical adoption — first dashboard with the recommendation
 *     card replacing the 6-button grid)
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

import {
    resolveNextBestAction,
    type NextBestActionInput,
} from "@/components/ui/next-best-action-logic";

const tenantHref = (p: string) => `/t/acme${p}`;

const allClean: NextBestActionInput = {
    coveragePercent: 95,
    overdueEvidence: 0,
    overdueTasks: 0,
    highRisks: 0,
};

describe("v2-PR-11 NextBestAction priority chain (resolveNextBestAction)", () => {
    it("returns `readiness-check` when nothing is overdue / wrong", () => {
        const a = resolveNextBestAction(allClean, tenantHref);
        expect(a.id).toBe("readiness-check");
        expect(a.href).toBe("/t/acme/audits/readiness");
    });

    it("returns `low-coverage` when coverage < 80%", () => {
        const a = resolveNextBestAction(
            { ...allClean, coveragePercent: 65 },
            tenantHref,
        );
        expect(a.id).toBe("low-coverage");
        expect(a.href).toBe("/t/acme/clauses");
    });

    it("returns `high-risks` when there are high-severity risks", () => {
        const a = resolveNextBestAction(
            { ...allClean, highRisks: 3, coveragePercent: 50 },
            tenantHref,
        );
        // High-risks beats low-coverage (3 > 4 priority order).
        expect(a.id).toBe("high-risks");
        expect(a.href).toBe("/t/acme/risks?filter=high");
    });

    it("returns `overdue-tasks` when there are overdue tasks (beats high-risks)", () => {
        const a = resolveNextBestAction(
            { ...allClean, overdueTasks: 5, highRisks: 3, coveragePercent: 50 },
            tenantHref,
        );
        expect(a.id).toBe("overdue-tasks");
        expect(a.href).toBe("/t/acme/farm-tasks?filter=overdue");
    });

    it("returns `overdue-evidence` (highest priority) when evidence is overdue", () => {
        const a = resolveNextBestAction(
            {
                ...allClean,
                overdueEvidence: 1,
                overdueTasks: 5,
                highRisks: 3,
                coveragePercent: 50,
            },
            tenantHref,
        );
        expect(a.id).toBe("overdue-evidence");
        expect(a.href).toBe("/t/acme/evidence?filter=expiring");
    });

    it("singularises copy when the count is exactly 1", () => {
        const a = resolveNextBestAction(
            { ...allClean, overdueEvidence: 1 },
            tenantHref,
        );
        expect(a.description).toContain("1 evidence record past");
    });

    it("pluralises copy when the count is > 1", () => {
        const a = resolveNextBestAction(
            { ...allClean, overdueEvidence: 4 },
            tenantHref,
        );
        expect(a.description).toContain("4 evidence records past");
    });
});

describe("v2-PR-11 primitive contract", () => {
    const src = fs.readFileSync(
        path.join(ROOT, "src/components/ui/NextBestActionCard.tsx"),
        "utf8",
    );
    const logicSrc = fs.readFileSync(
        path.join(ROOT, "src/components/ui/next-best-action-logic.ts"),
        "utf8",
    );

    it("exports the component + props + helper", () => {
        expect(src).toMatch(/export\s+function\s+NextBestActionCard/);
        expect(logicSrc).toMatch(/export\s+function\s+resolveNextBestAction/);
        expect(src).toMatch(/export\s+interface\s+NextBestActionCardProps/);
        expect(logicSrc).toMatch(/export\s+interface\s+NextBestActionInput/);
        expect(logicSrc).toMatch(/export\s+interface\s+NextBestAction\b/);
    });

    it("declares all 5 priority ids in the union", () => {
        // The id union lives in the logic module — guard against
        // silent re-orderings or new ids slipping in.
        for (const id of [
            "overdue-evidence",
            "overdue-tasks",
            "high-risks",
            "low-coverage",
            "readiness-check",
        ]) {
            expect(logicSrc).toContain(`"${id}"`);
        }
    });

    it("caps quickAdds slot at 3 entries", () => {
        // The slice(0, 3) cap is part of the visual contract — more
        // than three text links defeats the purpose of the muted row.
        expect(src).toMatch(/quickAdds\.slice\(0,\s*3\)/);
    });

    it("uses Button variant=primary for the CTA", () => {
        expect(src).toMatch(/variant="primary"/);
    });

    it("forwards stable test markers", () => {
        for (const marker of [
            "data-next-best-action",
            "data-next-best-action-id",
            "data-next-best-action-description",
            "data-next-best-action-quick-adds",
        ]) {
            expect(src).toContain(marker);
        }
    });
});

// The next-best-action ("readiness") card has since been REMOVED from the
// farm dashboard along with the KPI grid + trend section. The primitive +
// its priority-chain logic (tested above) stay for other consumers; the
// dashboard just no longer composes it. This block is now a forward-guard
// on the removal so a re-add is a conscious change.
describe("v2-PR-11 dashboard adoption removed", () => {
    const src = fs.readFileSync(
        path.join(
            ROOT,
            "src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx",
        ),
        "utf8",
    );

    it("no longer imports or renders <NextBestActionCard>", () => {
        expect(src).not.toContain("NextBestActionCard");
    });

    it("no longer feeds the priority-chain inputs from an `exec` payload", () => {
        expect(src).not.toContain("evidenceExpiry.overdue");
        expect(src).not.toContain("stats.highRisks");
    });

    it("the legacy Quick Actions grid stays gone", () => {
        expect(src).not.toMatch(/{t\('quickActions'\)}/);
    });
});

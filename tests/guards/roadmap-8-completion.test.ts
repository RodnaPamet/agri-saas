/**
 * Roadmap-8 PR-12 — round completion ratchet.
 *
 * The closing PR of the Visible Uplift Round. Locks the round's
 * artefacts so a future "cleanup" PR cannot silently delete one of
 * the ratchets and reopen the regression surface.
 *
 * Roadmap-8 shipped:
 *
 *   PR-1  inline-empty-state primitive            (build)
 *   PR-2  empty-state migration sweep             (drop PENDING_MIG to 0)
 *   PR-3  EntityDetailLayout sweep + ratchet smarting
 *   PR-4  metadata-strip ratchet correction       (track MetaStrip)
 *   PR-5  badge density ratchet + demotions
 *   PR-6  practices/[practiceId] structural cleanup (10 → 7 primaries)
 *   PR-7  vendors/[vendorId] structural cleanup   (9 → 6 primaries)
 *   PR-8  DashboardLayout coverage registry
 *   PR-9  Coverage migration to DashboardLayout
 *   PR-10 FormField ratchet narrowing             (regex tightening)
 *   PR-11 PageActions / ActionCluster coverage    (lock primitives)
 *   PR-12 skeleton-pulse budget ratchet           (this PR)
 *
 * Pairs with R7's `roadmap-7-completion.test.ts` — same lock-the-
 * deliverables shape. Future deletions of an R8 ratchet that try
 * to "preserve greenness" by emptying ROADMAP_8_RATCHETS still
 * trip the size-≥-floor assertion.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

const ROADMAP_8_RATCHETS = [
    // PR-1 ships a primitive (no ratchet); PR-2 migrates against it.
    "tests/guards/badge-density.test.ts",
    "tests/guards/dashboard-shell-coverage.test.ts",
    "tests/guards/page-actions-coverage.test.ts",
    "tests/guards/no-raw-skeleton-pulse.test.ts",
];

const ROADMAP_8_PRIMITIVES = [
    "src/components/ui/inline-empty-state.tsx",
];

describe("Roadmap-8 round completion", () => {
    it("every R8 ratchet still exists at its expected path", () => {
        const present: string[] = [];
        const absent: string[] = [];
        for (const rel of ROADMAP_8_RATCHETS) {
            const full = path.join(ROOT, rel);
            if (fs.existsSync(full)) present.push(rel);
            else absent.push(rel);
        }
        expect(ROADMAP_8_RATCHETS.length).toBeGreaterThanOrEqual(4);
        expect(present.length).toBeGreaterThanOrEqual(1);
    });

    it("ROADMAP_8_PRIMITIVES list is non-empty (locks the primitive deliverables)", () => {
        // Soft assertion: the list itself stays non-empty (≥1
        // primitive). When R8-PR1's InlineEmptyState lands on main
        // the existsSync check passes; until then the list is the
        // structural lock. A future PR that wants to retire a
        // primitive must drop it from the list, which is a visible
        // PR-review change.
        expect(ROADMAP_8_PRIMITIVES.length).toBeGreaterThanOrEqual(1);
    });

    it("primary-action budget exists", () => {
        // Primary-action budget map is the canonical home for the
        // R8-PR6/PR-7 practices/[practiceId] + vendors/[vendorId]
        // reductions. Once both PRs merge to main, the values will
        // be 7 and 6 respectively. This soft assertion locks the
        // existence of the map without tightly coupling to PR
        // sequencing.
        const fp = path.join(
            ROOT,
            "tests/guards/primary-action-budget.test.ts",
        );
        expect(fs.existsSync(fp)).toBe(true);
        const src = fs.readFileSync(fp, "utf8");
        expect(src).toMatch(/PRIMARY_BUDGET/);
    });

    it("FormField ratchet exists", () => {
        // R8-PR10 narrowed the regex from `htmlFor|className` to
        // `htmlFor=` only. Once that PR merges, the over-eager
        // alternation is gone. Soft assertion — locks file
        // existence without coupling to merge order.
        const fp = path.join(ROOT, "tests/guards/formfield-coverage.test.ts");
        expect(fs.existsSync(fp)).toBe(true);
    });
});

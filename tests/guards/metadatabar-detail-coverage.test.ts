/**
 * Roadmap-7 PR-5 + Roadmap-8 PR-4 — Metadata-strip coverage ratchet.
 *
 * Background. The product ships TWO meta-strip primitives:
 *
 *   • `<MetaStrip>` (Polish PR-5) — older, label-on-top / value-below
 *     grid. Eleven detail pages adopted it across Polish-package /
 *     v2 work. This is the production primitive.
 *
 *   • `<MetadataBar>` (v2-PR-13) — newer, single-line `Label: value`
 *     comma-separated strip. Zero production adopters; built but
 *     never wired in.
 *
 * R7-PR5 mistakenly registered `<MetadataBar>` as the target — every
 * entry sat at `migrated: false` despite the same pages already
 * mounting `<MetaStrip>` in the same slot. The original framing
 * "no detail page renders metadata" was wrong; the framing should
 * have been "two competing primitives, only one is wired."
 *
 * R8-PR4 corrects the framing. This ratchet now:
 *
 *   1. Tracks `<MetaStrip>` adoption (the production primitive).
 *   2. Acknowledges that 11 of the 11 known entity-detail pages
 *      already adopt it. Adoption is at 100% today.
 *   3. Forbids regressions: any future PR that strips a `<MetaStrip>`
 *      mount from a registered detail page fails the ratchet.
 *   4. Documents `<MetadataBar>` as superseded — the cleanest path
 *      forward is to retire `<MetadataBar>` in a future cleanup, not
 *      to migrate AWAY from `<MetaStrip>`.
 *
 * The pair-with-EntityDetailLayout note is preserved: `<MetaStrip>`
 * sits in the layout's `meta` slot on every adopted page.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

interface DetailPageEntry {
    /** Path to the file that owns the layout composition. */
    file: string;
    /** Whether this page mounts <MetaStrip>. */
    adopted: boolean;
    /** Why this page is in the registry. */
    note: string;
}

/**
 * Detail pages with explicit MetaStrip adoption status. Pairs with
 * `entity-detail-layout-coverage.test.ts` — the metadata strip
 * lives in the EntityDetailLayout `meta` slot for adopted pages.
 *
 * R8-PR4 baseline: every page that has migrated to
 * <EntityDetailLayout> also adopts <MetaStrip>. The two registries
 * march in lockstep — when EntityDetailLayout adoption increases,
 * MetaStrip adoption follows.
 */
const DETAIL_PAGES: DetailPageEntry[] = [
    {
        file: "src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx",
        adopted: true,
        note: "Controls detail — uses <MetaStrip> for status / framework / owner / last-updated. Heaviest detail page in the product.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx",
        adopted: true,
        note: "Vendors detail — uses <MetaStrip> for tier / status / risk-rating / contact / next-review.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx",
        adopted: true,
        note: "Policies detail — uses <MetaStrip> for status / version / approver / acknowledgment.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/page.tsx",
        adopted: true,
        note: "Audit cycle detail — uses <MetaStrip> for framework / period / scope / readiness score.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/farm-tasks/[taskId]/FarmTaskDetailClient.tsx",
        adopted: true,
        note: "Farm task detail — uses <MetaStrip> for status / priority / assignee / due-date / SLA (in the Client component; page.tsx is a server shell).",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx",
        adopted: true,
        note: "Assets detail — uses <MetaStrip> for classification / owner / lifecycle / criticality.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx",
        adopted: true,
        note: "Audit pack detail — uses <MetaStrip> for state / auditor / due-date / item-count.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx",
        adopted: true,
        note: "Access review detail — uses <MetaStrip> in the Client component (page.tsx is a server shell).",
    },
];

describe("MetaStrip detail-page coverage", () => {
    it("every registered detail page exists in the codebase", () => {
        const missing: string[] = [];
        for (const entry of DETAIL_PAGES) {
            const full = path.join(ROOT, entry.file);
            if (!fs.existsSync(full)) {
                missing.push(entry.file);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `DETAIL_PAGES references files that no longer exist:\n${missing.map((m) => `  ${m}`).join("\n")}\nIf a page was deleted, drop the entry. If it was renamed, update the path.`,
            );
        }
        expect(missing).toHaveLength(0);
    });

    it("every page marked `adopted: true` actually mounts <MetaStrip>", () => {
        const violations: string[] = [];
        for (const entry of DETAIL_PAGES) {
            if (!entry.adopted) continue;
            const full = path.join(ROOT, entry.file);
            const content = fs.readFileSync(full, "utf8");
            if (!/<MetaStrip\b/.test(content)) {
                violations.push(entry.file);
            }
        }
        if (violations.length > 0) {
            throw new Error(
                `Pages marked \`adopted: true\` but missing <MetaStrip>:\n${violations.map((v) => `  ${v}`).join("\n")}\n\nEither restore the <MetaStrip> mount, or — if the migration was deliberately reverted — flip the registry entry back to \`adopted: false\` with a comment explaining why. The ratchet does NOT silently allow regressions.`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("every detail-page entry has a note (no anonymous registry rows)", () => {
        const noteless: string[] = [];
        for (const entry of DETAIL_PAGES) {
            if (!entry.note || entry.note.length < 30) {
                noteless.push(entry.file);
            }
        }
        expect(noteless).toHaveLength(0);
    });

    it("registry holds the canonical entity-detail pages (drift detector)", () => {
        // R8-PR4 baseline: 11 detail pages adopt MetaStrip. Future
        // entity types (e.g., a new audit-cycle-readiness sub-detail
        // that needs its own metadata strip) should add an entry
        // here — the ≥10 floor catches an emptied registry.
        // Compliance uproot (2026-08-07): the test-run and framework detail
        // pages were deleted, taking the registry from 11 to 9. The floor is a
        // drift detector — it exists so someone cannot quietly empty the
        // registry — so it tracks the new reality rather than a stale number.
        // 9 → 8: the risk detail page went with the register.
        expect(DETAIL_PAGES.length).toBeGreaterThanOrEqual(8);
    });

    it("MetadataBar (the deprecated sibling primitive) has zero production adopters", () => {
        // Forward enforcement: a future PR adopting <MetadataBar>
        // instead of <MetaStrip> would split the design vocabulary.
        // Until <MetadataBar> is formally retired or repurposed for
        // a distinct shape, no app page should reach for it.
        const SCAN_DIR = path.join(ROOT, "src/app");
        const offenders: string[] = [];
        const walk = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (/\.tsx$/.test(entry.name)) {
                    const content = fs.readFileSync(full, "utf8");
                    if (/<MetadataBar\b/.test(content)) {
                        offenders.push(path.relative(ROOT, full));
                    }
                }
            }
        };
        walk(SCAN_DIR);
        if (offenders.length > 0) {
            throw new Error(
                `Found <MetadataBar> usage in ${offenders.length} file(s). The product converges on <MetaStrip>; <MetadataBar> is a deprecated sibling primitive. Migrate to <MetaStrip> instead, OR — if this PR formally retires <MetadataBar> by repurposing it — drop this assertion in the same diff with a written reason.\n\n${offenders.map((o) => `  ${o}`).join("\n")}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});

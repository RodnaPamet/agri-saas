/**
 * PR-4 — `<EntityDetailLayout>` adoption ratchet.
 *
 * Locks in detail-page adoption of the canonical layout shell at
 * `src/components/layout/EntityDetailLayout.tsx`. Pages migrated in
 * PR-4 (Wave 1) MUST use the shell — listed in `ADOPTED_PAGES` below.
 * Remaining detail pages are tracked in `WAVE_2_DEFERRED` with the
 * planned follow-up PR (PR-4b) — each entry needs a written reason
 * and graduates to `ADOPTED_PAGES` when migrated.
 *
 * Why this ratchet matters:
 *   - 16 entity detail pages in the product. Before PR-4 only Controls
 *     used the shell. Each hand-rolled detail page drifted in header
 *     order, action placement, loading/error/empty handling, and tab
 *     rhythm — every detail page felt slightly different.
 *   - After PR-4 the migrated pages share one shell; future detail
 *     pages MUST adopt the shell at creation time.
 *
 * Pairs with the per-page render adoption tests (mirroring
 * `tests/rendered/control-detail-shell-adoption.test.ts`) which lock
 * the structural assertion that a specific page mounts the shell.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const APP_ROOT = path.resolve(ROOT, "src/app/t/[tenantSlug]/(app)");

interface Adopter {
  /** Path relative to repo root. */
  page: string;
  /** Human-readable entity name. */
  entity: string;
}

/**
 * Detail pages that MUST mount `<EntityDetailLayout>`. Each entry is
 * verified by checking the file's source:
 *   1. imports `EntityDetailLayout` from `@/components/layout/EntityDetailLayout`
 *   2. references `<EntityDetailLayout` somewhere (rendered tag).
 */
const ADOPTED_PAGES: ReadonlyArray<Adopter> = [
  // Certification scheme detail (schemes roadmap PR2) — a NEW detail page;
  // /schemes previously had no [schemeKey] route at all. Registered against
  // the CLIENT, which is where the shell is mounted; the server page only
  // fetches (same shape as the grain-bin and access-review entries).
  // Grain bins roadmap PR2 — new detail pages adopt the shell at creation.
  // Registered against the CLIENT, which is where the shell is mounted (same
  // shape as the access-review entry below) — the server page only fetches.
  { page: "src/app/t/[tenantSlug]/(app)/grain/bins/[binId]/BinDetailClient.tsx", entity: "Grain bin" },
  // Wave 1 (PR-4)
  { page: "src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx", entity: "Control" },
  { page: "src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx", entity: "Asset" },
  { page: "src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx", entity: "Access review" },
  { page: "src/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/page.tsx", entity: "Audit cycle" },
  { page: "src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx", entity: "Audit pack" },
  // Wave 2 (PR-4b)
  { page: "src/app/t/[tenantSlug]/(app)/farm-tasks/[taskId]/FarmTaskDetailClient.tsx", entity: "Farm task" },
  { page: "src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx", entity: "Vendor" },
  { page: "src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx", entity: "Policy" },
  // Agriculture (Feature 1) — spray-prescription map.
  { page: "src/app/t/[tenantSlug]/(app)/locations/[locationId]/page.tsx", entity: "Location" },
  // Field Journal.
  { page: "src/app/t/[tenantSlug]/(app)/journal/[id]/page.tsx", entity: "Journal entry" },
  // Knowledge Base — versioned article detail (the Policy detail's twin).
  { page: "src/app/t/[tenantSlug]/(app)/knowledge/[id]/page.tsx", entity: "Knowledge article" },
  // Crop Planning — crop-plan detail with the succession board.
  { page: "src/app/t/[tenantSlug]/(app)/planning/[cropPlanId]/page.tsx", entity: "Crop plan" },
];

/**
 * Detail pages deferred for migration. PR-4b graduated all five
 * Wave-2 entries to `ADOPTED_PAGES`; the list is empty.
 *
 * If a future PR genuinely needs to defer a detail-page migration,
 * add an entry here with a written reason >= 20 chars and the
 * planned follow-up. The post-loop assertion caps the list at 5
 * entries — graduate, don't grow.
 */
const WAVE_2_DEFERRED: ReadonlyArray<{ page: string; entity: string; reason: string }> = [];

function read(rel: string): string | null {
  const abs = path.resolve(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, "utf8");
}

describe("EntityDetailLayout adoption — PR-4", () => {
  describe.each(ADOPTED_PAGES)(
    "$entity detail ($page)",
    ({ page, entity }) => {
      const src = read(page);

      it("file exists at the documented path", () => {
        expect(src).not.toBeNull();
      });

      it("imports EntityDetailLayout from the canonical layout module", () => {
        expect(src).toMatch(
          /import\s+\{[^}]*\bEntityDetailLayout\b[^}]*\}\s+from\s+['"]@\/components\/layout\/EntityDetailLayout['"]/,
        );
      });

      it("renders <EntityDetailLayout> at least once", () => {
        expect(src).toMatch(/<EntityDetailLayout\b/);
      });

      it("does not regress to a hand-rolled top-level header for the migrated entity", () => {
        // The pre-migration shape was a flex header with a back link
        // (`<Link className="text-content-muted hover:text-content-emphasis...">`)
        // immediately followed by an inline `<Heading level={1}>`.
        // Once migrated, the back link is the shell's `back` prop.
        // Reject any reintroduction of the hand-rolled `← Back` link
        // outside the shell prop value.
        //
        // We allow `back={{ href: ..., label: ... }}` (the shell prop)
        // but reject a literal `← ` followed by `</Link>` at the same
        // indentation as the heading — that's the old shape.
        const handRolledBack = /<Link[^>]*>\s*←\s*[^<]+<\/Link>/.test(src ?? "");
        expect({ entity, handRolledBack }).toEqual({ entity, handRolledBack: false });
      });
    },
  );

  it("Wave-2 deferred entries are real files with documented reasons", () => {
    for (const { page, reason } of WAVE_2_DEFERRED) {
      const abs = path.resolve(ROOT, page);
      expect(fs.existsSync(abs)).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("Wave-2 backlog is bounded — graduate entries to ADOPTED_PAGES, do not grow this list", () => {
    // Bumping this means we're putting MORE detail pages on the
    // hand-rolled side. Should only ever shrink.
    expect(WAVE_2_DEFERRED.length).toBeLessThanOrEqual(5);
  });

  it("every detail-page route under `src/app/t/[tenantSlug]/(app)` is either adopted or explicitly deferred", () => {
    // Walk app pages and find every `*/[*]/page.tsx` route. Each must
    // appear in ADOPTED_PAGES, WAVE_2_DEFERRED, or KNOWN_NON_DETAIL.
    const adopted = new Set(ADOPTED_PAGES.map((a) => a.page));
    // Some pages have their layout in a sibling Client component
    // (e.g. access-reviews/[reviewId]/page.tsx is a thin server shell
    // that delegates to AccessReviewDetailClient.tsx). Treat the page
    // file as covered if its directory contains any adopted file.
    const adoptedDirs = new Set<string>();
    for (const a of ADOPTED_PAGES) {
      adoptedDirs.add(path.dirname(a.page));
    }
    const deferred = new Set(WAVE_2_DEFERRED.map((d) => d.page));

    // Routes that are nested sub-pages of a parent entity (e.g. tests
    // sub-page under controls) — these have their own layout needs and
    // are not the entity's primary detail surface. Documented here so
    // the ratchet doesn't flag them.
    const KNOWN_NON_PRIMARY_DETAIL = new Set<string>([
      "src/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/readiness/page.tsx",
      "src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/assessment/[assessmentId]/page.tsx",
      "src/app/t/[tenantSlug]/(app)/issues/[issueId]/page.tsx", // legacy redirect → /farm-tasks/[id]
      "src/app/t/[tenantSlug]/(app)/admin/vendor-templates/[templateId]/page.tsx",
      "src/app/t/[tenantSlug]/(app)/admin/vendor-assessment-reviews/[assessmentId]/page.tsx",
      // Offline operator PWA — phones-with-gloves field-execution surface
      // (big touch targets, queue-and-sync). Intentionally NOT an
      // EntityDetailLayout chrome page; it renders the operator panel.
      "src/app/t/[tenantSlug]/(app)/field/[taskId]/page.tsx",
    ]);

    function walk(dir: string, out: string[] = []): string[] {
      if (!fs.existsSync(dir)) return out;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name === "page.tsx") out.push(full);
      }
      return out;
    }
    const allPages = walk(APP_ROOT)
      .map((abs) => path.relative(ROOT, abs))
      // Detail pages have a SECOND `[param]` segment beyond the
      // outer `[tenantSlug]`. Plain list/dashboard routes only have
      // the tenant slug — we filter those out.
      .filter((rel) => (rel.match(/\[[^\]]+\]/g) ?? []).length >= 2);

    const unknown: string[] = [];
    for (const page of allPages) {
      if (adopted.has(page)) continue;
      if (deferred.has(page)) continue;
      if (KNOWN_NON_PRIMARY_DETAIL.has(page)) continue;
      // page may be covered indirectly by a sibling Client component
      const dir = path.dirname(page);
      if (adoptedDirs.has(dir)) continue;
      unknown.push(page);
    }
    expect(unknown).toEqual([]);
  });
});

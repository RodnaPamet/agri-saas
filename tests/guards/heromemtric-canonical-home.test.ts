/**
 * Roadmap-9 PR-8 — HeroMetric canonical home.
 *
 * Per user directive (R9 north-star locked 2026-05-11):
 * canonicalize `<HeroMetric>` as the dashboard-masthead primitive.
 * Don't retire it; document the canonical home and lock the
 * boundary so it doesn't spread to surfaces where the 72px metric
 * would feel out of place (admin pages, detail pages, modals).
 *
 * Today the primitive has exactly one consumer:
 * `src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx`
 * — the main tenant dashboard masthead. The 72px value carries the
 * executive verdict (overall compliance score / readiness percent).
 * That's the right home: a 72px number reads as "the headline
 * answer" only in a masthead context.
 *
 * What this ratchet locks:
 *
 *   1. The primitive file exists with the locked 72px / hero-tier
 *      typography contract.
 *   2. The canonical home (DashboardClient) mounts it.
 *   3. No OTHER file in src/app reaches for it. A future PR
 *      proposing a second consumer must add the path to
 *      ADDITIONAL_HOMES with a written rationale.
 *
 * Why a registry instead of "ban everywhere but X":
 *   • R10 (delight round) may extend the masthead pattern to the
 *     org-level dashboard. ADDITIONAL_HOMES is the explicit
 *     extension surface — adding `src/app/org/.../dashboard/...`
 *     when the time comes is a one-line ratchet diff that documents
 *     the new home rather than silently widening the ban.
 *   • The 72px is a load-bearing typographic decision. Spreading
 *     it casually (e.g. a 72px practice count on a detail page)
 *     dilutes the masthead signal.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIR = "src/app";

const PRIMITIVE = "src/components/ui/HeroMetric.tsx";

// The farm-UI trim removed the HeroMetric masthead from the main tenant
// dashboard (its only consumer). The primitive is retained for reuse but
// currently has NO home — so the canonical-home list is empty and the
// "no other file mounts it" ban below now applies everywhere.
const CANONICAL_HOMES: string[] = [];

/**
 * Future R10+ extensions of the masthead pattern get added here
 * with a comment explaining why the 72px metric belongs at the
 * new surface. The ratchet's "no other file mounts HeroMetric"
 * assertion treats these as allowlist additions.
 */
const ADDITIONAL_HOMES: Record<string, string> = {
    // empty — populate as R10+ extensions land
};

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

describe("HeroMetric canonical home", () => {
    it("primitive exists at the expected path", () => {
        expect(fs.existsSync(path.join(ROOT, PRIMITIVE))).toBe(true);
    });

    it("primitive carries the locked 72px hero typography contract", () => {
        const src = fs.readFileSync(path.join(ROOT, PRIMITIVE), "utf8");
        // The 72px is the load-bearing decision. If a future PR
        // tries to bump down to text-5xl (48px) or text-7xl (72px
        // via Tailwind's named class) silently, the assertion
        // surfaces the change.
        expect(src).toMatch(/text-\[72px\]|text-7xl/);
    });

    it("the farm dashboard no longer mounts <HeroMetric> (masthead removed)", () => {
        // Forward-guard the removal: the main tenant dashboard was the
        // canonical home and dropped the hero in the farm-UI trim.
        const src = fs.readFileSync(
            path.join(ROOT, "src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx"),
            "utf8",
        );
        expect(src).not.toMatch(/<HeroMetric\b/);
    });

    it("no OTHER file in src/app mounts <HeroMetric> (allowlist via ADDITIONAL_HOMES)", () => {
        const allowed = new Set<string>([
            ...CANONICAL_HOMES,
            ...Object.keys(ADDITIONAL_HOMES),
        ]);
        const offenders: string[] = [];
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const rel = path.relative(ROOT, file);
            if (allowed.has(rel)) continue;
            const content = fs.readFileSync(file, "utf8");
            if (/<HeroMetric\b/.test(content)) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `Found <HeroMetric> usage outside the canonical / allowed homes:\n${offenders.map((o) => `  ${o}`).join("\n")}\n\nThe 72px hero metric is a load-bearing typographic decision reserved for the dashboard masthead. If the new surface is genuinely a masthead context (e.g., org-level dashboard hero, executive-report header), add the file to ADDITIONAL_HOMES in this ratchet with a written rationale in the same diff. Otherwise migrate to a smaller metric primitive (KPIStat) or a custom display.`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it("ADDITIONAL_HOMES entries each have a non-trivial rationale", () => {
        for (const [, rationale] of Object.entries(ADDITIONAL_HOMES)) {
            expect(rationale.length).toBeGreaterThan(40);
        }
    });
});

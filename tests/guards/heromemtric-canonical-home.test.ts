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
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
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
    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `walk` and NOT ONE test went red. Its only
    // call site is the `for (const file of walk(...))` loop in the ban
    // below, so `return []` runs that loop zero times: `offenders` stays
    // empty, the throw never fires, `expect(offenders).toHaveLength(0)`
    // passes. "214 files scanned, none mounts the hero" and "no file was
    // ever opened" were the same green. The other four tests never call it.
    //
    // `[]` is also the ONLY gut the tool could score: the `: string[]`
    // return annotation makes '' / 0 / null / undefined / false / Set / Map
    // / {} fail to compile, so they are skipped rather than run. Two of
    // those ('' and an empty Set / Map) would have passed the for-of seam
    // untouched — the annotation, not any assertion, is what removed them.
    //
    // The `fs.existsSync` throw (#875) does not cover this: it lives INSIDE
    // `walk`, so gutting the body removes it too. A floor one layer down
    // cannot protect a caller that stops calling it, which is why the
    // second control asserts that throw from the outside.

    it("control: walk returns the real .tsx population under src/app", () => {
        const files = walk(path.join(ROOT, SCAN_DIR));
        expect(Array.isArray(files)).toBe(true);
        const rels = files.map((f) =>
            path.relative(ROOT, f).split(path.sep).join("/"),
        );

        // Measured 2026-09-19: 214 `.tsx` files under `src/app` (588 files
        // in all). The floor sits far below that, so ordinary feature work
        // never moves it.
        expect(rels.length).toBeGreaterThan(120);
        expect(rels.filter((r) => !r.startsWith(`${SCAN_DIR}/`))).toEqual([]);

        // The extension filter is `walk`'s only exclusion and it has to
        // BITE. Derived rather than named: `src/app` itself holds non-.tsx
        // files (globals.css, favicon.ico, icon.svg, the global-error CSS
        // module — 4 measured).
        const nonTsxAtRoot = fs
            .readdirSync(path.join(ROOT, SCAN_DIR), { withFileTypes: true })
            .filter((e) => e.isFile() && !e.name.endsWith(".tsx"))
            .map((e) => `${SCAN_DIR}/${e.name}`);
        expect(nonTsxAtRoot.length).toBeGreaterThan(1);
        expect(rels.filter((r) => nonTsxAtRoot.includes(r))).toEqual([]);
        expect(rels.filter((r) => !r.endsWith(".tsx"))).toEqual([]);

        // RECURSION — the one behaviour a constant return cannot express.
        // Measured: the deepest page is 9 segments from the repo root
        // (`src/app/t/[tenantSlug]/(app)/grain/bins/[binId]/page.tsx`).
        expect(
            Math.max(...rels.map((r) => r.split("/").length)),
        ).toBeGreaterThanOrEqual(6);

        // POSITIVE ANCHOR from real product source: the ex-canonical home,
        // the one file the third test below opens by hard-coded path. If
        // `walk` cannot reach it, "no OTHER file mounts it" is a statement
        // about the empty set.
        expect(rels).toContain(
            "src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx",
        );
    });

    it("control: walk throws when the scan root does not exist (#875)", () => {
        // Asserted from OUTSIDE, because the throw sits inside the function
        // the mutation replaces — it can only be proved from a caller.
        expect(() =>
            walk(path.join(ROOT, SCAN_DIR, "__no_such_directory__")),
        ).toThrow(/scan root does not exist/);
    });

    it("control: the <HeroMetric detector matches real source and ignores near-misses", () => {
        // The other half of the chain. The detector is spelled INLINE in the
        // ban below, so `selector-teeth` never reaches it — and a pattern
        // that matches nothing is worth exactly what an empty walk is worth.
        const HERO_MOUNT = /<HeroMetric\b/; // the same literal as the ban

        // POSITIVE CONTROL from REAL product source: the primitive's own
        // docblock spells the tag, so it genuinely matches; it is not an
        // offender only because it lives OUTSIDE the scan root, which is
        // what makes it usable here. Read through PRIMITIVE so it cannot
        // drift from the file the two tests above pin. There is no live
        // MOUNT to point at by construction — this ratchet exists to keep
        // src/app free of them, and CANONICAL_HOMES / ADDITIONAL_HOMES are
        // both empty — and the sibling guard
        // tests/guards/dashboard-masthead-discipline.test.ts uses the same
        // source for the same reason.
        const primitive = fs.readFileSync(path.join(ROOT, PRIMITIVE), "utf8");
        expect(primitive.length).toBeGreaterThan(2000); // measured: 13,166 bytes
        expect(HERO_MOUNT.test(primitive)).toBe(true);

        // A mount as it would actually be written under src/app…
        expect(HERO_MOUNT.test('    <HeroMetric value={pct} label="Readiness" />')).toBe(true);
        // …and the near-misses that must NOT trip it. This is what the `\b`
        // buys: drop it and the first of these reddens.
        expect(HERO_MOUNT.test("<HeroMetricStrip />")).toBe(false);
        expect(HERO_MOUNT.test("import { HeroMetric } from '@/components/ui/metric';")).toBe(false);
    });
    // ── Control (#971) — `isExempt` is a DIFFERENT finding ────────────
    //
    // It also survived, and it is not the same defect. Its `: boolean`
    // annotation is what makes that true, in both directions:
    //
    //   • The DANGEROUS direction is unreachable by the tool. `isExempt` is
    //     consumed as `if (isExempt(rel)) continue` INSIDE `walk`, so ANY
    //     truthy return skips every entry and the walk collects nothing —
    //     and "no offenders" is exactly what an empty walk produces. The
    //     four truthy guts ({} / [] / new Set() / new Map()) all violate
    //     `boolean` and never compile, so the annotation, not an assertion,
    //     is all that stands there. The negative half below covers it.
    //   • The gut that DID survive, `false`, is a mutation that does not
    //     mutate. Measured 2026-09-19: `src/app` holds 214 `.tsx` files and
    //     ZERO node_modules / __tests__ / __mocks__ directories and ZERO
    //     *.test.tsx / *.spec.tsx / *.stories.tsx — so `isExempt` already
    //     returns false for every input this guard feeds it. Same
    //     population, same result: a failed probe, not a coverage hole. So
    //     this control pins the MECHANISM, not today's emptiness.

    it("control: isExempt exempts the shapes it lists, and nothing in the real population", () => {
        // POSITIVE half — each exclusion must actually bite. Derived from
        // the guard's own lists, so editing either one is covered.
        expect(EXEMPT_DIR_NAMES.size).toBeGreaterThan(0);
        for (const dirName of EXEMPT_DIR_NAMES) {
            expect(isExempt(path.join(SCAN_DIR, dirName, "Widget.tsx"))).toBe(true);
        }
        for (const name of ["Widget.test.tsx", "Widget.spec.tsx", "Widget.stories.tsx"]) {
            expect(EXEMPT_FILE_PATTERNS.some((rx) => rx.test(name))).toBe(true);
            expect(isExempt(path.join(SCAN_DIR, "dashboard", name))).toBe(true);
        }

        // NEGATIVE half, at the CALL SITE and on the value the ban
        // consumes. A blanket-true `isExempt` empties the walk; the floor is
        // what turns that into a red rather than a quieter green. It is
        // asserted BEFORE the filter below, which would otherwise pass
        // vacuously over an empty population.
        const rels = walk(path.join(ROOT, SCAN_DIR)).map((f) =>
            path.relative(ROOT, f).split(path.sep).join("/"),
        );
        expect(rels.length).toBeGreaterThan(120); // measured: 214
        expect(rels.filter((r) => isExempt(r))).toEqual([]);
        expect(
            isExempt("src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx"),
        ).toBe(false);
    });

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

    it("control: the allowlist skip and the rationale floor can both fire", () => {
        // NOT a `selector-teeth` finding — these are lists, not functions,
        // so the tool never scored them. They are controlled here because
        // both are EMPTY today, which makes two things in this file assert
        // nothing: the `allowed.has(rel)` skip in the ban can never fire,
        // and the rationale test below loops zero times. Per the triage
        // rule, control the MECHANISM rather than pinning today's emptiness
        // — so both rules run over a probe list, and the day a real second
        // home lands the rule it has to satisfy is already proved to bite.
        const RATIONALE_MIN = 40; // the floor spelled in the test below
        const probe: Record<string, string> = {
            "src/app/org/[orgId]/dashboard/OrgDashboardClient.tsx":
                "org-level masthead — the 72px number carries the same executive verdict one level up, so it still reads as the headline answer.",
            "src/app/t/[tenantSlug]/(app)/assets/page.tsx": "because",
        };
        const tooShort = Object.entries(probe)
            .filter(([, rationale]) => rationale.length <= RATIONALE_MIN)
            .map(([file]) => file);
        expect(tooShort).toEqual(["src/app/t/[tenantSlug]/(app)/assets/page.tsx"]);

        // …and the skip itself: an allowed path is exempt from the ban, a
        // neighbouring one is not. Built the same way the ban builds it.
        const allowed = new Set<string>([
            ...CANONICAL_HOMES,
            ...Object.keys(ADDITIONAL_HOMES),
            ...Object.keys(probe),
        ]);
        expect(allowed.has("src/app/org/[orgId]/dashboard/OrgDashboardClient.tsx")).toBe(true);
        expect(
            allowed.has("src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx"),
        ).toBe(false);
    });

    it("ADDITIONAL_HOMES entries each have a non-trivial rationale", () => {
        for (const [, rationale] of Object.entries(ADDITIONAL_HOMES)) {
            expect(rationale.length).toBeGreaterThan(40);
        }
    });
});

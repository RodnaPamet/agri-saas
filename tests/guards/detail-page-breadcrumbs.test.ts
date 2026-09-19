/**
 * v2-fu-3 — Detail-page breadcrumbs coverage ratchet.
 *
 * Asserts that every page using `<EntityDetailLayout>` passes a
 * `breadcrumbs` prop. Without breadcrumbs, the user has only the
 * `back` link to navigate up — and `back` only goes one level. A
 * detail page reached through a sub-list (e.g. tasks reached via
 * audit pack) needs the full chain to feel navigable.
 *
 * The companion ratchet at
 * `tests/guards/page-breadcrumbs-coverage.test.ts` covers list
 * pages (level-1 heading sites). This one covers detail pages
 * (EntityDetailLayout consumers).
 *
 * What this ratchet enforces
 *   Every file that imports + renders `<EntityDetailLayout>` MUST
 *   pass `breadcrumbs={[...]}` on the main render path. The check
 *   is text-level — if `breadcrumbs={` appears anywhere in the
 *   file (props or const declaration), the assertion passes.
 *
 * Pairs with:
 *   - src/components/layout/EntityDetailLayout.tsx (the shell)
 *   - src/components/layout/PageHeader.tsx (the breadcrumbs slot)
 *   - tests/guards/page-breadcrumbs-coverage.test.ts (list-page
 *     coverage — the other half of the breadcrumbs story)
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/app/t"];

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

// Files that legitimately use `<EntityDetailLayout>` WITHOUT
// breadcrumbs. Each entry needs a written reason.
const EXEMPT_FILES = new Set<string>([
    // Currently empty — every detail page should have breadcrumbs.
    // If a future page genuinely doesn't need them (e.g. a modal-
    // shaped page outside the main hierarchy), add it here with a
    // written reason and bump the cap.
]);

const ENTITY_DETAIL_RE = /<EntityDetailLayout\b/;
const BREADCRUMBS_RE = /breadcrumbs\s*=\s*\{|breadcrumbs\s*:\s*\[|const\s+breadcrumbs\s*=|const\s+\w*[Bb]readcrumbs\s*=/;

interface Hit {
    file: string;
}

function isExempt(rel: string): boolean {
    if (EXEMPT_FILES.has(rel)) return true;
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
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe("detail-page breadcrumbs coverage", () => {
    it("control: walk discovers the real tree it claims to scan (#971)", () => {
        const scans = SCAN_DIRS.map((dir) => {
            const root = path.join(ROOT, dir);
            return { root, files: walk(root) };
        });
        const files = scans.flatMap((s) => s.files);

        // Floors measured 2026-09-19: 190 source files under src/app/t.
        // Set far below reality so ordinary churn never trips them — only
        // an empty selection does, which is exactly what the guard's
        // `expect(offenders).toHaveLength(0)` reads as a pass.
        expect(files.length).toBeGreaterThanOrEqual(100);

        // Every entry is a real file carrying an extension the walker
        // claims to collect, so a fabricated or stale list fails here too.
        for (const file of files) {
            expect(fs.statSync(file).isFile()).toBe(true);
            expect(file).toMatch(/\.(tsx|ts|jsx|js)$/);
        }

        // RECURSION — the one behaviour a constant return cannot express.
        // Every detail page sits 4-5 directories below the scan root
        // (…/[tenantSlug]/(app)/<section>/[id]/page.tsx), so a walker that
        // reads only the top directory returns none of the pages this
        // ratchet exists to check.
        const deepest = Math.max(
            ...scans.flatMap((s) =>
                s.files.map(
                    (f) => path.relative(s.root, f).split(path.sep).length - 1,
                ),
            ),
        );
        expect(deepest).toBeGreaterThanOrEqual(3);

        // The #875 guard is part of the mechanism, not decoration: a
        // renamed scan root must throw rather than quietly scan zero files.
        // A constant return never throws.
        expect(() => walk(path.join(ROOT, "src/app/t-renamed-away"))).toThrow(
            /scan root does not exist/,
        );
    });

    it("control: the breadcrumbs detector flags a planted offender derived from real source (#971)", () => {
        const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
        const detailPages = files.filter((file) =>
            ENTITY_DETAIL_RE.test(fs.readFileSync(file, "utf8")),
        );

        // Measured 8 on 2026-09-19. `offenders` coming back empty is also
        // what a guard that found NOTHING TO CHECK reports, so the checked
        // population needs a floor of its own.
        expect(detailPages.length).toBeGreaterThanOrEqual(5);

        const isOffender = (content: string) =>
            ENTITY_DETAIL_RE.test(content) && !BREADCRUMBS_RE.test(content);

        for (const file of detailPages) {
            const clean = fs.readFileSync(file, "utf8");

            // Clean negative: the shipped page is not an offender.
            expect(isOffender(clean)).toBe(false);

            // Planted positive, derived from the LIVE file so it cannot go
            // stale (there is no real offender — offenders is 0 by
            // construction and EXEMPT_FILES is empty): the same page with
            // every breadcrumbs spelling renamed away.
            const planted = clean.replace(/[Bb]readcrumbs/g, "navTrail");
            expect(BREADCRUMBS_RE.test(planted)).toBe(false);
            expect(isOffender(planted)).toBe(true);

            // Near-miss: a file that only MENTIONS the shell in an import
            // or a comment never renders it, so it is out of scope rather
            // than an offender. The live instance of that shape is
            // src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx,
            // whose comment names EntityDetailLayout and breadcrumbs both.
            const mentionOnly = planted.replace(
                /<EntityDetailLayout\b/g,
                "EntityDetailLayout",
            );
            expect(isOffender(mentionOnly)).toBe(false);
        }
    });
    it("every page rendering <EntityDetailLayout> also passes breadcrumbs", () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, "utf8");
                if (!ENTITY_DETAIL_RE.test(content)) continue;
                if (BREADCRUMBS_RE.test(content)) continue;
                offenders.push({ file: path.relative(ROOT, file) });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 15)
                .map((o) => `  ${o.file}`)
                .join("\n");
            throw new Error(
                `Found ${offenders.length} detail page(s) using <EntityDetailLayout> without a breadcrumbs prop. Detail pages reached from a sub-list (e.g. tasks via audit pack) need the full chain — 'back' only goes one level.\n\nAdd:\n\n  const breadcrumbs = [\n    { label: 'Dashboard', href: tenantHref('/dashboard') },\n    { label: '<Section>', href: tenantHref('/<section>') },\n    { label: <entity?.name ?? 'Entity'> },\n  ];\n\nand pass it on every <EntityDetailLayout breadcrumbs={breadcrumbs}> call (loading/error/empty/main).\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it("control: isExempt excludes what it declares, and nothing else (#971)", () => {
        // The exclusion arms are dead code against the live tree — src/app/t
        // has no __tests__ / __mocks__ / node_modules directory, no
        // .test|.spec|.stories file, and EXEMPT_FILES is empty — so the five
        // FALSY guts of this function change no result. That is a failed
        // probe, not a passing guard, and the fix is to drive the mechanism
        // with inputs derived from the lists themselves rather than to assert
        // today's emptiness.
        for (const dirName of Array.from(EXEMPT_DIR_NAMES)) {
            expect(
                isExempt(path.join("src", "app", "t", dirName, "page.tsx")),
            ).toBe(true);
        }

        const EXEMPT_SAMPLES = [
            "src/app/t/[tenantSlug]/(app)/journal/[id]/page.test.tsx",
            "src/app/t/[tenantSlug]/(app)/journal/[id]/page.test.ts",
            "src/app/t/[tenantSlug]/(app)/journal/[id]/page.spec.tsx",
            "src/app/t/[tenantSlug]/(app)/journal/[id]/page.stories.tsx",
        ];
        for (const sample of EXEMPT_SAMPLES) {
            expect(isExempt(sample)).toBe(true);
        }
        // …and every declared pattern is represented above, so a fourth
        // pattern cannot be added and left unexercised.
        for (const pattern of EXEMPT_FILE_PATTERNS) {
            expect(EXEMPT_SAMPLES.some((s) => pattern.test(s))).toBe(true);
        }

        // The exclusions are exact matches, not substring denylists: a
        // directory merely STARTING with __tests__, a file merely ENDING in
        // 'test.tsx', and a real product page must all stay in scope.
        for (const inScope of [
            "src/app/t/[tenantSlug]/(app)/contests/latest.tsx",
            "src/app/t/[tenantSlug]/(app)/__tests__helpers/page.tsx",
            "src/app/t/[tenantSlug]/(app)/journal/[id]/page.tsx",
        ]) {
            expect(isExempt(inScope)).toBe(false);
        }
    });

    it("control: the exclusions cannot swallow the population this guard scans (#971)", () => {
        // `if (isExempt(rel)) continue;` is the seam, and EVERY empty
        // container the mutation tool reaches — {}, [], new Set(), new Map()
        // — is TRUTHY there. A gutted isExempt therefore skips every entry,
        // walk returns [] at every level, and the ratchet passes having
        // checked no detail page at all. Nothing else in this file measures
        // how much of the population the exclusions cover: the cap test
        // reads EXEMPT_FILES.size and never calls isExempt.
        const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
        const detailPages = files.filter((file) =>
            ENTITY_DETAIL_RE.test(fs.readFileSync(file, "utf8")),
        );

        // Floors measured 2026-09-19 (190 files, 8 detail pages), set far
        // below reality. Without them the loop below is vacuous and passes.
        expect(files.length).toBeGreaterThanOrEqual(100);
        expect(detailPages.length).toBeGreaterThanOrEqual(5);

        // Asserted on the value the guard itself consumes, not a fresh walk
        // one layer down: every page this ratchet checks must be non-exempt.
        for (const file of detailPages) {
            expect(isExempt(path.relative(ROOT, file))).toBe(false);
        }
    });

    it("exempt list is deliberately bounded", () => {
        // Currently 0; a future exemption should be a deliberate
        // call documented inline. Cap at 5 to prevent silent growth.
        expect(EXEMPT_FILES.size).toBeLessThanOrEqual(5);
    });
});

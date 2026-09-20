/**
 * Roadmap-7 PR-3 — single H1 per page.
 *
 * A page should have ONE top-level heading. Two `<Heading level={1}>`
 * occurrences in the same source file mean either:
 *
 *   (a) the loaded branch and the loading early-return branch each
 *       render the same H1 — at runtime only one renders, but the
 *       source duplication is a maintenance hazard. Demote the
 *       loading branch's heading to level={2} with explicit
 *       "Loading X…" copy and the H1 is single-source.
 *
 *   (b) the file legitimately renders different page identities at
 *       different states — invite pages flip between "Invitation"
 *       and "Invitation expired"; auth/mfa flips between "MFA
 *       Enrollment Required" and "Verify Your Identity". These are
 *       distinct pages that share a route, and each state's H1 is
 *       its own page. They're listed in EXEMPT_FILES with reason.
 *
 * Pairs with the broader Roadmap-4 PR-8 Heading-level discipline
 * (H1 = page · H2 = section · H3 = subsection). This ratchet is the
 * complementary "no two H1s in one file" check the count-based
 * primitive ratchet doesn't cover.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIR = "src/app";

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

/**
 * Files that legitimately render different H1s at different page
 * states. Each entry must have a written reason explaining what
 * the multiple states are.
 */
const EXEMPT_FILES: Record<string, string> = {
    // The vendor-assessment external page entry went with GRC teardown T1.
    "src/app/t/[tenantSlug]/(app)/auth/mfa/page.tsx":
        "MFA gate renders distinct H1s for `enrollment` and `verification` flows — each is a separate sign-in obstacle, not a sub-section of one page.",
    "src/app/invite/[token]/page.tsx":
        "Invite preview renders one H1 for valid invite and another for `invalid / expired` — two distinct page identities.",
    "src/app/invite/org/[token]/page.tsx":
        "Org invite preview — same shape as tenant invite.",
};

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

function countH1s(content: string): number {
    // Match <Heading level={1}> / <Heading level=1> / <h1>
    const re = /<Heading\s+[^>]*\blevel=\{?1\}?|<h1\b/g;
    const matches = content.match(re);
    return matches ? matches.length : 0;
}

interface Violation {
    file: string;
    count: number;
}

describe("single H1 per page", () => {
    it("no source file has more than one <Heading level={1}> outside the exemption list", () => {
        const violations: Violation[] = [];
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            const count = countH1s(content);
            if (count <= 1) continue;
            const rel = path.relative(ROOT, file);
            if (rel in EXEMPT_FILES) continue;
            violations.push({ file: rel, count });
        }
        if (violations.length > 0) {
            const sample = violations
                .slice(0, 15)
                .map((v) => `  ${v.file}: ${v.count} H1s`)
                .join("\n");
            throw new Error(
                `Found ${violations.length} file(s) with multiple <Heading level={1}>. Demote duplicate H1s in loading / error early-return branches to level={2} with explicit "Loading X…" copy, OR — if the file legitimately renders different page identities at different states — add the file to EXEMPT_FILES with a written reason.\n\nFirst ${Math.min(15, violations.length)} offender(s):\n${sample}`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    // ── Control: the exclusion bites, and only where it claims ──
    //
    // `isExempt` is consumed as `if (isExempt(rel)) continue` INSIDE `walk`,
    // against DIRECTORIES as well as files and BEFORE the recursion — so a
    // truthy return prunes the tree at its first level, `walk` yields nothing
    // at all, and the ratchet above reports zero violations over zero files.
    // Four of the nine `scripts/selector-teeth.mjs` guts ({}, [], new Set(),
    // new Map()) are truthy objects, so that direction is reachable even
    // though the gut set never tries a bare `true`; the floor below is what
    // catches it.
    //
    // The falsy guts survive for a different reason, and it is not the
    // guard's fault: measured, the exemption list bites ZERO times under
    // src/app today — no `__tests__` / `__mocks__` / `node_modules`
    // directories there, and no `.test` / `.spec` / `.stories` `.tsx` files —
    // so "exempt nothing" changes no result. That half is a mutation that
    // does not mutate, which is why each class is exercised EXPLICITLY below
    // instead of being trusted to turn up in the scanned tree.
    it("control: isExempt excludes every class it lists and nothing else", () => {
        // The floor and the loop must live in ONE test: an empty selection
        // passes a for-loop, so without the floor a truthy gut satisfies it.
        // 100 sits far below the real population (214 `.tsx` files under
        // src/app at the time of writing) so ordinary churn never trips it.
        const scanned = walk(path.join(ROOT, SCAN_DIR));
        expect(scanned.length).toBeGreaterThan(100);
        for (const file of scanned) {
            // Shape before use: a non-string here would make every assertion
            // below meaningless, and `0` is a valid file descriptor.
            expect(typeof file).toBe("string");
            expect(fs.existsSync(file)).toBe(true);
            expect(isExempt(path.relative(ROOT, file))).toBe(false);
        }

        for (const dirName of EXEMPT_DIR_NAMES) {
            expect(isExempt(path.join("src", "app", dirName, "page.tsx"))).toBe(
                true,
            );
        }

        const EXEMPT_FILE_SAMPLES = [
            path.join("src", "app", "x", "page.test.tsx"),
            path.join("src", "app", "x", "page.spec.tsx"),
            path.join("src", "app", "x", "page.stories.tsx"),
        ];
        for (const sample of EXEMPT_FILE_SAMPLES) {
            expect(isExempt(sample)).toBe(true);
        }
        // …and every listed pattern is actually exercised by one of them, so
        // a pattern added to EXEMPT_FILE_PATTERNS without a sample fails here
        // instead of riding along unexercised.
        for (const rx of EXEMPT_FILE_PATTERNS) {
            expect(EXEMPT_FILE_SAMPLES.some((s) => rx.test(s))).toBe(true);
        }

        // The near-miss: same directory, same basename, not a test file.
        expect(isExempt(path.join("src", "app", "x", "page.tsx"))).toBe(false);
        // A real page the ratchet MUST keep scanning — one of the files the
        // EXEMPT_FILES list names, which is a different mechanism entirely.
        expect(
            isExempt(path.join("src", "app", "invite", "[token]", "page.tsx")),
        ).toBe(false);
    });

    it("exempt files actually have multiple H1s (otherwise drop them from the list)", () => {
        for (const exemptPath of Object.keys(EXEMPT_FILES)) {
            const full = path.join(ROOT, exemptPath);
            if (!fs.existsSync(full)) {
                throw new Error(
                    `EXEMPT_FILES contains a path that no longer exists: ${exemptPath}. Drop the entry — the ratchet only enforces real files.`,
                );
            }
            const count = countH1s(fs.readFileSync(full, "utf8"));
            expect(count).toBeGreaterThanOrEqual(2);
        }
    });

    it("exempt entries each have a non-trivial reason", () => {
        for (const [_file, reason] of Object.entries(EXEMPT_FILES)) {
            // 30+ chars rules out single-word "loading" / "wizard"
            // hand-waves; forces an actual sentence about why two
            // H1s in the same file is correct here.
            expect(reason.length).toBeGreaterThan(30);
        }
    });
});

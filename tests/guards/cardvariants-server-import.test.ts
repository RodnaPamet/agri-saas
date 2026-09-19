/**
 * Hotfix ratchet — server components must import `cardVariants` from
 * `@/components/ui/card-variants`, NEVER from `@/components/ui/card`.
 *
 * Background. `card.tsx` carries `"use client"` because it exports the
 * `<Card>` JSX component. In Next.js App Router, every export from a
 * `"use client"` module — INCLUDING re-exports of values from other
 * server-safe modules — becomes a client reference at the boundary.
 * When a SERVER component imports `cardVariants` from
 * `@/components/ui/card`, the symbol it gets back is a client
 * reference, not the actual cva function. Calling it during SSR
 * throws "An error occurred in the Server Components render".
 *
 * The fix: server components import from
 * `@/components/ui/card-variants` (no `"use client"` directive).
 * The client `<Card>` component still imports + re-exports
 * `cardVariants` from the same sibling so existing client-side
 * `import { Card, cardVariants } from '@/components/ui/card'` callers
 * keep working.
 *
 * Why a static ratchet instead of a runtime check: the failure mode
 * only surfaces at SSR time on the specific page — it's invisible
 * to typecheck, jest unit tests, AND the per-page Playwright suite if
 * the suite uses an authenticated cookie that bypasses the broken
 * server-side render. A static scan catches it the moment a server
 * component imports `cardVariants` from `card`.
 *
 * The first incident (hotfix #282 — Roadmap-5 PR-1) split the cva
 * function out but did NOT update the import statements at the
 * 5 known callsites; the regression went live and required a second
 * hotfix to migrate every server-component callsite + add this
 * ratchet so the next contributor cannot reintroduce the boundary
 * violation.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/app", "src/components"];

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

// `card.tsx` itself is the canonical re-exporter. The CLIENT `<Card>`
// component lives there and legitimately calls `cardVariants` —
// because it runs in the client bundle, the boundary issue does not
// apply. Excluded from the scan.
const EXEMPT_FILES = new Set<string>([
    "src/components/ui/card.tsx",
]);

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
        else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full);
    }
    return out;
}

function hasUseClientDirective(src: string): boolean {
    // The directive must be the first executable statement of the
    // module — but Next allows it after a leading docblock. Match
    // any line in the file that is exactly `"use client"` /
    // `'use client'` (with optional trailing semicolon).
    return /^['"]use client['"];?$/m.test(src);
}

interface Offender {
    file: string;
    line: number;
    text: string;
}

describe("cardVariants server-import boundary", () => {
    // ── Controls (#971) ──────────────────────────────────────────────
    // `walk` IS the population: the scan below is
    // `for (const file of walk(path.join(ROOT, dir)))`, so a walk that
    // hands back nothing collects no offenders and
    // `expect(offenders).toHaveLength(0)` passes having opened no file.
    // `selector-teeth` confirmed it survives being gutted to `[]` — and a
    // gut replaces the whole body, so the #875 missing-root `throw` inside
    // it goes too and cannot report the loss.
    it("control: walk reaches both scan roots and returns real source files", () => {
        const perRoot = SCAN_DIRS.map((dir) => walk(path.join(ROOT, dir)));
        // src/app holds ~580 files and src/components ~690. The floor sits
        // far below both, so ordinary deletions never move it, and far
        // above zero, which is what a gutted walk returns.
        for (const files of perRoot) {
            expect(files.length).toBeGreaterThan(200);
        }

        const scanned = perRoot.flat();
        for (const file of scanned) {
            expect(path.isAbsolute(file)).toBe(true);
            expect(file).toMatch(/\.tsx?$/);
        }

        const rel = scanned.map((f) => path.relative(ROOT, f));
        // The module this ratchet is about is inside the population…
        expect(rel).toContain(
            path.join("src", "components", "ui", "card-variants.ts"),
        );
        // …and the canonical re-exporter is filtered out, which is the
        // isExempt control's subject.
        expect(rel).not.toContain(
            path.join("src", "components", "ui", "card.tsx"),
        );

        // A non-empty walk is still not the guarantee this guard needs.
        // What it polices is SERVER components that use `cardVariants`, so
        // that class has to be inside the population: five files today —
        // two admin pages, two `ui/` cards, and the definition module.
        // Zero would mean the scan is green over a class that is not there.
        let serverComponents = 0;
        const serverCardVariantsUsers: string[] = [];
        for (const file of scanned) {
            const content = fs.readFileSync(file, "utf8");
            if (hasUseClientDirective(content)) continue;
            serverComponents += 1;
            if (content.includes("cardVariants")) {
                serverCardVariantsUsers.push(path.relative(ROOT, file));
            }
        }
        expect(serverComponents).toBeGreaterThan(100);
        expect(serverCardVariantsUsers.length).toBeGreaterThanOrEqual(4);
        expect(serverCardVariantsUsers).toEqual(
            expect.arrayContaining([
                path.join("src", "components", "ui", "ProgressCard.tsx"),
                path.join("src", "components", "ui", "StatusBreakdown.tsx"),
            ]),
        );
    });

    it("control: the import detector fires on a corrupted real file, not on the pristine one", () => {
        // The control above proves the scan has something to read. This one
        // proves a read file can still FAIL. Fed only a hand-written
        // fixture a detector proves nothing about the path that executes,
        // so the positive is a real server component with its import
        // specifier corrupted to the banned one.
        const target = path.join(ROOT, "src/components/ui/ProgressCard.tsx");
        const pristine = fs.readFileSync(target, "utf8");
        const corrupted = pristine.replace(
            "from '@/components/ui/card-variants'",
            "from '@/components/ui/card'",
        );
        expect(corrupted).not.toEqual(pristine);
        // It has to be a SERVER component, or the scan would skip it and
        // the corruption would prove nothing.
        expect(hasUseClientDirective(pristine)).toBe(false);

        // The two halves of the rule, spelled exactly as the scan below
        // spells them inline (the scan lives inside its `it`, so there is
        // no function to call — see the drift pin at the end).
        const USES_CARD_VARIANTS = /\bcardVariants\b/;
        const FROM_CARD_MODULE =
            /from\s+['"]@\/components\/ui\/card(?!-variants)['"]/;
        const offendingLines = (content: string): string[] =>
            content
                .split("\n")
                .filter(
                    (line) =>
                        USES_CARD_VARIANTS.test(line) &&
                        FROM_CARD_MODULE.test(line),
                );

        expect(offendingLines(pristine)).toEqual([]);
        expect(offendingLines(corrupted)).toHaveLength(1);
        expect(offendingLines(corrupted)[0]).toContain(
            "@/components/ui/card'",
        );

        // The `(?!-variants)` lookahead is the whole precision of the rule,
        // so pin both sides of it on the shapes that occur in the tree.
        expect(
            offendingLines(
                "import { cardVariants } from '@/components/ui/card-variants';",
            ),
        ).toEqual([]);
        expect(
            offendingLines("import { Card } from '@/components/ui/card';"),
        ).toEqual([]);
        expect(
            offendingLines(
                "import { Card, cardVariants } from '@/components/ui/card';",
            ),
        ).toHaveLength(1);

        // DRIFT PIN. The two regexes above are a SECOND copy of what the
        // scan spells inline, so this control could go on proving an
        // obsolete rule. Each literal must therefore appear TWICE in this
        // file — once in the scan loop, once here. Each occurs exactly once
        // today, so editing the loop's pattern without editing this copy
        // drops the count to one and fails here instead of passing quietly.
        const self = fs.readFileSync(
            path.join(__dirname, "cardvariants-server-import.test.ts"),
            "utf8",
        );
        for (const pattern of [USES_CARD_VARIANTS, FROM_CARD_MODULE]) {
            expect(self.split(String(pattern)).length - 1).toBeGreaterThanOrEqual(
                2,
            );
        }
    });

    it("no server component imports cardVariants from @/components/ui/card", () => {
        const offenders: Offender[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, "utf8");
                if (hasUseClientDirective(content)) continue;
                const lines = content.split("\n");
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    // Only flag the SPECIFIC bad shape: an import
                    // that pulls `cardVariants` from `card` (NOT
                    // `card-variants`). The `(?!-variants)` lookahead
                    // makes the match path-precise.
                    if (
                        /\bcardVariants\b/.test(line) &&
                        /from\s+['"]@\/components\/ui\/card(?!-variants)['"]/.test(
                            line,
                        )
                    ) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            line: i + 1,
                            text: line.trim(),
                        });
                    }
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 15)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join("\n");
            throw new Error(
                `Found ${offenders.length} server component(s) importing cardVariants from "@/components/ui/card". Use "@/components/ui/card-variants" instead — the "use client" boundary in card.tsx turns the import into a client reference that cannot be invoked during SSR. See tests/guards/cardvariants-server-import.test.ts for the rationale.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    // ── Control (#971) ───────────────────────────────────────────────
    // `isExempt` gates the walk at `if (isExempt(rel)) continue`, and the
    // tool reported it as a survivor — but that survival is a FAILED
    // PROBE, not a hole. `selector-teeth` guts to falsy only, and falsy
    // here means "exempt nothing", which WIDENS the scan by three entries
    // today: card.tsx (which `hasUseClientDirective` skips anyway) and the
    // two files under src/components/ui/hooks/__tests__, none of which
    // carries the banned import. Nothing changes, so nothing notices.
    //
    // The direction that WOULD hollow this guard out is `true`, which the
    // tool never tries: a predicate that answers "exempt" to everything
    // makes `walk` return [] from a root that exists, and the scan passes
    // having read no file. So this exercises the mechanism in both
    // directions instead of asserting today's exempt set.
    it("control: isExempt excludes the re-exporter and test-shaped paths, and nothing else", () => {
        // One case per exclusion source, so each arm is proved to fire.
        expect(
            isExempt(path.join("src", "components", "ui", "card.tsx")),
        ).toBe(true); // EXEMPT_FILES
        expect(
            isExempt(
                path.join(
                    "src",
                    "components",
                    "ui",
                    "hooks",
                    "__tests__",
                    "use-x.test.tsx",
                ),
            ),
        ).toBe(true); // EXEMPT_DIR_NAMES
        expect(
            isExempt(path.join("src", "components", "ui", "card.test.tsx")),
        ).toBe(true); // EXEMPT_FILE_PATTERNS
        expect(isExempt(path.join("src", "app", "x.spec.ts"))).toBe(true);
        expect(
            isExempt(path.join("src", "components", "x.stories.tsx")),
        ).toBe(true);

        // The files this guard exists to READ are not exempt.
        expect(
            isExempt(path.join("src", "components", "ui", "card-variants.ts")),
        ).toBe(false);
        expect(
            isExempt(path.join("src", "components", "ui", "ProgressCard.tsx")),
        ).toBe(false);
        expect(
            isExempt(
                path.join(
                    "src",
                    "app",
                    "t",
                    "[tenantSlug]",
                    "(app)",
                    "admin",
                    "rbac",
                    "page.tsx",
                ),
            ),
        ).toBe(false);

        // …and the predicate discriminates rather than matching on
        // substring: the directory check is a SEGMENT match and the file
        // patterns are dot-anchored, so neither near-miss is exempt.
        expect(
            isExempt(path.join("src", "components", "__tests__helper.tsx")),
        ).toBe(false);
        expect(isExempt(path.join("src", "components", "latest.tsx"))).toBe(
            false,
        );

        // The `true` hazard, measured rather than argued about: an
        // always-exempt predicate empties `walk`, and this floor is the
        // only assertion in the file that would notice.
        const scanned = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
        expect(scanned.length).toBeGreaterThan(400);
    });

    it("card-variants module exists and is server-safe (no use-client directive)", () => {
        const cardVariantsPath = path.join(
            ROOT,
            "src/components/ui/card-variants.ts",
        );
        expect(fs.existsSync(cardVariantsPath)).toBe(true);
        const src = fs.readFileSync(cardVariantsPath, "utf8");
        expect(hasUseClientDirective(src)).toBe(false);
        // Sanity: it actually exports cardVariants.
        expect(src).toMatch(/export\s+const\s+cardVariants\s*=/);
    });
});

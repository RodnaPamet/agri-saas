/**
 * v2-PR-2 — Semantic spacing scale ratchet.
 *
 * The five semantic spacing tokens (defined in tailwind.config.js)
 * replace the high-frequency raw numeric gap/space-y utilities:
 *
 *   gap-2 / space-y-2 (8 px)  → tight
 *   gap-3 / space-y-3 (12 px) → compact
 *   gap-4 / space-y-4 (16 px) → default
 *   gap-6 / space-y-6 (24 px) → section
 *   gap-8 / space-y-8 (32 px) → page (closest semantic, used sparingly)
 *
 * Why a ratchet:
 *   The whole point of the scale is consumer-side discipline. Without
 *   forward enforcement, the next dev who needs "16 px gap" will pick
 *   `gap-4` and the vocabulary gradually de-unifies.
 *
 * What this ratchet does NOT ban:
 *   - `gap-1` / `space-y-1` (4 px micro spacing) — kept as raw inside
 *     primitives where the exact value is part of the render contract
 *     (e.g. button-variants.ts xs size, icon-text gaps).
 *   - `gap-1.5` / `gap-2.5` etc. (decimal sub-step values) — used for
 *     dense interaction areas (segmented toggles, dropdown rows).
 *   - `gap-0`, `space-y-0` — explicit-zero overrides, not magnitude.
 *   - `gap-5`, `space-y-5`, `gap-7`, etc. — rare odd magnitudes; if
 *     the count grows past a handful, define a new semantic token
 *     instead of widening the raw allowlist.
 *
 * Pairs with:
 *   - `tailwind.config.js` (the spacing token definitions)
 *   - `tests/guardrails/cva-primitives.test.ts` (per-primitive shape
 *     assertions — the ratchet runs across application code, not
 *     primitive internals).
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

// Files where raw numeric spacing utilities are deliberately part of
// the render contract. Each exemption needs a written reason.
const EXEMPT_FILES = new Set<string>([
    // Legacy `.btn-lg { @apply ... gap-2 }` lives in CSS, not TSX —
    // this scanner doesn't touch CSS files anyway, but listing it
    // documents the residual usage.
    // (Kept for reference; not required for the scan.)
]);

// Pattern bans the migrated-away numerics. Word boundary on both
// sides — `gap-2` matches but `gap-2.5` doesn't (the `.` would not
// be a word boundary on the trailing side; we explicitly check the
// next char is not `[.0-9]`).
const BANNED_GAPS = ["gap-2", "gap-3", "gap-4", "gap-6", "gap-8"];
const BANNED_SPACE_Y = [
    "space-y-2",
    "space-y-3",
    "space-y-4",
    "space-y-6",
    "space-y-8",
];
const ALL_BANNED = [...BANNED_GAPS, ...BANNED_SPACE_Y];

// Build a single regex that captures any banned utility WITHOUT
// matching `gap-2.5`, `gap-20`, `gap-200`. The leading boundary is a
// non-class char; the trailing boundary is a non-`[.0-9]` char (or
// end-of-string).
const BANNED_RE = new RegExp(
    `(?<![a-zA-Z0-9.-])(${ALL_BANNED.join("|")})(?![.0-9])`,
);

interface Hit {
    file: string;
    line: number;
    text: string;
    util: string;
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

describe("v2-PR-2 semantic spacing scale ratchet", () => {
    // ── Control (#971): the exclusion bites, and only where it claims ──
    //
    // `isExempt` is consumed as `if (isExempt(rel)) continue` INSIDE `walk`,
    // against DIRECTORIES as well as files and before the recursion — so a
    // truthy return prunes both scan roots at their first level, `walk`
    // yields nothing, and the offender loop below iterates over an empty
    // population. `expect(offenders).toHaveLength(0)` is EXACTLY what that
    // produces, which is why `selector-teeth` found this selector surviving
    // all nine guts:
    //
    //   - the four truthy ones (`[]`, `{}`, `new Set()`, `new Map()`) empty
    //     the scan, and an empty scan is the ratchet's own success shape;
    //   - the five falsy ones (`''`, `0`, `null`, `undefined`, `false`) only
    //     ADD the two files under `src/components/ui/hooks/__tests__`, and
    //     neither of them carries a banned utility — a mutation that does
    //     not mutate any observable of the assertion.
    //
    // Neither direction is reachable through the ratchet's assertion, so both
    // are asserted here explicitly. The floor and the loop must live in ONE
    // test: an empty selection passes a for-loop, so without the floor a
    // truthy gut satisfies it.
    it("control: isExempt exempts every class it lists and nothing in the scanned population", () => {
        const scanned = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
        // 1,272 files at the time of writing — floored far below so ordinary
        // churn never trips it, but a pruned-to-nothing walk always does.
        expect(scanned.length).toBeGreaterThan(400);
        for (const file of scanned) {
            // Shape before any filesystem call: `0` is a valid file
            // descriptor, so a non-string path must never reach `fs`.
            expect(typeof file).toBe("string");
            expect(fs.existsSync(file)).toBe(true);
            expect(isExempt(path.relative(ROOT, file))).toBe(false);
        }

        // A REAL exemption, not a synthetic one: this file is on disk under a
        // scan root, is exempt by BOTH rules (the `__tests__` segment and the
        // `.test.ts` pattern), and must be absent from the walk.
        const REAL_EXEMPT = path.join(
            "src",
            "components",
            "ui",
            "hooks",
            "__tests__",
            "use-toast-with-undo.test.ts",
        );
        expect(fs.existsSync(path.join(ROOT, REAL_EXEMPT))).toBe(true);
        expect(isExempt(REAL_EXEMPT)).toBe(true);
        expect(scanned).not.toContain(path.join(ROOT, REAL_EXEMPT));

        // Every declared class, exercised explicitly rather than trusted to
        // turn up in the tree — the directory names below have no instance
        // under `src/app` at all.
        for (const dirName of EXEMPT_DIR_NAMES) {
            expect(
                isExempt(path.join("src", "components", dirName, "Widget.tsx")),
            ).toBe(true);
        }
        const EXEMPT_FILE_SAMPLES = [
            path.join("src", "components", "x", "Widget.test.tsx"),
            path.join("src", "components", "x", "Widget.spec.tsx"),
            path.join("src", "components", "x", "Widget.stories.tsx"),
        ];
        for (const sample of EXEMPT_FILE_SAMPLES) {
            expect(isExempt(sample)).toBe(true);
        }
        // …and every listed pattern is actually exercised by one of them, so a
        // pattern added to EXEMPT_FILE_PATTERNS without a sample fails here
        // instead of riding along unexercised.
        for (const rx of EXEMPT_FILE_PATTERNS) {
            expect(EXEMPT_FILE_SAMPLES.some((s) => rx.test(s))).toBe(true);
        }

        // The near-misses: same directory, same basename, not a test file.
        expect(isExempt(path.join("src", "components", "x", "Widget.tsx"))).toBe(
            false,
        );
        expect(isExempt(path.join("src", "app", "page.tsx"))).toBe(false);

        // `EXEMPT_FILES` is empty, so isExempt's first branch is inert today
        // and no assertion above can reach it. Pinned rather than looped over:
        // a `for (const f of EXEMPT_FILES)` would pass vacuously, which is the
        // empty-selection defect this control exists to close. Adding an entry
        // fails here — that failure is the prompt to assert it directly.
        expect(EXEMPT_FILES.size).toBe(0);
    });

    describe("migrated-away numerics are not reintroduced", () => {
        it("zero `gap-{2,3,4,6,8}` or `space-y-{2,3,4,6,8}` outside exempts", () => {
            const offenders: Hit[] = [];
            for (const dir of SCAN_DIRS) {
                for (const file of walk(path.join(ROOT, dir))) {
                    const content = fs.readFileSync(file, "utf8");
                    const lines = content.split("\n");
                    lines.forEach((line, i) => {
                        const trimmed = line.trim();
                        if (
                            trimmed.startsWith("//") ||
                            trimmed.startsWith("*")
                        )
                            return;
                        const m = BANNED_RE.exec(line);
                        if (m) {
                            offenders.push({
                                file: path.relative(ROOT, file),
                                line: i + 1,
                                text: trimmed.slice(0, 200),
                                util: m[1],
                            });
                        }
                    });
                }
            }
            if (offenders.length > 0) {
                const sample = offenders
                    .slice(0, 15)
                    .map(
                        (o) =>
                            `  ${o.file}:${o.line}  (${o.util})\n    ${o.text}`,
                    )
                    .join("\n");
                throw new Error(
                    `Found ${offenders.length} raw numeric spacing utility/utilities outside primitives. Use the v2-PR-2 semantic scale: tight (8 px) | compact (12 px) | default (16 px) | section (24 px) | page (40 px).\n\nMigration map:\n  gap-2 / space-y-2 → -tight\n  gap-3 / space-y-3 → -compact\n  gap-4 / space-y-4 → -default\n  gap-6 / space-y-6 → -section\n  gap-8 / space-y-8 → -page\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
                );
            }
            expect(offenders).toHaveLength(0);
        });
    });

    describe("tailwind.config.js declares the 5 semantic tokens", () => {
        const cfg = fs.readFileSync(
            path.join(ROOT, "tailwind.config.js"),
            "utf8",
        );

        it("declares the spacing extend block with all five tokens", () => {
            // The block lives inside theme.extend.spacing — check the
            // token names are present with the documented values.
            const block = cfg.match(/spacing:\s*\{([\s\S]*?)\}/);
            expect(block).not.toBeNull();
            const inner = block![1];
            expect(inner).toMatch(/tight:\s*['"]0\.5rem['"]/);
            expect(inner).toMatch(/compact:\s*['"]0\.75rem['"]/);
            expect(inner).toMatch(/default:\s*['"]1rem['"]/);
            expect(inner).toMatch(/section:\s*['"]1\.5rem['"]/);
            expect(inner).toMatch(/page:\s*['"]2\.5rem['"]/);
        });
    });
});

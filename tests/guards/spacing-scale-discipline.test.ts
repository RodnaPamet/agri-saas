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

/**
 * Roadmap-7 PR-8 — no inline tab/segmented strips.
 *
 * IC ships three shape-locked primitives for grouped click targets:
 *
 *   • <TabSelect>    — single-select tabs with a strong active state.
 *   • <ToggleGroup>  — multi-mode segmented toggle.
 *   • <Accordion>    — vertical collapsible sections.
 *
 * Each owns active-state language (`data-[selected=true]`), focus
 * recipe (`focus-visible:ring-2 ring-offset-2 ring-offset-background`
 * — locked by R6-PR3), disabled state (50% opacity + cursor-not-
 * allowed — locked by R6-PR2), and motion vocabulary (`animate-fadeIn`,
 * `animate-slide-up-fade` — locked by R6-PR1).
 *
 * Hand-rolled tab strips bypass all four contracts at once. The
 * canonical recipe drift signature is a `<button>` element with
 * `text-xs px-3 py-1.5 rounded-md transition font-medium` plus a
 * conditional `bg-*` based on an `active` flag. This shape is the
 * exact pixel signature of `<TabSelect>` items, just without any of
 * its locks.
 *
 * The ratchet forbids the exact-pixel signature. New offenders fail
 * CI; the contributor must reach for `<TabSelect>` (or one of the
 * primitive siblings).
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
 * Files that legitimately use the inline pill recipe for a NON-tab
 * use case (e.g., a single toggle button, not a tab strip). Each
 * entry must explain why the primitive doesn't fit.
 */
const EXEMPTIONS: Record<string, string> = {
    "src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx":
        "Single 'Full Access (*)' toggle button + per-scope toggle pills inside a custom scope-picker widget. Migration to <ToggleGroup> would constrain the per-scope grid layout the picker depends on; deferred until the scope picker itself is rebuilt.",
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

/**
 * Detects the canonical inline tab-pill recipe:
 *   className=`text-xs px-3 py-1.5 rounded-md transition font-medium ${...}`
 * with active/inactive bg branches.
 *
 * Permissive on whitespace + class ordering inside the bracket;
 * conservative on the recipe identity (must have all five class
 * tokens in the same string literal).
 */
function findInlineTabPills(content: string): number {
    const re = /text-xs[^"`']*px-3[^"`']*py-1\.5[^"`']*rounded-md[^"`']*transition[^"`']*font-medium/g;
    const matches = content.match(re);
    return matches ? matches.length : 0;
}

interface Violation {
    file: string;
    count: number;
}

describe("no inline tab/segmented strips", () => {
    it("no source file outside EXEMPTIONS uses the inline tab-pill recipe", () => {
        const violations: Violation[] = [];
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            const count = findInlineTabPills(content);
            if (count === 0) continue;
            const rel = path.relative(ROOT, file);
            if (rel in EXEMPTIONS) continue;
            violations.push({ file: rel, count });
        }
        if (violations.length > 0) {
            const sample = violations
                .slice(0, 15)
                .map((v) => `  ${v.file}: ${v.count} inline pill(s)`)
                .join("\n");
            throw new Error(
                `Found ${violations.length} file(s) using the inline tab-pill recipe (text-xs px-3 py-1.5 rounded-md transition font-medium). Use <TabSelect> (single-select tabs), <ToggleGroup> (segmented toggle), or <Accordion> (vertical sections) — each owns active-state language, focus recipe, disabled state, and motion vocabulary that hand-rolled pills bypass. If the use case genuinely doesn't fit any primitive, add an EXEMPTIONS entry with a written reason.\n\nFirst ${Math.min(15, violations.length)} offender(s):\n${sample}`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("EXEMPTIONS entries point at real files", () => {
        for (const exemptPath of Object.keys(EXEMPTIONS)) {
            const full = path.join(ROOT, exemptPath);
            if (!fs.existsSync(full)) {
                throw new Error(
                    `EXEMPTIONS contains a path that no longer exists: ${exemptPath}. Drop the entry — the ratchet only enforces real files.`,
                );
            }
        }
    });

    it("EXEMPTIONS entries actually have inline tab pills (otherwise drop them)", () => {
        for (const [file] of Object.entries(EXEMPTIONS)) {
            const full = path.join(ROOT, file);
            const count = findInlineTabPills(fs.readFileSync(full, "utf8"));
            expect(count).toBeGreaterThan(0);
        }
    });

    it("EXEMPTIONS entries each have a non-trivial reason", () => {
        for (const [, reason] of Object.entries(EXEMPTIONS)) {
            expect(reason.length).toBeGreaterThan(50);
        }
    });
});

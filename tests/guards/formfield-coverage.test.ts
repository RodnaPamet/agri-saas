/**
 * Roadmap-7 PR-7 — FormField coverage ratchet.
 *
 * 28 source files in `src/app` mount raw `<label>` tags directly
 * instead of routing through the `<FormField>` primitive. The
 * primitive owns the field's vertical rhythm — label, optional
 * description, practice, optional error — with one set of paddings,
 * one weight, one focus contract. Hand-rolled labels drift across
 * pages: spacing, label styling, error placement, all per-page.
 *
 * The number is a ceiling. Any new file in `src/app` that mounts a
 * raw `<label>` increases the count and fails the ratchet. The
 * direction of travel is one-way down: as files migrate to
 * `<FormField>`, the budget number drops in lockstep.
 *
 * Why a budget rather than a coverage list:
 *   - 28 files is too many to list per-site with notes today.
 *     Maintaining the registry would be more friction than the
 *     migrations themselves.
 *   - The ceiling is binary: any NEW <label> trips the ratchet,
 *     forcing the contributor to use FormField.
 *   - Migration PRs drop the budget number to lock the win — the
 *     same shape as `border-tone-budget.test.ts` (R5-PR10).
 *
 * Excludes:
 *   - The FormField primitive itself (it legitimately renders a
 *     <label> internally).
 *   - <Label> primitive that wraps <label> with token styling.
 *   - Any compound widget that needs a click-to-label region for
 *     accessibility (custom checkboxes wrapping their <label>).
 *     None today; if added, allowlist by file path.
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
 * Locked at the file count when this ratchet landed
 * (Roadmap-7 PR-7, 2026-05-10) at 34. Roadmap-8 PR-10 narrowed the
 * detection regex to only `<label htmlFor=>` (the actual <FormField>-
 * replaceable shape) — the budget drops to 2 as a result
 * (login/page.tsx + EditPracticeModal). The 32 false-positives the
 * original regex caught were display labels and radio/checkbox-
 * wrapper labels, neither of which need <FormField>. Future PRs
 * migrate the two genuine htmlFor offenders and drop the budget
 * toward 0.
 */
const RAW_LABEL_FILE_BUDGET = 2;

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

function hasRawLabel(content: string): boolean {
    // R8-PR10 audit narrowed the regex from
    // `<label\s+(htmlFor|className)>` to `<label\s+htmlFor=>` only.
    // The original definition over-counted: most "raw labels" in
    // the codebase were either DISPLAY labels (above stat values,
    // above code blocks, above metadata strips) — which don't need
    // <FormField> because they're not form labels at all — or
    // RADIO/CHECKBOX wrappers `<label><input type="radio"></label>`
    // which is a valid pattern (the label wraps its practice). The
    // narrowed regex matches the actual offending shape: a label
    // pointing at a separate practice via htmlFor — that's the
    // pattern <FormField> replaces.
    return /<label\s+htmlFor=/.test(content);
}

describe("FormField coverage", () => {
    it("raw <label> file count does not exceed the budget", () => {
        let count = 0;
        const offenders: string[] = [];
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            if (hasRawLabel(content)) {
                count += 1;
                offenders.push(path.relative(ROOT, file));
            }
        }
        if (count > RAW_LABEL_FILE_BUDGET) {
            const sample = offenders
                .slice(0, 15)
                .map((o) => `  ${o}`)
                .join("\n");
            throw new Error(
                `Found ${count} file(s) with raw <label> — budget is ${RAW_LABEL_FILE_BUDGET}. Migrate the new offender(s) to <FormField> with proper label / description / required / error slots, OR — if FormField doesn't fit the use case — explain why in the PR description and lower a budget elsewhere to compensate.\n\nFirst ${Math.min(15, offenders.length)} file(s) with raw <label>:\n${sample}`,
            );
        }
        expect(count).toBeLessThanOrEqual(RAW_LABEL_FILE_BUDGET);
    });

    it("budget tracks reality (forbids slack > 5 files)", () => {
        // If migrations land, the count drops. The budget here
        // must drop with them — keeps the ratchet honest. A drift
        // > 5 files between budget and reality means a previous
        // migration PR forgot to decrement the budget.
        let count = 0;
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            if (hasRawLabel(content)) count += 1;
        }
        expect(RAW_LABEL_FILE_BUDGET).toBeLessThanOrEqual(count + 5);
    });
});

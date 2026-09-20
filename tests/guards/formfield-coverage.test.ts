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

    /**
     * CONTROL for `hasRawLabel` — it survived every FALSY gut.
     *
     * The guts split cleanly here. Every TRUTHY gut ([] {} Set Map) makes
     * every file an offender, blows RAW_LABEL_FILE_BUDGET and is already RED.
     * Every FALSY gut ('' 0 null undefined false) makes the detector match
     * nothing: `count` is 0, `0 <= 2` passes, and "budget tracks reality"
     * passes too because `2 <= 0 + 5`. So the ratchet certified a clean tree
     * having detected nothing — empty selection reading as a pass (#971).
     *
     * Pinned with a SYNTHETIC two-sided assertion rather than a floor on the
     * real population: exactly ONE file under src/app carries a raw label
     * today (src/app/login/page.tsx), so a population floor would turn the
     * migration of that last offender — the outcome this ratchet exists to
     * produce — into a CI failure. `hasRawLabel` is a pure string predicate,
     * so a literal input exercises the real code path with nothing to rot.
     */
    it("hasRawLabel matches a real raw label and refuses ordinary markup", () => {
        expect(hasRawLabel('<label htmlFor="email">Email</label>')).toBe(true);
        expect(hasRawLabel('<div className="field">no labels here</div>')).toBe(false);

        // Tied to the tree as well: the detector and an independent regex must
        // agree across the real population, so a narrowed detector cannot
        // quietly stop counting while the budget still reads as satisfied.
        let byDetector = 0;
        let byIndependent = 0;
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            if (hasRawLabel(content)) byDetector += 1;
            if (/<label\s+htmlFor=/.test(content)) byIndependent += 1;
        }
        expect(byDetector).toBe(byIndependent);
    });

    /**
     * CONTROL for `isExempt` — it had NO TEETH.
     *
     * `scripts/selector-teeth.mjs` gutted it to each of `[] '' 0 null
     * undefined false new Set() new Map() {}` and both tests above stayed
     * green on all nine, because neither depends on what it returns:
     *   - gutted TRUTHY, `walk` skips every entry, the count is 0, and
     *     `0 <= 2` passes — the ratchet certifies an empty scan;
     *   - gutted FALSY, nothing under `src/app` matches an exclusion today
     *     (no `__tests__` / `__mocks__` dir, no `.test|.spec|.stories` file
     *     there), so the count is unchanged and the budget still holds.
     *
     * A predicate therefore needs BOTH directions asserted. Exempting
     * something real kills every falsy gut; refusing to exempt the real
     * scanned population kills every truthy one. Either half alone passes
     * for a predicate that has collapsed to a constant.
     */
    it("isExempt exempts real excluded paths and does not exempt the scanned population", () => {
        // It DOES exempt — one path per live exclusion rule, each on disk.
        const exemptOnDisk = [
            path.join("src", "components", "ui", "hooks", "__tests__"), // EXEMPT_DIR_NAMES
            path.join("tests", "guards", "formfield-coverage.test.ts"), // /\.test\.tsx?$/
            path.join("tests", "e2e", "tenant-switcher.spec.ts"), //       /\.spec\.tsx?$/
        ];
        for (const rel of exemptOnDisk) {
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
            expect(isExempt(rel)).toBe(true);
        }
        // The rules with no instance in the tree today are pinned anyway, so
        // narrowing the exclusion lists fails here instead of silently.
        expect(isExempt(path.join(SCAN_DIR, "node_modules", "page.tsx"))).toBe(true);
        expect(isExempt(path.join(SCAN_DIR, "__mocks__", "page.tsx"))).toBe(true);
        expect(isExempt(path.join(SCAN_DIR, "Button.stories.tsx"))).toBe(true);

        // It does NOT exempt everything — a real page the ratchet must read.
        const scannedPage = path.join(SCAN_DIR, "page.tsx");
        expect(fs.existsSync(path.join(ROOT, scannedPage))).toBe(true);
        expect(isExempt(scannedPage)).toBe(false);

        // …and the population `walk` hands the ratchet is real and non-trivial.
        // 214 `.tsx` files under `src/app` today; the floor sits far below so
        // ordinary churn never trips it.
        const scanned = walk(path.join(ROOT, SCAN_DIR));
        expect(scanned.length).toBeGreaterThan(100);
        for (const abs of scanned) {
            expect(typeof abs).toBe("string");
            expect(fs.existsSync(abs)).toBe(true);
            expect(isExempt(path.relative(ROOT, abs))).toBe(false);
        }
    });
});

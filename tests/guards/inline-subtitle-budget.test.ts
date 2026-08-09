/**
 * Roadmap-9 PR-5 — inline subtitle pattern budget.
 *
 * The subtitle pattern `<p className="text-sm text-content-muted
 * mt-1">…</p>` under a Heading repeats across the app — 36 sites
 * before the R9-PR1 PageHeader sweep started. Same exact JSX in 36
 * places is 36 chances to drift; three already did (`text-xs`
 * instead of `text-sm`, `mt-2` instead of `mt-1`).
 *
 * The canonical home for this shape is `<PageHeader description=>`.
 * R9-PR1 migrates pages one at a time; each migration drops the
 * subtitle count by one (the inline `<p>` collapses into the
 * description slot).
 *
 * This ratchet locks the count at the current ceiling. The
 * direction of travel is one-way down: as R9-PR1 follow-ups land,
 * the budget number drops in lockstep. New inline subtitle sites
 * trip the ratchet at PR-review time.
 *
 * Excludes:
 *   • `<PageHeader>` internals (the primitive renders this pattern
 *     legitimately).
 *   • Test fixtures + storybook files.
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
 * Locked at the count at R9-PR5 land. Three sites collapsed during
 * R9-PR1's first migrations (notifications, AuditsClient,
 * FindingsClient); the budget tracks that floor + the remaining
 * 33 sites awaiting future PageHeader migration. Each subsequent
 * PageHeader migration PR decrements this number.
 *
 * R31 Bundle 3 (PR 1 — document bar) — adjusted 37 → 36. The
 * Processes page retired its `<Heading> + description paragraph`
 * block above the canvas; the description that sat at
 * `<p className="text-sm text-content-muted mt-1">…</p>` was one
 * of the budgeted sites. The supersession is documented in
 * `tests/guards/r31-document-bar.test.ts`.
 */
// Compliance uproot (2026-08-07): compliance uproot removed 10 inline-subtitle sites.
const INLINE_SUBTITLE_BUDGET = 26;

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

function countInlineSubtitles(content: string): number {
    // Match the exact shape that PageHeader.description replaces:
    // `<p className="text-sm text-content-muted mt-1">`. Strict
    // class-string match — drift variants (text-xs, mt-2) and
    // descriptions inside <PageHeader> are handled separately.
    const re = /<p\s+className="text-sm\s+text-content-muted\s+mt-1"/g;
    const matches = content.match(re);
    return matches ? matches.length : 0;
}

describe("inline subtitle pattern budget", () => {
    it("total inline subtitle count does not exceed the budget", () => {
        let count = 0;
        const offenders: Array<{ file: string; count: number }> = [];
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            const c = countInlineSubtitles(content);
            if (c > 0) {
                count += c;
                offenders.push({ file: path.relative(ROOT, file), count: c });
            }
        }
        if (count > INLINE_SUBTITLE_BUDGET) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}: ${o.count}`)
                .join("\n");
            throw new Error(
                `Found ${count} inline subtitle pattern(s) (\`<p className="text-sm text-content-muted mt-1">\`) — budget is ${INLINE_SUBTITLE_BUDGET}. The canonical home for this shape is <PageHeader description=>. Migrate to PageHeader OR — if PageHeader doesn't fit — lower a budget elsewhere to compensate.\n\n${sample}`,
            );
        }
        expect(count).toBeLessThanOrEqual(INLINE_SUBTITLE_BUDGET);
    });

    it("budget tracks reality (forbids slack > 3 sites)", () => {
        let count = 0;
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            count += countInlineSubtitles(fs.readFileSync(file, "utf8"));
        }
        // A migration PR drops sites — the budget number must drop
        // with them. Drift > 3 means a prior PR forgot to decrement.
        expect(INLINE_SUBTITLE_BUDGET).toBeLessThanOrEqual(count + 3);
    });
});

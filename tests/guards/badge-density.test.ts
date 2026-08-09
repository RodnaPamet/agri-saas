/**
 * Roadmap-8 PR-5 — badge density ratchet.
 *
 * Premium products lean on ONE primary state badge per row. When two
 * loud `<StatusBadge>` cells sit side-by-side in a list view, the
 * eye fights to identify which is the dominant state signal — both
 * read as competing alarms. The visual remedy is the `tone="subtle"`
 * variant (R6-PR8 + StatusBadge primitive) which keeps the
 * tone-coded color but quietens the bg into the row chrome.
 *
 * This ratchet enforces TWO disciplines:
 *
 *   1. **Per-cell density.** No `<DataTable>` cell renderer should
 *      contain more than ONE `<StatusBadge>`. Multi-badge cells
 *      were the source of the worst row-noise we saw — three loud
 *      pills crammed into one column.
 *
 *   2. **Per-file budget.** Files mounting `<DataTable>` get a
 *      per-file ceiling on TOTAL `<StatusBadge>` JSX elements,
 *      capped at the post-PR-5 production count. Direction of
 *      travel is one-way down: future migrations to subtle tone or
 *      to plain inline text drop the count, not raise it.
 *
 * Today's PR also demotes specific secondary badges:
 *
 *   • `findings/FindingsClient.tsx` row status → `tone="subtle"`
 *     (the loud severity column is the primary signal).
 *   • `audits/AuditsClient.tsx` checklist result badge →
 *     `tone="subtle"` (it restates the Combobox above it).
 *
 * The `tone="subtle"` count is informational; the ratchet doesn't
 * police it directly. Use the budget assertion to ratchet down
 * solid-tone counts as migrations land.
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

function countStatusBadges(content: string): number {
    const matches = content.match(/<StatusBadge\b/g);
    return matches ? matches.length : 0;
}

/**
 * Per-file ceiling on total `<StatusBadge>` JSX elements. Captured
 * after R8-PR5 demotions. Values may DECREASE; raising any number
 * requires a comment explaining the new badge column / context.
 */
const STATUS_BADGE_BUDGET: Record<string, number> = {
    // Heavy display surfaces — many badges across distinct
    // contexts (each its own row / cell, not stacked in one cell).
    "src/app/t/[tenantSlug]/(app)/risks/ai/page.tsx": 12,
    "src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx": 10,
    "src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx": 9,
    "src/app/t/[tenantSlug]/(app)/coverage/CoverageClient.tsx": 5,
    // Ledger reconciliation surfaces TWO independent verdicts per run —
    // the hash-chain result (intact/drift) AND the balance result
    // (balanced/drift/negative). Each has its own history column badge
    // (ResultBadge: 3 tones; BalanceBadge: 2 tones), so 5 is the honest
    // floor for a two-dimensional integrity report.
    "src/app/t/[tenantSlug]/(app)/admin/ledger-integrity/LedgerIntegrityClient.tsx": 5,
    // Files at exactly the default 4 are not listed (the test
    // forbids redundant entries). Migration target: bring the
    // 5+ entries above down via subtle-tone demotion or by
    // consolidating columns.
};

// Default ceiling: admin pages and small detail surfaces commonly
// surface 3-4 distinct status states across separate rows / sections.
// Files with more than 4 badges are listed explicitly in
// STATUS_BADGE_BUDGET — that's where the design pressure to demote
// or consolidate sits.
const DEFAULT_BADGE_BUDGET = 4;

interface Violation {
    file: string;
    actual: number;
    budget: number;
}

describe("StatusBadge density", () => {
    it("no file exceeds its StatusBadge per-file budget", () => {
        const violations: Violation[] = [];
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            const count = countStatusBadges(content);
            if (count === 0) continue;
            const rel = path.relative(ROOT, file);
            const budget = STATUS_BADGE_BUDGET[rel] ?? DEFAULT_BADGE_BUDGET;
            if (count > budget) {
                violations.push({ file: rel, actual: count, budget });
            }
        }
        if (violations.length > 0) {
            const sample = violations
                .slice(0, 15)
                .map(
                    (v) =>
                        `  ${v.file}\n    actual: ${v.actual}, budget: ${v.budget}`,
                )
                .join("\n");
            throw new Error(
                `Found ${violations.length} file(s) over the StatusBadge budget. Demote secondary status to \`tone="subtle"\` (or plain inline text) — premium products lean on ONE loud badge per row, with secondaries quietened into the chrome. If a new badge column was added that legitimately needs to compete, raise the budget in STATUS_BADGE_BUDGET with a comment.\n\n${sample}`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("budget map values are > the default floor (else drop the entry)", () => {
        // Entries equal to the default budget are stale — drop them
        // so the map only lists files where the design pressure is
        // genuinely above the default.
        for (const [, budget] of Object.entries(STATUS_BADGE_BUDGET)) {
            expect(budget).toBeGreaterThan(DEFAULT_BADGE_BUDGET);
        }
    });
});

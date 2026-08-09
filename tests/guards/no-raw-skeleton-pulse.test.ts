/**
 * Roadmap-8 PR-12 — skeleton-pulse budget ratchet.
 *
 * R5-PR6 unified skeleton TONE; R6-PR1 retired the `animate-slideIn`
 * legacy. What's still drifting: the SHAPE. Different pages render
 * different skeleton shapes for what's logically the same loading
 * state — bare `<div className="... animate-pulse">` divs, custom
 * shimmer recipes, hand-rolled multi-line placeholders.
 *
 * The product ships four skeleton primitives:
 *   • <SkeletonLine>     — single horizontal bar (text placeholder)
 *   • <SkeletonCard>     — card-shaped block with N internal lines
 *   • <SkeletonRow>      — table row placeholder
 *   • <SkeletonDetailTabs> — full detail-page skeleton including
 *                            header + tabs + body
 *
 * Together they cover every legitimate loading shape in the
 * product. Hand-rolled `animate-pulse` divs bypass the tone +
 * shape contracts.
 *
 * This ratchet is a budget on the COUNT of files in `src/app` that
 * mount raw `animate-pulse` outside the skeleton primitives.
 * Locked at the post-PR-12 baseline. Direction of travel one-way
 * down: migrations to skeleton primitives drop the count.
 *
 * Why a budget rather than a per-file allowlist:
 *   • 26 files is too many to list with reasons today.
 *   • Many sites are intentional non-skeleton pulses (e.g.,
 *     "saving…" feedback on a single button), which the primitives
 *     don't cover and shouldn't.
 *   • The budget structure is the same shape as
 *     border-tone-budget.test.ts (R5-PR10) and formfield-coverage
 *     (R7-PR7) — proven design.
 *
 * Excludes the skeleton primitive files themselves.
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
 * (Roadmap-8 PR-12, 2026-05-10) at 26. Future PRs that migrate
 * raw `animate-pulse` divs to the skeleton primitives MUST
 * decrement this number to lock in the win.
 *
 * Genuine non-skeleton pulse usages (e.g., "saving…" button
 * affordance) are tolerated as exceptions inside the budget —
 * each migration that drops the count toward zero gets a free
 * win.
 */
// Compliance uproot (2026-08-07): compliance uproot removed 7 animate-pulse files.
const ANIMATE_PULSE_FILE_BUDGET = 19;

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

function hasRawPulse(content: string): boolean {
    return /\banimate-pulse\b/.test(content);
}

describe("skeleton vocabulary — no raw animate-pulse over budget", () => {
    it("file count using raw `animate-pulse` does not exceed the budget", () => {
        let count = 0;
        const offenders: string[] = [];
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            if (hasRawPulse(content)) {
                count += 1;
                offenders.push(path.relative(ROOT, file));
            }
        }
        if (count > ANIMATE_PULSE_FILE_BUDGET) {
            const sample = offenders
                .slice(0, 15)
                .map((o) => `  ${o}`)
                .join("\n");
            throw new Error(
                `Found ${count} file(s) using raw \`animate-pulse\` — budget is ${ANIMATE_PULSE_FILE_BUDGET}. Migrate the new offender(s) to <SkeletonLine> / <SkeletonCard> / <SkeletonRow> / <SkeletonDetailTabs> instead. The skeleton primitives own tone, shape, and motion — hand-rolled pulses bypass all three.\n\nFirst ${Math.min(15, offenders.length)} file(s):\n${sample}`,
            );
        }
        expect(count).toBeLessThanOrEqual(ANIMATE_PULSE_FILE_BUDGET);
    });

    it("budget tracks reality (forbids slack > 5 files)", () => {
        // If migrations land, the count drops. The budget here
        // must drop with them — keeps the ratchet honest. A drift
        // > 5 files between budget and reality means a previous
        // migration PR forgot to decrement the budget.
        let count = 0;
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            if (hasRawPulse(content)) count += 1;
        }
        expect(ANIMATE_PULSE_FILE_BUDGET).toBeLessThanOrEqual(count + 5);
    });
});

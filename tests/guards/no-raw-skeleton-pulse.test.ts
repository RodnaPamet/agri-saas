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
 *
 * SCOPE, measured 2026-10-16 and recorded because the prose above reads
 * wider than the guard is: `src/app` holds **14** such files, and `src`
 * holds **26** — the figure this docblock cites as the reason for a budget.
 * The other 12 are in `src/components` (11) and `src/lib` (1), where the UI
 * primitives themselves live, so the argument "hand-rolled pulses bypass the
 * tone and shape contracts" applies there at least as strongly. Widening the
 * scope is a separate change with its own baseline, filed rather than done
 * here.
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

import { blankNonCode } from "../helpers/blank-non-code";

const ROOT = path.resolve(__dirname, "../..");
/**
 * The roots this budgets, each with its OWN number (#1974).
 *
 * It used to be one `SCAN_DIR = "src/app"` against a budget of 19, and the
 * 19 descended from a figure of 26 that the docblock cited as the reason a
 * budget beat an allowlist. 26 was never `src/app`: measured 2026-10-17 it is
 * app 14 + components 10 + lib 1 = 25 after blanking. So the justification
 * ranged over a population the guard never scanned, and 12 of those files
 * were unwatched.
 *
 * One budget per root rather than one total, on the owner's ruling. A shared
 * number lets a migration in `src/components` free a slot in `src/app`, so a
 * win in one place silently pays for a regression in another — the
 * cross-subsidy that let a shared lint cap hide a batch collision for a whole
 * merge earlier the same day (#1774). Three numbers that each fail on their
 * own cost more to maintain and cannot do that.
 *
 * `src/components` is also the half with the wider blast radius: a hand-
 * rolled pulse in a shared component is inherited by every page that renders
 * it, where one in a route harms that route only.
 */
const SCAN_ROOTS = [
    { dir: "src/app", budget: 14 },
    { dir: "src/components", budget: 10 },
    { dir: "src/lib", budget: 1 },
] as const;

/** How far a budget may sit ABOVE reality before it is slack, per root. */
const DRIFT_ALLOWANCE = 5;

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

function hasRawPulse(content: string): boolean {
    // Comments blanked first (#1774). MEASURED before converting: inside this
    // guard's own scope (`src/app`) it changes nothing — 14 files match
    // either way — so the budget below does not move. The conversion is
    // future-proofing, not a correction: a docblock in `src/app` that
    // discussed `animate-pulse` would otherwise count as a file mounting it,
    // and this guard's prose is exactly the kind that would.
    //
    // It is not hypothetical elsewhere: `src/components/ui/skeleton.tsx` —
    // the primitive this guard steers people toward — names the class twice
    // in its docblock and nowhere in its code, so an unblanked scan counts
    // the cure as a symptom. It sits outside `SCAN_DIR` today, which is the
    // only reason that has never mattered.
    return /\banimate-pulse\b/.test(blankNonCode(content));
}

describe("skeleton vocabulary — no raw animate-pulse over budget", () => {
    it("CONTROL: isExempt can actually exempt, and does not exempt everything", () => {
        // `selector-teeth` found this predicate DEAD: forcing it to return
        // falsy for every input left every assertion green, so nothing
        // exercised the exclusion at all.
        //
        // The reason is the scope. `EXEMPT_DIR_NAMES` and
        // `EXEMPT_FILE_PATTERNS` are written for the whole of `src` — tests,
        // stories, mocks, and "the skeleton primitive files themselves" —
        // and `SCAN_DIR` is `src/app`, which contains none of those. So the
        // exclusion is correct, unexercised, and would silently stop working
        // the moment the scope widened (#1974).
        //
        // Asserted directly rather than through the walk, because the walk
        // cannot reach an input that would prove it.
        expect(isExempt(path.join("src", "app", "__tests__", "x.tsx"))).toBe(true);
        expect(isExempt(path.join("src", "app", "foo.test.tsx"))).toBe(true);
        expect(isExempt(path.join("src", "app", "foo.stories.tsx"))).toBe(true);
        // And the other direction, or an always-true version would pass the
        // three above while exempting the entire population.
        expect(isExempt(path.join("src", "app", "dashboard", "page.tsx"))).toBe(false);
        expect(isExempt(path.join("src", "components", "ui", "skeleton.tsx"))).toBe(false);
    });

    /** Offending files under one root, comments already blanked. */
    function offendersIn(dir: string): string[] {
        const out: string[] = [];
        for (const file of walk(path.join(ROOT, dir))) {
            if (hasRawPulse(fs.readFileSync(file, "utf8"))) {
                out.push(path.relative(ROOT, file));
            }
        }
        return out;
    }

    it("prints the per-root breakdown — the denominator", () => {
        const parts = SCAN_ROOTS.map(
            (r) => `${r.dir}=${offendersIn(r.dir).length}/${r.budget}`,
        );
        const total = SCAN_ROOTS.reduce((n, r) => n + offendersIn(r.dir).length, 0);
        console.log(`[skeleton-pulse] ${parts.join(" ")} total=${total}`);
        // The scope is the thing that was wrong here, so assert it rather
        // than describing it: three roots, and `src/components` present, is
        // what #1974 was about.
        expect(SCAN_ROOTS.map((r) => r.dir)).toEqual([
            "src/app",
            "src/components",
            "src/lib",
        ]);
    });

    for (const { dir, budget } of SCAN_ROOTS) {
        it(`${dir}: raw \`animate-pulse\` files stay within ${budget}`, () => {
            const offenders = offendersIn(dir);
            if (offenders.length > budget) {
                const sample = offenders.slice(0, 15).map((o) => `  ${o}`).join("\n");
                throw new Error(
                    `Found ${offenders.length} file(s) using raw \`animate-pulse\` under ${dir} — budget is ${budget}. Migrate the new offender(s) to <SkeletonLine> / <SkeletonCard> / <SkeletonRow> / <SkeletonDetailTabs> instead. The skeleton primitives own tone, shape, and motion — hand-rolled pulses bypass all three.\n\nFirst ${Math.min(15, offenders.length)} file(s):\n${sample}`,
                );
            }
            expect(offenders.length).toBeLessThanOrEqual(budget);
        });

        it(`${dir}: its budget tracks reality (slack <= ${DRIFT_ALLOWANCE})`, () => {
            // Per root, deliberately. A single total would let a migration
            // here pay for a regression somewhere else, which is the whole
            // reason these are three numbers.
            expect(budget).toBeLessThanOrEqual(offendersIn(dir).length + DRIFT_ALLOWANCE);
        });
    }
});

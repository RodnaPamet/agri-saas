/**
 * Roadmap-7 PR-6 — empty + loading state primitive-only ratchet.
 *
 * R6-PR5 (`empty-state-vocabulary.test.ts`) locked the COPY of empty
 * states ("No items found" / "No items yet") so the vocabulary is
 * uniform across the product. R6-PR6 (`loading-text-discipline.test.ts`)
 * did the same for loading copy.
 *
 * What's NOT yet locked: the WRAPPER. Many tab bodies and inline
 * panels render their empty state as a hand-rolled
 * `<div className="p-8 text-center text-content-subtle text-sm">No X
 * yet</div>` instead of using `<EmptyState>` / `<TableEmptyState>`.
 * The text reads correctly under the previous ratchets, but the
 * visual rhythm — padding, alignment, optional icon, optional
 * description — drifts per page.
 *
 * This ratchet forbids raw `<div>` (or `<p>`) bodies whose only
 * content is an empty-state phrase. The required path is the
 * primitive: `<EmptyState>` (full body), `<TableEmptyState>` (table
 * row), or for tab bodies the upcoming `<InlineEmptyState>`. An
 * EXEMPTIONS list captures the small number of legitimate sites
 * (loading-skeleton placeholders that are NOT empty states; pages
 * with bespoke empty rendering documented per-site).
 *
 * Today's offenders are six known tab-body inline empty messages:
 * three on the task detail page (No links yet · No comments yet ·
 * No activity yet), one on the practice detail page (No tasks yet),
 * and two on the practices/templates page (twin "No templates found"
 * messages). They sit in EXEMPTIONS as `migrated: false` with the
 * direction of travel being one-way: future PRs migrate sites to
 * `<EmptyState>` / `<InlineEmptyState>` and remove the entry.
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

interface PendingSite {
    file: string;
    note: string;
}

/**
 * Sites with known inline empty-state divs awaiting migration to
 * `<EmptyState>` / `<InlineEmptyState>`. Each entry documents the
 * specific tab body or section. PRs that ADD a new entry require a
 * non-trivial note. The direction of travel: this list shrinks as
 * sites migrate; new offenders are not allowed.
 */
const PENDING_MIGRATIONS: PendingSite[] = [
    // R8-PR2 cleared all 9 entries. The list now sits empty as the
    // "freeze the regression boundary" baseline — any NEW inline
    // empty-state div in `src/app` will fail the ratchet without
    // a written EXEMPTION here. The direction of travel: this list
    // stays at zero unless a future PR introduces a new tab-body
    // pattern that doesn't fit InlineEmptyState (in which case
    // adding an entry requires a 40+ char structural reason).
];

const PENDING_FILES = new Set(PENDING_MIGRATIONS.map((p) => p.file));

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
 * Detect inline empty-state divs:
 *   <div className="...">No X yet</div>
 *   <p className="...">No X found</p>
 *   <span ...>No X here</span>
 *
 * Match shape: a JSX element whose direct text content is an
 * empty-state phrase — `No|Zero` + a noun + a REQUIRED trailing
 * terminator (yet|found|here|available|recorded|completed|linked).
 *
 * Why the terminator is required (R8-PR2 tightening): without it
 * the regex catches inline missing-value markers (e.g. policy
 * `<span>No content</span>` displayed in a row cell when a version
 * has empty body, or `<span>No runs</span>` in a test summary
 * column). Those aren't tab-body empty states — they're per-row
 * cell markers and the InlineEmptyState primitive would over-pad
 * them. The terminator narrows the regex to the actual empty-state
 * shape ("No X yet" / "No X found" / "No X recorded" / "No X
 * linked" / "No X completed").
 */
function findInlineEmptyStates(content: string): number {
    const re =
        /<(?:div|p|span)[^>]*>\s*(?:No|Zero)\s+\w+(?:\s+\w+)?\s+(?:yet|found|here|available|recorded|completed|linked)\s*<\/(?:div|p|span)>/g;
    const matches = content.match(re);
    return matches ? matches.length : 0;
}

interface Violation {
    file: string;
    count: number;
}

describe("empty/loading primitive-only", () => {
    it("no inline empty-state divs outside the pending-migration list", () => {
        const violations: Violation[] = [];
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            const count = findInlineEmptyStates(content);
            if (count === 0) continue;
            const rel = path.relative(ROOT, file);
            if (PENDING_FILES.has(rel)) continue;
            violations.push({ file: rel, count });
        }
        if (violations.length > 0) {
            const sample = violations
                .slice(0, 15)
                .map((v) => `  ${v.file}: ${v.count} inline empty-state(s)`)
                .join("\n");
            throw new Error(
                `Found ${violations.length} file(s) with inline empty-state divs outside the pending-migration list. Use <EmptyState> (full body) / <TableEmptyState> (table row) / <InlineEmptyState> (tab body) instead — the primitive owns padding, icon, title, and description rhythm. If migration is genuinely deferred, add an entry to PENDING_MIGRATIONS with a written note.\n\nFirst ${Math.min(15, violations.length)} offender(s):\n${sample}`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    // ── Control (#971): the scan is a POPULATION, not an empty list ──
    //
    // `selector-teeth` gutted `walk` and nothing failed. The seam is the
    // `for (const file of walk(...))` above: `0`, `null`, `undefined`,
    // `false` and `{}` throw "is not iterable" there and were already
    // caught — but `[]`, `""`, `new Set()` and `new Map()` all iterate
    // ZERO times, so "scanned 214 files and found no inline empty state"
    // and "scanned nothing" are the same green.
    //
    // The existsSync throw inside `walk` (#875) cannot see this: it proves
    // the ROOT EXISTS, one layer below the yield. A root that exists while
    // the walk returns nothing sails straight past it. The three
    // PENDING_MIGRATIONS tests cannot see it either — that list is empty,
    // so each of them loops zero times.
    //
    // Floors are MEASURED (2026-09-19: 214 .tsx under src/app, max depth 7)
    // and set far below reality so ordinary churn never moves them.
    it("control: the scanned population is non-empty, recursive and .tsx-only", () => {
        const scanned = walk(path.join(ROOT, SCAN_DIR));
        expect(scanned.length).toBeGreaterThan(100);

        // Recursion is the one behaviour a constant return cannot express.
        // A walk that reads only the top directory yields nothing nested,
        // so depth is the discriminator between "descended" and "listed".
        const depths = scanned.map(
            (f) =>
                path
                    .relative(path.join(ROOT, SCAN_DIR), f)
                    .split(path.sep).length,
        );
        expect(Math.max(...depths)).toBeGreaterThanOrEqual(4);

        // Every yielded entry is a real, readable .tsx — a walk that starts
        // returning directory names or stale paths fails here rather than
        // quietly shrinking what the ratchet reads.
        for (const file of scanned) {
            expect(file.endsWith(".tsx")).toBe(true);
            expect(fs.existsSync(file)).toBe(true);
        }
    });

    it("PENDING_MIGRATIONS entries point at real files", () => {
        for (const entry of PENDING_MIGRATIONS) {
            const full = path.join(ROOT, entry.file);
            if (!fs.existsSync(full)) {
                throw new Error(
                    `PENDING_MIGRATIONS contains a path that no longer exists: ${entry.file}. Drop the entry — the ratchet only enforces real files.`,
                );
            }
        }
    });

    // ── Control (#971): the exclusion bites, and only where it claims ──
    //
    // `isExempt` is consumed as `if (isExempt(rel)) continue` INSIDE `walk`,
    // against DIRECTORIES as well as files and before the recursion — so a
    // truthy return prunes the tree at its first level and `walk` yields
    // nothing at all. Four of the nine guts ({}, [], new Set(), new Map())
    // are truthy objects, so that direction is reachable even though the
    // gut set never tries bare `true`; the floor below is what catches it.
    //
    // The falsy guts survive for a different reason, and it is not the
    // guard's fault: measured, the exemption list bites ZERO times under
    // src/app (no __tests__ / __mocks__ directories, no .test / .spec /
    // .stories .tsx there), so "exempt nothing" changes no result. That
    // half is a mutation that does not mutate — which is exactly why the
    // classes are exercised EXPLICITLY below instead of being trusted to
    // turn up in the scanned tree.
    it("control: isExempt excludes every class it lists and nothing else", () => {
        // The floor and the loop must live in ONE test: an empty selection
        // passes a for-loop, so without the floor a truthy gut satisfies it.
        const scanned = walk(path.join(ROOT, SCAN_DIR));
        expect(scanned.length).toBeGreaterThan(100);
        for (const file of scanned) {
            expect(isExempt(path.relative(ROOT, file))).toBe(false);
        }

        for (const dirName of EXEMPT_DIR_NAMES) {
            expect(isExempt(path.join("src", "app", dirName, "page.tsx"))).toBe(
                true,
            );
        }

        const EXEMPT_FILE_SAMPLES = [
            path.join("src", "app", "x", "page.test.tsx"),
            path.join("src", "app", "x", "page.spec.tsx"),
            path.join("src", "app", "x", "page.stories.tsx"),
        ];
        for (const sample of EXEMPT_FILE_SAMPLES) {
            expect(isExempt(sample)).toBe(true);
        }
        // …and every listed pattern is actually exercised by one of them, so
        // a pattern added to EXEMPT_FILE_PATTERNS without a sample fails here
        // instead of riding along unexercised.
        for (const rx of EXEMPT_FILE_PATTERNS) {
            expect(EXEMPT_FILE_SAMPLES.some((s) => rx.test(s))).toBe(true);
        }

        // The near-miss: same directory, same basename, not a test file.
        expect(isExempt(path.join("src", "app", "x", "page.tsx"))).toBe(false);
    });

    it("PENDING_MIGRATIONS entries each have a non-trivial note", () => {
        for (const entry of PENDING_MIGRATIONS) {
            expect(entry.note.length).toBeGreaterThan(40);
        }
    });

    // ── Control (#971): the DETECTOR, not today's emptiness ──
    //
    // At the `const count = findInlineEmptyStates(content); if (count === 0)`
    // seam, strict equality means EIGHT of the nine guts (null, undefined,
    // false, "", [], {}, new Set(), new Map()) make every scanned file a
    // violation and turn this suite red. Only `0` survives — and `0` is what
    // the function already returns for all 214 scanned files, so that
    // mutation does not mutate: the probe failed, the guard did not pass.
    //
    // What IS unproven is the regex. Nothing in the repo has ever run it
    // against a positive, so a tightening that goes one notch too far — or a
    // JSX shape it no longer recognises — reads exactly like a clean product.
    // These two bracket it: a live positive from real product source, and
    // the claimed vocabulary plus the near-misses R8-PR2 excluded on purpose.
    it("control: the detector finds the banned shape in real product source", () => {
        // The primitive this ratchet exists to force adoption of writes the
        // banned shape in its OWN docblock, and lives OUTSIDE SCAN_DIR — so
        // it is a live positive that can never become a violation.
        const primitive = path.join(
            ROOT,
            "src/components/ui/inline-empty-state.tsx",
        );
        expect(fs.existsSync(primitive)).toBe(true);
        const source = fs.readFileSync(primitive, "utf8");
        // That docblock names THIS guard, which is what binds the two: if the
        // example is rewritten the positive disappears, and this fails loudly
        // instead of the control quietly asserting nothing.
        expect(source).toContain("empty-loading-primitive-only.test.ts");
        expect(findInlineEmptyStates(source)).toBeGreaterThan(0);
    });

    it("control: every terminator and tag it claims bites, and near-misses do not", () => {
        const TERMINATORS = [
            "yet",
            "found",
            "here",
            "available",
            "recorded",
            "completed",
            "linked",
        ];
        for (const terminator of TERMINATORS) {
            expect(
                findInlineEmptyStates(
                    `<div className="p-8 text-center text-content-subtle text-sm">No tasks ${terminator}</div>`,
                ),
            ).toBe(1);
        }
        expect(findInlineEmptyStates('<p className="x">Zero items found</p>')).toBe(1);
        expect(findInlineEmptyStates("<span>No links yet</span>")).toBe(1);
        expect(findInlineEmptyStates("<div>No crop plans yet</div>")).toBe(1);
        // It COUNTS, it does not merely detect — the failure message reports a
        // per-file number, so a detector that stops at the first hit is caught.
        expect(
            findInlineEmptyStates("<div>No tasks yet</div>\n<p>No comments yet</p>"),
        ).toBe(2);

        // Near-misses the R8-PR2 tightening excludes ON PURPOSE: a per-row cell
        // marker with no terminator, and a tag outside the list. A detector
        // "fixed" by widening it back fails here.
        expect(findInlineEmptyStates("<span>No content</span>")).toBe(0);
        expect(findInlineEmptyStates("<span>No runs</span>")).toBe(0);
        expect(findInlineEmptyStates("<td>No tasks yet</td>")).toBe(0);
        // …and the sanctioned path is never a violation.
        expect(
            findInlineEmptyStates('<InlineEmptyState title="No tasks yet" />'),
        ).toBe(0);
    });

    it("PENDING_MIGRATIONS entries actually have inline empty states (otherwise drop them)", () => {
        for (const entry of PENDING_MIGRATIONS) {
            const full = path.join(ROOT, entry.file);
            const count = findInlineEmptyStates(fs.readFileSync(full, "utf8"));
            if (count === 0) {
                throw new Error(
                    `PENDING_MIGRATIONS entry has zero inline empty states (migration is done — drop the entry): ${entry.file}`,
                );
            }
        }
    });
});

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

    it("PENDING_MIGRATIONS entries each have a non-trivial note", () => {
        for (const entry of PENDING_MIGRATIONS) {
            expect(entry.note.length).toBeGreaterThan(40);
        }
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

/**
 * Roadmap-9 PR-7 — Cancel button size parity.
 *
 * R6-PR8 locked Cancel buttons to `variant="secondary"` (never
 * ghost, never destructive). What it didn't lock: SIZE parity with
 * the paired submit. The visual smell is two buttons in the same
 * inline-form row at different heights — a Cancel at default
 * `size="sm"` next to a Save at `size="xs"`, or vice-versa. The
 * user sees the height jump; they can't name it; the form feels
 * assembled.
 *
 * Audit at R9-PR7 land: the production code already paired
 * correctly — the two `size="xs"` Cancel sites in the codebase
 * (risks/ai, policies/[policyId]) both sit next to `size="xs"`
 * submits. No migrations needed today.
 *
 * This ratchet locks the pairing rule going forward: if a future
 * PR sets a Cancel button's size that doesn't match a sibling
 * Save/Submit button in the same JSX block, fail CI.
 *
 * Detection shape: look for `<Button` elements whose children
 * contain the literal `Cancel`. For each, look at the next/previous
 * sibling `<Button>` (within 10 lines, same indent level — i.e. in
 * the same JSX flex row) and assert their `size=` props match.
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

function getSize(buttonTag: string): string {
    const m = buttonTag.match(/size=["']([a-z]+)["']/);
    return m ? m[1] : "sm"; // sm is the implicit default per button-variants.ts
}

interface Mismatch {
    file: string;
    line: number;
    cancelSize: string;
    siblingSize: string;
    siblingText: string;
}

describe("Cancel button size parity", () => {
    it("every Cancel button has the same size= as its paired submit/save sibling", () => {
        const mismatches: Mismatch[] = [];
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            const rel = path.relative(ROOT, file);

            // Find every `<Button ...>Cancel</Button>` site. Use a
            // line-by-line scan; multi-line attribute splits are
            // common — match against a 6-line window.
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                // Look for Cancel-bearing Button open tag + its
                // closing children on the same or near line.
                const window6 = lines
                    .slice(i, Math.min(i + 6, lines.length))
                    .join("\n");
                const cancelMatch = window6.match(
                    /<Button\b[\s\S]*?>(?:\s*\{[^}]*\})?[Cc]ancel\s*<\/Button>/,
                );
                if (!cancelMatch) continue;

                const cancelSize = getSize(cancelMatch[0]);

                // Look for a sibling Button in a ±10-line window.
                // Sibling = another Button whose children include
                // Save / Submit / Apply / Create / Update / Confirm /
                // Send / Yes / Delete / Save the form-submit-shaped verb.
                const siblingWindow = lines
                    .slice(Math.max(0, i - 10), Math.min(i + 16, lines.length))
                    .join("\n");
                const siblingMatch = siblingWindow.match(
                    /<Button\b[\s\S]*?>(?:[^<]*?)(?:Save|Submit|Apply|Create|Update|Confirm|Send|Delete|Yes|Add|Install|Mark|Generate)[^<]*?<\/Button>/,
                );
                if (!siblingMatch) continue;

                const siblingSize = getSize(siblingMatch[0]);
                if (cancelSize !== siblingSize) {
                    mismatches.push({
                        file: rel,
                        line: i + 1,
                        cancelSize,
                        siblingSize,
                        siblingText: siblingMatch[0].slice(0, 80),
                    });
                }

                // Skip ahead past the match to avoid double-counting.
                i += 5;
            }
        }
        if (mismatches.length > 0) {
            const sample = mismatches
                .slice(0, 10)
                .map(
                    (m) =>
                        `  ${m.file}:${m.line}  Cancel size="${m.cancelSize}" but sibling size="${m.siblingSize}"\n    sibling: ${m.siblingText}`,
                )
                .join("\n");
            throw new Error(
                `Found ${mismatches.length} Cancel button(s) with mismatched size vs paired submit:\n${sample}\n\nCancel and its paired submit MUST share the same \`size=\` prop so the form's footer row reads as one rhythm. Either bump Cancel up or the submit down so they match.`,
            );
        }
        expect(mismatches).toHaveLength(0);
    });
});

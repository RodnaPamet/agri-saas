/**
 * v2-PR-1 — Button variant cull ratchet.
 *
 * Bans the four retired Button variants — `outline`, `success`,
 * `danger`, `danger-outline` — from being reintroduced as Button
 * variants. The cull retired:
 *
 *   - `outline`    → fold into `secondary` (visually adjacent at rest)
 *   - `success`    → fold into `primary`   (premium products use a
 *                                            single brand colour for
 *                                            affirmative actions; green
 *                                            "approve" reads dated)
 *   - `danger`            → renamed `destructive`         (clearer intent)
 *   - `danger-outline`    → renamed `destructive-outline` (matched rename)
 *
 * Final Button variant catalogue (5 — primary, secondary, ghost,
 * destructive, destructive-outline) lives in
 * `src/components/ui/button-variants.ts`.
 *
 * IMPORTANT: this ratchet ONLY targets the Button variant system.
 * `<InlineNotice variant="success">`, `<StatusBadge variant="success">`,
 * `<ProgressBar variant="success">` use separate, independent variant
 * systems. The patterns below are scoped to `<Button>` JSX usage and
 * `buttonVariants({...})` helper calls — never bare `variant="X"`.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/app", "src/components"];

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

// The button-variants source is exempt — it owns the catalogue and
// the test file references the retired variants in the docstring
// rationale. The button.tsx primitive is also exempt (forwards the
// variant prop directly to CVA, no string match needed).
const EXEMPT_FILES = new Set<string>([
    "src/components/ui/button-variants.ts",
    "src/components/ui/button.tsx",
]);

const RETIRED_VARIANTS = [
    "outline",
    "success",
    "danger",
    "danger-outline",
] as const;

// Match `<Button ... variant="<retired>">` (multi-line tolerant since
// many JSX elements span lines) AND `buttonVariants({ ... variant:
// '<retired>' ... })`. We deliberately don't match bare
// `variant="success"` because that catches StatusBadge/InlineNotice/
// ProgressBar — they have independent variant systems.
function buildPatterns(variant: string): RegExp[] {
    // The retired variant names contain only [a-z-] characters. The
    // hyphen is literal outside character classes so no escape is
    // needed; we interpolate the variant name directly. (CodeQL was
    // flagging an earlier `variant.replace(/-/g, "\\-")` pass as
    // js/incomplete-sanitization — false positive on trusted input,
    // but the simpler form is also correct.)
    return [
        // <Button ... variant="X" ...> on a single line
        new RegExp(`<Button[^>]*variant=["']${variant}["']`),
        // multi-line <Button> followed (within ~10 lines) by variant="X"
        // — caught by the line-by-line scan below
        // buttonVariants({ ... variant: 'X' ... })
        new RegExp(`buttonVariants\\(\\{[^}]*variant:\\s*['"\`]${variant}['"\`]`),
    ];
}

interface Hit {
    file: string;
    line: number;
    text: string;
    variant: string;
}

function isExempt(rel: string): boolean {
    if (EXEMPT_FILES.has(rel)) return true;
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
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

// Scan multi-line <Button> blocks: when we see a `<Button` that doesn't
// close on the same line, look ahead up to 15 lines for
// `variant="<retired>"`. Stops at the first `>` that closes the
// element (start tag).
function scanMultiLineButton(content: string, variant: string): number[] {
    const hits: number[] = [];
    const lines = content.split("\n");
    // Hyphen is literal outside character classes — no escape needed.
    const variantRe = new RegExp(`variant=["']${variant}["']`);
    for (let i = 0; i < lines.length; i++) {
        if (!/<Button(\s|>|$)/.test(lines[i])) continue;
        // single-line case is caught by buildPatterns; here we want
        // multi-line where the start tag spills across lines
        if (/<Button[^/]*\/?>/.test(lines[i]) && /variant=/.test(lines[i])) continue;
        for (let j = i; j < Math.min(i + 15, lines.length); j++) {
            if (variantRe.test(lines[j])) {
                hits.push(j + 1);
                break;
            }
            if (/^[^<]*>/.test(lines[j]) && j > i) break; // start tag closed
        }
    }
    return hits;
}

describe("v2-PR-1 Button variant cull ratchet", () => {
    describe("retired Button variants are not reintroduced", () => {
        it("zero `<Button variant=\"outline|success|danger|danger-outline\">` usages outside exempts", () => {
            const offenders: Hit[] = [];
            for (const dir of SCAN_DIRS) {
                for (const file of walk(path.join(ROOT, dir))) {
                    const content = fs.readFileSync(file, "utf8");
                    const lines = content.split("\n");
                    for (const variant of RETIRED_VARIANTS) {
                        const patterns = buildPatterns(variant);
                        lines.forEach((line, i) => {
                            const trimmed = line.trim();
                            if (
                                trimmed.startsWith("//") ||
                                trimmed.startsWith("*")
                            )
                                return;
                            for (const rx of patterns) {
                                if (rx.test(line)) {
                                    offenders.push({
                                        file: path.relative(ROOT, file),
                                        line: i + 1,
                                        text: trimmed.slice(0, 200),
                                        variant,
                                    });
                                    break;
                                }
                            }
                        });
                        for (const ln of scanMultiLineButton(content, variant)) {
                            offenders.push({
                                file: path.relative(ROOT, file),
                                line: ln,
                                text: lines[ln - 1].trim().slice(0, 200),
                                variant,
                            });
                        }
                    }
                }
            }
            if (offenders.length > 0) {
                const sample = offenders
                    .slice(0, 15)
                    .map(
                        (o) =>
                            `  ${o.file}:${o.line}  (variant="${o.variant}")\n    ${o.text}`,
                    )
                    .join("\n");
                throw new Error(
                    `Found ${offenders.length} retired Button variant(s). Use the new catalogue from src/components/ui/button-variants.ts (primary | secondary | ghost | destructive | destructive-outline).\n\nMigration map:\n  outline → secondary\n  success → primary\n  danger → destructive\n  danger-outline → destructive-outline\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
                );
            }
            expect(offenders).toHaveLength(0);
        });
    });

    describe("button-variants.ts catalogue contract", () => {
        const src = fs.readFileSync(
            path.join(ROOT, "src/components/ui/button-variants.ts"),
            "utf8",
        );

        it("declares exactly the 5 final variants", () => {
            // Find every `<name>: [` inside the variants block (the
            // CVA shape uses array values). The variant identifier is
            // either bare or quoted (`"destructive-outline":`).
            const variantBlock = src.match(
                /variant:\s*\{([\s\S]*?)\},\s*size:/,
            );
            expect(variantBlock).not.toBeNull();
            const block = variantBlock![1];
            const declared = Array.from(
                block.matchAll(/^\s*"?([a-z][a-z-]*)"?\s*:\s*\[/gm),
            ).map((m) => m[1]);
            expect(declared.sort()).toEqual(
                [
                    "destructive",
                    "destructive-outline",
                    "ghost",
                    "primary",
                    "secondary",
                ].sort(),
            );
        });

        it("does NOT declare any retired variant", () => {
            for (const v of RETIRED_VARIANTS) {
                // bare or quoted key followed by `: [`. The leading
                // boundary is `\b` (or start-of-line + optional quote)
                // so `"destructive-outline": [` does not match
                // `outline:` — the `-` before `outline` breaks the
                // word boundary cleanly.
                const re = new RegExp(
                    `(^|\\W)["']?${v}["']?\\s*:\\s*\\[`,
                    "m",
                );
                // Tighter: require the preceding char to NOT be `-`
                // so `"destructive-outline":` does not match `outline:`.
                const m = src.match(re);
                if (m) {
                    const idx = src.search(re);
                    const lineStart = src.lastIndexOf("\n", idx) + 1;
                    const lineEnd = src.indexOf("\n", idx);
                    const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
                    // Skip if the boundary char before the variant key
                    // is `-` (i.e. inside a hyphenated key like
                    // `destructive-outline`).
                    const offset = idx - lineStart;
                    const before = line[offset];
                    if (before !== "-") {
                        throw new Error(
                            `button-variants.ts still declares retired variant '${v}' at line: ${line.trim()}`,
                        );
                    }
                }
                // No real match — pass.
            }
            expect(true).toBe(true);
        });
    });
});

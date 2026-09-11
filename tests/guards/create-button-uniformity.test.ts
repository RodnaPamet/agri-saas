/**
 * v2-fu-2 — Create button uniformity ratchet.
 *
 * Asserts the positive contract for create-action buttons. Pairs
 * with `tests/guards/action-label-vocabulary.test.ts` (which owns
 * the BAN side — no legacy `New|Add|Create X` text).
 *
 * The convention (v2-fu-2):
 *   Every "create" button reads literally `+ <Singular Noun>` and
 *   uses `<Button variant="primary">` (default `size="md"` — h-9 px).
 *
 *   - The `+` IS the icon. No separate `<Plus>` component.
 *   - The variant is locked to `primary` so the `+` glyph is
 *     uniformly white-on-brand across every create button.
 *   - The size is locked to `md` (no `sm` / `xs`) so the pill
 *     height is constant.
 *
 * What this ratchet enforces
 *   1. JSX `<Button ...>+ <Word>...</Button>` must declare
 *      `variant="primary"`. Calls without an explicit variant
 *      inherit the default (`primary`) so they pass.
 *   2. The same buttons must NOT declare `size="sm"` or `size="xs"`
 *      — calls without an explicit size pass (default = `md`).
 *
 * Pairs with:
 *   - tests/guards/action-label-vocabulary.test.ts (BAN side)
 *   - src/components/ui/button-variants.ts (the variant catalogue)
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

interface Hit {
    file: string;
    line: number;
    text: string;
    issue: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full);
        const segments = rel.split(path.sep);
        if (segments.some((s) => EXEMPT_DIR_NAMES.has(s))) continue;
        if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

/**
 * Multi-line + multi-tag scan for create-button-shaped JSX blocks.
 *
 * Strategy:
 *   1. Find any `+ <CapitalisedWord>` text node in the file (whether
 *      it's on its own line, inline `>+ X<`, or inside a string).
 *   2. Walk BACKWARDS up to ~6 lines looking for the most recent
 *      open tag of `<Button`, `<button`, or `<Link`. Capture the
 *      attribute substring between `<TagName` and the matching `>`.
 *      Attributes can span multiple lines.
 *   3. Skip JSX text inside the open-tag bracket (we only want the
 *      *children* text node).
 *   4. If the captured attrs contain `buttonVariants(` (for `<Link>`
 *      / `<button>`) or the tag is `<Button` (CVA primitive), it's a
 *      create-button site. Yield the attrs for variant/size checks.
 */
interface CreateBtnHit {
    line: number;
    text: string;
    tagAttrs: string;
}

function findCreateButtons(content: string): CreateBtnHit[] {
    const lines = content.split("\n");
    const out: CreateBtnHit[] = [];
    // The `+ Word` text matcher. We require the `+` to be on its
    // own (preceded by start-of-line/whitespace/quote/`>`) and the
    // word to be capitalised. Skip lines that are clearly comments
    // or include "(New|Add|Create) X" — those are picked up by
    // action-label-vocabulary.
    const TEXT_RE =
        /(?:^|['"`>\s])\+\s+([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,3})/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*"))
            continue;
        if (!TEXT_RE.test(line)) continue;
        // Skip the legacy-verb form (handled by the other ratchet).
        if (/\+\s+(New|Add|Create)\s+/.test(line)) continue;

        // Walk back up to 6 lines for the most recent open tag.
        let openLineIdx = -1;
        let openMatch: RegExpExecArray | null = null;
        for (
            let j = i;
            j >= Math.max(0, i - 6) && openMatch === null;
            j--
        ) {
            const re = /<([Bb]utton|Link)\b/g;
            let m: RegExpExecArray | null = null;
            let last: RegExpExecArray | null = null;
            while ((m = re.exec(lines[j])) !== null) last = m;
            if (last) {
                openLineIdx = j;
                openMatch = last;
            }
        }
        if (!openMatch) continue;

        // Build the attribute substring from `<TagName` to the next `>`
        // — possibly spanning multiple lines.
        let attrs = "";
        let foundClose = false;
        const startIdx = openMatch.index + openMatch[0].length;
        for (let j = openLineIdx; j <= i && !foundClose; j++) {
            const segment =
                j === openLineIdx ? lines[j].slice(startIdx) : lines[j];
            const closeIdx = segment.indexOf(">");
            if (closeIdx >= 0) {
                attrs += segment.slice(0, closeIdx);
                foundClose = true;
            } else {
                attrs += segment + " ";
            }
        }
        if (!foundClose) continue;

        const tagName = openMatch[1];
        // For `<Link>` / `<button>`, only count it as a create-button
        // if the attrs reference `buttonVariants(...)` (otherwise
        // it's just a plain link/button).
        if (tagName !== "Button" && !/buttonVariants\s*\(/.test(attrs))
            continue;

        out.push({
            line: i + 1,
            text: trimmed.slice(0, 200),
            tagAttrs: attrs,
        });
    }
    return out;
}

describe("v2-fu-2 create-button uniformity", () => {
    it("zero `+ X` buttons declare a non-primary variant", () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, "utf8");
                for (const hit of findCreateButtons(content)) {
                    const variantMatch = hit.tagAttrs.match(
                        /variant\s*[:=]\s*["']([a-z-]+)["']/,
                    );
                    if (
                        variantMatch &&
                        variantMatch[1] !== "primary"
                    ) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            line: hit.line,
                            text: hit.text,
                            issue: `variant="${variantMatch[1]}" — must be variant="primary"`,
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
                        `  ${o.file}:${o.line}  [${o.issue}]\n    ${o.text}`,
                )
                .join("\n");
            throw new Error(
                `Found ${offenders.length} create-button(s) with non-primary variant. The '+' glyph must render uniformly white-on-brand across every create button — keep the variant locked to 'primary'.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it("zero `+ X` buttons declare size='sm' or size='xs'", () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, "utf8");
                for (const hit of findCreateButtons(content)) {
                    const sizeMatch = hit.tagAttrs.match(
                        /size\s*[:=]\s*["'](xs|sm)["']/,
                    );
                    if (sizeMatch) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            line: hit.line,
                            text: hit.text,
                            issue: `size="${sizeMatch[1]}" — drop the prop (default 'md' is the canonical pill height)`,
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
                        `  ${o.file}:${o.line}  [${o.issue}]\n    ${o.text}`,
                )
                .join("\n");
            throw new Error(
                `Found ${offenders.length} create-button(s) with size='xs' or 'sm'. Pill height must be uniform — drop the prop so the default 'md' (h-9) applies.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});

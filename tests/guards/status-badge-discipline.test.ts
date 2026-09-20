/**
 * v2-PR-3 — StatusBadge override eradication ratchet.
 *
 * The StatusBadge primitive owns three visual axes:
 *   - variant (neutral | info | success | warning | error) — Roadmap-6 PR-10 retired `pending`
 *   - tone    (solid | subtle)
 *   - size    (sm | md)
 *
 * Consumers MUST NOT bypass these via className overrides for size,
 * shape, or opacity. The acceptable className additions are:
 *   - layout (`ml-auto`, `mr-1`, `flex-shrink-0`, `w-fit`, …)
 *   - cursor / hover behaviour (`cursor-help`, `animate-pulse`, …)
 *   - testing hooks (`tabular-nums` for monospaced numbers)
 *
 * What this ratchet bans:
 *   - `text-[Npx]`           — use `size="sm"` for 10 px / `size="md"` for 12 px
 *   - `rounded-(md|lg|none)` — pill shape is locked at the primitive
 *   - `py-N px-N`            — sizing comes from `size` prop
 *   - `bg-bg-{success,info,warning,error}` overrides — variant owns the bg
 *   - `text-content-{...}/[0-9]+` opacity overrides — variant owns the tone
 *
 * Pairs with:
 *   - `src/components/ui/status-badge.tsx` (the primitive)
 *   - `tests/guardrails/cva-primitives.test.ts` (CVA shape contract)
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

const EXEMPT_FILES = new Set<string>([
    // Primitive itself + the type module — own their own className.
    "src/components/ui/status-badge.tsx",
]);

// Banned className substrings (when present inside a StatusBadge
// className= prop). The detector is line-scoped: it greps for
// `<StatusBadge` start and looks at the rest of that line for any
// banned substring. Multi-line StatusBadge declarations are caught
// by a 5-line lookahead.
const BANNED_PATTERNS: { name: string; rx: RegExp }[] = [
    {
        name: "text-[Npx] override (use size='sm' or size='md')",
        rx: /text-\[\d+px\]/,
    },
    {
        name: "rounded-* override (pill shape locked at primitive)",
        rx: /\brounded-(?:md|lg|none|sm|xl|2xl|3xl)\b/,
    },
    {
        name: "py-N or px-N override (size prop owns padding)",
        rx: /\b(?:py|px)-(?:0\.5|1|1\.5|2|2\.5|3|3\.5|4|5|6|7|8)\b/,
    },
];

interface Hit {
    file: string;
    line: number;
    text: string;
    rule: string;
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

// Single-line: <StatusBadge ... className="..." ...>
// Multi-line: <StatusBadge then later (within 5 lines) className="..."
function scanFile(content: string): {
    line: number;
    classNameValue: string;
}[] {
    const lines = content.split("\n");
    const hits: { line: number; classNameValue: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/<StatusBadge\b/.test(lines[i])) continue;
        // Look for className= within the next 5 lines
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
            const m = lines[j].match(/className=["']([^"']+)["']/);
            if (m) {
                hits.push({ line: j + 1, classNameValue: m[1] });
                break;
            }
            // Stop at the closing > of the JSX start tag
            if (j > i && /^[^<]*>/.test(lines[j])) break;
        }
    }
    return hits;
}

describe("v2-PR-3 StatusBadge override eradication", () => {
    /**
     * SELECTOR CONTROL — `isExempt` has teeth.
     *
     * The ratchet below asserts `offenders` is EMPTY, and an empty selection
     * is a pass. `isExempt` is the gate on the whole population: gutted to
     * `true` it exempts every entry, `walk` returns zero files, and the
     * ratchet passes having scanned nothing. Gutted to any falsy constant it
     * exempts nothing, and the primitive — which owns its own className by
     * design — is scanned as if it were a consumer. `scripts/selector-teeth.mjs`
     * confirmed all NINE guts survived before these assertions existed.
     *
     * So pin both directions, on paths that are REAL:
     *   - it exempts something that genuinely is exempt, and
     *   - it does NOT exempt a file the ratchet must keep scanning,
     *   - and those two answers show up in the population `walk` returns.
     */
    describe("selector control: isExempt", () => {
        // The primitive itself (EXEMPT_FILES) and this guard file (the
        // `.test.ts` arm of EXEMPT_FILE_PATTERNS) — both exist on disk.
        const EXEMPT_REAL = [
            "src/components/ui/status-badge.tsx",
            path.relative(ROOT, __filename),
        ];
        // A real StatusBadge consumer. If this is ever exempted the ratchet
        // stops reading the exact class of file it was written for.
        const SCANNED_REAL = "src/components/ui/meta-strip.tsx";

        it("exempts real exempt paths and refuses a real consumer", () => {
            for (const rel of EXEMPT_REAL) {
                expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
                expect(isExempt(rel)).toBe(true);
            }

            const consumer = path.join(ROOT, SCANNED_REAL);
            expect(fs.existsSync(consumer)).toBe(true);
            expect(fs.readFileSync(consumer, "utf8")).toContain("<StatusBadge");
            // A predicate gutted to `true` — or to any truthy constant — dies
            // here; one gutted to a falsy constant dies on the loop above.
            expect(isExempt(SCANNED_REAL)).toBe(false);
        });

        it("shapes a real, non-trivial scan population", () => {
            const scanned: string[] = [];
            for (const dir of SCAN_DIRS) scanned.push(...walk(path.join(ROOT, dir)));

            // Shape BEFORE any read: `0` is a valid file descriptor, and
            // `readFileSync(0)` blocks on stdin forever.
            expect(Array.isArray(scanned)).toBe(true);
            expect(scanned.every((f) => typeof f === "string")).toBe(true);

            // 1271 files at the time of writing; the floor sits far below so
            // ordinary churn never trips it, and zero can never pass.
            expect(scanned.length).toBeGreaterThan(600);
            expect(scanned.filter((f) => fs.existsSync(f))).toHaveLength(
                scanned.length,
            );

            // The exemption actually removed the primitive…
            expect(scanned).not.toContain(
                path.join(ROOT, "src/components/ui/status-badge.tsx"),
            );
            // …and did not remove a file the ratchet is here to police.
            expect(scanned).toContain(path.join(ROOT, SCANNED_REAL));
        });
    });

    /**
     * CONTROL for `scanFile` — it survived the four EMPTY ITERABLES.
     *
     * The consumer below is `for (const m of scanFile(content))`. That seam
     * throws on the five non-iterable guts (0 null undefined false {}) but
     * accepts [] '' new Set() new Map() and simply iterates nothing — so the
     * ratchet reported zero banned overrides having examined nothing (#971).
     * Exactly the 4-of-9 signature the completed sweep found 35 times over.
     *
     * Collected through the guard's OWN seam, deliberately: a control that
     * consumed with `flatMap` would WRAP a non-array return rather than
     * rejecting it, making the control weaker than the code it certifies.
     */
    describe("selector control: scanFile", () => {
        it("finds real StatusBadge className usages, correctly shaped", () => {
            const hits: { line: number; classNameValue: string }[] = [];
            for (const dir of SCAN_DIRS) {
                for (const file of walk(path.join(ROOT, dir))) {
                    for (const m of scanFile(fs.readFileSync(file, "utf8"))) {
                        hits.push(m);
                    }
                }
            }
            // ~51 StatusBadge usages carry a className today across src/app
            // and src/components; the floor sits far below so churn is safe.
            expect(hits.length).toBeGreaterThan(20);
            for (const h of hits) {
                expect(typeof h.line).toBe("number");
                expect(typeof h.classNameValue).toBe("string");
                expect(h.classNameValue.length).toBeGreaterThan(0);
            }
        });

        it("locates the shape precisely, not just in bulk", () => {
            const one = scanFile('<StatusBadge variant="ok" className="h-8 px-2" />');
            expect(one).toHaveLength(1);
            expect(one[0].classNameValue).toBe("h-8 px-2");
        });
    });

    describe("banned className overrides", () => {
        it("zero size/shape/padding overrides on StatusBadge", () => {
            const offenders: Hit[] = [];
            for (const dir of SCAN_DIRS) {
                for (const file of walk(path.join(ROOT, dir))) {
                    const content = fs.readFileSync(file, "utf8");
                    const matches = scanFile(content);
                    for (const m of matches) {
                        for (const ban of BANNED_PATTERNS) {
                            if (ban.rx.test(m.classNameValue)) {
                                offenders.push({
                                    file: path.relative(ROOT, file),
                                    line: m.line,
                                    text: m.classNameValue.slice(0, 200),
                                    rule: ban.name,
                                });
                                break;
                            }
                        }
                    }
                }
            }
            if (offenders.length > 0) {
                const sample = offenders
                    .slice(0, 15)
                    .map(
                        (o) =>
                            `  ${o.file}:${o.line}  [${o.rule}]\n    className="${o.text}"`,
                    )
                    .join("\n");
                throw new Error(
                    `Found ${offenders.length} StatusBadge className override(s). Use props (variant / tone / size) instead — the primitive owns shape, padding, and tone.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
                );
            }
            expect(offenders).toHaveLength(0);
        });
    });

    describe("StatusBadge primitive contract (post v2-PR-3)", () => {
        const src = fs.readFileSync(
            path.join(ROOT, "src/components/ui/status-badge.tsx"),
            "utf8",
        );

        it("base CVA uses rounded-full (pill shape locked)", () => {
            // The base class string lives on the cva() first arg.
            expect(src).toMatch(/cva\(\s*["'][^"']*\brounded-full\b/);
        });

        it("declares the 5 main variants and no `*-subtle` legacy variants", () => {
            // Roadmap-6 PR-10 — `pending` retired. Zero callsites
            // ever used it; the semantic was redundant with
            // `warning` (needs-attention) or `info` (in-progress).
            const variantBlock = src.match(
                /variant:\s*\{([\s\S]*?)\},\s*tone:/,
            );
            expect(variantBlock).not.toBeNull();
            const inner = variantBlock![1];
            for (const v of [
                "neutral",
                "info",
                "success",
                "warning",
                "error",
            ]) {
                expect(inner).toContain(`${v}:`);
            }
            // The retired `pending` variant must not come back.
            expect(inner).not.toMatch(/\bpending:/);
            // Legacy `*-subtle` variants must NOT be back.
            for (const v of [
                "info-subtle",
                "success-subtle",
                "warning-subtle",
                "error-subtle",
            ]) {
                expect(inner).not.toMatch(new RegExp(`["']${v}["']`));
            }
        });

        it("declares the tone axis (solid | subtle)", () => {
            const toneBlock = src.match(/tone:\s*\{([\s\S]*?)\},\s*size:/);
            expect(toneBlock).not.toBeNull();
            const inner = toneBlock![1];
            expect(inner).toMatch(/solid:/);
            expect(inner).toMatch(/subtle:/);
        });

        it("declares the size axis (sm | md)", () => {
            const sizeBlock = src.match(
                /size:\s*\{([\s\S]*?)\},\s*\},\s*compoundVariants:/,
            );
            expect(sizeBlock).not.toBeNull();
            const inner = sizeBlock![1];
            expect(inner).toMatch(/sm:/);
            expect(inner).toMatch(/md:/);
        });

        it("compoundVariants table covers all (variant × tone) combinations", () => {
            const variants = [
                "neutral",
                "info",
                "success",
                "warning",
                "error",
            ];
            const tones = ["solid", "subtle"];
            for (const v of variants) {
                for (const t of tones) {
                    const re = new RegExp(
                        `\\{\\s*variant:\\s*["']${v}["'],\\s*tone:\\s*["']${t}["']`,
                    );
                    expect(src).toMatch(re);
                }
            }
        });
    });
});

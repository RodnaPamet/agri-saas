/**
 * v2-PR-9 — Card elevation system ratchet.
 *
 * Locks the `<Card>` primitive to a 3-level elevation scale —
 * `flat | raised | floating` — expressed via background tone (never
 * shadows).
 *
 * Why no shadows on Card consumers:
 *   - Premium products (Linear, Stripe, Vercel) express depth on
 *     dark surfaces through background-tone changes, not via
 *     box-shadow. Shadows on glass / blurred surfaces look uncertain.
 *   - Tone-based elevation reads as deliberate and quiet — the same
 *     motion + focus discipline as v2-PR-4 (no transform / shadow
 *     hovers).
 *
 * What this ratchet bans:
 *   - `shadow-(sm|md|lg|xl|2xl)` className overrides on `<Card>`
 *     consumers. The primitive owns depth; consumers express
 *     elevation via the prop, not via shadow utilities.
 *
 * Pairs with:
 *   - src/components/ui/card.tsx (the primitive)
 *   - tests/guards/card-density-discipline.test.ts (the density axis)
 *   - tests/guards/motion-language-discipline.test.ts (no
 *     hover-transform / hover-shadow on clickable surfaces)
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
    // The primitive owns its own className. The Card module references
    // shadow utilities only via the docstring rationale.
    "src/components/ui/card.tsx",
]);

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

function scanCardWithShadowOverride(
    content: string,
): { line: number; classNameValue: string }[] {
    const lines = content.split("\n");
    const hits: { line: number; classNameValue: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/<Card\b/.test(lines[i])) continue;
        // Look for className= within the next 5 lines (handles
        // multi-line JSX start tags).
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
            const m = lines[j].match(/className=["']([^"']+)["']/);
            if (m) {
                if (
                    /\bshadow-(sm|md|lg|xl|2xl)\b/.test(m[1])
                ) {
                    hits.push({ line: j + 1, classNameValue: m[1] });
                }
                break;
            }
            // Closing tag of the JSX start element.
            if (j > i && /^[^<]*>/.test(lines[j])) break;
        }
    }
    return hits;
}

describe("v2-PR-9 Card elevation ratchet", () => {
    describe("no `shadow-*` className overrides on Card consumers", () => {
        it("zero shadow utilities on `<Card>` outside primitives", () => {
            const offenders: {
                file: string;
                line: number;
                text: string;
            }[] = [];
            for (const dir of SCAN_DIRS) {
                for (const file of walk(path.join(ROOT, dir))) {
                    const content = fs.readFileSync(file, "utf8");
                    for (const m of scanCardWithShadowOverride(content)) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            line: m.line,
                            text: m.classNameValue.slice(0, 200),
                        });
                    }
                }
            }
            if (offenders.length > 0) {
                const sample = offenders
                    .slice(0, 15)
                    .map(
                        (o) =>
                            `  ${o.file}:${o.line}\n    className="${o.text}"`,
                    )
                    .join("\n");
                throw new Error(
                    `Found ${offenders.length} <Card> consumer(s) with shadow-* overrides. The Card primitive owns depth via the \`elevation\` prop (flat | raised | floating). Use \`<Card elevation="floating">\` for "above-raised" surfaces instead of \`shadow-md\`.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
                );
            }
            expect(offenders).toHaveLength(0);
        });
    });

    describe("Card primitive contract", () => {
        // Roadmap-5 hotfix — `cardVariants` lives in
        // `card-variants.ts` (a non-"use client" sibling) so server
        // components can call it. The CVA definition + variant
        // bodies are asserted on that file; the JSX-level wiring is
        // asserted on card.tsx.
        const variants = fs.readFileSync(
            path.join(ROOT, "src/components/ui/card-variants.ts"),
            "utf8",
        );
        const src = fs.readFileSync(
            path.join(ROOT, "src/components/ui/card.tsx"),
            "utf8",
        );

        it("declares the elevation axis", () => {
            const elevationBlock = variants.match(
                /elevation:\s*\{([\s\S]*?)\},\s*density:/,
            );
            expect(elevationBlock).not.toBeNull();
            const inner = elevationBlock![1];
            for (const e of ["flat", "raised", "floating"]) {
                expect(inner).toMatch(new RegExp(`\\b${e}:`));
            }
        });

        it("`raised` elevation maps to glass-card (visual unchanged)", () => {
            // The consumer-facing default. Must not silently switch
            // visuals — every existing <Card> without an explicit
            // elevation prop renders identically to before.
            expect(variants).toMatch(/raised:\s*["']glass-card["']/);
        });

        it("`flat` elevation uses bg-bg-page (matches page background)", () => {
            expect(variants).toMatch(/flat:\s*["'][^"']*\bbg-bg-page\b/);
        });

        it("`floating` elevation uses bg-bg-elevated", () => {
            expect(variants).toMatch(/floating:\s*["'][^"']*\bbg-bg-elevated\b/);
        });

        it("default elevation is `raised` (preserves existing visual)", () => {
            expect(variants).toMatch(/elevation:\s*["']raised["']/);
        });

        it("forwards the `elevation` prop to the cardVariants call", () => {
            expect(src).toMatch(
                /cardVariants\(\{[^}]*elevation[^}]*\}\)/,
            );
        });
    });
});

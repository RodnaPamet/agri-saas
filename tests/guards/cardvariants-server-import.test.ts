/**
 * Hotfix ratchet — server components must import `cardVariants` from
 * `@/components/ui/card-variants`, NEVER from `@/components/ui/card`.
 *
 * Background. `card.tsx` carries `"use client"` because it exports the
 * `<Card>` JSX component. In Next.js App Router, every export from a
 * `"use client"` module — INCLUDING re-exports of values from other
 * server-safe modules — becomes a client reference at the boundary.
 * When a SERVER component imports `cardVariants` from
 * `@/components/ui/card`, the symbol it gets back is a client
 * reference, not the actual cva function. Calling it during SSR
 * throws "An error occurred in the Server Components render".
 *
 * The fix: server components import from
 * `@/components/ui/card-variants` (no `"use client"` directive).
 * The client `<Card>` component still imports + re-exports
 * `cardVariants` from the same sibling so existing client-side
 * `import { Card, cardVariants } from '@/components/ui/card'` callers
 * keep working.
 *
 * Why a static ratchet instead of a runtime check: the failure mode
 * only surfaces at SSR time on the specific page — it's invisible
 * to typecheck, jest unit tests, AND the per-page Playwright suite if
 * the suite uses an authenticated cookie that bypasses the broken
 * server-side render. A static scan catches it the moment a server
 * component imports `cardVariants` from `card`.
 *
 * The first incident (hotfix #282 — Roadmap-5 PR-1) split the cva
 * function out but did NOT update the import statements at the
 * 5 known callsites; the regression went live and required a second
 * hotfix to migrate every server-component callsite + add this
 * ratchet so the next contributor cannot reintroduce the boundary
 * violation.
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

// `card.tsx` itself is the canonical re-exporter. The CLIENT `<Card>`
// component lives there and legitimately calls `cardVariants` —
// because it runs in the client bundle, the boundary issue does not
// apply. Excluded from the scan.
const EXEMPT_FILES = new Set<string>([
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
        else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full);
    }
    return out;
}

function hasUseClientDirective(src: string): boolean {
    // The directive must be the first executable statement of the
    // module — but Next allows it after a leading docblock. Match
    // any line in the file that is exactly `"use client"` /
    // `'use client'` (with optional trailing semicolon).
    return /^['"]use client['"];?$/m.test(src);
}

interface Offender {
    file: string;
    line: number;
    text: string;
}

describe("cardVariants server-import boundary", () => {
    it("no server component imports cardVariants from @/components/ui/card", () => {
        const offenders: Offender[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, "utf8");
                if (hasUseClientDirective(content)) continue;
                const lines = content.split("\n");
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    // Only flag the SPECIFIC bad shape: an import
                    // that pulls `cardVariants` from `card` (NOT
                    // `card-variants`). The `(?!-variants)` lookahead
                    // makes the match path-precise.
                    if (
                        /\bcardVariants\b/.test(line) &&
                        /from\s+['"]@\/components\/ui\/card(?!-variants)['"]/.test(
                            line,
                        )
                    ) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            line: i + 1,
                            text: line.trim(),
                        });
                    }
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 15)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join("\n");
            throw new Error(
                `Found ${offenders.length} server component(s) importing cardVariants from "@/components/ui/card". Use "@/components/ui/card-variants" instead — the "use client" boundary in card.tsx turns the import into a client reference that cannot be invoked during SSR. See tests/guards/cardvariants-server-import.test.ts for the rationale.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it("card-variants module exists and is server-safe (no use-client directive)", () => {
        const cardVariantsPath = path.join(
            ROOT,
            "src/components/ui/card-variants.ts",
        );
        expect(fs.existsSync(cardVariantsPath)).toBe(true);
        const src = fs.readFileSync(cardVariantsPath, "utf8");
        expect(hasUseClientDirective(src)).toBe(false);
        // Sanity: it actually exports cardVariants.
        expect(src).toMatch(/export\s+const\s+cardVariants\s*=/);
    });
});

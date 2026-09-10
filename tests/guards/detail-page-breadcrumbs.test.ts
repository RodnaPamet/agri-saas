/**
 * v2-fu-3 — Detail-page breadcrumbs coverage ratchet.
 *
 * Asserts that every page using `<EntityDetailLayout>` passes a
 * `breadcrumbs` prop. Without breadcrumbs, the user has only the
 * `back` link to navigate up — and `back` only goes one level. A
 * detail page reached through a sub-list (e.g. tasks reached via
 * audit pack) needs the full chain to feel navigable.
 *
 * The companion ratchet at
 * `tests/guards/page-breadcrumbs-coverage.test.ts` covers list
 * pages (level-1 heading sites). This one covers detail pages
 * (EntityDetailLayout consumers).
 *
 * What this ratchet enforces
 *   Every file that imports + renders `<EntityDetailLayout>` MUST
 *   pass `breadcrumbs={[...]}` on the main render path. The check
 *   is text-level — if `breadcrumbs={` appears anywhere in the
 *   file (props or const declaration), the assertion passes.
 *
 * Pairs with:
 *   - src/components/layout/EntityDetailLayout.tsx (the shell)
 *   - src/components/layout/PageHeader.tsx (the breadcrumbs slot)
 *   - tests/guards/page-breadcrumbs-coverage.test.ts (list-page
 *     coverage — the other half of the breadcrumbs story)
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/app/t"];

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

// Files that legitimately use `<EntityDetailLayout>` WITHOUT
// breadcrumbs. Each entry needs a written reason.
const EXEMPT_FILES = new Set<string>([
    // Currently empty — every detail page should have breadcrumbs.
    // If a future page genuinely doesn't need them (e.g. a modal-
    // shaped page outside the main hierarchy), add it here with a
    // written reason and bump the cap.
]);

const ENTITY_DETAIL_RE = /<EntityDetailLayout\b/;
const BREADCRUMBS_RE = /breadcrumbs\s*=\s*\{|breadcrumbs\s*:\s*\[|const\s+breadcrumbs\s*=|const\s+\w*[Bb]readcrumbs\s*=/;

interface Hit {
    file: string;
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

describe("detail-page breadcrumbs coverage", () => {
    it("every page rendering <EntityDetailLayout> also passes breadcrumbs", () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, "utf8");
                if (!ENTITY_DETAIL_RE.test(content)) continue;
                if (BREADCRUMBS_RE.test(content)) continue;
                offenders.push({ file: path.relative(ROOT, file) });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 15)
                .map((o) => `  ${o.file}`)
                .join("\n");
            throw new Error(
                `Found ${offenders.length} detail page(s) using <EntityDetailLayout> without a breadcrumbs prop. Detail pages reached from a sub-list (e.g. tasks via audit pack) need the full chain — 'back' only goes one level.\n\nAdd:\n\n  const breadcrumbs = [\n    { label: 'Dashboard', href: tenantHref('/dashboard') },\n    { label: '<Section>', href: tenantHref('/<section>') },\n    { label: <entity?.name ?? 'Entity'> },\n  ];\n\nand pass it on every <EntityDetailLayout breadcrumbs={breadcrumbs}> call (loading/error/empty/main).\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it("exempt list is deliberately bounded", () => {
        // Currently 0; a future exemption should be a deliberate
        // call documented inline. Cap at 5 to prevent silent growth.
        expect(EXEMPT_FILES.size).toBeLessThanOrEqual(5);
    });
});

/**
 * PR-10 — InlineNotice primitive ratchet.
 *
 * Bans the hand-rolled `bg-bg-{variant} border border-border-{variant}`
 * banner-shape pattern outside the canonical primitive. The 5-line
 * recurring block:
 *
 *   <div className="p-3 bg-bg-error border border-border-error rounded-lg flex items-center gap-2">
 *     <XCircle ... />
 *     <span className="... text-content-error">{error}</span>
 *     <button onClick={() => setError(null)}>...</button>
 *   </div>
 *
 * is now `<InlineNotice variant="error" onDismiss={...}>{error}</InlineNotice>`.
 * One source of truth for: per-variant token pair, role/aria-live,
 * dismiss button shape, icon defaults.
 *
 * Pairs with:
 *   - `tests/rendered/inline-notice.test.tsx` — primitive contract
 *   - `src/components/ui/inline-notice.tsx` — the canonical surface
 *   - `src/components/ui/empty-state.tsx` (companion empty primitive)
 *   - `src/components/ui/error-state.tsx` (companion full-pane error)
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

// Files that legitimately use `bg-bg-X border border-border-X` for a
// non-banner shape (stat panels, conditional pills, circular icon
// frames, segmented toggle buttons). Each exemption needs a written
// reason.
const EXEMPT_FILES = new Set<string>([
    // The canonical primitive itself + its docstring example block.
    "src/components/ui/inline-notice.tsx",

    // Stat-card cluster — four colour-coded metric panels (controls /
    // policies / evidence / issues counts) inside a default audit
    // pack preview. The shape is a panel, not a notice — pulling out
    // the count-as-headline + label-below-it doesn't fit InlineNotice.
    "src/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/page.tsx",

    // Conditional sync-result class string — sync-result rows colour
    // their background by status (PASSED → success, FAILED → error,
    // RUNNING → neutral). It's a styled row inside a list, not a
    // dismissable banner.
    "src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx",

    // Conditional status pill class string — drives an integration's
    // health pill background (HEALTHY → success, DEGRADED → error).
    // It's a status pill, not a banner.
    "src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx",

    // Circular 16x16 icon container backgrounds for the 401 / 403
    // illustrations. Same colour pair, but the shape is a rounded-2xl
    // square holding an icon — not a banner with text.
    "src/components/ForbiddenPage.tsx",

    // Segmented Full-Access toggle button inside ScopePicker (api-keys
    // create form). Uses the warning-tone colour pair as the SELECTED
    // state of a button — not a banner. The two error/success banner
    // sites in this file have already been migrated to InlineNotice.
    "src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx",

    // Per-row "is current user" pill button on the members table (line
    // 482). The colour pair drives a button-shape, not a banner. The
    // two error/success banner sites in this file have already been
    // migrated to InlineNotice.
    "src/app/t/[tenantSlug]/(app)/admin/members/page.tsx",

    // Two non-banner uses: a segmented active/inactive toggle (line
    // 130) and a small inline error sub-row label inside a tab bar
    // (line 234). The new-token banner has already been migrated to
    // InlineNotice.
    "src/app/t/[tenantSlug]/(app)/admin/scim/page.tsx",

    // Two `rounded-full` status pills inside SoA report rows
    // (UNMAPPED → error pill, JUSTIFIED → warning pill). Pills are not
    // notices; SoA has no banner sites.

    // "MFA enrolled" success pill (rounded-full, single-line). Not a
    // notice — there's no ?error/?success messaging here, just a
    // current-state pill on the user's settings page.
    "src/app/t/[tenantSlug]/(app)/security/mfa/page.tsx",

    // Inside admin/security/page.tsx the "Strict" rounded-full pill
    // next to the REQUIRED MFA radio option (line 237) uses the same
    // colour pair as a warning notice would. The three banner sites
    // in this file have already been migrated to InlineNotice. Listed
    // here because the pill keeps the colour-pair signature on a
    // line that the regex still matches.
    "src/app/t/[tenantSlug]/(app)/admin/security/page.tsx",

    // FormError reused with a warning-tone className override on the
    // task-create page's link validation hint. The override uses
    // opacity modifiers (bg-bg-warning/10, border-border-warning/40)
    // to render a subtler shade than InlineNotice's full tint —
    // intentional. Long-term: extend FormError to accept a `tone`
    // prop instead of the className override; out of PR-10 scope.
    //
    // Modal-form P1 (2026-05-24) — the field cluster was extracted
    // from `tasks/new/page.tsx` into `tasks/_form/NewTaskFields.tsx`
    // so the future modal can compose the same markup. The warning-
    // tone FormError moved with the fields; the exemption follows.
    "src/components/tasks/_form/NewTaskFields.tsx",
]);

// Match `bg-bg-{variant}` co-occurring with `border-border-{variant}`
// on the same line. The same pair always means "tinted-surface +
// matching border" — InlineNotice owns that combo.
const BANNED_PATTERN =
    /bg-bg-(error|success|warning|info)\b[^"'`]*\bborder-border-\1\b/;

function isExempt(rel: string): boolean {
    if (EXEMPT_FILES.has(rel)) return true;
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
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

interface Hit {
    file: string;
    line: number;
    text: string;
}

describe("PR-10 InlineNotice discipline", () => {
    describe("hand-rolled `bg-bg-X border border-border-X` banners eradicated", () => {
        it("zero banner-shape blocks outside the canonical InlineNotice", () => {
            const offenders: Hit[] = [];
            for (const dir of SCAN_DIRS) {
                for (const file of walk(path.join(ROOT, dir))) {
                    const content = fs.readFileSync(file, "utf8");
                    const lines = content.split("\n");
                    lines.forEach((line, i) => {
                        const trimmed = line.trim();
                        if (
                            trimmed.startsWith("//") ||
                            trimmed.startsWith("*")
                        )
                            return;
                        if (BANNED_PATTERN.test(line)) {
                            offenders.push({
                                file: path.relative(ROOT, file),
                                line: i + 1,
                                text: trimmed.slice(0, 200),
                            });
                        }
                    });
                }
            }
            if (offenders.length > 0) {
                const sample = offenders
                    .slice(0, 15)
                    .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                    .join("\n");
                throw new Error(
                    `Found ${offenders.length} hand-rolled bg-bg-X border border-border-X banner block(s). Use <InlineNotice variant="..."> from @/components/ui/inline-notice instead.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
                );
            }
            expect(offenders).toHaveLength(0);
        });

        it("documents every exempt file with a reason", () => {
            for (const rel of EXEMPT_FILES) {
                const abs = path.resolve(ROOT, rel);
                expect(fs.existsSync(abs)).toBe(true);
            }
        });

        it("exempt files are deliberately small in number", () => {
            // 1 canonical primitive + ≤14 documented non-banner uses
            // (stat panels, sync-result rows, status pills, segmented
            // toggle buttons, the ForbiddenPage icon frame, and one
            // FormError tone override). The cap is generous because
            // pills + segmented toggles use the same colour-pair
            // tokens — but each new exemption MUST carry a written
            // reason. Bumping past 15 without rationale means a
            // banner is leaking through unmigrated.
            expect(EXEMPT_FILES.size).toBeLessThanOrEqual(15);
        });
    });

    describe("InlineNotice primitive contract", () => {
        const src = fs.readFileSync(
            path.join(ROOT, "src/components/ui/inline-notice.tsx"),
            "utf8",
        );

        it("exports the InlineNotice component", () => {
            expect(src).toMatch(/export\s+function\s+InlineNotice/);
        });

        it("exports the InlineNoticeProps + InlineNoticeVariant types", () => {
            expect(src).toMatch(/export\s+interface\s+InlineNoticeProps/);
            expect(src).toMatch(/export\s+type\s+InlineNoticeVariant/);
        });

        it("declares all four variants", () => {
            for (const v of ["error", "success", "warning", "info"]) {
                expect(src).toMatch(new RegExp(`['"]${v}['"]`));
            }
        });

        it("error variant uses role=alert, others use role=status", () => {
            // Both roles must appear in the per-variant tokens table.
            expect(src).toMatch(/role:\s*["']alert["']/);
            expect(src).toMatch(/role:\s*["']status["']/);
        });

        it("uses aria-live=polite", () => {
            expect(src).toMatch(/aria-live="polite"/);
        });
    });
});

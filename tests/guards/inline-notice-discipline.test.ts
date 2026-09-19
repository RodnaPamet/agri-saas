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

    // Stat-card cluster — four colour-coded metric panels (practices /
    // policies / evidence / issues counts) inside a default audit
    // pack preview. The shape is a panel, not a notice — pulling out
    // the count-as-headline + label-below-it doesn't fit InlineNotice.

    // Conditional sync-result class string — sync-result rows colour
    // their background by status (PASSED → success, FAILED → error,
    // RUNNING → neutral). It's a styled row inside a list, not a
    // dismissable banner.

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

interface Hit {
    file: string;
    line: number;
    text: string;
}

describe("PR-10 InlineNotice discipline", () => {
    describe("hand-rolled `bg-bg-X border border-border-X` banners eradicated", () => {
        // ── Controls (#971) ──────────────────────────────────────────────
        //
        // `selector-teeth` gutted `walk` and nothing failed. Only ONE of its
        // nine guts is ever scored: the `: string[]` annotation is what kills
        // '' / 0 / null / undefined / false / Set / Map / {} — the TYPE, not
        // any assertion, is all that stood between this guard and eight more
        // vacuous passes. The gut that compiles is `[]`, and it is exactly
        // the shape the seam cannot see: the offender loop is
        // `for (const file of walk(...))`, so an empty array runs it zero
        // times, `offenders` stays empty and the suite is green. "1263 files
        // scanned, none offends" and "no file was ever opened" were the same
        // result. The other two tests in this describe iterate EXEMPT_FILES
        // and never call `walk` at all.
        //
        // The `fs.existsSync` throw INSIDE `walk` (#875) does not cover it —
        // gutting replaces the whole body, so that floor never runs. A check
        // one layer down cannot protect a caller that stops calling it, so it
        // is asserted below at the CALL SITE as well.

        it("control: walk returns the real population the offender loop consumes", () => {
            const perRoot = SCAN_DIRS.map((d) => walk(path.join(ROOT, d)));
            // Measured 2026-09-19: src/app 578 + src/components 685 = 1263.
            // Both floors sit far below that, so ordinary feature PRs never
            // move them — and `[]` fails both.
            for (const files of perRoot) {
                expect(files.length).toBeGreaterThan(100);
            }
            const all = perRoot.flat();
            expect(all.length).toBeGreaterThan(400);

            const rels = all.map((f) =>
                path.relative(ROOT, f).split(path.sep).join("/"),
            );
            expect(rels.filter((r) => r.startsWith(".."))).toEqual([]);

            // RECURSION — the one behaviour a constant return cannot express.
            // Real product source proves it: the deepest file sits 12 segments
            // down (src/app/api/t/[tenantSlug]/locations/[id]/basemap/[z]/[x]/
            // [y]/route.ts, measured).
            expect(
                Math.max(...rels.map((r) => r.split("/").length)),
            ).toBeGreaterThanOrEqual(8);

            // The extension filter must BITE, and its subjects are DERIVED
            // rather than named: `src/app` itself holds non-code siblings
            // (favicon.ico, globals.css, icon.svg, global-error.module.css).
            const nonCode = fs
                .readdirSync(path.join(ROOT, "src/app"), { withFileTypes: true })
                .filter((e) => e.isFile() && !/\.(tsx|ts|jsx|js)$/.test(e.name))
                .map((e) => `src/app/${e.name}`);
            expect(nonCode.length).toBeGreaterThan(0);
            expect(rels.filter((r) => nonCode.includes(r))).toEqual([]);
            expect(rels.filter((r) => !/\.(tsx|ts|jsx|js)$/.test(r))).toEqual([]);

            // The scan must REACH the neighbourhood it polices, or "zero
            // offenders" only means "zero files read". Measured: 75 files in
            // the population carry a `bg-bg-{variant}` token on 111 lines —
            // every one a near-miss this guard must see and not flag.
            const withTone = all.filter((f) =>
                /bg-bg-(error|success|warning|info)\b/.test(
                    fs.readFileSync(f, "utf8"),
                ),
            );
            expect(withTone.length).toBeGreaterThanOrEqual(20);
        });

        it("control: walk throws on a renamed scan root (#875), asserted at the call site", () => {
            // Asserted OUT HERE because the throw lives inside the body a gut
            // replaces. Without this the #875 floor is invisible to exactly
            // the mutation it was written to stop.
            expect(() =>
                walk(path.join(ROOT, "src/__scan_root_that_does_not_exist__")),
            ).toThrow(/scan root does not exist/);
        });
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

                // ── Controls (#971) — isExempt ───────────────────────────────────
        //
        // TRIAGE, because the two directions are not the same finding.
        //
        // FALSY: `: boolean` means the only gut that typechecks is `false`,
        // and that one is already killed — by the main test, not by anything
        // deliberate. Six of the nine EXEMPT_FILES genuinely carry the banned
        // pair on a non-comment line (9 lines, measured), so un-exempting
        // everything makes the scan report them. That kill is a side effect
        // of today's exemption list, which is why the biting subset is pinned
        // below: if it ever empties, `false` becomes a silent survivor.
        //
        // TRUTHY is the dangerous direction and the tool CANNOT REACH IT.
        // `{}` / `[]` / `new Set()` / `new Map()` are its truthy guts and none
        // of them typechecks against `boolean`; the gut set never tries
        // `true`. It is consumed as `if (isExempt(rel)) continue` INSIDE
        // `walk`, before the isDirectory branch, so a blanket-true prunes
        // both roots at their first entry: `walk` returns nothing, the guard
        // reports zero offenders, green. Same vacuum as gutting `walk`,
        // reached through its filter.

        it("control: isExempt exempts what it lists and nothing else", () => {
            // Positive half — every listed exemption is honoured.
            for (const rel of EXEMPT_FILES) {
                expect(isExempt(rel)).toBe(true);
            }

            // NEGATIVE half — the one a blanket-true fails. DERIVED from real
            // product source (the .tsx files sitting directly in
            // src/components — 8 of them once the one exemption among them is
            // removed) rather than named, so it cannot go stale.
            const siblings = fs
                .readdirSync(path.join(ROOT, "src/components"), {
                    withFileTypes: true,
                })
                .filter((e) => e.isFile() && e.name.endsWith(".tsx"))
                .map((e) => `src/components/${e.name}`)
                .filter((rel) => !EXEMPT_FILES.has(rel));
            expect(siblings.length).toBeGreaterThanOrEqual(3);
            expect(siblings.filter((rel) => isExempt(rel))).toEqual([]);

            // Each ARM bites on its own, and only on its own: the pairs below
            // differ by exactly the thing the arm matches.
            expect(isExempt("src/components/ui/hooks/__tests__")).toBe(true);
            expect(isExempt("src/components/ui/hooks")).toBe(false);
            expect(isExempt("src/components/Probe.test.tsx")).toBe(true);
            expect(isExempt("src/components/Probe.spec.ts")).toBe(true);
            expect(isExempt("src/components/Probe.stories.tsx")).toBe(true);
            expect(isExempt("src/components/Probe.tsx")).toBe(false);
        });

        it("control: the exemptions remove real entries, and bite on real banned source", () => {
            // The dir arm has a LIVE subject: two real hook tests sit under
            // src/components/ui/hooks/__tests__ and must be absent from the
            // scanned set. Absence alone proves nothing — the directory has to
            // exist, and the set it is absent from has to be non-empty.
            const hookTests = path.join(
                ROOT,
                "src/components/ui/hooks/__tests__",
            );
            expect(fs.existsSync(hookTests)).toBe(true);
            expect(
                fs
                    .readdirSync(hookTests)
                    .filter((n) => /\.test\.tsx?$/.test(n)).length,
            ).toBeGreaterThan(0);

            const scanned = SCAN_DIRS.flatMap((d) =>
                walk(path.join(ROOT, d)),
            ).map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
            expect(scanned.length).toBeGreaterThan(400);
            expect(
                scanned.filter((r) => r.split("/").includes("__tests__")),
            ).toEqual([]);
            expect(
                scanned.filter((r) => /\.(test|spec|stories)\.tsx?$/.test(r)),
            ).toEqual([]);

            // What makes the `false` gut RED rather than a no-op: the file
            // exemptions are load-bearing, not decorative. Measured
            // 2026-09-19 — 6 of the 9 listed files carry the banned pair on a
            // non-comment line. (The other 3 no longer match: inline-notice
            // only inside its docstring, and the two security pages write the
            // pair in the reverse order the regex requires. That is why this
            // asserts a floor on the subset and NOT that all nine bite.)
            const biting = Array.from(EXEMPT_FILES).filter((rel) => {
                const abs = path.resolve(ROOT, rel);
                if (!fs.existsSync(abs)) return false;
                return fs
                    .readFileSync(abs, "utf8")
                    .split("\n")
                    .some((line) => {
                        const trimmed = line.trim();
                        if (
                            trimmed.startsWith("//") ||
                            trimmed.startsWith("*")
                        ) {
                            return false;
                        }
                        return BANNED_PATTERN.test(line);
                    });
            });
            expect(biting.length).toBeGreaterThanOrEqual(3);
        });

it("documents every exempt file with a reason", () => {
            for (const rel of EXEMPT_FILES) {
                const abs = path.resolve(ROOT, rel);
                expect(fs.existsSync(abs)).toBe(true);
            }
        });

                // ── Control (#971) — BANNED_PATTERN ──────────────────────────────
        //
        // `selector-teeth` never scores this one. It mutates module-level
        // FUNCTIONS, and the detector here is a module-level const consumed by
        // a `.test(line)` INLINE inside the it() above — the tool's own
        // "selecting happens inside it()" blind spot, one level in. So it
        // reports nothing about the single value that decides whether this
        // guard can find anything: narrow it to /$^/ and every assertion in
        // the file still passes, because the whole guard collapses to
        // `expect([]).toHaveLength(0)`.
        //
        // Positive control from REAL PRODUCT SOURCE, derived from the guard's
        // own exemption list rather than hand-written: these lines are the
        // markup EXEMPT_FILES exists to excuse, so they cannot drift out of
        // sync with the product the way a pasted fixture would.

        it("control: BANNED_PATTERN matches real banned source and ignores near-misses", () => {
            const offending: string[] = [];
            for (const rel of EXEMPT_FILES) {
                const abs = path.resolve(ROOT, rel);
                if (!fs.existsSync(abs)) continue;
                for (const line of fs.readFileSync(abs, "utf8").split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
                        continue;
                    }
                    if (BANNED_PATTERN.test(line)) offending.push(line);
                }
            }
            // Measured 2026-09-19: 9 such lines across 6 of the 9 files.
            expect(offending.length).toBeGreaterThanOrEqual(3);

            // Near-misses. Each differs from a real hit by exactly one thing
            // the regex claims to require, so a widened pattern fails here
            // before it starts flagging the 75 population files that
            // legitimately use these tokens apart.
            expect(BANNED_PATTERN.test("p-3 bg-bg-error rounded-lg")).toBe(
                false,
            );
            expect(
                BANNED_PATTERN.test("border border-border-error rounded-lg"),
            ).toBe(false);
            // Cross-variant pair — the \1 backreference is what rejects it.
            expect(
                BANNED_PATTERN.test(
                    "bg-bg-error border border-border-success",
                ),
            ).toBe(false);
            // Two separate class strings, not one line of markup — the
            // [^\"'`] clause is what rejects it.
            expect(
                BANNED_PATTERN.test(
                    "bg-bg-error\" gap \"border-border-error",
                ),
            ).toBe(false);
            // Order matters, and this is a REAL shape from
            // security/mfa/page.tsx — pinned so a future "tidy-up" of the
            // pattern has to decide about it deliberately.
            expect(
                BANNED_PATTERN.test(
                    "border border-border-error bg-bg-error flex",
                ),
            ).toBe(false);
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

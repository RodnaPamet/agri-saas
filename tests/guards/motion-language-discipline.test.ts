/**
 * v2-PR-4 — Motion language ratchet (initial scope).
 *
 * The motion vocabulary is a single line: 150ms ease-out, animating
 * `background-color` and `border-color` only — never `transform`,
 * never `box-shadow` — for **layout-affecting surfaces** (cards,
 * buttons, table rows, sidebar items, list cards).
 *
 * Why this is a feature:
 *   - Transform/scale/translate hovers cause text reflow (subpixel
 *     anti-aliasing shifts) and trigger compositor work on every
 *     frame. The visual "lift" reads cheap on premium products.
 *   - Shadow hovers add visual noise and feel uncertain — premium
 *     products use border darkening (`hover:border-border-emphasis`)
 *     for "this is clickable" instead.
 *
 * What this ratchet bans (outside primitives):
 *   - hover:translate-*  (lift / shift)
 *   - hover:scale-*      (zoom)
 *   - hover:shadow-*     (drop shadow on hover)
 *   - hover:-translate-* (negative-direction lift)
 *
 * What is exempt (primitive-level motion is part of the render
 * contract):
 *   - `expanding-arrow.tsx` — the slide-on-hover arrow IS the
 *     icon's render contract; the visual cue is the navigation hint.
 *   - `file-upload.tsx`     — drop-zone icon scaling is the
 *     canonical drag-feedback pattern. Active-scale-95 is the
 *     tap-feedback gesture.
 *
 * NOT covered by this PR (deferred to follow-up):
 *   - `transition-all` → `transition-colors` codemod across the
 *     29 application sites. Many `transition-all` uses are
 *     legitimate (animating width on progress bars, stroke on
 *     SVG charts). A blind codemod would break them.
 *   - Focus-ring unification (would touch 100+ sites; bigger PR).
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
    // The slide-on-hover arrow is the icon's render contract — the
    // motion IS the navigation hint.
    "src/components/ui/icons/expanding-arrow.tsx",
    // File-upload drop-zone icon: scale-110 on hover/drag = drop
    // affordance; scale-95 on active = tap feedback. Both are
    // canonical drag-and-drop motion gestures, not decorative
    // hover lifts.
    "src/components/ui/file-upload.tsx",
    // v2-PR-12 — DataTable rows use `hover:shadow-[inset_2px_0_0_0_...]`
    // as a left-border affordance on clickable rows. `<tr>` elements
    // don't render direct CSS borders (table-border-collapse model
    // intercepts them); inset box-shadow is the canonical workaround.
    // This is a 1-edge tone change, NOT a depth shadow — semantically
    // a border, not lift. Reading order: row hover > tone shift +
    // brand-coloured left edge > navigate.
    "src/components/ui/table/table.tsx",
    // R13-PR2 — same inset-shadow left-edge affordance, applied
    // to the virtualized row path so all three DataTable branches
    // (resizable, non-resizable, virtualized) signal clickable
    // rows identically. The virtualized row is a `<div role="row">`
    // not a `<tr>`, but the inset-shadow trick is still the
    // canonical "this is a 1-edge tone change, not a lift" pattern.
    "src/components/ui/table/virtual-table-body.tsx",
    // Roadmap-13 — the NavItem primitive consciously broadens the
    // motion language for the sidebar's tactile-button vocabulary:
    //   - `hover:shadow-[var(--nav-bevel-shadow)]` (R13-PR7) is an
    //     INSET shadow that simulates concavity on hover — the
    //     bottom-edge counterpart to the R13-PR6 top-edge gloss
    //     highlight. Inset shadow, not lift; the row stays flush
    //     with the sidebar.
    //   - `active:translate-y-px` (R13-PR8) is the 1px press-down
    //     feedback on click. The single tactile micro-motion the
    //     R13 vocabulary explicitly allows; geometry stays still
    //     in every other state.
    // Both are locked by their own R13 ratchets (`r13-bevel-
    // shadow.test.ts`, `r13-press-feedback.test.ts`). The exempt
    // here documents the deliberate broadening so a future PR
    // that adds `hover:scale-105` to nav-item.tsx is still caught
    // by the local R13 ratchets — those don't get carved out.
    "src/components/layout/nav-item.tsx",
    // Roadmap-14 — the top-bar chrome carries the same tactile
    // press feedback as the sidebar's NavItem. Every clickable
    // slot (brand mark, switcher trigger, search anchor, bell,
    // user-menu avatar) composes `NAV_BAR_SLOT_PRESS` from
    // `nav-bar.tsx` which carries `active:translate-y-px` +
    // motion-reduce safety net. The R14 ratchets at
    // `r14-nav-bar-*.test.ts` lock the hover-translate /
    // hover-scale / hover-shadow bans inside these files even
    // though the global exempt skips the structural scan.
    "src/components/layout/nav-bar.tsx",
    "src/components/layout/tenant-switcher.tsx",
    "src/components/layout/user-menu.tsx",
    "src/components/layout/notifications-bell.tsx",
]);

const BANNED_PATTERNS = [
    /\bhover:translate-[^\s"'`]+/,
    /\bhover:-translate-[^\s"'`]+/,
    /\bhover:scale-[^\s"'`]+/,
    /\bhover:shadow-[^\s"'`]+/,
    /\bgroup-hover:translate-[^\s"'`]+/,
    /\bgroup-hover:-translate-[^\s"'`]+/,
    /\bgroup-hover:scale-[^\s"'`]+/,
    /\bgroup-hover:shadow-[^\s"'`]+/,
];

interface Hit {
    file: string;
    line: number;
    text: string;
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

describe("v2-PR-4 motion language ratchet", () => {
    describe("hover:transform / scale / shadow eradication", () => {
        it("zero `hover:(translate|scale|shadow)` outside exempts", () => {
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
                        for (const rx of BANNED_PATTERNS) {
                            if (rx.test(line)) {
                                offenders.push({
                                    file: path.relative(ROOT, file),
                                    line: i + 1,
                                    text: trimmed.slice(0, 200),
                                });
                                break;
                            }
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
                    `Found ${offenders.length} hover-transform/scale/shadow class(es). The motion language is bg + border-color only — clickable cards use \`hover:border-border-emphasis\` for the "this is clickable" affordance, not transform/shadow lift.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
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

        it("exempt list is deliberately tiny", () => {
            // Documented exemptions where the transform / inset
            // shadow IS the render contract:
            //   - icons/expanding-arrow.tsx (sliding arrow)
            //   - file-upload.tsx (drop-zone scale + active tap)
            //   - table/table.tsx (clickable-row left-border via
            //     inset box-shadow — <tr> can't render direct borders)
            //   - table/virtual-table-body.tsx (R13-PR2 — same
            //     left-edge affordance on the virtualized row path
            //     so all three DataTable branches signal clickable
            //     rows identically)
            //   - layout/nav-item.tsx (Roadmap-13 — sidebar's
            //     tactile-button vocabulary: inset bevel shadow
            //     on hover + 1px press-down on active)
            //   - layout/nav-bar.tsx + three sibling slot files
            //     (Roadmap-14 — top-bar chrome's tactile-press
            //     vocabulary: shared NAV_BAR_SLOT_PRESS recipe
            //     across brand mark + switcher + bell + user
            //     menu, all carrying active:translate-y-px).
            //     The searchbar-kill sweep retired the SearchAnchor
            //     pill; its file was deleted along with the
            //     exempt-list entry (cap dropped 11 → 10).
            // Bumping past 10 means the team is reintroducing
            // decorative lift on pages — push back on the new
            // exemption.
            expect(EXEMPT_FILES.size).toBeLessThanOrEqual(10);
        });
    });
});

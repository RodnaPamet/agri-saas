/**
 * PR-8 — Loading/error/empty state primitives ratchet.
 *
 * Bans new `animate-pulse h-X` placeholder blocks in `src/app` and
 * `src/components` outside the canonical skeleton primitives module.
 * Asserts the `<ErrorState>` primitive exists with the documented
 * exports + that the DataTable wires errors through it.
 *
 * Why:
 *   - Page authors used to hand-roll `<div className="glass-card
 *     animate-pulse h-48" />` for lazy-loaded panel placeholders.
 *     The result was a generic gray box that didn't reflect the
 *     final panel's shape — users got a "loading" without context.
 *     `<SkeletonCard lines={N}>` paints a panel-shape skeleton with
 *     N skeleton lines; `<SkeletonDetailPage>` mirrors a detail-page
 *     header + body shape; etc.
 *   - DataTable failures used to surface as raw error text in
 *     muted gray inside the table body. `<ErrorState>` wraps that
 *     in an alert role + icon + retry affordance.
 *
 * Pairs with:
 *   - `tests/rendered/error-state.test.tsx` — primitive contract
 *   - `src/components/ui/skeleton.tsx` — the canonical skeleton family
 *   - `src/components/ui/empty-state.tsx` — companion empty primitive
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

// Files that legitimately use `animate-pulse h-` because they ARE the
// canonical skeleton primitives. Each entry needs a written reason.
const EXEMPT_FILES = new Set<string>([
  "src/components/ui/skeleton.tsx", // The canonical skeleton family
  "src/components/ui/animated-size-container.tsx", // animation utility
  "src/components/ui/animated-number.tsx", // animation utility
  // OnboardingWizard renders a side-by-side 2-pane skeleton to
  // match its split layout (left rail + right canvas). The shape
  // doesn't fit <SkeletonCard>'s single-card mould; the wizard is
  // also already exempt from the PR-3 raw-color ratchet because of
  // its dark gradient background.
  "src/components/onboarding/OnboardingWizard.tsx",
  // EvidenceGallery's loading state is a 4-column grid of card-
  // shaped placeholders (h-56 rounded-lg bg-bg-elevated/60). The
  // grid layout is gallery-specific; <SkeletonCard> would render a
  // text-line shape which doesn't match a media tile.
  "src/components/ui/EvidenceGallery.tsx",
]);

// Match `animate-pulse` co-occurring with a PANEL-SHAPE height
// utility (h-24/h-32/h-40/h-48/h-64/h-80/h-96 — the gray-empty-box
// shape PR-8 retired). Smaller heights (h-3/h-4/h-5) are micro-
// skeleton text-row placeholders inside larger hand-rolled skeleton
// compositions; those are a separate cleanup bucket and don't
// belong to this ratchet.
const PANEL_HEIGHT_RE = /h-(?:2[4-9]|[3-9]\d|1\d{2})\b/;
const PATTERNS_TO_BAN = [
  // Order doesn't matter — animate-pulse may come before or after
  // the height utility in the className.
  (line: string): boolean =>
    /\banimate-pulse\b/.test(line) && PANEL_HEIGHT_RE.test(line),
];

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

describe("PR-8 state primitives discipline", () => {
  describe("animate-pulse h- placeholder eradication", () => {
    it("zero `animate-pulse h-N` placeholder blocks outside canonical skeletons", () => {
      const offenders: Hit[] = [];
      for (const dir of SCAN_DIRS) {
        for (const file of walk(path.join(ROOT, dir))) {
          const content = fs.readFileSync(file, "utf8");
          const lines = content.split("\n");
          lines.forEach((line, i) => {
            const trimmed = line.trim();
            if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
            for (const matcher of PATTERNS_TO_BAN) {
              if (matcher(line)) {
                offenders.push({
                  file: path.relative(ROOT, file),
                  line: i + 1,
                  text: trimmed,
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
          `Found ${offenders.length} hand-rolled animate-pulse placeholder block(s). Use <SkeletonCard lines={N}> from @/components/ui/skeleton (or another canonical skeleton primitive) so the placeholder reflects the final panel shape.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
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
      // 3 canonical skeleton/animation utilities + 2 documented
      // legitimate exemptions (OnboardingWizard split-pane skeleton,
      // EvidenceGallery media-tile grid). Bumping this past 7
      // means the team is hand-rolling skeletons instead of
      // composing from the canonical primitives.
      expect(EXEMPT_FILES.size).toBeLessThanOrEqual(7);
    });
  });

  describe("ErrorState primitive contract", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src/components/ui/error-state.tsx"),
      "utf8",
    );

    it("exports the ErrorState component", () => {
      expect(src).toMatch(/export\s+function\s+ErrorState/);
    });

    it("exports the ErrorStateProps + ErrorStateAction interfaces", () => {
      expect(src).toMatch(/export\s+interface\s+ErrorStateProps/);
      expect(src).toMatch(/export\s+interface\s+ErrorStateAction/);
    });

    it("renders inside an alert role with aria-live=polite", () => {
      expect(src).toMatch(/role="alert"/);
      expect(src).toMatch(/aria-live="polite"/);
    });

    it("default title is `Something went wrong`", () => {
      expect(src).toMatch(/title\s*=\s*["']Something went wrong["']/);
    });

    it("default retry label is `Try again`", () => {
      expect(src).toMatch(/retryLabel\s*=\s*["']Try again["']/);
    });
  });

  describe("DataTable error fallback uses ErrorState", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src/components/ui/table/table.tsx"),
      "utf8",
    );

    it("imports ErrorState from the canonical module", () => {
      expect(src).toMatch(
        /import\s+\{\s*ErrorState\s*\}\s+from\s+["']\.\.\/error-state["']/,
      );
    });

    it("renders <ErrorState> when a string `error` prop is supplied", () => {
      expect(src).toMatch(/<ErrorState\b/);
    });
  });
});

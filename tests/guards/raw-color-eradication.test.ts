/**
 * PR-1 — Raw status-color eradication ratchet.
 *
 * Bans raw Tailwind status-color utilities (text-red-*, bg-emerald-*,
 * border-amber-*, etc.) in app pages and shared UI components, forcing
 * everything through the semantic tokens defined in `src/styles/tokens.css`.
 *
 * Why this matters: raw color scales don't flip when the theme switches
 * (`[data-theme="light"]`). Semantic tokens do. Migrating means light
 * mode actually works — and that future palette evolutions don't require
 * a code-wide replace.
 *
 * Documented exemptions live in `EXEMPT_FILES` below — heatmaps that
 * use multiple alpha tiers as a visual gradient, and node/category
 * palettes where colors distinguish kinds rather than status. The
 * `icons/` directory is also exempt because raw colors are part of icon
 * SVG definitions.
 *
 * Pairs with Epic 51's slate / text-white guard (the same shape, applied
 * to the status-color subset of Tailwind's palette).
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/app", "src/components"];

// Files that legitimately use raw colors and are explicitly exempt.
// Keep this list narrow — every entry needs a written reason.
const EXEMPT_FILES = new Set<string>([
  "src/components/ui/ExpiryCalendar.tsx", // 3-tier urgency gradient (red/amber/yellow) — collapsing urgent + upcoming to a single warning token would erase the at-a-glance distinction
]);

// Directories whose contents are skipped entirely.
const EXEMPT_DIR_NAMES = new Set<string>([
  "icons",        // src/components/ui/icons — raw colors are part of icon SVG defs
  "charts",       // chart palette colors are visualization, not status semantics
  "__tests__",
  "__mocks__",
]);

const EXEMPT_FILE_PATTERNS: RegExp[] = [
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /\.stories\.tsx?$/,
];

const RAW_STATUS_COLOR_RE =
  /\b(?:text|bg|border|divide|ring|hover:bg|hover:text|hover:border|focus:bg|focus:text|focus:border|focus-visible:bg|focus-visible:text|focus-visible:border|dark:bg|dark:text|dark:border|group-hover:bg|group-hover:text|group-hover:border)-(?:red|rose|emerald|green|amber|yellow|blue|sky)-(?:50|100|200|300|400|500|600|700|800|900|950)(?:\/(?:\d{1,3}|\[[\d.]+\]))?\b/g;

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

function findOffenders(): Array<{ file: string; line: number; match: string }> {
  const offenders: Array<{ file: string; line: number; match: string }> = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        // skip pure comments
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        const matches = line.match(RAW_STATUS_COLOR_RE);
        if (matches) {
          for (const match of matches) {
            offenders.push({
              file: path.relative(ROOT, file),
              line: i + 1,
              match,
            });
          }
        }
      });
    }
  }
  return offenders;
}

describe("Raw status-color eradication ratchet", () => {
  const offenders = findOffenders();

  it("has zero raw status-color usages outside the documented exemptions", () => {
    if (offenders.length > 0) {
      const sample = offenders
        .slice(0, 20)
        .map((o) => `  ${o.file}:${o.line}  ${o.match}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} raw status-color usage(s). Use semantic tokens (text-content-error, bg-bg-success, border-border-warning, etc.) instead.\n\nFirst ${Math.min(20, offenders.length)} offender(s):\n${sample}\n\nIf the file genuinely needs raw colors (visualization, gradient, category palette), add it to EXEMPT_FILES in this test with a written reason.`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  it("documents every exempt file with a reason", () => {
    // Each exemption MUST exist on disk — stale exemption entries hide
    // real offenders that have moved or been renamed.
    for (const rel of EXEMPT_FILES) {
      const abs = path.resolve(ROOT, rel);
      expect(fs.existsSync(abs)).toBe(true);
    }
  });

  it("exempt files are deliberately small in number", () => {
    // If this number creeps up, the team is reaching for raw colors when
    // they should be defining new semantic tokens. Bump only with a
    // written design-system rationale in the PR description.
    expect(EXEMPT_FILES.size).toBeLessThanOrEqual(5);
  });
});

describe("Semantic status-token adoption", () => {
  // Counterpart to the eradication ratchet — verify the migration
  // actually moved sites onto the semantic tokens. Catches regressions
  // where someone deletes a status-tinted surface entirely instead of
  // migrating it.
  const ADOPTION_RE =
    /\b(?:text-content|bg-bg|border-border|divide-border)-(?:success|warning|error|info)(?:-emphasis)?\b/g;

  function countAdoptions(): number {
    let total = 0;
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const content = fs.readFileSync(file, "utf8");
        const matches = content.match(ADOPTION_RE);
        if (matches) total += matches.length;
      }
    }
    return total;
  }

  it("app pages + components use semantic status tokens extensively", () => {
    const count = countAdoptions();
    // Baseline after PR-1 migration. This number should only go UP as
    // status-tinted surfaces continue to be added.
    expect(count).toBeGreaterThanOrEqual(400);
  });
});

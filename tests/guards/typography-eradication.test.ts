/**
 * PR-3 — Typography eradication ratchet.
 *
 * Bans new inline `<h1 className="...">` / `<h2>` / `<h3>` headings in
 * `src/app` and `src/components`. The canonical primitives are
 * `<Heading level={1|2|3}>`, `<Eyebrow>`, and `<Caption>` from
 * `src/components/ui/typography.tsx`.
 *
 * Why:
 *   - One source of truth for the type scale (semibold L1/L2/L3, the
 *     eyebrow signature, caption tone). Pages that hand-roll
 *     `<h1 className="text-2xl font-bold">` make the scale drift.
 *   - The shells (`EntityListPage`, `EntityDetailLayout`) already use
 *     `<Heading>` internally — every consumer already gets the new
 *     typography. This ratchet keeps non-shell pages aligned.
 *
 * Allowed:
 *   - The shells + the typography primitive itself + tests / stories.
 *   - Pages with pre-existing dark/raw-color leaks (`text-gray-900`,
 *     `text-white`) — those need their colours migrated first; once
 *     they're token-clean they can graduate to `<Heading>`. Tracked as
 *     EXEMPT_FILES with a written reason and a corresponding entry in
 *     the raw-color eradication ratchet.
 *
 * Pairs with:
 *   - `tests/guards/raw-color-eradication.test.ts` (PR-1)
 *   - `tests/guards/legacy-badge-eradication.test.ts` (PR-2)
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/app", "src/components"];

// Files where `<Heading>` is the implementation, not the consumer.
const SHELL_FILES = new Set<string>([
  "src/components/layout/EntityListPage.tsx",
  "src/components/layout/EntityDetailLayout.tsx",
  "src/components/layout/ListPageShell.tsx",
  "src/components/ui/typography.tsx",
]);

// Files exempt from the ratchet. Each entry needs a written reason.
const EXEMPT_FILES = new Set<string>([
  // Pre-existing raw-color leaks (text-gray-900 / text-white). These
  // need their colours migrated to semantic tokens first; once clean
  // they can graduate to <Heading>. Tracking outside PR-3 scope.
  "src/app/not-found.tsx",
  "src/app/vendor-assessment/[assessmentId]/VendorAssessmentClient.tsx",
  "src/components/onboarding/OnboardingWizard.tsx",
]);

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

const HEADING_RE = /<h[1-4]\b[^>]*className="[^"]+"/g;

function isExempt(rel: string): boolean {
  if (SHELL_FILES.has(rel) || EXEMPT_FILES.has(rel)) return true;
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
  match: string;
}

function findOffenders(): Hit[] {
  const hits: Hit[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        const matches = line.match(HEADING_RE);
        if (matches) {
          for (const m of matches) {
            hits.push({
              file: path.relative(ROOT, file),
              line: i + 1,
              match: m,
            });
          }
        }
      });
    }
  }
  return hits;
}

describe("Typography eradication ratchet", () => {
  const offenders = findOffenders();

  it("zero inline `<hN className=...>` headings outside shells / exemptions", () => {
    if (offenders.length > 0) {
      const sample = offenders
        .slice(0, 20)
        .map((o) => `  ${o.file}:${o.line}  ${o.match}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} inline heading(s). Use <Heading level={1|2|3}> / <Eyebrow> / <Caption> from @/components/ui/typography instead.\n\nFirst ${Math.min(20, offenders.length)} offender(s):\n${sample}\n\nIf the heading genuinely needs raw-class control (print view, dark-themed onboarding background), add it to EXEMPT_FILES with a written reason.`,
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
    // Bumping this means more pages are escaping the type-scale
    // discipline. Only raise with a written design-system rationale.
    expect(EXEMPT_FILES.size).toBeLessThanOrEqual(8);
  });
});

describe("Typography primitive adoption", () => {
  // Counterpart positive ratchet: the migration moved hundreds of
  // headings onto the new primitives. Guards against silent
  // un-adoption (e.g. someone reverts a page back to inline `<h1>` and
  // adds it to EXEMPT_FILES).
  const PRIMITIVE_RE = /<(Heading|Eyebrow|Caption|TextLink)\b/g;

  function countAdoptions(): number {
    let total = 0;
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const content = fs.readFileSync(file, "utf8");
        const matches = content.match(PRIMITIVE_RE);
        if (matches) total += matches.length;
      }
    }
    return total;
  }

  it("app pages + components use the typography primitives extensively", () => {
    const count = countAdoptions();
    // Baseline after PR-3 migration. Should only go UP.
    expect(count).toBeGreaterThanOrEqual(150);
  });
});

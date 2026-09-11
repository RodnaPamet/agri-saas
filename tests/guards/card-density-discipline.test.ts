/**
 * PR-6 — Card density discipline ratchet.
 *
 * Bans `glass-card p-5` and `glass-card p-8` in `src/app` and
 * `src/components`. The audit's call: a finite density scale.
 * Pages were drifting between `p-4` (compact) and `p-6` (comfortable)
 * via `p-5` and `p-8` rungs without a documented reason. PR-6
 * collapsed those drift sites onto the canonical `p-6` and shipped
 * the `<Card density>` primitive at `src/components/ui/card.tsx`.
 *
 * What this ratchet enforces:
 *   - No new `glass-card p-5` or `glass-card p-8` strings (anywhere
 *     they appear in className: static strings, template literals,
 *     conditional ternaries).
 *   - The `<Card>` primitive itself stays in `src/components/ui/card.tsx`
 *     and only paints `p-4`, `p-6`, or no padding (verified by the
 *     primitive's own contract tests).
 *
 * What this ratchet does NOT enforce (yet):
 *   - Adoption of `<Card>` over the legacy `glass-card` CSS class.
 *     ~245 sites still use `<div className="glass-card p-4|p-6 …">`
 *     and may continue to. Migration to `<Card>` is a gradual
 *     follow-up; the canonical-rung discipline is locked first.
 *
 * Pairs with:
 *   - `tests/rendered/card.test.tsx` (PR-6) — primitive contract tests
 *   - `tests/guards/raw-color-eradication.test.ts` (PR-1)
 *   - `tests/guards/legacy-badge-eradication.test.ts` (PR-2)
 *   - `tests/guards/typography-eradication.test.ts` (PR-3)
 *   - `tests/guards/entity-detail-shell-coverage.test.ts` (PR-4 / PR-4b)
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

// Files that legitimately reference the strings (e.g. the Card
// primitive's docstring describing what it replaces). Each entry must
// have a written reason.
const EXEMPT_FILES = new Set<string>([
  // Card primitive's docstring mentions `<div className="glass-card p-5">`
  // and `<div className="glass-card p-8">` as historical patterns.
  "src/components/ui/card.tsx",
]);

// Match `glass-card` and `p-5` (or `p-8`) co-occurring within the same
// className value. We accept either ordering and any extra utilities
// in between.
const PATTERNS_TO_BAN = [
  /\bglass-card\b[^"`]*\bp-5\b/,
  /\bp-5\b[^"`]*\bglass-card\b/,
  /\bglass-card\b[^"`]*\bp-8\b/,
  /\bp-8\b[^"`]*\bglass-card\b/,
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

function findOffenders(): Hit[] {
  const hits: Hit[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        for (const re of PATTERNS_TO_BAN) {
          if (re.test(line)) {
            hits.push({
              file: path.relative(ROOT, file),
              line: i + 1,
              text: line.trim(),
            });
            break; // one hit per line is enough
          }
        }
      });
    }
  }
  return hits;
}

describe("Card density discipline ratchet", () => {
  const offenders = findOffenders();

  it("zero `glass-card p-5` or `glass-card p-8` sites in src/app + src/components", () => {
    if (offenders.length > 0) {
      const sample = offenders
        .slice(0, 15)
        .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} legacy glass-card p-5/p-8 site(s). Use <Card> from @/components/ui/card with density="comfortable" (p-6) or density="compact" (p-4) instead.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
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
    expect(EXEMPT_FILES.size).toBeLessThanOrEqual(3);
  });
});

describe("<Card> primitive contract", () => {
  // Defence-in-depth: even if the eradication ratchet is bypassed by
  // some clever className composition, the Card primitive itself must
  // expose only the canonical density rungs.
  it("only exposes `comfortable` / `compact` / `spacious` / `none` density variants", () => {
    // Roadmap-5 hotfix — the cva definition lives in
    // `card-variants.ts` (server-safe sibling). The `spacious` rung
    // landed in Roadmap-5 PR-2 alongside the existing trio.
    const src = fs.readFileSync(
      path.join(ROOT, "src/components/ui/card-variants.ts"),
      "utf8",
    );
    // Strip docstring + line comments so the assertion runs against
    // executable code only — the primitive's docstring legitimately
    // mentions `glass-card p-5` / `p-8` as historical patterns it
    // replaces, and we don't want those to trip the structural check.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).toMatch(/comfortable\s*:\s*["']p-6["']/);
    expect(code).toMatch(/compact\s*:\s*["']p-4["']/);
    expect(code).toMatch(/none\s*:\s*["']["']/);
    // Reject any `p-5`, `p-7`, `p-8` token co-occurring with the
    // density variants object in executable code.
    expect(code).not.toMatch(/density[^}]*p-5/);
    expect(code).not.toMatch(/density[^}]*p-7/);
    expect(code).not.toMatch(/density[^}]*p-8/);
  });
});

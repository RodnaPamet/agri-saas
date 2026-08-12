/**
 * PR-2 — Legacy `.badge` / `.badge-*` CSS class eradication ratchet.
 *
 * The `.badge` legacy CSS class layer (`.badge`, `.badge-success`,
 * `.badge-warning`, `.badge-danger`, `.badge-info`, `.badge-neutral`)
 * was retired in PR-2. Every call site migrated to `<StatusBadge>` from
 * `src/components/ui/status-badge.tsx` — the CVA primitive carries
 * a11y labels, icon slots, and `*-subtle` tiers the CSS layer never
 * had.
 *
 * This ratchet prevents reintroduction. New code that reaches for
 * `className="badge ..."` or `'badge-X'` literal strings fails CI.
 *
 * Pairs with the legacy-ui-ratchet at `tests/unit/legacy-ui-ratchet.test.ts`
 * (which still tracks the `.btn` migration baseline).
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

// Files where the regex false-positives because `badge` appears as a
// property accessor (e.g. `config.badge`, `badge.tone`) rather than as
// the legacy `.badge` CSS class. Each exemption needs a written reason.
const EXEMPT_FILES = new Set<string>([
  // ExpiryCalendar uses `config.badge` / `itemConfig.badge` as property
  // accessors — the property holds an arbitrary class string for the
  // 3-tier urgency gradient. Exempt from PR-1 raw-color migration too.
  "src/components/ui/ExpiryCalendar.tsx",
  // RiskEvaluationFields (shared create/edit scoring box) uses `badge.tone`
  // (not the .badge CSS class) — `badge` is a local variable holding a
  // `{ tone, label }` shape for the risk-score preview styling. The code
  // moved here from NewRiskModal on 2026-06-06.
]);

// `className=` strings (string OR template literal) containing the
// `badge` token as a class name. The token must appear bracketed by
// non-class characters (start/end of attribute value or whitespace),
// so we don't false-positive on identifiers like `FreshnessBadge`,
// `StatusBadge`, or property accessors like `config.badge`.
const CLASSNAME_BADGE_RE =
  /className=(?:"[^"]*\bbadge\b[^"]*"|`[^`]*\bbadge\b[^`]*`|\{`[^`]*\bbadge\b[^`]*`\})/g;

// Literal `'badge-X'` / `"badge-X"` strings anywhere in source — the
// migrated code paths use bare variant strings (`'success'`, `'error'`).
const LEGACY_BADGE_LITERAL_RE =
  /['"`]badge-(?:success|warning|danger|error|info|neutral|primary)['"`]/g;

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
  match: string;
  kind: "className" | "literal";
}

function findOffenders(): Hit[] {
  const hits: Hit[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        // Skip pure comments
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        const classMatches = line.match(CLASSNAME_BADGE_RE);
        if (classMatches) {
          for (const m of classMatches) {
            hits.push({ file: path.relative(ROOT, file), line: i + 1, match: m, kind: "className" });
          }
        }
        const litMatches = line.match(LEGACY_BADGE_LITERAL_RE);
        if (litMatches) {
          for (const m of litMatches) {
            hits.push({ file: path.relative(ROOT, file), line: i + 1, match: m, kind: "literal" });
          }
        }
      });
    }
  }
  return hits;
}

describe("Legacy badge CSS eradication ratchet", () => {
  const offenders = findOffenders();

  it("zero `className=\"badge ...\"` and zero `'badge-X'` literals in src/app + src/components", () => {
    if (offenders.length > 0) {
      const sample = offenders
        .slice(0, 20)
        .map((o) => `  [${o.kind}] ${o.file}:${o.line}  ${o.match}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} legacy badge usage(s). Use <StatusBadge variant="…"> from @/components/ui/status-badge instead.\n\nFirst ${Math.min(20, offenders.length)} offender(s):\n${sample}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });
});

describe("StatusBadge adoption", () => {
  // Counterpart positive ratchet: the migration moved every legacy
  // badge site onto <StatusBadge>. This guards against silent removal
  // (e.g. someone deletes a status surface entirely instead of porting
  // it). The number should only go UP.
  const STATUS_BADGE_RE = /<StatusBadge\b/g;

  function countAdoptions(): number {
    let total = 0;
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const content = fs.readFileSync(file, "utf8");
        const matches = content.match(STATUS_BADGE_RE);
        if (matches) total += matches.length;
      }
    }
    return total;
  }

  it("app pages + components use <StatusBadge> extensively", () => {
    const count = countAdoptions();
    // Baseline after PR-2 migration. This number should only go UP.
    expect(count).toBeGreaterThanOrEqual(140);
  });
});

describe("globals.css legacy class layer", () => {
  // Defence-in-depth: even if the eradication ratchet is bypassed by
  // some clever class composition, we make sure the CSS classes
  // themselves don't come back to globals.css.
  it("globals.css does not redefine `.badge` / `.badge-*` selectors", () => {
    const css = fs.readFileSync(
      path.join(ROOT, "src/app/globals.css"),
      "utf8",
    );
    // Match `.badge {` or `.badge-* {` selectors — but tolerate the
    // PR-2 retirement comment block which mentions the names.
    const lines = css.split("\n");
    const offenders: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
      if (/^\.badge(-\w+)?\s*\{/.test(trimmed)) {
        offenders.push({ line: i + 1, text: trimmed });
      }
    }
    expect(offenders).toEqual([]);
  });
});

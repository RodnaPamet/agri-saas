/**
 * PR-9 — Search placeholder vocabulary ratchet.
 *
 * Every `<FilterToolbar searchPlaceholder>` value follows the
 * canonical shape: `Search {entityPlural}…`. One ellipsis character
 * (`…`, U+2026 — NOT three dots `...`). NEVER append a parenthetical
 * hint like ` (Enter)` / ` (Press Enter)` / ` (Enter to apply)`.
 *
 * Why:
 *   - The FilterToolbar search is live (typing filters the table on a
 *     short debounce, no Enter required), so an Enter hint would be
 *     actively misleading on top of adding visual noise.
 *   - One ellipsis character is consistent with the rest of the
 *     product's microcopy (loading messages, empty states).
 *
 * Pairs with the search-placeholder convention documented in
 * CLAUDE.md "Key Conventions".
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/app", "src/components"];
const I18N_DIR = "messages";

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

// Bans `(Enter)` / `(Press Enter)` and similar parenthetical hints
// inside searchPlaceholder values (JSX attribute or i18n string).
const PARENTHETICAL_HINT_RE =
  /searchPlaceholder\s*[:=]\s*["'`][^"'`]*\([^)]*[Ee]nter[^)]*\)[^"'`]*["'`]/;

// Bans three-dot `...` in any searchPlaceholder value (use `…`).
const THREE_DOT_RE = /searchPlaceholder\s*[:=]\s*["'`][^"'`]*\.\.\.[^"'`]*["'`]/;

// i18n: bans the same shapes inside JSON values whose key looks like
// a search-related placeholder (keys containing 'earch' anywhere —
// covers searchPlaceholder, searchRisks, search, etc.).
const I18N_HINT_RE =
  /"[Ss]earch\w*"\s*:\s*"[^"]*\([^)]*[Ee]nter[^)]*\)[^"]*"/;
const I18N_THREE_DOT_RE =
  /"[Ss]earch\w*"\s*:\s*"[^"]*\.\.\.[^"]*"/;

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) {
      throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);
    const segments = rel.split(path.sep);
    if (segments.some((s) => EXEMPT_DIR_NAMES.has(s))) continue;
    if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) continue;
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

function findOffenders(re: RegExp, dirs: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const dir of dirs) {
    for (const file of walk(path.join(ROOT, dir))) {
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (re.test(line)) {
          hits.push({
            file: path.relative(ROOT, file),
            line: i + 1,
            text: trimmed,
          });
        }
      });
    }
  }
  return hits;
}

function findI18nOffenders(re: RegExp): Hit[] {
  const hits: Hit[] = [];
  const i18nDir = path.join(ROOT, I18N_DIR);
  if (!fs.existsSync(i18nDir)) {
      throw new Error(`scan root does not exist: ${i18nDir} — a renamed root would scan zero files and pass (#875)`);
  }
  for (const file of fs.readdirSync(i18nDir)) {
    if (!file.endsWith(".json")) continue;
    const abs = path.join(i18nDir, file);
    const content = fs.readFileSync(abs, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (re.test(line)) {
        hits.push({
          file: path.relative(ROOT, abs),
          line: i + 1,
          text: line.trim(),
        });
      }
    });
  }
  return hits;
}

describe("Search placeholder vocabulary ratchet", () => {
  it("zero ` (Enter)` parenthetical hints in searchPlaceholder JSX values", () => {
    const offenders = findOffenders(PARENTHETICAL_HINT_RE, SCAN_DIRS);
    if (offenders.length > 0) {
      const sample = offenders
        .slice(0, 10)
        .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} searchPlaceholder value(s) with a parenthetical hint. The 'type=search' input plus FilterToolbar's commit-on-Enter is self-documenting — drop the hint.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  it("zero three-dot `...` in searchPlaceholder JSX values (use `…`)", () => {
    const offenders = findOffenders(THREE_DOT_RE, SCAN_DIRS);
    if (offenders.length > 0) {
      const sample = offenders
        .slice(0, 10)
        .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} searchPlaceholder value(s) using three dots. Use the single ellipsis character '…' (U+2026).\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  it("zero ` (Enter)` parentheticals in i18n search* values", () => {
    const offenders = findI18nOffenders(I18N_HINT_RE);
    if (offenders.length > 0) {
      const sample = offenders
        .slice(0, 10)
        .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} i18n search* value(s) with a parenthetical hint.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  it("zero three-dot `...` in i18n search* values", () => {
    const offenders = findI18nOffenders(I18N_THREE_DOT_RE);
    if (offenders.length > 0) {
      const sample = offenders
        .slice(0, 10)
        .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} i18n search* value(s) using three dots. Use '…' (U+2026).\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });
});

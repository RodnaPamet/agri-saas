/**
 * Polish PR-2 — Metric typography ratchet.
 *
 * Bans raw `text-(2xl|3xl|4xl) font-(bold|semibold)` next to numeric
 * content in `src/app`. Numbers are typographic primitives — they
 * MUST flow through `<HeroMetric>` or `<KPIStat>` from
 * `@/components/ui/metric`.
 *
 * Why
 *   Until this PR every dashboard invented its own number
 *   typography. The result was that the same KPI on the executive
 *   dashboard, the risks dashboard, and the tasks dashboard rendered
 *   at three different sizes / weights / tracking values.
 *
 * What this ratchet detects
 *   Any line in `src/app` that contains BOTH:
 *     (a) a `text-(2xl|3xl|4xl)` size + `font-(bold|semibold)` pair
 *         (in any order, possibly with other classes between), AND
 *     (b) a JSX expression `{...}` that looks like it's rendering a
 *         numeric value.
 *
 *   The pair-detection guards against false positives on body
 *   typography. Heading L1 (the canonical title rung) uses
 *   `<Heading level={1}>` and is exempt by virtue of being a
 *   component, not a literal. Decorative oversized text (rare —
 *   marketing-style) needs an explicit allowlist entry below.
 *
 * Pairs with:
 *   - src/components/ui/metric.tsx (the primitive)
 *   - tests/rendered/metric.test.tsx (the contract)
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/app'];

const EXEMPT_DIR_NAMES = new Set<string>([
    'node_modules',
    '__tests__',
    '__mocks__',
]);

const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

// Specific files that legitimately render decorative oversized text
// that isn't a metric. Each entry needs a written reason. Cap at 8
// so this list doesn't quietly grow.
const EXEMPT_FILES = new Set<string>([
    // Empty / not-found surfaces use a single oversized status code
    // (404, 403) as a focal point — that's not a metric.
    'src/app/not-found.tsx',
    'src/app/error.tsx',
    // Auth landing pages render brand wordmark / heroic copy that's
    // editorial, not a number.
    'src/app/login/page.tsx',
]);

const SIZE_RE = /\btext-(2xl|3xl|4xl|5xl|6xl)\b/;
const WEIGHT_RE = /\bfont-(bold|semibold)\b/;
// Look for either an interpolated expression (`{value}`, `{count}`,
// `{metrics.foo}`, `{x}%`) or a literal numeric (rare, e.g. ASCII art).
// We err on the side of inclusion — body copy doesn't combine
// text-3xl + font-bold in a single className.
const HAS_EXPRESSION_RE = /\{[^}]*\}/;

interface Hit {
    file: string;
    line: number;
    text: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full);
        if (EXEMPT_FILES.has(rel)) continue;
        const segments = rel.split(path.sep);
        if (segments.some((s) => EXEMPT_DIR_NAMES.has(s))) continue;
        if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe('Metric typography ratchet (Polish PR-2)', () => {
    it('zero raw `text-(2xl|3xl|4xl) font-(bold|semibold)` next to numeric content in src/app', () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, 'utf8');
                const lines = content.split('\n');
                lines.forEach((line, i) => {
                    const trimmed = line.trim();
                    if (
                        trimmed.startsWith('//') ||
                        trimmed.startsWith('*')
                    )
                        return;
                    if (!SIZE_RE.test(line)) return;
                    if (!WEIGHT_RE.test(line)) return;
                    // We additionally require that this line either
                    // contains a JSX expression (numeric value) OR
                    // sits within a 2-line window of one. The vast
                    // majority of false-positives would be heading
                    // text in a decorative card — rare today.
                    const window = lines
                        .slice(Math.max(0, i - 1), Math.min(lines.length, i + 2))
                        .join(' ');
                    if (!HAS_EXPRESSION_RE.test(window)) return;
                    offenders.push({
                        file: path.relative(ROOT, file),
                        line: i + 1,
                        text: trimmed.slice(0, 200),
                    });
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 15)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} raw \`text-(2xl|3xl|4xl) font-(bold|semibold)\` site(s) next to numeric content in src/app.\n\nNumbers MUST flow through \`<HeroMetric>\` or \`<KPIStat>\` from '@/components/ui/metric'. The primitive locks tabular-nums + a single typographic register so dashboards stop drifting.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('exempt list is bounded and every entry exists', () => {
        for (const rel of EXEMPT_FILES) {
            const abs = path.resolve(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
        }
        expect(EXEMPT_FILES.size).toBeLessThanOrEqual(8);
    });
});
